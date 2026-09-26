import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The extension notices when the tabdriver app is missing: it reports "missing", opens the
// setup page on install, and connects once the app is registered, without a reload.
// Usage: node test/missing-app.mjs [path/to/tabdriver]
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const BIN = resolve(process.argv[2] || join(ROOT, 'bin', 'tabdriver'));
const HOME = mkdtempSync('/tmp/td-');
const udd = mkdtempSync(join(tmpdir(), 'udd-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, got) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}`); };

const ctx = await chromium.launchPersistentContext(udd, {
  channel: 'chromium', headless: true, env: { ...process.env, TABDRIVER_HOME: HOME },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
await sleep(3500);
const before = await sw.evaluate(() => status);
check('no app: status', before === 'missing', before);
const setup = ctx.pages().find((p) => p.url().endsWith('/setup.html'));
check('setup page opened', !!setup, ctx.pages().map((p) => p.url()));

mkdirSync(join(udd, 'NativeMessagingHosts'), { recursive: true });
writeFileSync(join(udd, 'NativeMessagingHosts', 'com.tabdriver.host.json'), JSON.stringify({
  name: 'com.tabdriver.host', description: 't', path: BIN, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`],
}));
await sleep(4500); // the setup page asks the extension to retry every 3 s
const after = await sw.evaluate(() => [status, hostVersion]);
check('app installed: status', after[0] === 'connected' && !!after[1], after);
if (setup) {
  const pill = await setup.locator('#status').textContent();
  check('setup page shows it', pill === 'Installed', pill);
}
await ctx.close();
console.log(fails ? `\nFAILURES: ${fails}` : '\nALL PASS');
process.exit(fails ? 1 : 0);
