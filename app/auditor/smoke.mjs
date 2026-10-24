import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserAdapter } from './browser.mjs';
import { runAudit, runTeaser } from './audit.mjs';
import { createDelivery } from './delivery.mjs';
import { fixtureJob, fixturePages, fixedEvaluationSites } from './fixtures.mjs';

const executablePath = process.env.AUDITOR_CHROME_PATH;
const publicRun = process.argv.includes('--public');
const adapter = publicRun ? null : await createBrowserAdapter({ executablePath, fixturePages });
const dir = await mkdtemp(join(tmpdir(), 'wittle-auditor-smoke-'));
let store;
try {
  await mkdir(new URL('./evidence/', import.meta.url), { recursive: true });
  if (publicRun) {
    for (const [index, url] of fixedEvaluationSites.entries()) {
      const job = fixtureJob({ mode: 'sandbox', order_id: `local-evaluation-${index}`, job_id: `local-evaluation-job-${index}`,
        scope: { ...fixtureJob().scope, site_url: url, pages: [url] } });
      const siteAdapter = await createBrowserAdapter({ executablePath });
      let report;
      try { report = await runAudit(job, siteAdapter); }
      finally { await siteAdapter.close(); }
      await writeFile(new URL(`./evidence/public-${index + 1}.json`, import.meta.url), JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ evidence: 'local public-browser observation; no payment/provider/customer proof', url, state: report.state, findings: report.findings.length, coverage: report.coverage, duration_ms: report.duration_ms }));
    }
  } else {
    const job = fixtureJob();
    const report = await runAudit(job, adapter);
    assert.equal(report.state, 'complete');
    assert.ok(report.findings.some(finding => finding.rule === 'missing-title'));
    assert.ok(report.findings.some(finding => finding.viewport === 'mobile' && finding.rule === 'horizontal-overflow'));
    assert.equal(report.findings.some(finding => /secret/i.test(finding.observation)), false);
    const teaser = await runTeaser({ site_url: 'https://example.com/', request_id: 'fixture-teaser-1', mode: 'fixture',
      provenance: { source_url: 'https://example.com/', observed_at: '2026-10-24T17:00:00.000Z', evidence_level: 'fixture' } }, adapter);
    assert.equal(teaser.findings.length, 3);
    assert.equal('order_id' in teaser, false);
    const clean = await runAudit(fixtureJob({ scope: { ...job.scope, pages: ['https://example.com/clean'] } }), adapter);
    assert.deepEqual(clean.findings, []);
    const login = await runAudit(fixtureJob({ scope: { ...job.scope, pages: ['https://example.com/login'] } }), adapter);
    assert.equal(login.state, 'failed');
    assert.ok(login.coverage.every(row => row.reason === 'AUTHENTICATED_SITE_UNSUPPORTED'));
    const capacityPages = Array.from({ length: 5 }, (_, index) => `https://example.com/capacity-${index}`);
    const capacityAdapter = await createBrowserAdapter({ executablePath,
      fixturePages: Object.fromEntries(capacityPages.map(url => [url, fixturePages['https://example.com/']])) });
    let capacity;
    try { capacity = await runAudit(fixtureJob({ scope: { ...job.scope, pages: capacityPages } }), capacityAdapter); }
    finally { await capacityAdapter.close(); }
    assert.equal(capacity.state, 'complete');
    assert.equal(capacity.coverage.filter(row => row.state === 'observed').length, 10);
    assert.equal(capacity.findings.length, 10);
    assert.equal(capacity.tool_calls, 10);
    let sends = 0;
    const options = { databasePath: join(dir, 'durable-results.sqlite'), authorize: async ({ job: current }) => ({ ...current, allowed: true }),
      send: async ({ room_id, delivery_key }) => ({ room_id, delivery_key, message_id: `fixture-message-${++sends}` }),
      readBuyerEvent: async () => null };
    store = createDelivery(options);
    assert.equal((await store.fulfill(job, async () => report)).state, 'delivered');
    store.close();
    store = createDelivery(options);
    assert.equal((await store.fulfill(job, () => { throw Error('Must use persisted report'); })).duplicate, true);
    assert.equal(sends, 1);
    await writeFile(new URL('./evidence/fixture-audit.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
    await writeFile(new URL('./evidence/fixture-teaser.json', import.meta.url), JSON.stringify(teaser, null, 2) + '\n');
    await writeFile(new URL('./evidence/fixture-contracts.json', import.meta.url), JSON.stringify({ job, ...store.records(job.order_id) }, null, 2) + '\n');
    await writeFile(new URL('./evidence/fixture-artifact.json', import.meta.url), JSON.stringify(report));
    await writeFile(new URL('./evidence/fixture-capacity.json', import.meta.url), JSON.stringify(capacity, null, 2) + '\n');
    console.log(JSON.stringify({ evidence: 'fixture HTML rendered in actual local Chromium; fixture delivery transport only', audit: report.state,
      findings: report.findings.map(({ rule, viewport }) => ({ rule, viewport })), teaser_findings: teaser.findings.length,
      clean_findings: clean.findings.length, login: login.state, capacity_observations: capacity.tool_calls, capacity_findings: capacity.findings.length,
      delivered_messages: sends, restart_duplicate: true }));
  }
} finally {
  store?.close();
  await adapter?.close();
  await rm(dir, { recursive: true, force: true });
}
