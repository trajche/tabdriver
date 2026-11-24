// Tab Driver background script (service worker in Chromium, event page in Firefox).
// Connects to the local native messaging host (com.tabdriver.host), which
// relays commands from AI agents (Claude, Codex, Cursor, ...) running on this
// machine, and executes them against tabs the user has allowed agents to control.

const api = globalThis.browser ?? globalThis.chrome;
const HOST_NAME = 'com.tabdriver.host';
// pointer: show the agent's pointer in pages. background: never bring tabs or windows to the front.
const DEFAULTS = { enabled: true, pointer: true, background: true };
// Working in the background needs screenshots of tabs that aren't showing: Firefox only.
const CAN_BACKGROUND = typeof api.tabs.captureTab === 'function';

// ---------- state ----------
let port = null;
// connecting | connected | missing (the tabdriver app isn't installed or can't start)
// | disconnected (the app exited after connecting) | error | disabled
let status = 'disconnected';
let statusDetail = '';
let hostVersion = null; // version the app reported
let hostProtocol = 0; // protocol the app speaks (apps before 0.2.5 don't say: 1)
// Lowest app protocol this extension works with. Raise it together with common.Protocol when the
// extension starts relying on something new in the app; only then are users asked to update.
const MIN_APP_PROTOCOL = 1;
let agents = []; // names of agents currently connected through the host
const controlled = new Set(); // tab ids agents may act on
const tabAgent = new Map(); // tabId -> name of the agent that last acted on it
const agentTab = new Map(); // agent name -> its most recently used tab
let lastTabId = null;
const prompts = new Map(); // promptId -> { tabId, kind, title, message, resolve, timer }
let promptSeq = 0;
const chunks = new Map(); // cid -> { parts, total } for messages split by the host
const phones = new Map(); // tabId -> phone view of that tab (phone.js)
const pointerAt = new Map(); // tabId -> { x, y }: where the agent pointer last was, so it survives navigation
let pointerEnabled = DEFAULTS.pointer;
let background = DEFAULTS.background;
let enabled = DEFAULTS.enabled; // the popup's On switch

const ready = (async () => {
  const s = await api.storage.session.get(['controlled', 'lastTabId', 'phones']).catch(() => ({}));
  const open = new Set((await api.tabs.query({})).map((t) => t.id));
  for (const id of s.controlled || []) if (open.has(id)) controlled.add(id);
  lastTabId = open.has(s.lastTabId) ? s.lastTabId : null;
  for (const [id, p] of s.phones || []) if (open.has(id)) phones.set(id, p);
})();
ready.then(() => updateSidebarBadges());

// What a controlled tab shows: the "Agent is controlling this tab" pill and the agent pointer.
function controlParams(tabId) {
  return { on: true, agent: tabAgent.get(tabId), pointer: { enabled: pointerEnabled, ...pointerAt.get(tabId) } };
}

function persist() {
  api.storage.session.set({ controlled: [...controlled], lastTabId, phones: [...phones] }).catch(() => {});
  updateBadges();
  updateSidebarBadges();
}

// ---------- sidebar tab badges ----------
// Sidebar extensions that take tab badges get a robot icon on every controlled tab, so the
// user sees in their tab list which tabs agents drive. It blinks while the agent is working
// in the tab. Arcsidebar (Firefox) is the one so far; versions without icons show "AI".
const BADGE_HOSTS = browserName() === 'firefox' ? ['arc@sidebar'] : [];
const badgesSent = new Map(); // "host message-type" -> JSON the host last accepted
const ACTIVE_MS = 5000; // an agent counts as working in a tab this long after its last action
const lastActive = new Map(); // tabId -> when an agent last acted in it
let activeTimer = null;

function noteActivity(tabId) {
  lastActive.set(tabId, Date.now());
  if (currentVerb) setTabStatus(tabId, currentVerb);
  clearTimeout(activeTimer);
  activeTimer = setTimeout(() => { settleStatuses(); updateSidebarBadges(); }, ACTIVE_MS + 100); // stop the blinking
}

