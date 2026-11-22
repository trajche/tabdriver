import { chromium } from 'playwright';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir, homedir, networkInterfaces } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// End-to-end test: real browser + the unpacked extension + the tabdriver binary
// (native host and two MCP servers acting as Claude and Codex).
// Usage: make test | make test-firefox   (or: node test/e2e.mjs [path/to/tabdriver] [--firefox])
const FIREFOX = process.argv.includes('--firefox');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || join(ROOT, 'bin', 'tabdriver'));
const HOME = mkdtempSync('/tmp/td-'); // short path: Unix socket paths are limited to ~104 bytes
const BIG = join(HOME, 'big.bin');
writeFileSync(BIG, randomBytes(1500000)); // > 1 MB to exercise host->extension chunking
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PAGE = `<!doctype html><title>Test Bank</title><script>document.addEventListener('visibilitychange',()=>console.log('visibility:'+document.visibilityState))</script><h1>Transactions</h1>
<label for="q">Search</label><input id="q">
<select id="period"><option value="m">This month</option><option value="y">This year</option></select>
<div id="out"></div>
<div role="button" tabindex="0" onclick="out.textContent='Applied: '+q.value+' / '+period.value">Apply filter</div>
<form onsubmit="event.preventDefault();out.textContent='Submitted '+q2.value"><input id="q2" aria-label="Login name"></form>
<a href="/tx.csv" download="tx.csv">Download CSV</a>
<div id="dz" style="width:200px;height:50px;border:1px solid" ondragover="event.preventDefault()"
 ondrop="event.preventDefault();const f=event.dataTransfer.files[0];f.arrayBuffer().then(b=>r.textContent='drop:'+f.name+':'+b.byteLength)">drop</div><p id="r"></p>
<input type="file" id="fi" onchange="fr.textContent='file:'+this.files[0].name+':'+this.files[0].size"><p id="fr"></p>
<button onclick="console.warn('careful now');throw new Error('boom from Break')">Break</button>
<img src="/missing.png" alt="">
<button onclick="fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user:'ann',password:'hunter2'})})
 .then(()=>fetch('/api/invoices/42')).then(r=>r.json()).then(j=>{out.textContent='total '+j.total;return fetch('/api/missing')})">Load invoice</button>
<div style="position:relative"><button>Under banner</button><div id="banner" style="position:absolute;inset:0;background:rgba(0,0,0,.1)"></div></div>`;
const hits = [];
const MOBILE = (req) => `<!doctype html><title>Mobile ${req.url}</title><meta name="viewport" content="width=device-width">
<style>#nav{position:fixed;bottom:0;left:0;right:0;height:60px;background:teal}#small{display:none}@media(max-width:500px){#small{display:block}}</style>
<h1>${req.url}</h1><p>doc cookie ${req.headers.cookie}</p><p id="api"></p><p id="js"></p><p id="small">narrow layout</p>
<input aria-label="Name" id="n"><button onclick="console.log('greeted');js2.textContent='hello '+n.value+' layout '+document.documentElement.clientWidth">Greet</button><p id="js2"></p><a href="/m-page?2">Next page</a><div id="nav"></div><div style="height:2000px"></div>
<script>js.textContent=['who',localStorage.who,'nav bottom',Math.round(nav.getBoundingClientRect().bottom),'ua',/iPhone/.test(navigator.userAgent),'touch',navigator.maxTouchPoints>0&&'ontouchstart' in window,'coarse',matchMedia('(pointer: coarse)').matches,'screen',screen.width,innerWidth+'x'+innerHeight].join(' ');
fetch('/m-api').then(r=>r.text()).then(t=>api.textContent=t)</script>`;
const srv = http.createServer((req, res) => {
  if (req.url === '/missing.png' || req.url === '/api/missing') { res.writeHead(404); return res.end(); }
  if (req.url === '/api/login') { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=s3cr3t' }); return res.end('{"access_token":"abc123","user":{"name":"Ann"}}'); }
  if (req.url === '/api/invoices/42') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"id":42,"total":99.5,"shipping":"DHL"}'); }
  if (req.url === '/m-login') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': ['sid=strict; HttpOnly; SameSite=Strict', 'lax=1; SameSite=Lax'] }); return res.end('<script>localStorage.who="ann"</script>logged in'); }
  if (req.url.startsWith('/m-page')) { // forbids framing every way there is
    hits.push(`${req.url} ${/iPhone/.test(req.headers['user-agent']) ? 'phone' : 'desktop'}`);
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
    return res.end(MOBILE(req));
  }
  if (req.url === '/m-api') return res.end(`api cookie ${req.headers.cookie} ${/iPhone/.test(req.headers['user-agent']) ? 'phone' : 'desktop'}`);
  if (req.url === '/tx.csv') { res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="tx.csv"' }); return res.end('a,b\n1,2\n'); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
}).listen(8813);

const browser = FIREFOX ? await launchFirefox() : await launchChromium();
const socks = () => { try { return readdirSync(HOME + '/hosts').filter(f => f.endsWith('.sock')); } catch { return []; } };
for (let i = 0; i < 40 && !socks().length; i++) await sleep(250);
console.log('host sockets:', socks(), 'ext status:', await browser.inspect('[status, statusDetail]'));

// Chromium: the host manifest lives in the throwaway profile. TABDRIVER_HOME reaches the host via the browser's env.
async function launchChromium() {
  const ext = join(ROOT, 'extension');
  const udd = mkdtempSync(join(tmpdir(), 'udd-'));
  mkdirSync(join(udd, 'NativeMessagingHosts'), { recursive: true });
  writeFileSync(join(udd, 'NativeMessagingHosts', 'com.tabdriver.host.json'), JSON.stringify({
    name: 'com.tabdriver.host', description: 't', path: BIN, type: 'stdio',
    allowed_origins: ['chrome-extension://lpakianppngookkeolmodlkgcgbkmooo/'],
  }));
  const ctx = await chromium.launchPersistentContext(udd, {
    channel: 'chromium', headless: true, acceptDownloads: true, env: { ...process.env, TABDRIVER_HOME: HOME },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  return { inspect: (expr) => sw.evaluate(expr), close: () => ctx.close() };
}

// Firefox: Playwright can't load extensions there, so start a real Firefox with a throwaway
// profile and install build/firefox as a temporary add-on over the Remote Debugging Protocol.
// Firefox reads native host manifests only from the per-user location, so an existing one is
// backed up and restored afterwards.
async function launchFirefox() {
  const ext = join(ROOT, 'build', 'firefox');
  if (!existsSync(join(ext, 'manifest.json'))) throw new Error('build/firefox missing: run make firefox');
  const bin = process.env.FIREFOX_BIN || (process.platform === 'darwin' ? '/Applications/Firefox.app/Contents/MacOS/firefox' : 'firefox');
  const nmDir = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts')
    : join(homedir(), '.mozilla', 'native-messaging-hosts');
  const nmFile = join(nmDir, 'com.tabdriver.host.json');
  const saved = existsSync(nmFile) ? readFileSync(nmFile) : null;
  const restore = () => { if (saved) writeFileSync(nmFile, saved); else rmSync(nmFile, { force: true }); };
  mkdirSync(nmDir, { recursive: true });
  writeFileSync(nmFile, JSON.stringify({
    name: 'com.tabdriver.host', description: 't', path: BIN, type: 'stdio', allowed_extensions: ['tabdriver@firefox'],
  }));
  process.on('exit', restore);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

  const profile = mkdtempSync(join(tmpdir(), 'ffp-'));
  const prefs = {
    'devtools.debugger.remote-enabled': true, 'devtools.chrome.enabled': true, 'devtools.debugger.prompt-connection': false,
    'browser.download.folderList': 2, 'browser.download.dir': join(HOME, 'downloads'), 'browser.download.useDownloadDir': true,
    'browser.download.always_ask_before_handling_new_types': false, 'browser.shell.checkDefaultBrowser': false,
    'browser.aboutwelcome.enabled': false, 'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.reportingpolicy.firstRun': false, 'browser.startup.homepage_override.mstone': 'ignore',
  };
  writeFileSync(join(profile, 'user.js'),
    Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));
  const port = 6000 + Math.floor(Math.random() * 1000);
  const ff = spawn(bin, ['-headless', '-no-remote', '-profile', profile, '--start-debugger-server', String(port)], {
    env: { ...process.env, TABDRIVER_HOME: HOME }, stdio: 'ignore',
  });

  const rdp = await rdpConnect(port);
  const root = await rdp.request({ to: 'root', type: 'getRoot' });
  const r = await rdp.request({ to: root.addonsActor, type: 'installTemporaryAddon', addonPath: ext, openDevTools: false });
  if (r.error) throw new Error(`installTemporaryAddon: ${r.error} ${r.message}`);
  console.log('firefox add-on installed:', r.addon.id);
  return {
    inspect: async () => 'n/a (firefox)',
    close: async () => { rdp.close(); ff.kill(); await sleep(1000); restore(); },
  };
}

// Minimal Firefox Remote Debugging Protocol client: packets are "<byte length>:<json>".
async function rdpConnect(port) {
  for (let i = 0; ; i++) {
    try {
      const sock = await new Promise((ok, fail) => { const s = net.connect(port, '127.0.0.1', () => ok(s)); s.on('error', fail); });
      let buf = Buffer.alloc(0);
      const waiting = [];
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          const colon = buf.indexOf(':');
          if (colon < 0) break;
          const len = Number(buf.subarray(0, colon));
          if (buf.length < colon + 1 + len) break;
          const pkt = JSON.parse(buf.subarray(colon + 1, colon + 1 + len));
          buf = buf.subarray(colon + 1 + len);
          const w = waiting.findIndex((x) => x.from === pkt.from);
          if (w >= 0) waiting.splice(w, 1)[0].resolve(pkt);
        }
      });
      const request = (msg) => new Promise((ok) => {
        waiting.push({ from: msg.to, resolve: ok });
        const body = Buffer.from(JSON.stringify(msg));
        sock.write(`${body.length}:`);
        sock.write(body);
      });
      await new Promise((ok) => waiting.push({ from: 'root', resolve: ok })); // greeting
      return { request, close: () => sock.destroy() };
    } catch (e) {
      if (i > 80) throw e;
      await sleep(250);
    }
  }
}

