import { antiSlopLayout } from './study-core.mjs';

const params = new URLSearchParams(location.search);
const page = document.body.dataset.study;
const wave = params.get('wave') || 'v1';
const submissionId = params.get('teracSubmissionId') || params.get('submissionId') || '';
const taskId = params.get('taskId') || params.get('teracTaskId') || '';
const main = document.querySelector('main');
const form = document.querySelector('form');
const status = document.querySelector('#status');

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v; else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
};

function stop(message) {
  form.hidden = true;
  status.textContent = message;
  status.className = 'status error';
}

async function load(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load the study material. Please refresh.');
  return res.json();
}

function renderAntiSlop(data) {
  const pairs = new Map(data.pairs.map((p) => [p.id, p]));
  const layout = antiSlopLayout(data.pairs.map((p) => p.id), `${submissionId}:${wave}`);
  const list = form.querySelector('#items');
  layout.forEach((slot, i) => {
    const pair = pairs.get(slot.pair_id);
    const [a, b] = slot.rewrite_side === 'A' ? [pair.rewrite, pair.original] : [pair.original, pair.rewrite];
    const name = `choice-${i}`;
    list.append(el('fieldset', { class: 'item', 'data-pair': pair.id },
      el('legend', {}, `Pair ${i + 1} of ${layout.length} · written for ${pair.destination.replace('_', ' ')}`),
      el('div', { class: 'texts' },
        el('label', { class: 'text-card' }, el('input', { type: 'radio', name, value: 'A', required: '' }), el('span', { class: 'tag' }, 'Text A'), el('p', {}, a)),
        el('label', { class: 'text-card' }, el('input', { type: 'radio', name, value: 'B', required: '' }), el('span', { class: 'tag' }, 'Text B'), el('p', {}, b))),
      el('label', { class: 'why' }, 'Why? (optional, one line)', el('input', { type: 'text', name: `why-${i}`, maxlength: '300' }))));
  });
  form.querySelector('#closing').append(
    el('label', {}, 'What is one thing that made a text sound AI-written to you? (required)',
      el('textarea', { name: 'note', required: '', maxlength: '600', rows: '3' })));
  return () => ({
    study: 'anti-slop', wave, terac_submission_id: submissionId, terac_task_id: taskId,
    answers: layout.map((slot, i) => ({ pair_id: slot.pair_id, choice: form.elements[`choice-${i}`].value, why: form.elements[`why-${i}`].value })),
    note: form.elements.note.value,
  });
}

function renderGuide(data) {
  const r = data.request, p = data.plan;
  const list = form.querySelector('#items');
  list.append(el('section', { class: 'item' },
    el('h2', {}, 'The request'),
    el('p', {}, `${r.group}, ${p.date} (Sunday), ${p.start}–${p.end}, starting in ${r.start_area}. Budget about $${r.budget_usd} per person. Interests: ${r.interests}.`)));
  const stops = el('ol', { class: 'stops' });
  for (const s of p.stops) {
    stops.append(el('li', {},
      el('strong', {}, `${s.arrive}–${s.depart} · ${s.name}`),
      el('span', { class: 'muted' }, `${s.address} · about $${s.cost_usd} · ${s.transit_min_from_prev} min from previous stop`),
      el('p', {}, s.why),
      el('span', { class: 'muted' }, `Hours (from source): ${s.hours} · `, el('a', { href: s.source_url, target: '_blank', rel: 'noopener noreferrer' }, 'source'))));
  }
  list.append(el('section', { class: 'item' }, el('h2', {}, 'The plan the agent sent'), stops,
    el('ul', { class: 'notes' }, ...p.notes.map((n) => el('li', {}, n)))));
  const scale = el('div', { class: 'scale' });
  for (let n = 1; n <= 7; n++) scale.append(el('label', {}, el('input', { type: 'radio', name: 'would_go', value: String(n), required: '' }), String(n)));
  form.querySelector('#closing').append(
    el('fieldset', {}, el('legend', {}, 'If a friend sent you this plan, would you go? 1 = no way, 7 = definitely'), scale),
    el('label', {}, 'Is anything wrong, closed, outdated or a bad idea? Write "nothing" if not. (required)', el('textarea', { name: 'problems', required: '', maxlength: '800', rows: '3' })),
    el('label', {}, 'Which one stop would you swap, and for what? (optional)', el('input', { type: 'text', name: 'swap', maxlength: '300' })));
  return () => ({
    study: 'local-guide', wave, terac_submission_id: submissionId, terac_task_id: taskId,
    would_go: Number(form.elements.would_go.value), problems: form.elements.problems.value, swap: form.elements.swap.value,
  });
}

async function main_() {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(submissionId)) {
    stop('This page needs to be opened from your Terac task link. Please go back to Terac and use the task link.');
    return;
  }
  let collect;
  try {
    if (page === 'anti-slop') {
      const data = await load(`/data/anti-slop-${wave === 'v2' ? 'v2' : 'v1'}.json`);
      if (wave === 'v2' && data.ready !== true) { stop('This round is not open yet. Please check back from your Terac task.'); return; }
      collect = renderAntiSlop(data);
    } else {
      collect = renderGuide(await load('/data/local-guide-v1.json'));
    }
  } catch (e) { stop(e.message); return; }
  form.hidden = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    status.className = 'status';
    status.textContent = 'Saving…';
    try {
      const res = await fetch('/api/response', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(collect()) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.saved) throw new Error(body.error || 'Could not save');
      form.hidden = true;
      status.className = 'status done';
      status.textContent = `Saved. Thank you! Your confirmation code is ${body.confirmation}. You can return to Terac now.`;
    } catch (e) {
      button.disabled = false;
      status.className = 'status error';
      status.textContent = `Your answers were not saved (${e.message}). Please try again.`;
    }
  });
}

main_();
main.dataset.ready = 'true';