// ---------- what the agent is doing, in words ----------
// Sidebars that take status lines (Arcsidebar) show one under the tab's title: the verb for the
// command the agent is running now, or whatever the agent said with set_status. The line goes
// quiet once the agent stops (same 5 s as the blinking badge) and says "Done" when it lets go.
const tabStatus = new Map(); // tabId -> { text, busy, pinned }
const DONE_MS = 8000; // how long "Done" stays after an agent gives a tab back
const doneTimers = new Map(); // tabId -> timer that clears the finished line
let currentVerb = null; // the command being handled, for the tab it turns out to be about

// A verb per command, so the line reads like a person saying what they're up to.
const VERBS = {
  open_tab: 'Opening a tab',
  request_tab_access: 'Asking for this tab',
  navigate: 'Opening a page',
  emulate_device: 'Changing the view',
  snapshot: 'Reading the page',
  get_text: 'Reading the page',
  click: 'Clicking',
  type: 'Typing',
  hover: 'Hovering',
  select_option: 'Choosing an option',
  press_key: 'Pressing a key',
  scroll: 'Scrolling',
  wait_for: 'Waiting for the page',
  upload_file: 'Uploading a file',
  screenshot: 'Taking a screenshot',
  storyboard_frame: 'Taking a screenshot',
  evaluate: 'Running a script',
  network: 'Checking network traffic',
  network_request: 'Making a request',
  har_start: 'Recording network traffic',
  har_stop: 'Saving the network recording',
  console: 'Reading the console',
  errors: 'Reading page errors',
  list_downloads: 'Checking downloads',
  wait_for_download: 'Waiting for a download',
  wait_for_user: 'Waiting for you',
  close_tab: 'Closing the tab',
};

function verbFor(method, params) {
  if (method === 'navigate') {
    if (params?.action) return `Going ${params.action}`;
    try {
      return `Opening ${new URL(params.url).hostname.replace(/^www\./, '')}`;
    } catch {
      return VERBS.navigate;
    }
  }
  return VERBS[method] || null;
}

/**
 * Write the line for a tab. `pinned` is a line the agent wrote itself with set_status, which
 * says what it is up to ("Checking backlinks") rather than which command is running: it stays
 * until the agent replaces it or gives the tab back, and the per-command verbs step aside for
 * it (they still keep it blinking, since the agent is plainly still working).
 */
function setTabStatus(tabId, text, { busy = true, pinned = false } = {}) {
  const line = String(text || '').trim().slice(0, 64);
  if (!line) return clearTabStatus(tabId);
  const was = tabStatus.get(tabId);
  if (was?.pinned && !pinned) {
    if (was.busy === busy) return;
    tabStatus.set(tabId, { ...was, busy });
    updateSidebarBadges();
    return;
  }
  clearTimeout(doneTimers.get(tabId));
  doneTimers.delete(tabId);
  if (was?.text === line && was.busy === busy && was.pinned === pinned) return;
  tabStatus.set(tabId, { text: line, busy, pinned });
  updateSidebarBadges();
}

function clearTabStatus(tabId) {
  clearTimeout(doneTimers.get(tabId));
  doneTimers.delete(tabId);
  if (tabStatus.delete(tabId)) updateSidebarBadges();
}

/** The agent gave this tab back: say so, then let the line go. */
function finishTabStatus(tabId) {
  tabStatus.set(tabId, { text: 'Done', busy: false, pinned: false });
  clearTimeout(doneTimers.get(tabId));
  doneTimers.set(tabId, setTimeout(() => clearTabStatus(tabId), DONE_MS));
  updateSidebarBadges();
}

/** Nothing has happened for a while: keep the words, stop the blinking. */
function settleStatuses() {
  const now = Date.now();
  for (const [tabId, s] of tabStatus) {
    if (s.busy && now - (lastActive.get(tabId) || 0) >= ACTIVE_MS) tabStatus.set(tabId, { ...s, busy: false });
  }
}

