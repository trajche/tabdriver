// Tab Driver background script (service worker in Chromium, event page in Firefox).
// Connects to the local native messaging host (com.tabdriver.host), which
// relays commands from AI agents (Claude, Codex, Cursor, ...) running on this
// machine, and executes them against tabs the user has allowed agents to control.

const api = globalThis.browser ?? globalThis.chrome;
const HOST_NAME = 'com.tabdriver.host';
const DEFAULTS = { enabled: true };

// ---------- state ----------
let port = null;
let status = 'disconnected'; // disconnected | connected | error | disabled
let statusDetail = '';
let agents = []; // names of agents currently connected through the host
const controlled = new Set(); // tab ids agents may act on
const tabAgent = new Map(); // tabId -> name of the agent that last acted on it
const agentTab = new Map(); // agent name -> its most recently used tab
let lastTabId = null;
const prompts = new Map(); // promptId -> { tabId, kind, title, message, resolve, timer }
let promptSeq = 0;
const chunks = new Map(); // cid -> { parts, total } for messages split by the host

const ready = (async () => {
  const s = await api.storage.session.get(['controlled', 'lastTabId']).catch(() => ({}));
  const open = new Set((await api.tabs.query({})).map((t) => t.id));
  for (const id of s.controlled || []) if (open.has(id)) controlled.add(id);
  lastTabId = open.has(s.lastTabId) ? s.lastTabId : null;
})();
ready.then(() => updateSidebarBadges());

function persist() {
  api.storage.session.set({ controlled: [...controlled], lastTabId }).catch(() => {});
  updateBadges();
  updateSidebarBadges();
}

// ---------- sidebar tab badges ----------
// Sidebar extensions that take tab badges get an "AI" badge on every controlled tab, so the
// user sees in their tab list which tabs agents drive. Arcsidebar (Firefox) is the one so far.
const BADGE_HOSTS = browserName() === 'firefox' ? ['arc@sidebar'] : [];
const badgesSent = new Map(); // host -> JSON of the badges it last accepted

function controlledBadges() {
  return [...controlled].map((tabId) => ({
    tabId,
    label: 'AI',
    title: `${tabAgent.get(tabId) || 'An AI agent'} is controlling this tab`,
  }));
}

// Send when the badges changed, or to hosts that missed them (not installed yet, restarted).
function updateSidebarBadges() {
  const badges = controlledBadges();
  const json = JSON.stringify(badges);
  for (const host of BADGE_HOSTS) {
    if (badgesSent.get(host) === json) continue;
    api.runtime.sendMessage(host, { type: 'arcsidebar:set-badges', badges })
      .then(() => badgesSent.set(host, json), () => badgesSent.delete(host));
  }
}

api.runtime.onMessageExternal.addListener((msg, sender) => {
  // A host restarted and lost its badges.
  if (msg?.type === 'arcsidebar:ready' && BADGE_HOSTS.includes(sender.id)) {
    badgesSent.delete(sender.id);
    ready.then(updateSidebarBadges);
  }
});

async function getSettings() {
  return { ...DEFAULTS, ...(await api.storage.local.get(Object.keys(DEFAULTS))) };
}

function setStatus(s, detail = '') {
  status = s;
  statusDetail = detail;
  updateBadges();
  notifyPopup();
}

function notifyPopup() {
  api.runtime.sendMessage({ type: 'status-changed' }).catch(() => {});
}

function updateBadges() {
  const active = status === 'connected' && agents.length > 0;
  api.action.setBadgeBackgroundColor({ color: active ? '#2e7d32' : '#9e9e9e' });
  api.action.setBadgeText({ text: status === 'connected' ? (controlled.size ? String(controlled.size) : active ? '✓' : '') : status === 'error' ? '!' : '' });
}

