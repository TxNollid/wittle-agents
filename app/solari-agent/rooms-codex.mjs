#!/usr/bin/env node
// Keep relay runner diagnostics private in the guest, never in room messages.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { assertTrustedDevelopment } from './execution-policy.mjs';
assertTrustedDevelopment(process.env);
const child = spawn('/work/codex/node_modules/.bin/codex', process.argv.slice(2), {
  stdio: ['inherit', 'inherit', 'pipe'], env: process.env,
});
let stderr = '';
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12_000); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => {
  writeFileSync('/work/rooms-relay/last-run-error.txt', error.message, { mode: 0o600 });
  process.exitCode = 127;
});
child.on('close', (code, signal) => {
  if (code !== 0) writeFileSync('/work/rooms-relay/last-run-error.txt', stderr, { mode: 0o600 });
  process.exitCode = code ?? (signal ? 128 : 1);
});