function tabStatuses() {
  return [...tabStatus].map(([tabId, s]) => ({ tabId, text: s.text, busy: s.busy }));
}

function controlledBadges() {
  const now = Date.now();
  return [...controlled].map((tabId) => {
    const waiting = [...prompts.values()].find((p) => p.tabId === tabId);
    return {
      tabId,
      label: 'AI',
      icon: 'bot',
      position: 'start',
      pulse: !!waiting || now - (lastActive.get(tabId) || 0) < ACTIVE_MS,
      title: waiting?.title || `${tabAgent.get(tabId) || 'An AI agent'} is controlling this tab`,
    };
  });
}

// The sidebar's tab menu (right-click) gets a toggle: take a tab for agents, or give it back.
function tabMenu() {
  if (!enabled) return []; // switched off: no AI items in the sidebar's menu
  const ids = [...controlled];
  return [
    { id: 'control', title: 'Let AI agents control this tab', exceptTabIds: ids },
    { id: 'release', title: 'Stop AI control of this tab', tabIds: ids },
  ];
}

// Send when the badges or menu changed, or to hosts that missed them (not installed yet, restarted).
function updateSidebarBadges() {
  const messages = [
    { type: 'arcsidebar:set-badges', badges: controlledBadges() },
    { type: 'arcsidebar:set-tab-menu', items: tabMenu() },
    { type: 'arcsidebar:set-status', statuses: tabStatuses() },
  ];
  for (const host of BADGE_HOSTS) {
    for (const msg of messages) {
      const key = `${host} ${msg.type}`;
      const json = JSON.stringify(msg);
      if (badgesSent.get(key) === json) continue;
      api.runtime.sendMessage(host, msg).then(() => badgesSent.set(key, json), () => badgesSent.delete(key));
    }
  }
}

api.runtime.onMessageExternal.addListener((msg, sender) => {
  if (!BADGE_HOSTS.includes(sender.id)) return;
  // A host restarted and lost its badges and menu items.
  if (msg?.type === 'arcsidebar:ready') {
    for (const key of badgesSent.keys()) if (key.startsWith(`${sender.id} `)) badgesSent.delete(key);
    ready.then(updateSidebarBadges);
  }
  if (msg?.type === 'arcsidebar:menu-clicked' && Number.isInteger(msg.tabId)) {
    ready.then(async () => {
      if (msg.id === 'release') return release(msg.tabId);
      if (msg.id !== 'control' || !enabled) return;
      const tab = await api.tabs.get(msg.tabId).catch(() => null);
      if (tab && /^(https?|file):/.test(tab.url || '')) await markControlled(tab.id);
    });
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
  if (prompts.size) { // an agent waits for the user, maybe in a tab that isn't showing
    api.action.setBadgeBackgroundColor({ color: '#d97757' });
    api.action.setBadgeText({ text: '!' });
    return;
  }
  const active = status === 'connected' && agents.length > 0;
  api.action.setBadgeBackgroundColor({ color: active ? '#2e7d32' : '#9e9e9e' });
  api.action.setBadgeText({ text: status === 'connected' ? (controlled.size ? String(controlled.size) : active ? '✓' : '') : status === 'error' || status === 'missing' ? '!' : '' });
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
  // The app answers the hello right away, so it only counts as connected once it has spoken.
  let answered = false;
  setStatus('connecting');
  const ua = navigator.userAgent;
  p.postMessage({
    type: 'hello',
    browser: { userAgent: ua, name: browserName(), extension: api.runtime.getManifest().version },
  });
  p.onMessage.addListener((msg) => {
    if (!answered) {
      answered = true;
      setStatus('connected');
    }
    onHostMessage(p, msg);
  });
  p.onDisconnect.addListener(() => {
    const err = api.runtime.lastError?.message || p.error?.message || '';
    if (port === p) port = null;
    agents = [];
    chunks.clear();
    if (!answered) {
      // Not registered, the registered binary is gone, or it's registered for another
      // extension ID. The browsers word this differently; to the user it's the same fix.
      hostVersion = null;
      setStatus('missing', err);
    } else {
      setStatus('disconnected', err || 'The tabdriver app exited.');
      setTimeout(() => getSettings().then((st) => st.enabled && connect()), 2000);
    }
  });
}

// Right after install, open the setup page if the app isn't there yet.
api.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'install') return;
  setTimeout(() => {
    if (status === 'missing') api.tabs.create({ url: api.runtime.getURL('setup.html') });
  }, 2000);
});

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
  if (msg.type === 'host') {
    hostVersion = msg.version || null;
    hostProtocol = msg.protocol || 1;
    notifyPopup();
    return;
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
// Switched off: agents are disconnected and every AI tab is given back (no pill, pointer,
// sidebar badges or menu items), and recordings stop.
async function switchOff() {
  disconnect();
  setStatus('disabled');
  await ready;
  for (const id of [...controlled]) await release(id).catch(() => forgetTab(id));
  updateSidebarBadges();
}

getSettings().then((s) => {
  pointerEnabled = s.pointer;
  background = s.background;
  enabled = s.enabled;
  if (s.enabled) connect();
  else setStatus('disabled');
});

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
  noteActivity(tabId);
  if (agent) {
    agentTab.set(agent, tabId);
    if (tabAgent.get(tabId) !== agent) {
      tabAgent.set(tabId, agent);
      page(tabId, 'setControlled', controlParams(tabId)).catch(() => {});
    }
  }
  persist();
}

