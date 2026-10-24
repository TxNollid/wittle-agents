const service = new URLSearchParams(location.search).get('service') || '';
const status = document.querySelector('#status');
const go = document.querySelector('#go');

// One request_id per browser tab and service, so retries and double clicks get the same room.
function requestId() {
  const key = `hire:${service}`;
  try {
    const saved = sessionStorage.getItem(key);
    if (saved) return saved;
    const id = crypto.randomUUID().replaceAll('-', '');
    sessionStorage.setItem(key, id);
    return id;
  } catch { return crypto.randomUUID().replaceAll('-', ''); }
}

async function start() {
  const info = await fetch(`/api/hire?service=${encodeURIComponent(service)}`).then((r) => r.json());
  if (!info.title) { status.className = 'status error'; status.textContent = 'Unknown agent. Go back to wittleagents.com and pick one.'; return; }
  document.querySelector('#title').textContent = `Hire the ${info.title}`;
  document.querySelector('#lede').textContent = `$${info.price_usd}. You'll get a private Wittle Rooms room with ${info.agent}. Scoping is free; you pay only after you agree the scope.`;
  go.hidden = false;
  go.addEventListener('click', async () => {
    go.disabled = true;
    status.className = 'status';
    status.textContent = 'Opening your room…';
    try {
      const res = await fetch('/api/hire', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service, request_id: requestId() }) });
      const body = await res.json();
      if (!res.ok || !body.join_url) throw new Error(body.error || 'could not open a room');
      location.assign(body.join_url);
    } catch (e) {
      go.disabled = false;
      status.className = 'status error';
      status.textContent = `${e.message}. Please try again.`;
    }
  });
}
start().catch(() => { status.className = 'status error'; status.textContent = 'Something went wrong. Please refresh.'; });
