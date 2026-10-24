import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallbackServer } from './rooms-callback.mjs';

test('OAuth forwarding rejects wrong state and keeps callback credentials on the fixed Solari origin', async () => {
  let calls = 0;
  const server = createCallbackServer({ authorization_url: 'https://auth.example/authorize?state=expected', callback_origin: 'https://test-53683.preview.getsolari.com', tunnel_token: 'test-token' }, async (url, options) => {
    calls++;
    assert.equal(url.origin, 'https://test-53683.preview.getsolari.com');
    assert.equal(url.pathname, '/callback');
    assert.equal(url.searchParams.get('code'), 'one-time-code');
    assert.equal(options.headers['x-solari-preview-token'], 'test-token');
    return new Response('Sign-in complete.');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${origin}/callback?state=wrong&code=test`)).status, 400);
    assert.equal((await fetch(`${origin}/other?state=expected`)).status, 400);
    assert.equal(calls, 0);
    const response = await fetch(`${origin}/callback?state=expected&code=one-time-code`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(calls, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
