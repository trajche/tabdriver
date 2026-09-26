import { chromium } from 'playwright';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
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

const PAGE = `<!doctype html><title>Test Bank</title><h1>Transactions</h1>
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
<div style="position:relative"><button>Under banner</button><div id="banner" style="position:absolute;inset:0;background:rgba(0,0,0,.1)"></div></div>`;
const srv = http.createServer((req, res) => {
  if (req.url === '/missing.png') { res.writeHead(404); return res.end(); }
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
const prompts = await claude.listPrompts();
const dog = await claude.getPrompt({ name: 'dogfood', arguments: { url: 'https://app.example.com' } });
expect(prompts.prompts.some(p => p.name === 'dogfood') && /dogfood-output\/app-example-com-/.test(dog.messages[0].content.text), 'dogfood prompt');

await call(codex, 'open_tab', { url: 'http://127.0.0.1:8813/?codex' });
await call(codex, 'upload_file', { selector: '#dz', paths: [BIG] });
await call(codex, 'wait_for', { text: 'drop:big.bin:1500000' });
await call(codex, 'upload_file', { selector: '#fi', paths: [BIG] });
await call(codex, 'wait_for', { text: 'file:big.bin:1500000' });
console.log('claude default tab ->', /Applied|Submitted/.test(await call(claude, 'get_text', {})) ? 'own tab ✓' : 'WRONG TAB');

await codex.close();
await sleep(500);
console.log('after codex exits, extension sees:', JSON.stringify(await browser.inspect('agents')));
await claude.close(); await browser.close(); srv.close();
await sleep(500);
console.log('leftover host files:', readdirSync(HOME + '/hosts'));
console.log(fails ? `\nFAILURES: ${fails}` : '\nALL PASS');
process.exit(fails ? 1 : 0);