// Where a tab's page is: its top frame, or the phone frame in Firefox's phone view.
function pageTarget(tabId) {
  const phone = phones.get(tabId);
  return phone?.mode === 'frame' && phone.frameId != null ? { tabId, frameIds: [phone.frameId] } : { tabId };
}

async function tabSummary(t) {
  const phone = phones.get(t.id);
  let { title, url } = t;
  if (phone?.mode === 'frame') {
    url = await phoneUrl(t.id);
    title = await evalInFrame(t.id, () => document.title) ?? title;
  }
  return {
    tabId: t.id, windowId: t.windowId, title, url, active: t.active, controlled: controlled.has(t.id), status: t.status,
    ...(t.hidden ? { hidden: true } : {}),
    ...(phone ? { device: `${phone.spec.device} ${phone.spec.width}x${phone.spec.height}` } : {}),
  };
}

// Bring an agent's tab to the front, unless the user wants agents to stay in the background.
async function showTab(tabId, windowId) {
  if (CAN_BACKGROUND && background) return;
  await focusTab(tabId, windowId);
}

async function focusTab(tabId, windowId) {
  await api.tabs.update(tabId, { active: true });
  await api.windows.update(windowId, { focused: true }).catch(() => {});
}

// Open agent tabs from the user's current tab, in its container (Firefox). Sidebar tab
// managers such as Arcsidebar file a tab with an opener under the opener's space; a tab
// without one looks like a fresh Ctrl+T tab, which they may replace or close.
// The window is picked explicitly: Firefox fails to create a tab when the last focused
// window is not a normal browser window.
async function newTabProps(params) {
  const props = { url: params.url, active: CAN_BACKGROUND && background ? false : params.active ?? true };
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
  if (phones.get(tabId)?.mode === 'frame') return waitForFrameLoad(tabId, timeoutMs);
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
    target: pageTarget(tabId), func: () => !!window.__tabdriver,
  }).catch((e) => { throw new Error(`Cannot access tab ${tabId}: ${e.message}`); });
  if (!probe?.result) {
    await api.scripting.insertCSS({ target: pageTarget(tabId), css: 'tabdriver-ui[data-tabdriver-ui] { display: block !important; }' })
      .catch(() => {});
    await api.scripting.executeScript({ target: pageTarget(tabId), files: ['page-agent.js'] });
    // A new page: show the pill and pointer before the agent's first action on it.
    if (controlled.has(tabId)) {
      await api.scripting.executeScript({
        target: pageTarget(tabId), func: (p) => window.__tabdriver.run('setControlled', p), args: [controlParams(tabId)],
      }).catch(() => {});
    }
  }
}

