const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const send = (msg) => api.runtime.sendMessage(msg);

const AGENTS = [
  { label: 'Claude Code', command: 'claude mcp add --scope user tabdriver -- tabdriver mcp' },
  { label: 'Codex', command: 'codex mcp add tabdriver -- tabdriver mcp' },
  { label: 'Other agents: run this for the exact config', command: 'tabdriver' },
];

$('guide').href = APP_GUIDE;
renderCommands($('agents'), AGENTS);

async function render() {
  const state = await send({ type: 'get-state' });
  if (!state || state.error) return;
  const connected = state.status === 'connected';
  const missing = state.status === 'missing';
  $('status').textContent = connected ? 'Installed' : missing ? 'Not found' : 'Checking…';
  $('status').className = `pill ${connected ? 'ok' : missing ? 'missing' : ''}`;
  $('install').hidden = connected;
  if (!$('commands').childElementCount) renderInstallCommands($('commands'), state.os);
  $('installed').hidden = !connected;
  $('installed').textContent = isOlderVersion(state.hostVersion, state.extensionVersion)
    ? `Connected, but the app (${state.hostVersion}) is older than the extension (${state.extensionVersion}). Update it: ${updateHint(state.os)}.`
    : `Connected${state.hostVersion ? ` to tabdriver ${state.hostVersion}` : ''}. You're set.`;
}

api.runtime.onMessage.addListener((m) => { if (m.type === 'status-changed') render(); });
// Keep trying while the app is missing, so the page turns green once it's installed.
setInterval(() => send({ type: 'check-app' }), 3000);
send({ type: 'check-app' });
render();
