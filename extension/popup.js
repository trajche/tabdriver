const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const send = (msg) => api.runtime.sendMessage(msg);

function item(text, title, button) {
  const li = document.createElement('li');
  const span = document.createElement('span');
  span.textContent = text;
  if (title) span.title = title;
  li.appendChild(span);
  if (button) li.appendChild(button);
  return li;
}

function list(ul, items, empty) {
  ul.textContent = '';
  if (!items.length) {
    const li = item(empty);
    li.firstChild.className = 'muted';
    ul.appendChild(li);
  }
  for (const li of items) ul.appendChild(li);
}

async function render() {
  const state = await send({ type: 'get-state' });
  if (!state || state.error) return;
  $('dot').className = `dot ${state.status}`;
  $('status').textContent = state.status === 'connected' ? 'ready' : state.status;
  $('enabled').checked = state.enabled;
  $('detail').textContent = state.status === 'connected' ? '' : state.statusDetail;

  list($('agents'), state.agents.map((a) => item(a)),
    state.status === 'connected' ? 'None: start an agent with the tabdriver MCP server' : '—');

  list($('tabs'), state.controlled.map((t) => {
    const b = document.createElement('button');
    b.textContent = 'Release';
    b.onclick = async () => { await send({ type: 'release', tabId: t.tabId }); render(); };
    return item(`${t.agent ? `[${t.agent}] ` : ''}${t.title || t.url}`, t.url, b);
  }), 'None');
}

$('control').onclick = async () => {
  const r = await send({ type: 'control-active-tab' });
  if (r?.error) $('detail').textContent = r.error;
  render();
};

$('enabled').onchange = async (e) => {
  await send({ type: 'set-enabled', enabled: e.target.checked });
  render();
};

api.runtime.onMessage.addListener((m) => { if (m.type === 'status-changed') render(); });
render();
