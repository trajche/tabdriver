// Network monitoring for controlled tabs, loaded after background.js (same global scope).
//
// - Every request of a controlled tab goes into a per-tab log (webRequest, both browsers):
//   method, URL, type, status, timing, headers and request body. The network and
//   network_request tools read it.
// - har_start/har_stop record a HAR with response bodies. Chromium gets bodies and raw headers
//   (with cookies) from the debugger's Network domain; Firefox reads bodies with
//   webRequest.filterResponseData, only for the recorded tab and only while recording.
// - Secrets are redacted unless the agent asks for them: cookie and auth headers, and
//   password/token/card-like fields in JSON and form bodies.

const NET_MAX = 500; // requests kept per tab
const BODY_MAX = 2 * 1024 * 1024; // per body
const HAR_BYTES_MAX = 40 * 1024 * 1024; // bodies per recording
const HAR_ENTRIES_MAX = 5000;
const netLogs = new Map(); // tabId -> [entry]
const netById = new Map(); // "n12" -> entry
const netPending = new Map(); // webRequest requestId -> entry in flight
let netSeq = 0;
const hars = new Map(); // tabId -> recording

const SECRET_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token)$/i;
// Field names are split into words (snake_case, kebab-case, camelCase) so "shipping" or "author" stay.
const SECRET_WORDS = /(^|_)(pass|password|passwd|secret|token|otp|pin|cvc|cvv|iban|ssn|auth|authorization|apikey|api_key|card_number|cardnumber|session|sessionid|session_id|sid|csrf|xsrf|signature|sig)(_|$)/;
const secretField = (k) => SECRET_WORDS.test(String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase());
const TEXT_TYPE = /json|text|javascript|ecmascript|xml|html|css|x-www-form-urlencoded|graphql|csv/i;
const WATCHED = { urls: ['<all_urls>'] };
const IS_FIREFOX = !!api.webRequest?.filterResponseData;

// ---------- the per-tab request log (webRequest) ----------
function netEntry(details) {
  const e = {
    id: `n${++netSeq}`, tabId: details.tabId, requestId: details.requestId, method: details.method, url: details.url,
    type: details.type, start: details.timeStamp, status: 0, statusText: '', requestHeaders: [], responseHeaders: [],
  };
  const body = details.requestBody;
  if (body?.formData) {
    e.requestBody = new URLSearchParams(Object.entries(body.formData).flatMap(([k, vs]) => vs.map((v) => [k, v]))).toString();
    e.requestMime = 'application/x-www-form-urlencoded';
  } else if (body?.raw?.length) {
    const bytes = body.raw.filter((r) => r.bytes).map((r) => new Uint8Array(r.bytes));
    const size = bytes.reduce((n, b) => n + b.length, 0);
    const all = new Uint8Array(Math.min(size, BODY_MAX));
    let at = 0;
    for (const b of bytes) { if (at >= all.length) break; all.set(b.subarray(0, all.length - at), at); at += b.length; }
    e.requestBody = new TextDecoder().decode(all);
    e.requestBodySize = size;
  }
  const log = netLogs.get(details.tabId) ?? [];
  log.push(e);
  netById.set(e.id, e);
  if (log.length > NET_MAX) netById.delete(log.shift().id);
  netLogs.set(details.tabId, log);
  const rec = hars.get(details.tabId);
  if (rec && rec.entries.length < HAR_ENTRIES_MAX) rec.entries.push(e);
  netPending.set(details.requestId, e);
  return e;
}

const watched = (d) => d.tabId >= 0 && controlled.has(d.tabId);

api.webRequest.onBeforeRequest.addListener((d) => {
  if (watched(d)) netEntry(d);
}, WATCHED, ['requestBody']);

api.webRequest.onSendHeaders.addListener((d) => {
  const e = netPending.get(d.requestId);
  if (e) e.requestHeaders = d.requestHeaders || [];
}, WATCHED, ['requestHeaders']);

