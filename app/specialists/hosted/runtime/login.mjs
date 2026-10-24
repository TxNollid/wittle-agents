// Forced fresh sign-in for the HostedAgents fleet home; prints the link instead of opening the browser.
import { join } from 'node:path';
import { homedir } from 'node:os';
const R = (process.env.ROOMS_RELAY_PACKAGE || join(homedir(), '.wittle-rooms/cli/lib/node_modules/@wittlelabs/rooms-relay'));
const { createAuth } = await import(`${R}/auth.mjs`);
const home = join(homedir(), '.wittle-rooms', 'hostedagents', 'relay');
const auth = createAuth({ server: 'https://rooms.wittlelabs.ai', dir: home, clientId: 'client_01M5NX7KDR46Y1ZBP8J6054HQ5', timeoutMs: 30 * 60_000 });
await auth.setup({ forceLogin: true, openBrowser: false, onUrl: (url) => console.log(`OPEN_THIS: ${url}`), onWaiting: () => console.log('waiting for sign-in…') });
console.log('SIGNED_IN');