async function page(tabId, method, params) {
  if (phones.get(tabId)?.mode !== 'frame') return runInPage(tabId, method, params);
  const started = Date.now();
  const r = await orNavigated(tabId, runInPage(tabId, method, params));
  if (r !== NAVIGATED) return r;
  if (method === 'wait_for') { // keep waiting in the new page
    const left = (params.timeoutMs ?? 15000) - (Date.now() - started);
    if (left > 0) return page(tabId, method, { ...params, timeoutMs: left });
  }
  throw new Error('No result from page (it may have navigated). Take a new snapshot.');
}

async function runInPage(tabId, method, params) {
  await ensureAgent(tabId);
  const [res] = await api.scripting.executeScript({
    target: pageTarget(tabId),
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
  injectRecorder(tabId);
  if (agent) { tabAgent.set(tabId, agent); agentTab.set(agent, tabId); noteActivity(tabId); }
  lastTabId = tabId;
  persist();
  await page(tabId, 'setControlled', controlParams(tabId)).catch(() => {});
}

async function release(tabId) {
  forgetTab(tabId);
  finishTabStatus(tabId);
  await page(tabId, 'setControlled', { on: false }).catch(() => {});
  await stopPhone(tabId).catch(() => {});
  await stopHar(tabId);
  await detachDebugger(tabId);
}

// Re-inject UI after navigations in controlled tabs; re-show pending prompts.
api.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === 'loading' && controlled.has(tabId)) injectRecorder(tabId);
  if (info.status !== 'complete') return;
  await pageLoaded(tabId);
});

async function pageLoaded(tabId) {
  await ready;
  if (controlled.has(tabId)) await page(tabId, 'setControlled', controlParams(tabId)).catch(() => {});
  for (const [id, p] of prompts) {
    if (p.tabId === tabId) page(tabId, 'showPrompt', { id, kind: p.kind, title: p.title, message: p.message }).catch(() => {});
  }
}

function forgetTab(tabId) {
  controlled.delete(tabId);
  clearTabStatus(tabId);
  tabAgent.delete(tabId);
  lastActive.delete(tabId);
  pointerAt.delete(tabId);
  for (const [agent, id] of agentTab) if (id === tabId) agentTab.delete(agent);
  if (lastTabId === tabId) lastTabId = null;
  persist();
}

api.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  forgetPhone(tabId);
  debuggerTabs.delete(tabId);
  for (const [id, p] of prompts) if (p.tabId === tabId) finishPrompt(id, 'tab-closed');
});

// ---------- prompts (user handoff) ----------
function finishPrompt(id, answer) {
  const p = prompts.get(id);
  if (!p) return;
  prompts.delete(id);
  clearTimeout(p.timer);
  promptsChanged();
  page(p.tabId, 'hidePrompt').catch(() => {});
  p.resolve(answer);
}

function promptsChanged() {
  updateBadges();
  updateSidebarBadges();
  notifyPopup();
}

