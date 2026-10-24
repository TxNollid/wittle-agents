// Founder review add-on: deadline and refund state for one paid add-on order.
// Pure state transitions; the controller persists records and calls Terac/Whop adapters.
//
// paid → queued (audit delivered, posted to the Terac founder opportunity)
//      → submitted (a founder submission is linked to this add-on)
//      → delivered (approved submission posted in the buyer's room)
// Any non-final state past the deadline → refund_due → refunded.
// A submission is only approved if it is linked to this add-on; never approve unsold work.

export const DEADLINE_HOURS = 48;
export const MIN_MARGIN = 2;
const FINAL = new Set(['delivered', 'refunded', 'cancelled']);

export function createAddOn({ addon_id, parent_order_id, room_id, price_minor, paid_at }) {
  for (const [k, v] of Object.entries({ addon_id, parent_order_id, room_id })) {
    if (typeof v !== 'string' || !v) throw new Error(`${k} is required`);
  }
  if (!Number.isInteger(price_minor) || price_minor <= 0) throw new Error('price_minor must be a positive integer');
  const paid = Date.parse(paid_at);
  if (Number.isNaN(paid)) throw new Error('paid_at must be a timestamp');
  return {
    addon_id, parent_order_id, room_id, price_minor,
    state: 'paid', paid_at: new Date(paid).toISOString(),
    deadline_at: new Date(paid + DEADLINE_HOURS * 3.6e6).toISOString(),
    submission_id: null, message_id: null, refund_id: null, history: [{ state: 'paid', at: new Date(paid).toISOString() }],
  };
}

function move(addOn, state, at, patch = {}) {
  return { ...addOn, ...patch, state, history: [...addOn.history, { state, at: new Date(at).toISOString() }] };
}

function requireState(addOn, ...states) {
  if (!states.includes(addOn.state)) throw new Error(`invalid transition from ${addOn.state}`);
}

function pastDeadline(addOn, at) { return Date.parse(at) >= Date.parse(addOn.deadline_at); }

export function queue(addOn, { audit_delivered, at }) {
  requireState(addOn, 'paid');
  if (!audit_delivered) throw new Error('audit must be delivered before founder review is queued');
  if (pastDeadline(addOn, at)) return move(addOn, 'refund_due', at);
  return move(addOn, 'queued', at);
}

export function linkSubmission(addOn, { submission_id, at }) {
  requireState(addOn, 'queued');
  if (typeof submission_id !== 'string' || !submission_id) throw new Error('submission_id is required');
  if (pastDeadline(addOn, at)) return move(addOn, 'refund_due', at);
  return move(addOn, 'submitted', at, { submission_id });
}

// Called after the controller has approved the linked submission in Terac and posted it in the room.
export function markDelivered(addOn, { submission_id, message_id, at }) {
  requireState(addOn, 'submitted');
  if (submission_id !== addOn.submission_id) throw new Error('submission is not linked to this add-on');
  if (typeof message_id !== 'string' || !message_id) throw new Error('message_id is required');
  return move(addOn, 'delivered', at, { message_id });
}

// Periodic sweep: anything unfinished past the deadline becomes refund_due.
export function sweep(addOn, { at }) {
  if (FINAL.has(addOn.state) || addOn.state === 'refund_due') return addOn;
  return pastDeadline(addOn, at) ? move(addOn, 'refund_due', at) : addOn;
}

export function markRefunded(addOn, { refund_id, at }) {
  requireState(addOn, 'refund_due');
  if (typeof refund_id !== 'string' || !refund_id) throw new Error('refund_id is required');
  return move(addOn, 'refunded', at, { refund_id });
}

export function cancel(addOn, { at }) {
  if (FINAL.has(addOn.state)) throw new Error(`cannot cancel ${addOn.state}`);
  return move(addOn, 'cancelled', at);
}

// May this submission be approved (which pays the founder)? Only one linked to a live add-on.
export function mayApprove(addOn, submission_id, at) {
  return addOn.state === 'submitted' && addOn.submission_id === submission_id && !pastDeadline(addOn, at);
}

// Sell only when price ≥ 2× Terac's priced per-review cost.
export function priceOk(price_minor, terac_cost_minor) {
  return Number.isInteger(price_minor) && Number.isInteger(terac_cost_minor) && terac_cost_minor > 0
    && price_minor >= MIN_MARGIN * terac_cost_minor;
}