api.webRequest.onHeadersReceived.addListener((d) => {
  const e = netPending.get(d.requestId);
  if (!e) return;
  e.status = d.statusCode;
  e.statusText = (d.statusLine || '').replace(/^\S+\s+\d+\s*/, '');
  e.responseHeaders = d.responseHeaders || [];
}, WATCHED, ['responseHeaders']);

api.webRequest.onBeforeRedirect.addListener((d) => {
  const e = netPending.get(d.requestId);
  if (!e) return;
  e.status = d.statusCode;
  e.redirectURL = d.redirectUrl;
  e.end = d.timeStamp;
  netPending.delete(d.requestId); // the next hop is a new entry with the same requestId
}, WATCHED, ['responseHeaders']);

api.webRequest.onCompleted.addListener((d) => {
  const e = netPending.get(d.requestId);
  if (!e) return;
  e.status = d.statusCode;
  e.end = d.timeStamp;
  e.fromCache = d.fromCache;
  e.ip = d.ip;
  netPending.delete(d.requestId);
}, WATCHED);

api.webRequest.onErrorOccurred.addListener((d) => {
  const e = netPending.get(d.requestId);
  if (!e) return;
  e.error = d.error;
  e.end = d.timeStamp;
  netPending.delete(d.requestId);
}, WATCHED);

api.tabs.onRemoved.addListener((tabId) => {
  for (const e of netLogs.get(tabId) || []) netById.delete(e.id);
  netLogs.delete(tabId);
  stopHar(tabId).catch(() => {});
});

const header = (list, name) => list.find((h) => h.name.toLowerCase() === name)?.value || '';
const sizeOf = (e) => Number(header(e.responseHeaders, 'content-length')) || 0;
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const shortType = { main_frame: 'doc', sub_frame: 'frame', xmlhttprequest: 'xhr', stylesheet: 'css', script: 'js', image: 'img', media: 'media', font: 'font', websocket: 'ws', ping: 'ping' };

function netLine(e, t0) {
  const status = e.error ? `ERR ${e.error}` : e.status || '…';
  const ms = e.end ? `${Math.round(e.end - e.start)}ms` : 'pending';
  return `${e.id} +${((e.start - t0) / 1000).toFixed(1)}s ${e.method} ${status} ${shortType[e.type] || e.type} ` +
    `${kb(sizeOf(e))} ${ms} ${e.url.length > 180 ? e.url.slice(0, 177) + '…' : e.url}`;
}

// network tool: { tabId, filter, failedOnly, types, limit }
function networkList(tabId, { filter, failedOnly, types, limit = 60 }) {
  let log = netLogs.get(tabId) || [];
  if (!log.length) return 'No requests recorded in this tab yet. Requests are recorded while a tab is controlled; reload to see the page load.';
  const t0 = log[0].start;
  const want = types ? types.split(',').map((t) => t.trim()) : null;
  log = log.filter((e) =>
    (!filter || e.url.includes(filter)) &&
    (!failedOnly || e.error || e.status >= 400) &&
    (!want || want.includes(shortType[e.type] || e.type)));
  const shown = log.slice(-limit);
  return [
    `${shown.length} of ${log.length} request(s)${log.length > shown.length ? ' (latest shown)' : ''}. network_request with an id shows headers and bodies.`,
    ...shown.map((e) => netLine(e, t0)),
  ].join('\n');
}

// ---------- redaction ----------
function redactHeaders(list, keep) {
  return list.map((h) => ({ name: h.name, value: !keep && SECRET_HEADER.test(h.name) ? '[redacted]' : h.value ?? '' }));
}