function askUser(tabId, { kind, title, message, timeoutMs }) {
  const id = String(++promptSeq);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finishPrompt(id, 'timeout'), timeoutMs);
    prompts.set(id, { tabId, kind, title, message, resolve, timer });
    promptsChanged();
    if (!(CAN_BACKGROUND && background)) api.tabs.update(tabId, { active: true }).catch(() => {});
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
      case 'pointer-at':
        if (tabId != null && Number.isFinite(msg.x) && Number.isFinite(msg.y)) pointerAt.set(tabId, { x: msg.x, y: msg.y });
        return true;
      case 'set-pointer':
        pointerEnabled = !!msg.enabled;
        await api.storage.local.set({ pointer: pointerEnabled });
        for (const id of controlled) page(id, 'setControlled', controlParams(id)).catch(() => {});
        return true;
      case 'set-background':
        background = !!msg.enabled;
        await api.storage.local.set({ background });
        return true;
      case 'show-tab': { // the user's own click in the popup
        const t = await api.tabs.get(msg.tabId);
        await focusTab(t.id, t.windowId);
        return true;
      }
      case 'phone-start':
      case 'phone-loaded':
        return onPhoneMessage(msg, sender);
      case 'release-tab':
        if (tabId != null) await release(tabId);
        return true;
      // popup messages
      case 'get-state': {
        const s = await getSettings();
        const tabs = await api.tabs.query({});
        return {
          status, statusDetail, agents, enabled: s.enabled, pointer: s.pointer, hostVersion,
          background: CAN_BACKGROUND ? s.background : null, // null: this browser can't
          waiting: [...prompts.values()].map(({ tabId, title, message }) => ({ tabId, title, message })),
          appOutdated: status === 'connected' && hostProtocol > 0 && hostProtocol < MIN_APP_PROTOCOL,
          extensionVersion: api.runtime.getManifest().version,
          os: (await api.runtime.getPlatformInfo()).os,
          controlled: await Promise.all(tabs.filter((t) => controlled.has(t.id))
            .map(async (t) => ({ ...await tabSummary(t), agent: tabAgent.get(t.id) }))),
        };
      }
      // Popup / setup page: try the app again now instead of waiting for the next alarm.
      case 'check-app':
        if ((await getSettings()).enabled && !port) connect();
        return true;
      case 'set-enabled':
        await api.storage.local.set({ enabled: msg.enabled });
        enabled = !!msg.enabled;
        if (enabled) { connect(); updateSidebarBadges(); } else await switchOff();
        return true;
      case 'control-active-tab': {
        if (!enabled) throw new Error('Tab Driver is off. Turn it on first.');
        const t = await activeTab();
        await markControlled(t.id);
        return await tabSummary(t);
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
  // A HAR recording or phone view keeps the debugger attached; use that connection as it is.
  if (debuggerHeld(tabId)) return fn((method, params) => api.debugger.sendCommand(target, method, params));
  if (!debuggerTabs.has(tabId)) {
    await api.debugger.attach(target, '1.3');
  }
  clearTimeout(debuggerTabs.get(tabId));
  // Stay attached briefly so consecutive calls don't flicker the "debugging" bar.
  debuggerTabs.set(tabId, setTimeout(() => detachDebugger(tabId), 15000));
  return fn((method, params) => api.debugger.sendCommand(target, method, params));
}

// Features that keep the debugger attached until they end.
function debuggerHeld(tabId) {
  return !!(hars.get(tabId)?.ownsDebugger || phones.get(tabId)?.ownsDebugger);
}

async function holdDebugger(tabId) {
  if (debuggerHeld(tabId)) return;
  if (debuggerTabs.has(tabId)) { // attached for a trusted click or evaluate: take it over
    clearTimeout(debuggerTabs.get(tabId));
    debuggerTabs.delete(tabId);
  } else {
    await api.debugger.attach({ tabId }, '1.3');
  }
}

async function dropDebugger(tabId) { // after the feature's own hold is gone
  if (!debuggerHeld(tabId)) await api.debugger.detach({ tabId }).catch(() => {});
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
  const rec = hars.get(tabId); // the user dismissed Chrome's "being debugged" bar
  if (rec) rec.ownsDebugger = false;
  forgetPhone(tabId); // emulation ends with the debugger
});

// ---------- command handlers ----------
// The verb for this command is picked before it runs; whichever tab it turns out to be about
// picks it up in noteActivity(), since only the handlers know which tab that is.
async function handle(method, params) {
  currentVerb = verbFor(method, params);
  try {
    return await runCommand(method, params);
  } finally {
    currentVerb = null;
  }
}

