// Phone view (emulate_device), loaded after background.js (same global scope).
//
// - Chromium: the debugger's device emulation, the same thing DevTools' device toolbar uses.
// - Firefox has no API for its Responsive Design Mode, and extensions can't open a narrow window
//   without taking focus. So the tab shows phone.html, an extension page with the site in a
//   phone-sized iframe. It works in hidden tabs. Firefox treats frames of an extension that has
//   access to the site as first-party, so logins and storage are those of a normal tab.
//   - Sites that forbid framing: X-Frame-Options is dropped in phone tabs only. A CSP can't be
//     edited, so it is dropped only for hosts whose CSP has frame-ancestors, and the agent is told.
//   - The mobile user agent is set with declarativeNetRequest (headers) and phone-main.js (JS).

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
const DEVICES = {
  'iphone': { width: 390, height: 844, dpr: 3, ua: IPHONE_UA, platform: 'iPhone' },
  'iphone-se': { width: 375, height: 667, dpr: 2, ua: IPHONE_UA, platform: 'iPhone' },
  'iphone-max': { width: 430, height: 932, dpr: 3, ua: IPHONE_UA, platform: 'iPhone' },
  'pixel': { width: 412, height: 915, dpr: 2.625, ua: ANDROID_UA, platform: 'Linux armv81' },
  'ipad': { width: 820, height: 1180, dpr: 2, ua: IPAD_UA, platform: 'iPad' },
};
const PHONE_SHELL = api.runtime.getURL('phone.html');
const PHONE_NAME = 'tabdriver-phone:'; // the iframe's window.name: this and the device as JSON
const isWebUrl = (u) => /^https?:\/\//i.test(u || '');

function deviceSpec({ device = 'iphone', width, height, landscape, keepUserAgent }) {
  const preset = DEVICES[device];
  if (!preset) throw new Error(`Unknown device "${device}". Use ${Object.keys(DEVICES).join(', ')} or off.`);
  let w = width ?? preset.width, h = height ?? preset.height;
  for (const n of [w, h]) if (!Number.isInteger(n) || n < 200 || n > 3000) throw new Error('width and height must be between 200 and 3000.');
  if (landscape && w < h) [w, h] = [h, w];
  return { ...preset, device, width: w, height: h, ua: keepUserAgent ? null : preset.ua, platform: keepUserAgent ? null : preset.platform };
}

async function emulateDevice(tabId, params) {
  if (params.device === 'off') {
    if (!phones.has(tabId)) return `Tab ${tabId} is not in phone view.`;
    await stopPhone(tabId);
    return { device: 'off', tab: await tabSummary(await api.tabs.get(tabId)) };
  }
  const spec = deviceSpec(params);
  if (api.debugger) await startDebuggerPhone(tabId, spec);
  else await startFramePhone(tabId, spec);
  const [res] = await api.scripting.executeScript({
    target: pageTarget(tabId),
    func: () => ({ w: innerWidth, h: innerHeight, meta: !!document.querySelector('meta[name=viewport]') }),
  }).catch(() => []);
  const notes = [];
  const phone = phones.get(tabId);
  if (phone?.mode === 'frame') {
    if (res?.result && !res.result.meta) notes.push('The page has no viewport meta tag: a real phone would lay it out about 980 px wide and zoom out.');
    if (phone.cspHosts.length) notes.push(`Content-Security-Policy is off in this tab for ${phone.cspHosts.join(', ')}, which forbid(s) framing.`);
  }
  return {
    device: spec.device,
    viewport: res?.result ? `${res.result.w}x${res.result.h}` : `${spec.width}x${spec.height}`,
    mobileUserAgent: !!spec.ua,
    ...(notes.length ? { notes } : {}),
    tab: await tabSummary(await api.tabs.get(tabId)),
  };
}

async function stopPhone(tabId) {
  const phone = phones.get(tabId);
  if (!phone) return;
  if (phone.mode === 'debugger') {
    if (phone.ownsDebugger) {
      const send = (method, params) => api.debugger.sendCommand({ tabId }, method, params).catch(() => {});
      await send('Emulation.clearDeviceMetricsOverride');
      await send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await send('Emulation.setUserAgentOverride', { userAgent: '' });
    }
    forgetPhone(tabId);
    await dropDebugger(tabId);
    return;
  }
  const url = await phoneUrl(tabId);
  forgetPhone(tabId); // first, so leaving the shell isn't taken for the user navigating away
  await syncPhone();
  if (!isWebUrl(url)) return;
  const loaded = waitForLoad(tabId);
  await api.tabs.update(tabId, { url, loadReplace: true });
  await loaded;
}

function forgetPhone(tabId) {
  if (!phones.delete(tabId)) return;
  persist();
  if (!api.debugger) syncPhone();
}

