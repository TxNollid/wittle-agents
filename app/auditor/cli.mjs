import { readFile } from 'node:fs/promises';
import { runAudit } from './audit.mjs';
import { createBrowserAdapter } from './browser.mjs';
import { fixturePages } from './fixtures.mjs';

const [path, ...args] = process.argv.slice(2);
if (!path || args.some(arg => !['--fixture', '--teaser'].includes(arg))) {
  console.error('Usage: node cli.mjs JOB.json [--fixture] [--teaser]');
  process.exitCode = 2;
} else {
  const job = JSON.parse(await readFile(path, 'utf8'));
  const adapter = await createBrowserAdapter({ executablePath: process.env.AUDITOR_CHROME_PATH,
    ...(args.includes('--fixture') ? { fixturePages } : {}) });
  try {
    const report = await runAudit(job, adapter, { auditMode: args.includes('--teaser') ? 'teaser' : 'paid' });
    console.log(JSON.stringify(report, null, 2));
    if (report.state !== 'complete') process.exitCode = 1;
  } finally { await adapter.close(); }
}