async function runCommand(method, params) {
  switch (method) {
    case 'list_tabs': {
      const tabs = await api.tabs.query({});
      return Promise.all(tabs.filter((t) => params.all || t.active || controlled.has(t.id)).map(tabSummary));
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
      if (controlled.has(tab.id)) { useTab(tab.id, params._agent); return { granted: true, tab: await tabSummary(tab) }; }
      const answer = await askUser(tab.id, {
        kind: 'access',
        title: `${params._agent} wants to control this tab`,
        message: params.reason || `Allow ${params._agent} to read this page and click/type in it?`,
        timeoutMs: 5 * 60 * 1000 - 5000,
      });
      if (answer !== 'allow') return { granted: false, answer };
      await markControlled(tab.id, params._agent);
      return { granted: true, tab: await tabSummary(await api.tabs.get(tab.id)) };
    }

    case 'set_status': {
      const id = requireControlled(params);
      if (params.text) setTabStatus(id, params.text, { pinned: true });
      else clearTabStatus(id);
      return params.text ? `Tab ${id}: ${tabStatus.get(id)?.text}` : `Cleared the status of tab ${id}`;
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
      if (phones.get(id)?.mode === 'frame') await navigateFrame(id, params);
      else if (params.url) await api.tabs.update(id, { url: params.url });
      else if (params.action === 'back') await api.tabs.goBack(id);
      else if (params.action === 'forward') await api.tabs.goForward(id);
      else if (params.action === 'reload') await api.tabs.reload(id);
      else throw new Error('Provide url or action');
      const failed = await loaded;
      if (failed) throw new Error(`The page did not load: ${failed}`);
      return tabSummary(await api.tabs.get(id));
    }

    case 'emulate_device':
      return await emulateDevice(requireControlled(params), params);

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
    case 'hover':
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
      await showTab(id, tab.windowId);
      const labels = params.annotate ? await page(id, 'annotate', { on: true }) : 0;
      await new Promise((r) => setTimeout(r, 300));
      const png = params.format === 'png';
      try {
        const dataUrl = await capture(tab, png ? { format: 'png' } : { format: 'jpeg', quality: 70 });
        return { mimeType: png ? 'image/png' : 'image/jpeg', data: dataUrl.split(',')[1], labels };
      } finally {
        if (params.annotate) await page(id, 'annotate', { on: false }).catch(() => {});
      }
    }

    // A recording frame: the tab with a marker showing the next action (or the page that loaded).
    case 'storyboard_frame': {
      const id = requireControlled(params);
      const tab = await api.tabs.get(id);
      await showTab(id, tab.windowId);
      const info = await page(id, 'markAction', params.mark);
      await new Promise((r) => setTimeout(r, 150));
      try {
        const dataUrl = await capture(tab, { format: 'jpeg', quality: 80 });
        return { mimeType: 'image/jpeg', data: dataUrl.split(',')[1], ...info };
      } finally {
        await page(id, 'clearMark').catch(() => {});
      }
    }

    case 'network':
      return networkList(requireControlled(params), params);
    case 'network_request':
      requireControlled(params);
      return networkRequest(params.id, params);
    case 'har_start':
      return await startHar(requireControlled(params), params);
    case 'har_stop':
      return await finishHar(requireControlled(params));

    case 'console':
    case 'errors': {
      const id = requireControlled(params);
      const log = await readPageLog(id, params.clear);
      if (!log) {
        await injectRecorder(id);
        return 'Nothing recorded on this page yet. Recording starts now; reload the page to catch errors while it loads.';
      }
      const wanted = method === 'errors'
        ? log.filter((e) => e.level === 'error')
        : log.filter((e) => e.type === 'console' && (!params.level || params.level === 'all' || e.level === params.level));
      const lines = wanted.map((e) => `+${(e.at / 1000).toFixed(1)}s [${e.type === 'console' ? e.level : e.type}] ${e.text}` +
        (e.source ? `  (${e.source})` : ''));
      const what = method === 'errors' ? 'errors' : 'console messages';
      return lines.length ? lines.join('\n') : `No ${what} since this page loaded.`;
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
      return { answer, tab: tab && await tabSummary(tab) };
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

// Firefox captures any tab, showing or not. Chromium captures the one in front, at most twice
// per second, so space those out.
let lastCapture = 0;
async function capture(tab, options) {
  const phone = phones.get(tab.id);
  if (phone?.mode === 'debugger') { // the emulated screen, which can be taller than the window
    const shot = await withDebugger(tab.id, (send) => send('Page.captureScreenshot', options));
    return `data:image/${options.format};base64,${shot.data}`;
  }
  if (phone) return api.tabs.captureTab(tab.id, { ...options, rect: { x: 0, y: 0, width: phone.spec.width, height: phone.spec.height } });
  if (CAN_BACKGROUND) return api.tabs.captureTab(tab.id, options);
  const wait = lastCapture + 550 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCapture = Date.now();
  return api.tabs.captureVisibleTab(tab.windowId, options);
}

// ---------- page console and errors ----------
// Console output and errors are only visible from the page's own JS world. In controlled tabs
// a small recorder goes in as each page starts loading and keeps its last 300 entries: console
// calls, uncaught errors, unhandled rejections, resources that failed to load, HTTP errors.
function installRecorder() {
  const key = Symbol.for('tabdriver.log');
  if (window[key]) return;
  const log = (window[key] = []);
  const t0 = performance.timeOrigin;
  const str = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) {
      // Chromium's stack starts with "Name: message"; Firefox's is only the frames.
      const head = `${v.name}: ${v.message}`;
      return v.stack?.startsWith(head) ? v.stack : `${head}${v.stack ? `\n${v.stack}` : ''}`;
    }
    try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
  };
  const push = (e) => {
    log.push({ at: Date.now() - t0, ...e, text: String(e.text).slice(0, 800) });
    if (log.length > 300) log.shift();
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level];
    console[level] = function (...args) {
      push({ type: 'console', level: level === 'log' || level === 'debug' ? 'info' : level, text: args.map(str).join(' ') });
      return orig.apply(this, args);
    };
  }
  addEventListener('error', (e) => {
    const el = e.target;
    if (el && el !== window && el.tagName) {
      push({ type: 'resource', level: 'error', text: `Failed to load <${el.tagName.toLowerCase()}> ${el.currentSrc || el.src || el.href || ''}` });
    } else {
      push({ type: 'exception', level: 'error', text: e.error ? str(e.error) : e.message, source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '' });
    }
  }, true);
  addEventListener('unhandledrejection', (e) => push({ type: 'exception', level: 'error', text: `Unhandled rejection: ${str(e.reason)}` }));
  try {
    const seen = new Set(); // Firefox can deliver a buffered entry twice
    new PerformanceObserver((list) => {
      for (const r of list.getEntries()) {
        const id = `${r.name} ${r.startTime}`;
        if (!(r.responseStatus >= 400) || seen.has(id)) continue;
        seen.add(id);
        push({ type: 'network', level: 'error', text: `HTTP ${r.responseStatus} ${r.name}` });
      }
    }).observe({ type: 'resource', buffered: true });
  } catch {}
}

function injectRecorder(tabId) {
  return api.scripting.executeScript({ target: pageTarget(tabId), world: 'MAIN', injectImmediately: true, func: installRecorder })
    .catch(() => {});
}

async function readPageLog(tabId, clear) {
  const [res] = await api.scripting.executeScript({
    target: pageTarget(tabId), world: 'MAIN', args: [!!clear],
    func: (clear) => {
      const log = window[Symbol.for('tabdriver.log')];
      if (!log) return null;
      const out = log.slice();
      if (clear) log.length = 0;
      return out;
    },
  });
  return res?.result ?? null;
}

// Firefox only: build the files and drag events in the page's world so the page can read them.
async function dropInMainWorld(tabId, { token, x, y, message }, files) {
  const [res] = await api.scripting.executeScript({
    target: pageTarget(tabId),
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

// Network log and HAR recording (network.js), phone view (phone.js). Firefox loads them from the manifest instead.
if (typeof importScripts === 'function') importScripts('network.js', 'phone.js');