function redactBody(text, mime, keep) {
  if (keep || !text) return text;
  try {
    if (/json/i.test(mime) || /^\s*[[{]/.test(text)) {
      const walk = (v) => {
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') {
          return Object.fromEntries(Object.entries(v).map(([k, x]) =>
            [k, secretField(k) && (typeof x === 'string' || typeof x === 'number') ? '[redacted]' : walk(x)]));
        }
        return v;
      };
      return JSON.stringify(walk(JSON.parse(text)));
    }
  } catch {}
  if (/x-www-form-urlencoded/i.test(mime) || (/^[^\s=&]+=[^\s]*(&[^\s=&]+=[^\s]*)*$/.test(text) && text.includes('='))) {
    const p = new URLSearchParams(text);
    for (const k of [...p.keys()]) if (secretField(k)) p.set(k, '[redacted]');
    return p.toString();
  }
  return text;
}

// ---------- HAR recording ----------
async function startHar(tabId, { includeSecrets }) {
  if (hars.has(tabId)) throw new Error('Already recording a HAR in this tab; call har_stop first.');
  const rec = { tabId, started: Date.now(), includeSecrets: !!includeSecrets, entries: [], bytes: 0, truncated: 0,
    bodies: new Map(), cdp: new Map(), cdpByKey: new Map(), ownsDebugger: false };
  hars.set(tabId, rec);
  if (IS_FIREFOX) {
    rec.listener = (d) => captureFirefoxBody(rec, d);
    api.webRequest.onBeforeRequest.addListener(rec.listener,
      { urls: ['<all_urls>'], tabId, types: ['main_frame', 'sub_frame', 'xmlhttprequest', 'script', 'stylesheet', 'other', 'ping'] },
      ['blocking']);
  } else {
    try {
      if (debuggerTabs.has(tabId)) { // attached for a trusted click or evaluate: take it over
        clearTimeout(debuggerTabs.get(tabId));
        debuggerTabs.delete(tabId);
      } else {
        await api.debugger.attach({ tabId }, '1.3');
      }
      rec.ownsDebugger = true;
      await api.debugger.sendCommand({ tabId }, 'Network.enable', { maxPostDataSize: BODY_MAX });
    } catch (e) {
      hars.delete(tabId);
      throw new Error(`Couldn't start recording: ${e.message}. DevTools may be open on this tab.`);
    }
  }
  return `Recording a HAR of tab ${tabId}${IS_FIREFOX ? '' : ' (Chrome shows a "being debugged" bar meanwhile)'}. ` +
    `Secrets are ${rec.includeSecrets ? 'kept' : 'redacted'}. Reload to include the page load. Call har_stop with a path to save it.`;
}

// Firefox: copy the response as it streams through; the page gets every byte unchanged.
function captureFirefoxBody(rec, d) {
  let filter;
  try { filter = api.webRequest.filterResponseData(d.requestId); } catch { return {}; }
  const chunks = [];
  let size = 0;
  filter.ondata = (ev) => {
    filter.write(ev.data);
    size += ev.data.byteLength;
    if (size <= BODY_MAX && rec.bytes + size <= HAR_BYTES_MAX) chunks.push(ev.data);
  };
  const done = () => {
    try { filter.close(); } catch {}
    if (!chunks.length) return;
    if (size > BODY_MAX || rec.bytes + size > HAR_BYTES_MAX) { rec.truncated++; return; }
    const all = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { all.set(new Uint8Array(c), at); at += c.byteLength; }
    rec.bytes += size;
    rec.bodies.set(d.requestId, { bytes: all, size });
  };
  filter.onstop = done;
  filter.onerror = done;
  return {};
}

// Chromium: bodies and raw headers from the debugger, matched to log entries by method + URL.
api.debugger?.onEvent.addListener(async ({ tabId }, method, p) => {
  const rec = hars.get(tabId);
  if (!rec || !p?.requestId) return;
  const c = rec.cdp.get(p.requestId) ?? {};
  rec.cdp.set(p.requestId, c);
  if (method === 'Network.requestWillBeSent') {
    c.key = `${p.request.method} ${p.request.url}`;
    c.requestHeaders = Object.entries(p.request.headers || {}).map(([name, value]) => ({ name, value }));
    c.postData = p.request.postData;
    const queue = rec.cdpByKey.get(c.key) ?? [];
    queue.push(c);
    rec.cdpByKey.set(c.key, queue);
  } else if (method === 'Network.requestWillBeSentExtraInfo') {
    c.requestHeaders = Object.entries(p.headers || {}).map(([name, value]) => ({ name, value })); // includes cookies
  } else if (method === 'Network.responseReceived') {
    c.mime = p.response.mimeType;
    if (!c.responseHeaders) c.responseHeaders = Object.entries(p.response.headers || {}).map(([name, value]) => ({ name, value }));
  } else if (method === 'Network.responseReceivedExtraInfo') {
    c.responseHeaders = Object.entries(p.headers || {}).map(([name, value]) => ({ name, value })); // includes Set-Cookie
  } else if (method === 'Network.loadingFinished') {
    if (!TEXT_TYPE.test(c.mime || '') || p.encodedDataLength > BODY_MAX || rec.bytes > HAR_BYTES_MAX) {
      if (TEXT_TYPE.test(c.mime || '')) rec.truncated++;
      return;
    }
    try {
      const r = await api.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: p.requestId });
      c.body = r.base64Encoded ? null : r.body;
      if (c.body) rec.bytes += c.body.length;
    } catch {}
  }
});

