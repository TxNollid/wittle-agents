import { createHash } from 'node:crypto';
import { publicUrl } from './network.mjs';

export const PROMPT_VERSION = 'auditor-v1';
export const SERVICE_VERSION = 'website_audit_v1';
const fixes = {
  'missing-title': ['Visitors and assistive tools cannot identify this page from its document title.', 'Add a concise, descriptive title unique to this page.'],
  'missing-language': ['Assistive technology cannot infer the declared document language.', 'Declare the correct language on the html element.'],
  'missing-image-alt': ['Some image meaning may be unavailable to screen-reader users.', 'Describe informative images; use alt="" only for genuinely decorative images.'],
  'unnamed-control': ['Some controls may not expose a clear accessible name.', 'Review the cited controls and give each an associated label or accessible name.'],
  'horizontal-overflow': ['Content extends beyond the visible viewport and may require horizontal scrolling.', 'Inspect overflowing elements and make their width/layout responsive.'],
};
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function auditScope(job, auditMode = 'paid') {
  if (!job || !['paid', 'teaser'].includes(auditMode)) throw new Error('INVALID_AUDIT_MODE');
  for (const key of auditMode === 'teaser' ? ['job_id'] : ['job_id', 'order_id', 'attempt_id', 'room_id', 'buyer_id', 'quote_id', 'quote_hash']) {
    if (typeof job[key] !== 'string' || !job[key] || job[key].length > 200) throw new Error(`INVALID_${key}`);
  }
  if (!['fixture', 'sandbox', 'live'].includes(job.mode)) throw new Error('INVALID_EVIDENCE_MODE');
  if (job.service_version !== SERVICE_VERSION || job.prompt_version !== PROMPT_VERSION) throw new Error('UNSUPPORTED_VERSION');
  const scope = job.scope;
  if (!scope || !Array.isArray(scope.pages) || !scope.pages.length || scope.pages.length > 5 ||
      !Number.isInteger(scope.findings_cap) || scope.findings_cap < 1 || scope.findings_cap > 10 ||
      scope.revisions !== 1 || JSON.stringify(scope.viewports) !== '["desktop","mobile"]' ||
      JSON.stringify(scope.allowed_actions) !== '["browse_public_pages","write_audit_report","deliver_in_bound_room"]') throw new Error('INVALID_SCOPE');
  const site = publicUrl(scope.site_url);
  const pages = scope.pages.map(value => publicUrl(value).href);
  if (new Set(pages).size !== pages.length || pages.some(value => new URL(value).origin !== site.origin)) throw new Error('INVALID_PAGE_SCOPE');
  if (!Array.isArray(scope.excluded_pages) || scope.excluded_pages.some(value => pages.includes(publicUrl(value).href))) throw new Error('EXCLUDED_PAGE_IN_SCOPE');
  // A teaser never slices a paid report: it performs only a fresh homepage observation.
  if (auditMode === 'teaser' && (pages.length !== 1 || new URL(pages[0]).pathname !== '/' || new URL(pages[0]).search)) throw new Error('TEASER_HOMEPAGE_ONLY');
  return { pages, cap: Math.min(scope.findings_cap, auditMode === 'teaser' ? 3 : 10) };
}

