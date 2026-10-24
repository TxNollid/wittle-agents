const params = new URLSearchParams(location.search);
const order = params.get('order') || '';
const submissionId = params.get('teracSubmissionId') || params.get('submissionId') || '';
const taskId = params.get('taskId') || params.get('teracTaskId') || '';
const form = document.querySelector('form');
const status = document.querySelector('#status');

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
};
const fail = (message) => { form.hidden = true; status.className = 'status error'; status.textContent = message; };

async function start() {
  if (!/^[a-f0-9]{32}$/.test(order) || !/^[A-Za-z0-9_-]{1,80}$/.test(submissionId)) {
    fail('This page needs to be opened from your Terac task link. Please go back to Terac and use the task link.');
    return;
  }
  const res = await fetch(`/api/review?order=${order}`, { cache: 'no-store' });
  if (!res.ok) { fail('This review task is not available. Please return to Terac.'); return; }
  const task = await res.json();
  document.title = `${task.title} — Wittle Labs`;
  document.querySelector('#title').textContent = task.title;
  document.querySelector('#intro').textContent = task.intro;
  const material = document.querySelector('#material');
  material.append(el('h2', {}, task.material.heading));
  for (const s of task.material.sections) material.append(el('h3', {}, s.title), el('p', { class: 'body' }, s.body));
  const questions = document.querySelector('#questions');
  for (const q of task.questions) {
    if (q.type === 'scale') {
      const scale = el('div', { class: 'scale' });
      for (let n = 1; n <= 7; n++) scale.append(el('label', {}, el('input', { type: 'radio', name: q.id, value: String(n), required: '' }), String(n)));
      questions.append(el('fieldset', {}, el('legend', {}, q.label), scale));
    } else {
      questions.append(el('label', {}, q.label, el('textarea', { name: q.id, rows: '3', maxlength: String(q.max), ...(q.required ? { required: '' } : {}) })));
    }
  }
  form.hidden = false;
  status.textContent = '';
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const answers = {};
    for (const q of task.questions) answers[q.id] = form.elements[q.id].value;
    const button = form.querySelector('button');
    button.disabled = true;
    status.className = 'status';
    status.textContent = 'Saving…';
    try {
      const save = await fetch('/api/review', { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ order, terac_submission_id: submissionId, terac_task_id: taskId, answers }) });
      const body = await save.json().catch(() => ({}));
      if (!save.ok || !body.saved) throw new Error(body.error || 'could not save');
      form.hidden = true;
      status.className = 'status done';
      status.textContent = `Saved. Thank you! Your confirmation code is ${body.confirmation}. You can return to Terac now.`;
    } catch (e) {
      button.disabled = false;
      status.className = 'status error';
      status.textContent = `Your review was not saved (${e.message}). Please try again.`;
    }
  });
}
start().catch(() => fail('Something went wrong loading this task. Please refresh.'));