function jpegSize(b) {
  for (let i = 2; i < b.length - 9;) {
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return { w: 0, h: 0 };
}

async function agent(name) {
  const c = new Client({ name, version: '1' });
  await c.connect(new StdioClientTransport({ command: BIN, args: ['mcp'], env: { ...process.env, TABDRIVER_HOME: HOME }, stderr: 'inherit' }));
  return c;
}
let fails = 0;
const expect = (ok, what) => { if (!ok) fails++; console.log(`${ok ? '  ok' : 'FAIL'} ${what}`); };
const call = async (c, name, args = {}, expectError = false) => {
  const r = await c.callTool({ name, arguments: args });
  const t = r.content[0].type === 'image' ? `<image ${r.content[0].mimeType} ${r.content[0].data.length} b64>` : r.content[0].text;
  if (!!r.isError !== expectError) fails++;
  console.log(`### [${c._clientInfo.name}] ${name}${r.isError ? ' [ERROR]' : ''}: ${t.replace(/\s+/g, ' ').slice(0, 160)}`);
  return t;
};

const claude = await agent('claude-code');
const codex = await agent('codex-mcp-client');
await sleep(500);
const tools = await claude.listTools();
console.log('tools:', tools.tools.length, '| snapshot schema props:', Object.keys(tools.tools.find(t => t.name === 'snapshot').inputSchema.properties).join(','));
await call(claude, 'browser_status');
console.log('extension sees agents:', JSON.stringify(await browser.inspect('agents')));

await call(claude, 'open_tab', { url: 'http://127.0.0.1:8813/' });
const snap = await call(claude, 'snapshot', { includeText: false });
const ref = (re) => snap.split('\n').find(l => re.test(l)).match(/\[(e\d+)\]/)[1];
await call(claude, 'type', { ref: ref(/Search/), text: 'coffee' });
await call(claude, 'select_option', { ref: ref(/combobox/), value: 'This year' });
await call(claude, 'click', { ref: ref(/Apply filter/) });
await call(claude, 'wait_for', { text: 'Applied: coffee / y' });
await call(claude, 'type', { ref: ref(/Login name/), text: 'alice', submit: true });
await call(claude, 'evaluate', { expression: 'document.getElementById("out").textContent' }, FIREFOX); // Chromium only
await call(claude, 'click', { ref: ref(/Apply filter/), trusted: true }, FIREFOX); // Firefox has no debugger API
await call(claude, 'screenshot');
await call(claude, 'click', { ref: ref(/Download CSV/) });
await call(claude, 'wait_for_download', { timeoutMs: 10000 });
await call(claude, 'click', { ref: 'e999' }, true);

// Console, errors, covered elements, annotated screenshots saved to disk.
const snap2 = await call(claude, 'snapshot', { includeText: false });
const ref2 = (re) => snap2.split('\n').find(l => re.test(l)).match(/\[(e\d+)\]/)[1];
await call(claude, 'click', { ref: ref2(/"Break"/) });
const errs = await call(claude, 'errors');
expect(/boom from Break/.test(errs) && /missing\.png/.test(errs), 'errors has the exception and the failed image');
const cons = await call(claude, 'console', { level: 'warn' });
expect(/careful now/.test(cons), 'console has the warning');
const under = await call(claude, 'click', { ref: ref2(/Under banner/) });
expect(/div#banner.*covers this element/.test(under), 'click reports the covering banner');
const shotPath = join(HOME, 'shots', 'annotated.png');
const shot = await claude.callTool({ name: 'screenshot', arguments: { path: shotPath, annotate: true } });
const note = shot.content.find(c => c.type === 'text')?.text || '';
expect(existsSync(shotPath) && readFileSync(shotPath).subarray(1, 4).toString() === 'PNG' && /\d+ elements labelled/.test(note), `annotated PNG saved (${note.replace(/\n/g, '; ')})`);
// Storyboard recording, hover, snapshot diff.
const recDir = join(HOME, 'rec');
await call(claude, 'record_start', { dir: recDir });
await call(claude, 'hover', { ref: ref2(/"Break"/) });
await call(claude, 'type', { ref: ref2(/Login name/), text: 'bob' });
const diff = await call(claude, 'snapshot', { diff: true });
expect(/Changes since the last snapshot/.test(diff) && /~ \[e\d+\] textbox "Login name" value="bob"/.test(diff), 'snapshot diff shows the typed value');
const stopped = await call(claude, 'record_stop');
const frames = existsSync(join(recDir, 'steps')) ? readdirSync(join(recDir, 'steps')) : [];
expect(/Recorded 4 steps/.test(stopped) && frames.join() === '01-page.jpg,02-hover.jpg,03-type.jpg,04-page.jpg' &&
  existsSync(join(recDir, 'storyboard.html')) && existsSync(join(recDir, 'recording.gif')), `storyboard recorded (${frames.join(' ')})`);
// Network log, one request in full, and a HAR with bodies.
await call(claude, 'har_start');
await call(claude, 'click', { ref: ref2(/Load invoice/) });
await call(claude, 'wait_for', { text: 'total 99.5' });
await new Promise(r => setTimeout(r, 800));
const xhr = await call(claude, 'network', { types: 'xhr' });
expect(/POST 200 xhr .*\/api\/login/.test(xhr) && /GET 200 xhr .*\/api\/invoices\/42/.test(xhr), 'network lists the API calls');
const failed = await call(claude, 'network', { failedOnly: true, filter: '/api/' });
expect(/404 .*\/api\/missing/.test(failed) && !/invoices/.test(failed), 'network failedOnly');
const loginId = xhr.split('\n').find(l => l.includes('/api/login')).split(' ')[0];
const login = await call(claude, 'network_request', { id: loginId });
expect(/"password":"\[redacted\]"/.test(login) && /"access_token":"\[redacted\]"/.test(login) && /"user":"ann"/.test(login), 'network_request redacts secrets, keeps the rest');
const loginRaw = await call(claude, 'network_request', { id: loginId, includeSecrets: true });
expect(/hunter2/.test(loginRaw) && /abc123/.test(loginRaw), 'network_request includeSecrets');
const harPath = join(HOME, 'net', 'session.har');
const stoppedHar = await call(claude, 'har_stop', { path: harPath });
const harJson = existsSync(harPath) ? JSON.parse(readFileSync(harPath, 'utf8')) : null;
const inv = harJson?.log.entries.find(e => e.request.url.endsWith('/api/invoices/42'));
expect(inv?.response.content.text?.includes('"shipping":"DHL"') && /GET 127\.0\.0\.1:8813\/api\/invoices\/:id/.test(stoppedHar), `HAR saved with bodies and endpoint summary (${harJson?.log.entries.length} entries)`);
const prompts = await claude.listPrompts();
const dog = await claude.getPrompt({ name: 'dogfood', arguments: { url: 'https://app.example.com' } });
expect(prompts.prompts.some(p => p.name === 'dogfood') && /dogfood-output\/app-example-com-/.test(dog.messages[0].content.text), 'dogfood prompt');

await call(codex, 'open_tab', { url: 'http://127.0.0.1:8813/?codex' });
await call(codex, 'upload_file', { selector: '#dz', paths: [BIG] });
await call(codex, 'wait_for', { text: 'drop:big.bin:1500000' });
await call(codex, 'upload_file', { selector: '#fi', paths: [BIG] });
await call(codex, 'wait_for', { text: 'file:big.bin:1500000' });
console.log('claude default tab ->', /Applied|Submitted/.test(await call(claude, 'get_text', {})) ? 'own tab ✓' : 'WRONG TAB');

// Firefox: agents work in the background. The user's tab stays in front while an agent opens,
// drives, captures and records a tab behind it.
if (FIREFOX) {
  const tabs = async () => JSON.parse((await claude.callTool({ name: 'list_tabs', arguments: { all: true } })).content[0].text);
  const front = async () => (await tabs()).filter(t => t.active).map(t => t.tabId).join();
  const before = await front();
  const opened = JSON.parse((await codex.callTool({ name: 'open_tab', arguments: { url: 'http://127.0.0.1:8813/?bg', active: true } })).content[0].text);
  expect(!opened.active && await front() === before, 'open_tab stays in the background');
  const s = await call(codex, 'snapshot', { includeText: false });
  const r = (re) => s.split('\n').find(l => re.test(l)).match(/\[(e\d+)\]/)[1];
  const shoot = async () => Buffer.from((await codex.callTool({ name: 'screenshot', arguments: {} })).content[0].data, 'base64');
  const shot1 = await shoot();
  const t0 = Date.now();
  await call(codex, 'type', { ref: r(/Search/), text: 'background tea' });
  await call(codex, 'click', { ref: r(/Apply filter/) });
  const took = Date.now() - t0;
  await call(codex, 'wait_for', { text: 'Applied: background tea / m' });
  expect(took < 1500, `actions in a hidden tab aren't slowed down (${took} ms)`);
  const shot2 = await shoot();
  const size = jpegSize(shot2);
  expect(size.w > 300 && size.h > 300 && !shot1.equals(shot2), `background screenshots are real and current (${size.w}x${size.h})`);
  if (process.env.SHOT_DIR) { writeFileSync(join(process.env.SHOT_DIR, 'bg1.jpg'), shot1); writeFileSync(join(process.env.SHOT_DIR, 'bg2.jpg'), shot2); }
  const bgRec = join(HOME, 'bgrec');
  await call(codex, 'record_start', { dir: bgRec });
  await call(codex, 'click', { ref: r(/Apply filter/) });
  expect(/Recorded 3 steps/.test(await call(codex, 'record_stop')), 'storyboard in the background');
  expect(/timeout/.test(await call(codex, 'wait_for_user', { message: 'nothing', timeoutSec: 1 })), 'wait_for_user prompts without switching tabs');
  expect(await front() === before, 'the front tab never changed');
  expect(!/visibility:/.test(await call(codex, 'console')), 'the agent tab was never shown');
}

// Phone view: a phone's viewport, touch and user agent, with the logins of the normal tab, on a page
// that forbids framing. Hosts: the loopback address, and this machine's plain-http LAN address.
const lan = Object.values(networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address;
for (const host of ['127.0.0.1', ...(lan ? [lan] : [])]) {
  console.log('phone view on', host === lan ? 'LAN address' : host);
  const base = `http://${host}:8813`;
  hits.length = 0;
  await call(claude, 'open_tab', { url: `${base}/m-login` });
  await call(claude, 'navigate', { url: `${base}/m-page?1` });
  const on = await call(claude, 'emulate_device', { device: 'iphone' });
  expect(/"viewport": "390x844"/.test(on) && on.includes(`"url": "${base}/m-page?1"`) && /iphone 390x844/.test(on), 'phone view on');
  await call(claude, 'wait_for', { text: 'api cookie' });
  const txt = await call(claude, 'get_text');
  const cookies = /doc cookie sid=strict; lax=1/.test(txt) && /api cookie sid=strict; lax=1 phone/.test(txt) && /who ann/.test(txt);
  expect(cookies, 'logins and storage kept');
  expect(/narrow layout/.test(txt) && /nav bottom 844 ua true touch true coarse true screen 390 390x844/.test(txt), `looks like a phone (${txt.match(/nav bottom.*/)?.[0]})`);
  const psnap = await call(claude, 'snapshot', { includeText: false });
  const pref = (re) => psnap.split('\n').find(l => re.test(l)).match(/\[(e\d+)\]/)[1];
  await call(claude, 'type', { ref: pref(/Name/), text: 'ann' });
  await call(claude, 'click', { ref: pref(/Greet/) });
  await call(claude, 'wait_for', { text: 'hello ann' });
  expect(/layout 390/.test(await call(claude, 'get_text')), 'no scrollbar takes width');
  const pshot = await claude.callTool({ name: 'screenshot', arguments: {} });
  const img = Buffer.from(pshot.content[0].data, 'base64');
  const ps = jpegSize(img);
  expect(Math.abs(ps.h / ps.w - 844 / 390) < 0.02, `screenshot is the phone's screen (${ps.w}x${ps.h})`);
  if (process.env.SHOT_DIR) writeFileSync(join(process.env.SHOT_DIR, `phone-${FIREFOX ? 'ff' : 'cr'}.jpg`), img);
  expect(/greeted/.test(await call(claude, 'console')), 'console recorded in phone view');
  await call(claude, 'click', { ref: pref(/Next page/) });
  if (!FIREFOX) await sleep(500); // Chromium ends a script call when its page goes away
  await call(claude, 'wait_for', { text: '/m-page?2' });
  const tab = JSON.parse(await call(claude, 'list_tabs')).find(t => t.controlled && t.device);
  expect(tab?.url === `${base}/m-page?2` && tab.title === 'Mobile /m-page?2', 'tab shows the page\'s own address and title');
  expect(/m-page\?3"/.test(await call(claude, 'navigate', { url: `${base}/m-page?3` })), 'navigate');
  if (FIREFOX) { // Chromium skips history entries made without a user gesture, phone view or not
    expect(/m-page\?2"/.test(await call(claude, 'navigate', { action: 'back' })), 'back');
    expect(/m-page\?3"/.test(await call(claude, 'navigate', { action: 'forward' })), 'forward');
  }
  const t1 = Date.now();
  expect(/m-page\?3"/.test(await call(claude, 'navigate', { action: 'reload' })), `reload (${Date.now() - t1} ms)`);
  expect(/"viewport": "844x390"/.test(await call(claude, 'emulate_device', { landscape: true })), 'landscape');
  expect(/m-page\?3 phone/.test(hits.at(-1)), 'mobile user agent sent');
  if (FIREFOX) {
    expect(/did not load/.test(await call(claude, 'navigate', { url: `http://${host}:8814/dead` }, true)), 'a failed load is reported');
    await call(claude, 'navigate', { url: `${base}/m-page?3` });
  }
  const off = await call(claude, 'emulate_device', { device: 'off' });
  expect(off.includes(`"url": "${base}/m-page?3"`) && !/iphone/.test(off), 'phone view off');
  if (FIREFOX) expect(/m-page\?3 desktop/.test(hits.at(-1)), 'back to the normal user agent');
  await call(claude, 'close_tab');
}
// HAR and phone view share the debugger in Chromium; ending one must not break the other.
await call(claude, 'open_tab', { url: 'http://127.0.0.1:8813/m-page?har' });
await call(claude, 'emulate_device', { device: 'pixel' });
await call(claude, 'har_start');
await call(claude, 'navigate', { action: 'reload' });
await call(claude, 'har_stop', { path: join(HOME, 'net', 'phone.har') });
const wide = await call(claude, 'get_text');
expect(/412x915/.test(wide), 'still in phone view after a HAR recording');
await call(claude, 'emulate_device', { device: 'nokia' }, true);
await call(claude, 'release_tab');
const released = JSON.parse(await call(codex, 'list_tabs', { all: true })).find(t => /m-page\?har/.test(t.url));
expect(released && !released.device && !released.controlled, 'releasing the tab ends phone view');

// Switching Tab Driver off gives every AI tab back and disconnects agents (Chromium: the
// test can reach the service worker; the Firefox side is covered by manual testing).
if (!FIREFOX) {
  await browser.inspect('(async () => { await chrome.storage.local.set({ enabled: false }); enabled = false; await switchOff(); })()');
  const off = await browser.inspect('[controlled.size, status, JSON.stringify(tabMenu())]');
  expect(off[0] === 0 && off[1] === 'disabled' && off[2] === '[]', `switched off: ${JSON.stringify(off)}`);
  await call(claude, 'list_tabs', {}, true);
  await browser.inspect('(async () => { await chrome.storage.local.set({ enabled: true }); enabled = true; connect(); })()');
  await new Promise(r => setTimeout(r, 1500));
  await call(claude, 'list_tabs');
}
await codex.close();
await sleep(500);
console.log('after codex exits, extension sees:', JSON.stringify(await browser.inspect('agents')));
await claude.close(); await browser.close(); srv.close();
await sleep(500);
console.log('leftover host files:', readdirSync(HOME + '/hosts'));
console.log(fails ? `\nFAILURES: ${fails}` : '\nALL PASS');
process.exit(fails ? 1 : 0);
