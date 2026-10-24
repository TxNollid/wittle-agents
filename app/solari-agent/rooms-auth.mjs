// Runs only in the dedicated guest. OAuth credentials are created there.
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { createAuth, resolveClientId } from '/work/rooms-install/cli/lib/node_modules/@wittlelabs/rooms-relay/auth.mjs';

const server = 'https://rooms.wittlelabs.ai';
const dir = '/work/rooms-relay';
await mkdir(dir, { recursive: true, mode: 0o700 });
// The registered OAuth callback remains loopback port 53682. A temporary,
// authenticated Solari port bridges it to the owner's browser on the laptop.
const bridge = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' || url.pathname !== '/callback') { res.writeHead(404).end(); return; }
  const upstream = http.get({ hostname: '127.0.0.1', port: 53682, path: req.url }, reply => {
    res.writeHead(reply.statusCode, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    reply.pipe(res);
  });
  upstream.on('error', () => res.writeHead(502).end('Remote callback is unavailable.'));
});
await new Promise(resolve => bridge.listen(53683, '0.0.0.0', resolve));
try {
  const clientId = await resolveClientId(server);
  const auth = createAuth({ server, dir, clientId, timeoutMs: 10 * 60_000 });
  await auth.setup({ openBrowser: false, onUrl: url => console.log(JSON.stringify({ authorization_url: url })), onSignedIn: () => console.log('Rooms sign-in completed.') });
  await writeFile(`${dir}/config.json`, JSON.stringify({ server, client_id: clientId }) + '\n', { mode: 0o600 });
  console.log('Relay authorization saved in the remote sandbox.');
} finally {
  // Let the callback response drain before removing the temporary bridge.
  setTimeout(() => bridge.close(), 1000);
}