// ---------- native messaging connection ----------
function connect() {
  if (port) return;
  let p;
  try {
    p = api.runtime.connectNative(HOST_NAME);
  } catch (e) {
    setStatus('error', String(e.message || e));
    return;
  }
  port = p;
  const ua = navigator.userAgent;
  p.postMessage({
    type: 'hello',
    browser: { userAgent: ua, name: browserName(), extension: api.runtime.getManifest().version },
  });
  setStatus('connected');
  p.onMessage.addListener((msg) => onHostMessage(p, msg));
  p.onDisconnect.addListener(() => {
    const err = api.runtime.lastError?.message || p.error?.message || '';
    if (port === p) port = null;
    agents = [];
    chunks.clear();
    if (/not found|not installed|forbidden|no such native application/i.test(err)) {
      setStatus('error', 'Native host not installed. Run: tabdriver install, then reload the extension.');
    } else {
      setStatus('disconnected', err || 'Native host exited.');
    }
  });
}

function browserName() {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return 'firefox';
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand).join(' ') || '';
  if (/Edge/.test(brands)) return 'edge';
  if (/Brave/.test(brands)) return 'brave';
  if (/Google Chrome/.test(brands)) return 'chrome';
  return 'chromium';
}

function disconnect() {
  if (port) port.disconnect();
  port = null;
  agents = [];
}

async function onHostMessage(p, msg) {
  if (msg.type === 'chunk') {
    // Host -> extension messages are capped at 1 MB; large ones arrive in base64 chunks.
    const c = chunks.get(msg.cid) ?? { parts: [], total: msg.total };
    c.parts[msg.seq] = msg.data;
    chunks.set(msg.cid, c);
    if (c.parts.filter(Boolean).length < c.total) return;
    chunks.delete(msg.cid);
    const bytes = Uint8Array.from(atob(c.parts.join('')), (ch) => ch.charCodeAt(0));
    msg = JSON.parse(new TextDecoder().decode(bytes));
  }
  if (msg.type === 'agents') {
    agents = msg.agents || [];
    updateBadges();
    notifyPopup();
    return;
  }
  if (msg.id == null) return;
  const reply = (body) => { if (port === p) p.postMessage({ id: msg.id, ...body }); };
  try {
    await ready;
    reply({ result: await handle(msg.method, { ...msg.params, _agent: msg.agent || 'AI agent' }) });
  } catch (e) {
    reply({ error: String(e?.message || e) });
  }
}

// Reconnect periodically if the host went away; alarms also wake the service worker.
api.alarms.create('reconnect', { periodInMinutes: 0.5 });
api.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'reconnect') return;
  updateSidebarBadges();
  if ((await getSettings()).enabled && !port) connect();
});
getSettings().then((s) => (s.enabled ? connect() : setStatus('disabled')));

// ---------- tab helpers ----------
async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No active tab');
  return tab;
}

function targetTabId(params) {
  const id = params.tabId ?? agentTab.get(params._agent) ?? lastTabId;
  if (id == null) throw new Error('No controlled tab. Use open_tab or request_tab_access first.');
  return id;
}

function requireControlled(params) {
  const id = targetTabId(params);
  if (!controlled.has(id)) {
    throw new Error(`Tab ${id} is not controlled. Use request_tab_access to ask the user for it, or open_tab.`);
  }
  useTab(id, params._agent);
  return id;
}

// Remember which tab an agent last used, and label the in-page banner with its name.
function useTab(tabId, agent) {
  lastTabId = tabId;
  if (agent) {
    agentTab.set(agent, tabId);
    if (tabAgent.get(tabId) !== agent) {
      tabAgent.set(tabId, agent);
      page(tabId, 'setControlled', { on: true, agent }).catch(() => {});
    }
  }
  persist();
}

function tabSummary(t) {
  return {
    tabId: t.id, windowId: t.windowId, title: t.title, url: t.url, active: t.active, controlled: controlled.has(t.id), status: t.status,
    ...(t.hidden ? { hidden: true } : {}),
  };
}

// Open agent tabs from the user's current tab, in its container (Firefox). Sidebar tab
// managers such as Arcsidebar file a tab with an opener under the opener's space; a tab
// without one looks like a fresh Ctrl+T tab, which they may replace or close.
// The window is picked explicitly: Firefox fails to create a tab when the last focused
// window is not a normal browser window.
async function newTabProps(params) {
  const props = { url: params.url, active: params.active ?? true };
  const win = await api.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (!win || win.incognito) return props;
  props.windowId = win.id;
  const [opener] = await api.tabs.query({ windowId: win.id, active: true });
  if (opener) {
    props.openerTabId = opener.id;
    if (opener.cookieStoreId && opener.cookieStoreId !== 'firefox-default') props.cookieStoreId = opener.cookieStoreId;
  }
  return props;
}