export async function runAudit(job, adapter, {
  auditMode = 'paid', maxObservations = 10, maxRuntimeMs = 120_000, pageTimeoutMs = 20_000,
} = {}) {
  const { pages, cap } = auditScope(job, auditMode);
  if (!Number.isInteger(maxObservations) || maxObservations < 1 || maxObservations > 10 ||
      !Number.isFinite(maxRuntimeMs) || maxRuntimeMs < 1 || maxRuntimeMs > 120_000 ||
      !Number.isFinite(pageTimeoutMs) || pageTimeoutMs < 1 || pageTimeoutMs > 20_000) throw new Error('INVALID_LIMITS');
  if (!['fixture', 'public_browser'].includes(adapter.evidence_kind)) throw new Error('INVALID_ADAPTER_EVIDENCE');
  if (job.mode !== 'fixture' && adapter.evidence_kind === 'fixture') throw new Error('FIXTURE_NOT_PROVIDER_PROOF');
  const started = Date.now();
  const coverage = [];
  const findings = [];
  const observations = [];
  const limitations = new Set();
  let calls = 0;
  for (const url of pages) for (const viewport of ['desktop', 'mobile']) {
    const remaining = maxRuntimeMs - (Date.now() - started);
    if (calls >= maxObservations || remaining <= 0) {
      coverage.push({ url, viewport, state: 'not_observed', reason: calls >= maxObservations ? 'TOOL_LIMIT' : 'TIME_LIMIT' });
      continue;
    }
    calls++;
    const controller = new AbortController();
    let timer;
    try {
      const result = await Promise.race([
        adapter.observe({ url, viewport, signal: controller.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('OBSERVATION_TIMEOUT')); }, Math.min(pageTimeoutMs, remaining)); }),
      ]);
      if (result.url !== url || result.viewport !== viewport || !Array.isArray(result.facts?.issues)) throw new Error('OBSERVATION_BINDING_MISMATCH');
      const evidenceId = digest({ url, viewport, facts: result.facts });
      observations.push({ evidence_id: evidenceId, url, final_url: result.final_url || url, viewport,
        observed_at: result.observed_at, title: String(result.facts.title || '').slice(0, 200) });
      coverage.push({ url, viewport, state: 'observed', complete: result.complete !== false, evidence_id: evidenceId });
      for (const item of result.facts.issues) {
        if (!fixes[item.rule]) continue;
        const [impact, fix] = fixes[item.rule];
        findings.push({ url, viewport, rule: item.rule, priority: item.priority === 1 ? 1 : 2,
          evidence_id: evidenceId, selector: String(item.selector).slice(0, 240),
          observation: String(item.observation).slice(0, 1000), impact, fix });
      }
      for (const limitation of result.limitations || []) limitations.add(String(limitation).slice(0, 240));
    } catch (error) {
      coverage.push({ url, viewport, state: 'failed', reason: String(error.message).slice(0, 200) });
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  const observed = coverage.filter(item => item.state === 'observed').length;
  const report = {
    schema_version: 'wa-v2.1', ...Object.fromEntries(['order_id', 'job_id', 'attempt_id', 'room_id', 'buyer_id', 'quote_id', 'quote_hash', 'service_version', 'prompt_version', 'mode'].filter(key => job[key] !== undefined).map(key => [key, job[key]])),
    scope_hash: digest(job.scope), completed_at: new Date().toISOString(), audit_mode: auditMode, evidence_kind: adapter.evidence_kind,
    state: observed === coverage.length && coverage.every(item => item.complete) ? 'complete' : observed ? 'partial' : 'failed',
    coverage, findings: findings.sort((a, b) => a.priority - b.priority).slice(0, cap), observations,
    limitations: [...limitations], duration_ms: Date.now() - started, tool_calls: calls,
  };
  if (Buffer.byteLength(JSON.stringify(report)) > 64_000) throw new Error('OUTPUT_LIMIT');
  return { ...report, report_hash: digest(report) };
}

export async function runTeaser({ site_url, request_id, mode, provenance, prompt_version = PROMPT_VERSION }, adapter, limits = {}) {
  if (!provenance || !['fixture', 'local_execution', 'provider'].includes(provenance.evidence_level) ||
      typeof provenance.source_url !== 'string' || provenance.source_url.length > 2000 ||
      !Number.isFinite(Date.parse(provenance.observed_at)) ||
      mode !== 'fixture' && provenance.evidence_level === 'fixture') throw new Error('INVALID_TEASER_PROVENANCE');
  publicUrl(provenance.source_url);
  if (limits.maxObservations !== undefined && limits.maxObservations > 2) throw new Error('INVALID_TEASER_LIMITS');
  const report = await runAudit({
    job_id: request_id, mode, prompt_version, service_version: SERVICE_VERSION,
    scope: { site_url, pages: [site_url], excluded_pages: [], viewports: ['desktop', 'mobile'], findings_cap: 3, revisions: 1,
      allowed_actions: ['browse_public_pages', 'write_audit_report', 'deliver_in_bound_room'] },
  }, adapter, { maxObservations: 2, ...limits, auditMode: 'teaser' });
  const { report_hash: _hash, ...body } = report;
  const result = { ...body, provenance: { source_url: provenance.source_url, observed_at: provenance.observed_at, evidence_level: provenance.evidence_level } };
  return { ...result, report_hash: digest(result) };
}
