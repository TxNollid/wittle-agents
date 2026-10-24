import test from 'node:test';
import assert from 'node:assert/strict';
import { publicUrl, isPublicAddress, publicFetch } from './network.mjs';
import { runAudit, runTeaser } from './audit.mjs';
import { fixtureJob } from './fixtures.mjs';

const clean = { evidence_kind: 'fixture', async observe({ url, viewport }) {
  return { url, viewport, facts: { title: 'Fixture', issues: [] } };
} };
test('private, mapped, metadata and reserved URLs never reach networking', async () => {
  for (const url of ['http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://169.254.169.254/',
    'http://10.1.2.3/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[2002:7f00:1::]/',
    'http://localhost/', 'http://x.local/', 'https://user:pass@example.com/', 'file:///etc/passwd', 'https://example.com:444/']) {
    assert.throws(() => publicUrl(url), /URL_NOT_PUBLIC|Invalid URL/);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  await assert.rejects(publicFetch('https://example.com/', { resolve: async () => [{ address: '127.0.0.1', family: 4 }] }), /DNS_NOT_PUBLIC/);
  await assert.rejects(publicFetch('https://example.com/', { resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] }), /DNS_NOT_PUBLIC/);
  assert.throws(() => publicUrl(new URL('http://169.254.169.254/latest/', 'https://example.com/').href), /URL_NOT_PUBLIC/);
});
test('clean observations produce zero findings; cap exhaustion leaves explicit unobserved coverage', async () => {
  const report = await runAudit(fixtureJob(), clean);
  assert.equal(report.state, 'complete');
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.coverage.map(row => row.viewport), ['desktop', 'mobile']);
  const limited = await runAudit(fixtureJob(), clean, { maxObservations: 1 });
  assert.equal(limited.state, 'partial');
  assert.deepEqual(limited.coverage[1], { url: 'https://example.com/', viewport: 'mobile', state: 'not_observed', reason: 'TOOL_LIMIT' });
});
test('timeouts preserve failed coverage and unsupported versions never observe', async () => {
  const report = await runAudit(fixtureJob(), { evidence_kind: 'fixture', observe: () => new Promise(() => {}) }, { pageTimeoutMs: 5, maxRuntimeMs: 20 });
  assert.equal(report.state, 'failed');
  assert.equal(report.coverage[0].reason, 'OBSERVATION_TIMEOUT');
  await assert.rejects(runAudit(fixtureJob({ prompt_version: 'unknown' }), clean), /UNSUPPORTED_VERSION/);
  await assert.rejects(runAudit(fixtureJob({ mode: 'live' }), clean), /FIXTURE_NOT_PROVIDER_PROOF/);
});
test('teaser only audits homepage; supported findings are capped without leaking hidden observations', async () => {
  const adapter = { evidence_kind: 'fixture', async observe({ url, viewport }) {
    return { url, viewport, facts: { issues: ['missing-title', 'missing-language', 'unnamed-control', 'horizontal-overflow'].map(rule => ({ rule, observation: rule, selector: 'html', priority: 2 })) } };
  } };
  const teaser = await runAudit(fixtureJob(), adapter, { auditMode: 'teaser' });
  assert.equal(teaser.findings.length, 3);
  assert.equal(teaser.observations.some(row => 'facts' in row), false);
  await assert.rejects(runAudit(fixtureJob({ scope: { ...fixtureJob().scope, pages: ['https://example.com/paid'] } }), adapter, { auditMode: 'teaser' }), /TEASER_HOMEPAGE_ONLY/);
  await assert.rejects(runAudit(fixtureJob({ scope: { ...fixtureJob().scope, pages: Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`) } }), adapter), /INVALID_SCOPE/);
});

test('free teaser rejects promotion of fixture provenance and excludes paid identity', async () => {
  const input = { site_url: 'https://example.com/', request_id: 'fixture-lead', mode: 'fixture',
    provenance: { source_url: 'https://example.com/', observed_at: '2026-10-24T17:00:00.000Z', evidence_level: 'fixture' } };
  const report = await runTeaser(input, clean);
  assert.deepEqual(report.findings, []);
  assert.equal('order_id' in report, false);
  assert.equal('quote_id' in report, false);
  await assert.rejects(runTeaser({ ...input, mode: 'live' }, clean), /INVALID_TEASER_PROVENANCE/);
  await assert.rejects(runTeaser({ ...input, provenance: { ...input.provenance, source_url: 'http://169.254.169.254/' } }, clean), /URL_NOT_PUBLIC/);
  await assert.rejects(runTeaser(input, clean, { maxObservations: 3 }), /INVALID_TEASER_LIMITS/);
});
