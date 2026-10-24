import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewOrderRequest, teracDraft, mayLaunch, STUDIES_ORIGIN } from './terac-hire.mjs';
import { normalizeOrder, normalizeReview } from './studies-site/review-core.mjs';
import guide from './terac/local-guide-sample.json' with { type: 'json' };

test('each specialist turns a deliverable into a valid review order', () => {
  const cases = [
    ['anti_slop_v1', { rewrite: 'Plain text.', destination: 'linkedin' }, 'human_read'],
    ['local_guide_nyc_v1', { plan: guide.plan }, 'local_check'],
    ['website_audit_v1', { site_url: 'https://example.com', findings: [{ title: 'Missing title', observation: 'No <title>', fix: 'Add one', url: 'https://example.com/' }] }, 'founder_review'],
  ];
  for (const [id, deliverable, kind] of cases) {
    const order = normalizeOrder(reviewOrderRequest(id, 'order_123', deliverable));
    assert.equal(order.kind, kind);
    assert.ok(order.material.sections.length > 0);
    assert.ok(!JSON.stringify(order).includes('room'), 'no room ids in material');
  }
});

test('terac draft points at a review page and launch is gated', () => {
  const d = teracDraft('anti_slop_v1', `${STUDIES_ORIGIN}/review?order=${'a'.repeat(32)}&teracSubmissionId={submissionId}`);
  assert.equal(d.task_type, 'external_link');
  assert.equal(d.participants, 3);
  assert.throws(() => teracDraft('anti_slop_v1', 'https://evil.example/x'));
  // All human checks are off for sale until a real round trip is proven.
  assert.deepEqual(mayLaunch({ service_id: 'anti_slop_v1', order_paid: true, buyer_opted_in: true, priced_total_minor: 300 }),
    { ok: false, reason: 'human check not enabled for sale' });
});

test('review answers are validated per kind', () => {
  const ok = normalizeReview({ order: 'b'.repeat(32), terac_submission_id: 's1', answers: { human_score: 5, ai_lines: 'none' } }, 'human_read');
  assert.equal(ok.answers.human_score, 5);
  assert.throws(() => normalizeReview({ order: 'b'.repeat(32), terac_submission_id: 's1', answers: { human_score: 5 } }, 'human_read'), /ai_lines/);
  assert.throws(() => normalizeReview({ order: 'nope', terac_submission_id: 's1', answers: {} }, 'human_read'), /bad order/);
});