// Response body (text) and raw headers for a log entry, from the running or last recording.
function extrasFor(e) {
  const rec = hars.get(e.tabId) || lastHars.get(e.tabId);
  if (!rec) return {};
  if (IS_FIREFOX) {
    const b = rec.bodies.get(e.requestId);
    const mime = header(e.responseHeaders, 'content-type');
    if (!b || !TEXT_TYPE.test(mime)) return {};
    return { body: new TextDecoder().decode(b.bytes), size: b.size };
  }
  if (!e.cdp) { // first use: claim the next debugger record with the same method + URL
    const queue = rec.cdpByKey.get(`${e.method} ${e.url}`);
    e.cdp = queue?.shift() || null;
  }
  const c = e.cdp;
  return c ? { body: c.body ?? undefined, size: c.body?.length, postData: c.postData, requestHeaders: c.requestHeaders, responseHeaders: c.responseHeaders } : {};
}

const lastHars = new Map(); // tabId -> the last finished recording, so network_request can still show bodies

async function stopHar(tabId) {
  const rec = hars.get(tabId);
  if (!rec) return null;
  hars.delete(tabId);
  if (rec.listener) api.webRequest.onBeforeRequest.removeListener(rec.listener);
  if (rec.ownsDebugger) await api.debugger.detach({ tabId }).catch(() => {});
  lastHars.set(tabId, rec);
  return rec;
}

function harEntry(e, keep) {
  const x = extrasFor(e);
  const reqHeaders = redactHeaders(x.requestHeaders || e.requestHeaders, keep);
  const resHeaders = redactHeaders(x.responseHeaders || e.responseHeaders, keep);
  const reqMime = header(e.requestHeaders, 'content-type') || e.requestMime || '';
  const resMime = header(x.responseHeaders || e.responseHeaders, 'content-type') || '';
  const url = new URL(e.url);
  const time = e.end ? Math.max(0, e.end - e.start) : 0;
  const postText = e.requestBody ?? x.postData;
  return {
    startedDateTime: new Date(e.start).toISOString(),
    time,
    request: {
      method: e.method, url: e.url, httpVersion: 'HTTP/1.1', headers: reqHeaders, cookies: [],
      queryString: [...url.searchParams].map(([name, value]) => ({ name, value: !keep && secretField(name) ? '[redacted]' : value })),
      headersSize: -1, bodySize: e.requestBodySize ?? (postText ? postText.length : 0),
      ...(postText ? { postData: { mimeType: reqMime, text: redactBody(postText, reqMime, keep) } } : {}),
    },
    response: {
      status: e.status || 0, statusText: e.statusText || '', httpVersion: 'HTTP/1.1', headers: resHeaders, cookies: [],
      content: { size: x.size ?? sizeOf(e), mimeType: resMime, ...(x.body !== undefined ? { text: redactBody(x.body, resMime, keep) } : {}) },
      redirectURL: e.redirectURL || '', headersSize: -1, bodySize: sizeOf(e),
    },
    cache: {},
    timings: { send: 0, wait: time, receive: 0 },
    serverIPAddress: e.ip,
    _resourceType: shortType[e.type] || e.type,
    ...(e.error ? { _error: e.error } : {}),
    _tabdriverId: e.id,
  };
}