// ---------- Chromium ----------
async function startDebuggerPhone(tabId, spec) {
  await holdDebugger(tabId);
  phones.set(tabId, { mode: 'debugger', spec, ownsDebugger: true });
  persist();
  const send = (method, params) => api.debugger.sendCommand({ tabId }, method, params);
  try {
    await send('Emulation.setDeviceMetricsOverride', {
      width: spec.width, height: spec.height, deviceScaleFactor: spec.dpr, mobile: true,
      screenWidth: spec.width, screenHeight: spec.height,
      screenOrientation: spec.width > spec.height ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
    });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setUserAgentOverride', spec.ua ? { userAgent: spec.ua, platform: spec.platform } : { userAgent: '' });
  } catch (e) {
    await stopPhone(tabId);
    throw e;
  }
  const loaded = waitForLoad(tabId); // reload, so the server sees the phone's user agent
  await api.tabs.reload(tabId);
  await loaded;
}

// ---------- Firefox ----------
async function startFramePhone(tabId, spec) {
  const before = phones.get(tabId);
  const url = before ? await phoneUrl(tabId) : (await api.tabs.get(tabId)).url;
  if (!isWebUrl(url)) throw new Error('Phone view needs an http(s) page. Navigate to one first.');
  phones.set(tabId, { mode: 'frame', spec, url, frameId: null, shown: !!before, cspHosts: before?.cspHosts ?? [] });
  persist();
  try {
    await syncPhone();
    const q = new URLSearchParams({
      tab: tabId, w: spec.width, h: spec.height, url,
      name: PHONE_NAME + JSON.stringify({ w: spec.width, h: spec.height, dpr: spec.dpr, ua: spec.ua, platform: spec.platform }),
    });
    const loaded = waitForFrameLoad(tabId);
    await api.tabs.update(tabId, { url: `${PHONE_SHELL}?${q}`, loadReplace: true });
    const failed = await loaded;
    if (failed || phones.get(tabId)?.frameId == null) throw new Error(`The page did not load in phone view${failed ? ` (${failed})` : ''}.`);
  } catch (e) {
    await stopPhone(tabId).catch(() => {});
    throw e;
  }
}

// The page's address inside the phone frame (the tab's own address is phone.html).
async function phoneUrl(tabId) {
  const phone = phones.get(tabId);
  if (phone?.frameId != null) {
    const url = await evalInFrame(tabId, () => location.href);
    if (isWebUrl(url)) phone.url = url;
  }
  return phone?.url;
}

async function navigateFrame(tabId, { url, action }) {
  if (action === 'back' || action === 'forward') {
    await evalInFrame(tabId, (a) => history[a](), [action]);
    return;
  }
  const to = url ?? (action === 'reload' ? await phoneUrl(tabId) : null);
  if (!to) throw new Error('Provide url or action');
  if (!isWebUrl(to)) throw new Error('Phone view opens http(s) pages only. Turn it off first (emulate_device device=off).');
  await api.runtime.sendMessage({ type: 'phone-go', tabId, url: to });
}

// Firefox never settles a script call whose frame navigates away, so calls into the phone frame
// also end when a new page starts there.
const NAVIGATED = Symbol('navigated');
const frameStarts = new Set(); // { tabId, resolve }
async function orNavigated(tabId, promise, timeoutMs = 0) {
  let entry, timer;
  const navigated = new Promise((resolve) => {
    entry = { tabId, resolve };
    frameStarts.add(entry);
    if (timeoutMs) timer = setTimeout(resolve, timeoutMs, NAVIGATED);
  });
  try {
    return await Promise.race([promise, navigated]);
  } finally {
    frameStarts.delete(entry);
    clearTimeout(timer);
  }
}

// A quick look into the phone frame; undefined when the page can't answer right now.
async function evalInFrame(tabId, func, args = []) {
  const r = await orNavigated(tabId, api.scripting.executeScript({ target: pageTarget(tabId), func, args }).catch(() => null), 3000);
  return r === NAVIGATED ? undefined : r?.[0]?.result;
}

const frameWaiters = new Set(); // { tabId, started, done }
// Resolves when the phone frame has loaded, with the error if its request failed.
function waitForFrameLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const w = { tabId, started: false, done: (error) => { frameWaiters.delete(w); clearTimeout(t1); clearTimeout(t2); resolve(error); } };
    frameWaiters.add(w);
    const t1 = setTimeout(() => { if (!w.started) w.done(); }, 2500); // nothing loads (e.g. a #hash change)
    const t2 = setTimeout(() => w.done(), timeoutMs);
  });
}

