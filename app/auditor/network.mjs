import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import http from 'node:http';
import https from 'node:https';

const blocked = new BlockList();
for (const [base, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['192.88.99.0', 24], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(base, prefix, 'ipv4');
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
for (const [base, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  blocked.addSubnet(base, prefix, 'ipv6');
}
export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && global6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
export function publicUrl(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.endsWith('.test') || !host.includes('.') && !isIP(host) ||
      isIP(host) && !isPublicAddress(host)) throw new Error('URL_NOT_PUBLIC');
  url.hash = '';
  return url;
}

// DNS is resolved once per request; the socket uses only the vetted address.
// Browser routing must use this function for subresources and redirects too.
export async function publicFetch(value, { signal, maxBytes = 2_000_000, redirects = 3, resolve = lookup, budget } = {}) {
  const url = publicUrl(value);
  signal?.throwIfAborted();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const records = isIP(host) ? [{ address: host, family: isIP(host) }]
    : await resolve(host, { all: true, verbatim: true });
  if (!records.length || records.some(({ address }) => !isPublicAddress(address))) throw new Error('DNS_NOT_PUBLIC');
  signal?.throwIfAborted();
  if (budget && ++budget.requests > budget.maxRequests) throw new Error('REQUEST_LIMIT');
  const { address, family } = records[0];
  const result = await new Promise((accept, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal,
      agent: false,
      lookup: (_host, options, callback) => options.all
        ? callback(null, [{ address, family }]) : callback(null, address, family),
      headers: { 'user-agent': 'WittleWebsiteAuditor/1.0 (read-only public-page audit)', 'accept-encoding': 'identity' },
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (budget) {
          budget.bytes += chunk.length;
          if (budget.bytes > budget.maxBytes) {
            response.destroy(new Error('BYTE_LIMIT'));
            return;
          }
        }
        if (bytes > maxBytes) response.destroy(new Error('RESPONSE_TOO_LARGE'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => accept({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), url: url.href }));
    });
    request.setTimeout(10_000, () => request.destroy(new Error('NETWORK_TIMEOUT')));
    request.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
    if (!redirects) throw new Error('REDIRECT_LIMIT');
    return publicFetch(new URL(result.headers.location, url).href, { signal, maxBytes, redirects: redirects - 1, resolve, budget });
  }
  return result;
}
