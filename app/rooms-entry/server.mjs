import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { EntryError } from './index.mjs';

const hash = value => createHash('sha256').update(value).digest();
// Mount behind the web server only. Browser requests must never receive this allocation token.
export function createEntryServer(adapter, { token } = {}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('A server-only allocation token of at least 32 characters is required.');
  const expected = hash(`Bearer ${token}`);
  return http.createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...headers });
      res.end(JSON.stringify(body));
    };
    try {
      const path = req.url;
      if (!['/entry', '/readiness'].includes(path)) throw new EntryError('INVALID_INPUT', 404, 'correct_input');
      // Previews and link scanners cannot reserve rooms, even with a valid allocation token.
      if ((path === '/entry' && req.method !== 'POST') || (path === '/readiness' && req.method !== 'GET')) {
        return send(405, { code: 'INVALID_INPUT', retryable: false, next_action: 'correct_input' }, { Allow: path === '/entry' ? 'POST' : 'GET' });
      }
      const auth = req.headers.authorization;
      if (typeof auth !== 'string' || auth.length > 4096 || !timingSafeEqual(expected, hash(auth))) throw new EntryError('FORBIDDEN', 401, 'stop');
      if (path === '/readiness') {
        const value = await adapter.readiness();
        return send(value.entry_available ? 200 : 503, value);
      }
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new EntryError('INVALID_INPUT', 415, 'correct_input');
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) throw new EntryError('INVALID_INPUT', 413, 'correct_input');
        chunks.push(chunk);
      }
      let request;
      try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new EntryError('INVALID_INPUT', 400, 'correct_input'); }
      const value = await adapter.allocate(req.headers['x-wittle-entry-principal'], request);
      return send(200, value);
    } catch (error) {
      // Neither provider error bodies nor SQLite failures (which may contain join links) are public.
      const safe = error instanceof EntryError ? error : new EntryError('RUNTIME_UNAVAILABLE', 503, 'wait', true);
      return send(safe.status, safe.body);
    }
  });
}
