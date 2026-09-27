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
  const missing = state.status === 'missing';
  $('dot').className = `dot ${state.status}`;
  $('status').textContent = state.status === 'connected' ? 'ready' : missing ? 'app not found' : state.status;
  $('enabled').checked = state.enabled;
  $('control').disabled = !state.enabled;
  $('pointer').checked = state.pointer;
  $('detail').textContent = state.status === 'connected' || missing ? '' : state.statusDetail;

  $('setup').hidden = !missing;
  $('main').hidden = missing;
  if (missing && !$('commands').childElementCount) renderInstallCommands($('commands'), state.os);
  const outdated = state.appOutdated;
  $('update').hidden = !outdated;
  if (outdated) {
    $('update').textContent = `The tabdriver app (${state.hostVersion}) is older than this extension ` +
      `(${state.extensionVersion}). Update it: ${updateHint(state.os)}.`;
  }

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

$('check').onclick = async () => {
  $('check').textContent = 'Checking…';
  await send({ type: 'check-app' });
  setTimeout(() => { $('check').textContent = 'Check again'; render(); }, 1000);
};

$('guide').onclick = () => {
  api.tabs.create({ url: api.runtime.getURL('setup.html') });
  window.close();
};

$('pointer').onchange = (e) => send({ type: 'set-pointer', enabled: e.target.checked });

$('enabled').onchange = async (e) => {
  await send({ type: 'set-enabled', enabled: e.target.checked });
  render();
};

api.runtime.onMessage.addListener((m) => { if (m.type === 'status-changed') render(); });
render();
send({ type: 'check-app' }); // opening the popup retries a missing app right away