// API endpoints seen in a recording: XHR/fetch calls grouped by method + path pattern.
function endpointSummary(entries) {
  const pattern = (u) => new URL(u).pathname.split('/').map((s) =>
    /^\d+$/.test(s) ? ':id' : /^[0-9a-f-]{16,}$/i.test(s) ? ':uuid' : s).join('/');
  const groups = new Map();
  for (const e of entries) {
    if (e.type !== 'xmlhttprequest') continue;
    const key = `${e.method} ${new URL(e.url).host}${pattern(e.url)}`;
    const g = groups.get(key) ?? { count: 0, statuses: new Set() };
    g.count++;
    g.statuses.add(e.error ? 'ERR' : e.status);
    groups.set(key, g);
  }
  return [...groups].map(([k, g]) => `${k}  ×${g.count}  [${[...g.statuses].join(', ')}]`);
}

async function finishHar(tabId) {
  const rec = await stopHar(tabId);
  if (!rec) throw new Error('Not recording a HAR in this tab; call har_start first.');
  const har = {
    log: {
      version: '1.2',
      creator: { name: 'Tab Driver', version: api.runtime.getManifest().version },
      pages: [],
      entries: rec.entries.map((e) => harEntry(e, rec.includeSecrets)),
    },
  };
  return {
    har,
    entries: rec.entries.length,
    endpoints: endpointSummary(rec.entries),
    truncated: rec.truncated,
    secrets: rec.includeSecrets ? 'kept' : 'redacted',
  };
}

// network_request tool: one request in full.
function networkRequest(id, { includeSecrets, maxBodyChars = 20000 }) {
  const e = netById.get(id);
  if (!e) throw new Error(`Unknown request ${id}. Use network to list requests.`);
  const x = extrasFor(e);
  const keep = !!includeSecrets;
  const reqMime = header(e.requestHeaders, 'content-type') || e.requestMime || '';
  const resMime = header(x.responseHeaders || e.responseHeaders, 'content-type');
  const cut = (t) => (t.length > maxBodyChars ? `${t.slice(0, maxBodyChars)}\n… [${t.length} chars; raise maxBodyChars or use har_stop]` : t);
  const headers = (list) => redactHeaders(list, keep).map((h) => `  ${h.name}: ${h.value}`).join('\n') || '  (none)';
  const postText = e.requestBody ?? x.postData;
  const out = [
    `${e.method} ${e.url}`,
    `Status: ${e.error ? `failed (${e.error})` : `${e.status} ${e.statusText}`}${e.redirectURL ? ` -> ${e.redirectURL}` : ''} · ` +
      `${shortType[e.type] || e.type} · ${e.end ? Math.round(e.end - e.start) + 'ms' : 'pending'}${e.fromCache ? ' · from cache' : ''}`,
    '', 'Request headers:', headers(x.requestHeaders || e.requestHeaders),
  ];
  if (postText) out.push('', `Request body (${reqMime || 'unknown type'}):`, cut(redactBody(postText, reqMime, keep)));
  out.push('', 'Response headers:', headers(x.responseHeaders || e.responseHeaders));
  if (x.body !== undefined) out.push('', `Response body (${resMime || 'unknown type'}):`, cut(redactBody(x.body, resMime, keep)));
  else out.push('', 'Response body: not captured. Record with har_start to capture bodies of the next requests.');
  if (!keep) out.push('', 'Cookies, auth headers and password/token fields are redacted; pass includeSecrets: true to see them.');
  return out.join('\n');
}