// Messages from phone.html (loaded) and from the document in its frame (start).
function onPhoneMessage(msg, sender) {
  const tabId = sender.tab?.id;
  const phone = phones.get(tabId);
  if (phone?.mode !== 'frame') return false;
  if (msg.type === 'phone-start' && sender.frameId) {
    phone.frameId = sender.frameId;
    if (isWebUrl(sender.url)) phone.url = sender.url;
    persist();
    for (const s of [...frameStarts]) if (s.tabId === tabId) s.resolve(NAVIGATED);
    // Phones draw scrollbars over the page; a desktop one would make it narrower.
    api.scripting.insertCSS({ target: pageTarget(tabId), css: ':root { scrollbar-width: none !important; }' }).catch(() => {});
    if (controlled.has(tabId)) injectRecorder(tabId);
  } else if (msg.type === 'phone-loaded' && sender.url?.startsWith(PHONE_SHELL)) {
    // Only loads of a request count: the frame's initial blank page can report one too.
    for (const w of [...frameWaiters]) if (w.tabId === tabId && w.started) w.done();
    if (phone.frameId != null) pageLoaded(tabId);
  }
  return true;
}

// Header rules and content scripts for the tabs in phone view right now.
let phoneSync = Promise.resolve();
function syncPhone() {
  phoneSync = phoneSync.catch(() => {}).then(async () => {
    const frames = [...phones].filter(([, p]) => p.mode === 'frame');
    const rules = [];
    const add = (condition, action) => rules.push({ id: rules.length + 1, condition, action: { type: 'modifyHeaders', ...action } });
    for (const [tabId, p] of frames) {
      if (p.spec.ua) {
        add({ tabIds: [tabId], resourceTypes: ['sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'] },
          { requestHeaders: [{ header: 'user-agent', operation: 'set', value: p.spec.ua }] });
      }
      add({ tabIds: [tabId], resourceTypes: ['sub_frame'] }, { responseHeaders: [{ header: 'x-frame-options', operation: 'remove' }] });
      if (p.cspHosts.length) {
        add({ tabIds: [tabId], resourceTypes: ['sub_frame'], requestDomains: p.cspHosts },
          { responseHeaders: [{ header: 'content-security-policy', operation: 'remove' }] });
      }
    }
    const old = await api.declarativeNetRequest.getSessionRules();
    await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: old.map((r) => r.id), addRules: rules });
    const ids = ['phone-main', 'phone-start'];
    const registered = (await api.scripting.getRegisteredContentScripts({ ids })).length > 0;
    if (frames.length && !registered) {
      const common = { matches: ['<all_urls>'], allFrames: true, runAt: 'document_start', persistAcrossSessions: false };
      await api.scripting.registerContentScripts([
        { id: 'phone-main', js: ['phone-main.js'], world: 'MAIN', ...common },
        { id: 'phone-start', js: ['phone-start.js'], ...common },
      ]);
    } else if (!frames.length && registered) {
      await api.scripting.unregisterContentScripts({ ids });
    }
  });
  return phoneSync;
}

if (!api.debugger) {
  ready.then(syncPhone).catch(() => {}); // clears rules left by an earlier run of this script
  api.webRequest.onBeforeRequest.addListener((d) => {
    if (d.parentFrameId === 0) for (const w of frameWaiters) if (w.tabId === d.tabId) w.started = true;
  }, { urls: ['<all_urls>'], types: ['sub_frame'] });
  api.webRequest.onErrorOccurred.addListener((d) => {
    if (d.parentFrameId !== 0 || d.error === 'NS_BINDING_ABORTED') return; // aborted: another load took over
    for (const w of [...frameWaiters]) if (w.tabId === d.tabId) w.done(d.error);
  }, { urls: ['<all_urls>'], types: ['sub_frame'] });
  // A page whose CSP forbids framing: drop the CSP for that host in this tab, and load it again.
  api.webRequest.onHeadersReceived.addListener(async (d) => {
    const phone = phones.get(d.tabId);
    if (phone?.mode !== 'frame' || (d.statusCode >= 300 && d.statusCode < 400)) return;
    const host = new URL(d.url).hostname;
    if (phone.cspHosts.includes(host)) return;
    if (!d.responseHeaders.some((h) => h.name.toLowerCase() === 'content-security-policy' && /frame-ancestors/i.test(h.value))) return;
    phone.cspHosts.push(host);
    persist();
    await syncPhone();
    if (d.method === 'GET') return { redirectUrl: d.url };
  }, { urls: ['<all_urls>'], types: ['sub_frame'] }, ['blocking', 'responseHeaders']);
  // The user typed another address, or went back past the phone view: it's a normal tab again.
  api.tabs.onUpdated.addListener((tabId, info) => {
    const phone = phones.get(tabId);
    if (phone?.mode !== 'frame' || !info.url) return;
    if (info.url.startsWith(PHONE_SHELL)) phone.shown = true;
    else if (phone.shown) forgetPhone(tabId);
  });
}
