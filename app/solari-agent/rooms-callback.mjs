// Temporary laptop-only forwarding of the relay's registered loopback callback.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function createCallbackServer(connection, request = fetch, complete = () => {}) {
  const expectedState = new URL(connection.authorization_url).searchParams.get('state');
  if (!expectedState) throw new Error('Missing OAuth state.');
  const origin = new URL(connection.callback_origin);
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.preview.getsolari.com')) throw new Error('Unexpected callback bridge origin.');
  return http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== expectedState) {
    res.writeHead(400).end('Unexpected Rooms callback.'); return;
  }
  try {
    const destination = new URL('/callback', origin);
    destination.search = url.search;
    const response = await request(destination, {
      headers: { 'x-solari-preview-token': connection.tunnel_token }, signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
    res.writeHead(response.status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end(await response.text());
    if (response.ok) complete();
  } catch { res.writeHead(502).end('Could not reach the Solari sign-in callback.'); }
  });
}

export async function startCallback() {
  const connection = JSON.parse(await readFile(resolve(root, '.solari/rooms-login.json'), 'utf8'));
  const server = createCallbackServer(connection, fetch, () => { clearTimeout(expiry); server.close(); });
  const expiry = setTimeout(() => server.close(), 10 * 60_000);
  server.on('error', () => clearTimeout(expiry));
  server.listen(53682, '127.0.0.1', () => console.log('Rooms callback forwarding ready on loopback port 53682.'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await startCallback();