function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let sawLoading = false;
    const done = () => { api.tabs.onUpdated.removeListener(listener); clearTimeout(t1); clearTimeout(t2); resolve(); };
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) done();
    };
    api.tabs.onUpdated.addListener(listener);
    // If no navigation actually started (e.g. same-page hash change), don't hang.
    const t1 = setTimeout(async () => {
      if (!sawLoading) {
        const t = await api.tabs.get(tabId).catch(() => null);
        if (!t || t.status === 'complete') done();
      }
    }, 1500);
    const t2 = setTimeout(done, timeoutMs);
  });
}

async function ensureAgent(tabId) {
  const [probe] = await api.scripting.executeScript({
    target: { tabId }, func: () => !!window.__tabdriver,
  }).catch((e) => { throw new Error(`Cannot access tab ${tabId}: ${e.message}`); });
  if (!probe?.result) {
    await api.scripting.executeScript({ target: { tabId }, files: ['page-agent.js'] });
  }
}

async function page(tabId, method, params) {
  await ensureAgent(tabId);
  const [res] = await api.scripting.executeScript({
    target: { tabId },
    func: (m, p) => window.__tabdriver.run(m, p),
    args: [method, params ?? {}],
  });
  const r = res?.result;
  if (!r) throw new Error('No result from page (it may have navigated). Take a new snapshot.');
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

async function markControlled(tabId, agent) {
  controlled.add(tabId);
  if (agent) { tabAgent.set(tabId, agent); agentTab.set(agent, tabId); }
  lastTabId = tabId;
  persist();
  await page(tabId, 'setControlled', { on: true, agent: tabAgent.get(tabId) }).catch(() => {});
}

async function release(tabId) {
  forgetTab(tabId);
  await detachDebugger(tabId);
  await page(tabId, 'setControlled', { on: false }).catch(() => {});
}

// Re-inject UI after navigations in controlled tabs; re-show pending prompts.
api.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  await ready;
  if (controlled.has(tabId)) await page(tabId, 'setControlled', { on: true, agent: tabAgent.get(tabId) }).catch(() => {});
  for (const [id, p] of prompts) {
    if (p.tabId === tabId) page(tabId, 'showPrompt', { id, kind: p.kind, title: p.title, message: p.message }).catch(() => {});
  }
});

function forgetTab(tabId) {
  controlled.delete(tabId);
  tabAgent.delete(tabId);
  for (const [agent, id] of agentTab) if (id === tabId) agentTab.delete(agent);
  if (lastTabId === tabId) lastTabId = null;
  persist();
}

api.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  debuggerTabs.delete(tabId);
  for (const [id, p] of prompts) if (p.tabId === tabId) finishPrompt(id, 'tab-closed');
});

// ---------- prompts (user handoff) ----------
function finishPrompt(id, answer) {
  const p = prompts.get(id);
  if (!p) return;
  prompts.delete(id);
  clearTimeout(p.timer);
  page(p.tabId, 'hidePrompt').catch(() => {});
  p.resolve(answer);
}

function askUser(tabId, { kind, title, message, timeoutMs }) {
  const id = String(++promptSeq);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finishPrompt(id, 'timeout'), timeoutMs);
    prompts.set(id, { tabId, kind, title, message, resolve, timer });
    api.tabs.update(tabId, { active: true }).catch(() => {});
    page(tabId, 'showPrompt', { id, kind, title, message }).catch(async (e) => {
      // Loading pages get the prompt re-shown on completion; restricted pages never will.
      const t = await api.tabs.get(tabId).catch(() => null);
      if (!t || t.status === 'complete') finishPrompt(id, `error: ${e.message}`);
    });
  });
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ready;
    const tabId = sender.tab?.id;
    switch (msg.type) {
      case 'prompt-answer':
        finishPrompt(msg.id, msg.answer);
        return true;
      case 'release-tab':
        if (tabId != null) await release(tabId);
        return true;
      // popup messages
      case 'get-state': {
        const s = await getSettings();
        const tabs = await api.tabs.query({});
        return {
          status, statusDetail, agents, enabled: s.enabled,
          controlled: tabs.filter((t) => controlled.has(t.id)).map((t) => ({ ...tabSummary(t), agent: tabAgent.get(t.id) })),
        };
      }
      case 'set-enabled':
        await api.storage.local.set({ enabled: msg.enabled });
        if (msg.enabled) connect();
        else { disconnect(); setStatus('disabled'); }
        return true;
      case 'control-active-tab': {
        const t = await activeTab();
        await markControlled(t.id);
        return tabSummary(t);
      }
      case 'release': await release(msg.tabId); return true;
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

// ---------- debugger (Chromium only; optional path) ----------
const debuggerTabs = new Map(); // tabId -> detach timer
async function withDebugger(tabId, fn) {
  if (!api.debugger) throw new Error('trusted input needs the Chromium debugger API, which this browser (Firefox) lacks. Retry without trusted.');
  const target = { tabId };
  if (!debuggerTabs.has(tabId)) {
    await api.debugger.attach(target, '1.3');
  }
  clearTimeout(debuggerTabs.get(tabId));
  // Stay attached briefly so consecutive calls don't flicker the "debugging" bar.
  debuggerTabs.set(tabId, setTimeout(() => detachDebugger(tabId), 15000));
  return fn((method, params) => api.debugger.sendCommand(target, method, params));
}

async function detachDebugger(tabId) {
  if (!debuggerTabs.has(tabId)) return;
  clearTimeout(debuggerTabs.get(tabId));
  debuggerTabs.delete(tabId);
  await api.debugger.detach({ tabId }).catch(() => {});
}
api.debugger?.onDetach.addListener(({ tabId }) => {
  clearTimeout(debuggerTabs.get(tabId));
  debuggerTabs.delete(tabId);
});

// ---------- command handlers ----------
async function handle(method, params) {
  switch (method) {
    case 'list_tabs': {
      const tabs = await api.tabs.query({});
      return tabs.filter((t) => params.all || t.active || controlled.has(t.id)).map(tabSummary);
    }

    case 'open_tab': {
      const props = await newTabProps(params);
      // With every window closed (macOS keeps the app running), a tab needs a new window.
      const tab = props.windowId != null || (await api.windows.getAll({ windowTypes: ['normal'] })).length
        ? await api.tabs.create(props)
        : (await api.windows.create({ url: params.url, focused: props.active })).tabs[0];
      controlled.add(tab.id);
      await waitForLoad(tab.id);
      await markControlled(tab.id, params._agent);
      return tabSummary(await api.tabs.get(tab.id));
    }

    case 'request_tab_access': {
      const tab = params.tabId != null ? await api.tabs.get(params.tabId) : await activeTab();
      if (controlled.has(tab.id)) { useTab(tab.id, params._agent); return { granted: true, tab: tabSummary(tab) }; }
      const answer = await askUser(tab.id, {
        kind: 'access',
        title: `${params._agent} wants to control this tab`,
        message: params.reason || `Allow ${params._agent} to read this page and click/type in it?`,
        timeoutMs: 5 * 60 * 1000 - 5000,
      });
      if (answer !== 'allow') return { granted: false, answer };
      await markControlled(tab.id, params._agent);
      return { granted: true, tab: tabSummary(await api.tabs.get(tab.id)) };
    }

    case 'release_tab': {
      const id = targetTabId(params);
      await release(id);
      return `Released tab ${id}`;
    }

    case 'close_tab': {
      const id = requireControlled(params);
      await api.tabs.remove(id);
      return `Closed tab ${id}`;
    }

    case 'navigate': {
      const id = requireControlled(params);
      const loaded = waitForLoad(id);
      if (params.url) await api.tabs.update(id, { url: params.url });
      else if (params.action === 'back') await api.tabs.goBack(id);
      else if (params.action === 'forward') await api.tabs.goForward(id);
      else if (params.action === 'reload') await api.tabs.reload(id);
      else throw new Error('Provide url or action');
      await loaded;
      return tabSummary(await api.tabs.get(id));
    }

    case 'snapshot': {
      const id = requireControlled(params);
      return `Tab ${id}\n` + await page(id, 'snapshot', params);
    }

    case 'click': {
      const id = requireControlled(params);
      if (!params.trusted) return await page(id, 'click', params);
      const { x, y } = await page(id, 'pointFor', params);
      await withDebugger(id, async (send) => {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
        }
      });
      return `Clicked ${params.ref} (trusted)`;
    }

    case 'type':
    case 'select_option':
    case 'press_key':
    case 'scroll':
    case 'wait_for':
    case 'get_text':
      return await page(requireControlled(params), method, params);

    case 'upload_file': {
      const id = requireControlled(params);
      const r = await page(id, method, params);
      return r?.mainWorldDrop ? await dropInMainWorld(id, r.mainWorldDrop, params.files) : r;
    }

    case 'screenshot': {
      const id = requireControlled(params);
      const tab = await api.tabs.get(id);
      await api.tabs.update(id, { active: true });
      await api.windows.update(tab.windowId, { focused: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
      return { mimeType: 'image/jpeg', data: dataUrl.split(',')[1] };
    }

    case 'evaluate': {
      const id = requireControlled(params);
      // Firefox has no debugger API, and add-on policy forbids running code from outside the add-on.
      if (!api.debugger) throw new Error('evaluate is not available in Firefox. Use snapshot, get_text, click and type.');
      const r = await withDebugger(id, (send) => send('Runtime.evaluate', {
        expression: params.expression, returnByValue: true, awaitPromise: true, userGesture: true,
      }));
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value === undefined ? `(${r.result.type})` : r.result.value;
    }

    case 'wait_for_user': {
      const id = requireControlled(params);
      const answer = await askUser(id, {
        kind: 'handoff',
        title: `${params._agent} needs you`,
        message: params.message,
        timeoutMs: (params.timeoutSec ?? 600) * 1000,
      });
      const tab = await api.tabs.get(id).catch(() => null);
      return { answer, tab: tab && tabSummary(tab) };
    }

    case 'list_downloads': {
      const items = await api.downloads.search({ orderBy: ['-startTime'], limit: params.limit ?? 10 });
      return items.map(downloadSummary);
    }

    case 'wait_for_download': {
      const since = params.sinceMs ?? Date.now() - 5000;
      const deadline = Date.now() + (params.timeoutMs ?? 60000);
      while (Date.now() < deadline) {
        const items = await api.downloads.search({ startedAfter: new Date(since).toISOString(), orderBy: ['-startTime'] });
        const done = items.find((d) => d.state === 'complete');
        if (done) return downloadSummary(done);
        const failed = items.find((d) => d.state === 'interrupted');
        if (failed) throw new Error(`Download interrupted: ${failed.error}`);
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('Timed out waiting for a download');
    }

    default:
      throw new Error(`Unknown method ${method}`);
  }
}

// Firefox only: build the files and drag events in the page's world so the page can read them.
async function dropInMainWorld(tabId, { token, x, y, message }, files) {
  const [res] = await api.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [token, x, y, files],
    func: (token, x, y, files) => {
      const el = document.querySelector(`[data-tabdriver-drop="${token}"]`);
      if (!el) return 'Drop target is gone. Take a new snapshot.';
      el.removeAttribute('data-tabdriver-drop');
      const dt = new DataTransfer();
      for (const f of files) {
        const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], f.name, { type: f.mime, lastModified: Date.now() }));
      }
      const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt };
      el.dispatchEvent(new DragEvent('dragenter', opts));
      el.dispatchEvent(new DragEvent('dragover', opts));
      el.dispatchEvent(new DragEvent('drop', opts));
      el.dispatchEvent(new DragEvent('dragleave', { ...opts, dataTransfer: null }));
      return null;
    },
  });
  if (res?.result) throw new Error(res.result);
  if (res?.error) throw new Error(res.error.message || String(res.error));
  return message;
}

function downloadSummary(d) {
  return { id: d.id, filename: d.filename, url: d.finalUrl || d.url, state: d.state, bytes: d.fileSize, mime: d.mime, startTime: d.startTime };
}
