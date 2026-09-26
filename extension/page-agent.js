// Injected into controlled tabs (isolated world). Builds snapshots, performs
// DOM actions, and renders the in-page UI (control banner, prompts, highlights).
// Uses only standard DOM + WebExtension APIs so it ports to Firefox as-is.

(() => {
  if (window.__tabdriver) return;
  const api = globalThis.browser ?? globalThis.chrome;
  const FIREFOX = 'wrappedJSObject' in window; // Firefox content scripts see the page through Xray wrappers

  // ---------- element refs ----------
  const elToRef = new WeakMap();
  const refToEl = new Map();
  let refCounter = 0;

  function refFor(el) {
    let r = elToRef.get(el);
    if (!r) {
      r = 'e' + ++refCounter;
      elToRef.set(el, r);
    }
    refToEl.set(r, el);
    return r;
  }

  function resolve(ref) {
    const el = refToEl.get(ref);
    if (!el) throw new Error(`Unknown ref "${ref}". Take a new snapshot.`);
    if (!el.isConnected) throw new Error(`Element ${ref} is no longer on the page. Take a new snapshot.`);
    return el;
  }

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s, n = 80) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };

  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'combobox', 'switch', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem', 'listbox',
  ]);

  function isOurUi(el) {
    return el.hasAttribute?.('data-tabdriver-ui');
  }

  function isVisible(el) {
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'hidden') return null;
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'range') return 'slider';
      if (t === 'search') return 'searchbox';
      if (t === 'file') return 'file';
      return 'textbox';
    }
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    return null;
  }

  function isInteractive(el) {
    const role = roleOf(el);
    if (role && (INTERACTIVE_ROLES.has(role) || role === 'file')) return role;
    if (el.hasAttribute('onclick')) return 'clickable';
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && Number(tabindex) >= 0 && el.tagName !== 'BODY') return 'focusable';
    // SPA "div buttons": pointer cursor that isn't just inherited from a parent.
    const cs = getComputedStyle(el);
    if (cs.cursor === 'pointer' && el.parentElement && getComputedStyle(el.parentElement).cursor !== 'pointer') {
      return 'clickable';
    }
    return null;
  }

  function labelText(el) {
    const doc = el.ownerDocument;
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const t = labelledby.split(/\s+/).map((id) => doc.getElementById(id)?.innerText || '').join(' ');
      if (t.trim()) return t;
    }
    if (el.labels?.length) return [...el.labels].map((l) => l.innerText).join(' ');
    if (el.id) {
      const l = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return l.innerText;
    }
    return '';
  }

  function accessibleName(el) {
    const tag = el.tagName;
    let name = labelText(el);
    if (!name && (tag === 'INPUT' || tag === 'TEXTAREA')) {
      name = el.placeholder || el.title || (['submit', 'button', 'reset'].includes(el.type) ? el.value : '');
    }
    if (!name && tag === 'IMG') name = el.alt;
    if (tag === 'SELECT') return clean(name);
    if (!name) name = el.innerText || el.textContent || '';
    if (!name) name = el.title || el.querySelector?.('img[alt]')?.alt || el.querySelector?.('svg title')?.textContent || '';
    return clean(name);
  }

  function describe(el, role) {
    const parts = [`[${refFor(el)}]`, role];
    const name = accessibleName(el);
    if (name) parts.push(JSON.stringify(name));
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') parts.push(el.checked ? 'checked' : 'unchecked');
      else if (t === 'password') parts.push(`type=password${el.value ? ' (filled)' : ''}`);
      else {
        if (t !== 'text' && tag === 'INPUT') parts.push(`type=${t}`);
        if (el.value) parts.push(`value=${JSON.stringify(clean(el.value, 60))}`);
      }
    } else if (tag === 'SELECT') {
      const opts = [...el.options];
      parts.push(`value=${JSON.stringify(clean(el.selectedOptions[0]?.text || '', 40))}`);
      parts.push(`options=[${opts.slice(0, 15).map((o) => JSON.stringify(clean(o.text, 30))).join(', ')}${opts.length > 15 ? ', …' : ''}]`);
    } else if (tag === 'A') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:')) parts.push(`-> ${clean(href, 80)}`);
    }
    const aria = (a) => el.getAttribute(a);
    if (aria('aria-expanded')) parts.push(`expanded=${aria('aria-expanded')}`);
    if (aria('aria-selected') === 'true') parts.push('selected');
    if (aria('aria-checked')) parts.push(`checked=${aria('aria-checked')}`);
    if (el.disabled || aria('aria-disabled') === 'true') parts.push('disabled');
    return parts.join(' ');
  }

  // Walk DOM including open shadow roots and same-origin iframes.
  function* walk(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      const children = [];
      if (node.shadowRoot) children.push(...node.shadowRoot.children);
      if (node.tagName === 'IFRAME') {
        try { if (node.contentDocument?.body) children.push(node.contentDocument.body); } catch {}
      }
      children.push(...(node.children || []));
      for (let i = children.length - 1; i >= 0; i--) {
        const c = children[i];
        if (isOurUi(c)) continue;
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'].includes(c.tagName)) continue;
        stack.push(c);
      }
      if (node !== root) yield node;
    }
  }

  function snapshot({ maxTextChars = 6000, includeText = true } = {}) {
    const lines = [];
    const MAX = 1500;
    let skipped = 0;
    for (const el of walk(document.documentElement)) {
      const role = isInteractive(el);
      if (!role) continue;
      if (!isVisible(el)) continue;
      if (lines.length >= MAX) { skipped++; continue; }
      lines.push(describe(el, role));
    }
    const out = [
      `URL: ${location.href}`,
      `Title: ${document.title}`,
      `Scroll: ${Math.round(scrollY)}/${Math.max(0, document.documentElement.scrollHeight - innerHeight)}px`,
      '',
      `Interactive elements (${lines.length}${skipped ? `, ${skipped} more omitted` : ''}):`,
      ...lines,
    ];
    if (includeText) {
      let t = (document.body?.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
      if (t.length > maxTextChars) t = t.slice(0, maxTextChars) + `\n… [truncated, ${t.length} chars total; use get_text]`;
      out.push('', 'Page text:', t);
    }
    return out.join('\n');
  }

  // ---------- in-page UI (shadow DOM so page CSS can't touch it) ----------
  let ui;
  function getUi() {
    if (ui?.host.isConnected) return ui;
    const host = document.createElement('tabdriver-ui');
    host.setAttribute('data-tabdriver-ui', '');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        [hidden] { display: none !important; }
        * { box-sizing: border-box; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .pill { position: fixed; right: 12px; bottom: 12px; display: flex; gap: 8px; align-items: center;
          background: #1f1d2b; color: #fff; padding: 6px 8px 6px 12px; border-radius: 999px;
          box-shadow: 0 4px 16px rgba(0,0,0,.3); pointer-events: auto; opacity: .92; }
        .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #d97757; animation: pulse 1.6s infinite; }
        @keyframes pulse { 50% { opacity: .35; } }
        button { cursor: pointer; border: 0; border-radius: 999px; padding: 4px 10px; background: #3a3750; color: #fff; }
        button:hover { background: #4a4768; }
        button.primary { background: #d97757; }
        button.primary:hover { background: #e8896a; }
        .card { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); max-width: 520px; width: calc(100% - 32px);
          background: #1f1d2b; color: #fff; padding: 14px 16px; border-radius: 12px; pointer-events: auto;
          box-shadow: 0 8px 32px rgba(0,0,0,.35); border: 2px solid #d97757; }
        .card .title { font-weight: 600; margin-bottom: 6px; }
        .card .msg { white-space: pre-wrap; margin-bottom: 12px; }
        .card .actions { display: flex; gap: 8px; justify-content: flex-end; }
        .hl { position: fixed; border: 2px solid #d97757; background: rgba(217,119,87,.15); border-radius: 4px;
          transition: opacity .6s; pointer-events: none; }
        .hl span { position: absolute; top: -20px; left: -2px; background: #d97757; color: #fff; font-size: 11px;
          padding: 1px 6px; border-radius: 4px; white-space: nowrap; }
        .pointer { position: fixed; left: 0; top: 0; will-change: transform; transition: opacity .4s;
          filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
        .pointer.idle { opacity: .55; }
        .pointer svg { display: block; width: 24px; height: 24px; transform-origin: 4px 2px; transition: transform .08s; }
        .pointer.press svg { transform: scale(.82); }
        .pointer .tag { position: absolute; left: 18px; top: 22px; background: #d97757; color: #fff; font-size: 11px;
          font-weight: 600; padding: 2px 7px; border-radius: 999px; white-space: nowrap; }
        .pointer .ring { position: absolute; left: -10px; top: -12px; width: 28px; height: 28px; border-radius: 50%;
          border: 2px solid #d97757; opacity: 0; }
        .pointer.press .ring { animation: ring .3s ease-out; }
        @keyframes ring { from { transform: scale(.3); opacity: .9; } to { transform: scale(1.5); opacity: 0; } }
      </style>
      <div class="pointer" hidden><div class="ring"></div>
        <svg viewBox="0 0 24 24"><path d="M4 2v17l4.5-4.5 3 6.5 2.6-1.1-3-6.4H17.5z" fill="#d97757" stroke="#fff"
          stroke-width="1.6" stroke-linejoin="round"/></svg><span class="tag"></span></div>
      <div class="pill" hidden><span class="dot"></span><span class="label"></span><button class="stop">Stop</button></div>
      <div class="card" hidden><div class="title"></div><div class="msg"></div><div class="actions"></div></div>`;
    (document.body || document.documentElement).appendChild(host);
    const pill = root.querySelector('.pill');
    pill.querySelector('.stop').addEventListener('click', () => api.runtime.sendMessage({ type: 'release-tab' }));
    ui = { host, root, pill, card: root.querySelector('.card'), pointer: root.querySelector('.pointer') };
    return ui;
  }

  // `pointer`: { enabled, x, y } from the background; x/y is where the pointer was on the previous page.
  function setControlled({ on, agent, pointer: cfg }) {
    const { pill, pointer: el } = getUi();
    pill.hidden = !on;
    pill.querySelector('.label').textContent = agent ? `${agent} is controlling this tab` : 'AI agents may control this tab';
    pointer.enabled = on && cfg?.enabled !== false;
    el.querySelector('.tag').textContent = agent || 'AI';
    if (!pointer.enabled) el.hidden = true;
    else if (pointer.x == null && Number.isFinite(cfg?.x)) {
      placePointer(cfg.x, cfg.y);
      el.hidden = false;
      el.classList.add('idle');
    }
    return true;
  }

  // ---------- agent pointer ----------
  // A pointer glides to each element the agent acts on, so the user can follow along. The path
  // bends slightly and the speed follows a minimum-jerk profile (quick start, soft landing), the
  // way a hand moves a mouse. Hidden tabs don't run animation frames, so there it just jumps.
  const pointer = { enabled: false, x: null, y: null, idleTimer: 0 };

  function placePointer(x, y) {
    getUi().pointer.style.transform = `translate(${x - 4}px, ${y - 2}px)`; // the arrow's tip is at (4, 2)
    pointer.x = x;
    pointer.y = y;
  }

  async function movePointer(x, y) {
    if (!pointer.enabled) return;
    const el = getUi().pointer;
    el.hidden = false;
    el.classList.remove('idle');
    clearTimeout(pointer.idleTimer);
    if (pointer.x == null) placePointer(innerWidth * 0.62, innerHeight * 0.72);
    const x0 = pointer.x, y0 = pointer.y, dx = x - x0, dy = y - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 3 || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      placePointer(x, y);
    } else {
      const ms = Math.min(750, 220 + dist * 0.45);
      const bend = (Math.random() - 0.5) * 0.4 * dist; // sideways arc, like a wrist
      const cx = (x0 + x) / 2 - (dy / dist) * bend, cy = (y0 + y) / 2 + (dx / dist) * bend;
      await new Promise((done) => {
        const t0 = performance.now();
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(safety);
          placePointer(x, y);
          done();
        };
        const safety = setTimeout(finish, ms + 250); // in case frames stop (tab hidden mid-move)
        const frame = (now) => {
          const t = Math.min(1, (now - t0) / ms);
          if (t >= 1 || finished) return finish();
          const e = t * t * t * (10 - 15 * t + 6 * t * t);
          const u = 1 - e;
          placePointer(u * u * x0 + 2 * u * e * cx + e * e * x, u * u * y0 + 2 * u * e * cy + e * e * y);
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
    }
    pointer.idleTimer = setTimeout(() => el.classList.add('idle'), 3000);
    api.runtime.sendMessage({ type: 'pointer-at', x, y }).catch(() => {});
  }

  async function pressPointer() {
    if (!pointer.enabled) return;
    const el = getUi().pointer;
    el.classList.remove('press');
    void el.offsetWidth; // restart the ripple
    el.classList.add('press');
    setTimeout(() => el.classList.remove('press'), 300);
    await sleep(90);
  }

  function highlight(el, label) {
    try {
      const r = el.getBoundingClientRect();
      const box = document.createElement('div');
      box.className = 'hl';
      box.style.cssText = `left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;`;
      if (label) { const s = document.createElement('span'); s.textContent = label; box.appendChild(s); }
      getUi().root.appendChild(box);
      setTimeout(() => { box.style.opacity = '0'; }, 700);
      setTimeout(() => box.remove(), 1400);
    } catch {}
  }

  // Prompt card. Answers go to the background via runtime messages so they
  // survive page navigations (the background re-shows the prompt after loads).
  function showPrompt({ id, kind, title, message }) {
    const { card } = getUi();
    card.hidden = false;
    card.querySelector('.title').textContent = title;
    card.querySelector('.msg').textContent = message;
    const actions = card.querySelector('.actions');
    actions.textContent = '';
    const buttons = kind === 'access'
      ? [['Deny', 'deny', ''], ['Allow', 'allow', 'primary']]
      : [['Cancel', 'cancel', ''], ['Done', 'done', 'primary']];
    for (const [text, answer, cls] of buttons) {
      const b = document.createElement('button');
      b.textContent = text;
      if (cls) b.className = cls;
      b.addEventListener('click', () => {
        card.hidden = true;
        api.runtime.sendMessage({ type: 'prompt-answer', id, answer });
      });
      actions.appendChild(b);
    }
    return true;
  }

  function hidePrompt() {
    if (ui) ui.card.hidden = true;
    return true;
  }

  // ---------- actions ----------
  function centerOf(el) {
    const r = el.getBoundingClientRect();
    // Account for same-origin iframes: offset by the frame's position.
    let x = r.left + r.width / 2, y = r.top + r.height / 2;
    let win = el.ownerDocument.defaultView;
    while (win && win !== window && win.frameElement) {
      const fr = win.frameElement.getBoundingClientRect();
      x += fr.left; y += fr.top;
      win = win.parent;
    }
    return { x, y };
  }

  // Bring `el` into view, move the agent pointer onto it, and flag it. `press` shows a click.
  async function prepare(el, label, press = false) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await sleep(50);
    const { x, y } = centerOf(el);
    await movePointer(x, y);
    highlight(el, label);
    if (press) await pressPointer();
    await sleep(pointer.enabled ? 60 : 150);
  }

  async function click({ ref }) {
    const el = resolve(ref);
    await prepare(el, 'click', true);
    const { x, y } = centerOf(el);
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
    return `Clicked ${describe(el, isInteractive(el) || el.tagName.toLowerCase())}`;
  }

  async function pointFor({ ref }) {
    const el = resolve(ref);
    await prepare(el, 'click', true);
    return centerOf(el);
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
  }

  async function type({ ref, text, clear = true, submit = false }) {
    const el = resolve(ref);
    await prepare(el, 'type', true);
    el.focus();
    const isField = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
    if (clear) {
      if (isField) el.select?.();
      else document.getSelection()?.selectAllChildren(el);
    }
    // execCommand produces native input events that frameworks (React, Vue) observe.
    const ok = document.execCommand('insertText', false, text);
    if (isField && (!ok || !el.value.endsWith(text))) {
      setNativeValue(el, clear ? text : el.value + text);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (submit) await pressKey({ key: 'Enter', ref });
    return `Typed into ${ref}${submit ? ' and pressed Enter' : ''}`;
  }

  async function selectOption({ ref, value }) {
    const el = resolve(ref);
    if (el.tagName !== 'SELECT') throw new Error(`${ref} is not a <select>; click it and pick an option instead.`);
    await prepare(el, 'select', true);
    const want = value.toLowerCase().trim();
    const opt = [...el.options].find((o) => o.value === value)
      || [...el.options].find((o) => o.text.toLowerCase().trim() === want)
      || [...el.options].find((o) => o.text.toLowerCase().includes(want));
    if (!opt) throw new Error(`No option matching "${value}"`);
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return `Selected "${opt.text}"`;
  }

  async function pressKey({ key, ref }) {
    const el = ref ? resolve(ref) : (document.activeElement || document.body);
    if (ref) { await prepare(el, key); el.focus(); }
    const opts = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, composed: true };
    if (key === 'Enter') Object.assign(opts, { keyCode: 13, which: 13 });
    const notCancelled = el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    // Synthetic Enter doesn't submit forms natively; do it explicitly.
    if (key === 'Enter' && notCancelled && el.form && el.tagName === 'INPUT') {
      el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
    }
    return `Pressed ${key}`;
  }

  function mainScroller() {
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollHeight > se.clientHeight + 10) return se;
    let best = se, bestArea = 0;
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight <= el.clientHeight + 10) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    return best;
  }

  async function scroll({ ref, direction = 'down', pixels }) {
    if (ref) {
      const el = resolve(ref);
      await prepare(el, 'scroll');
      return `Scrolled ${ref} into view`;
    }
    const s = mainScroller();
    const amount = pixels ?? Math.round(s.clientHeight * 0.8);
    if (direction === 'top') s.scrollTop = 0;
    else if (direction === 'bottom') s.scrollTop = s.scrollHeight;
    else s.scrollTop += direction === 'up' ? -amount : amount;
    await sleep(200);
    return `Scroll position ${Math.round(s.scrollTop)}/${s.scrollHeight - s.clientHeight}px`;
  }

  async function waitFor({ text, selector, gone = false, timeoutMs = 15000 }) {
    if (!text && !selector) throw new Error('Provide text or selector');
    const deadline = Date.now() + timeoutMs;
    const present = () => {
      if (selector) {
        const el = document.querySelector(selector);
        if (!el || !isVisible(el)) return false;
      }
      if (text && !(document.body?.innerText || '').includes(text)) return false;
      return true;
    };
    while (Date.now() < deadline) {
      if (present() !== gone) return `Condition met (${gone ? 'gone' : 'present'})`;
      await sleep(250);
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${selector || JSON.stringify(text)}${gone ? ' to disappear' : ''}`);
  }

  function getText({ ref }) {
    const el = ref ? resolve(ref) : document.body;
    return el.innerText ?? el.textContent ?? '';
  }

  // Attach files to a file input, or simulate dropping them onto any element
  // (attachment cells, dropzones). Files arrive base64-encoded from the bridge.
  async function uploadFiles({ ref, selector, files }) {
    const el = ref ? resolve(ref) : document.querySelector(selector);
    if (!el) throw new Error(`No element for ${ref || selector}`);
    const names = files.map((f) => f.name).join(', ');
    const isInput = el.tagName === 'INPUT' && el.type === 'file';
    if (!isInput) await prepare(el, 'drop');
    // Firefox hides DataTransfer items from pages when a content script added them,
    // so the background dispatches the drop from the page's own world instead.
    if (!isInput && FIREFOX) {
      const token = String(Math.random()).slice(2);
      el.setAttribute('data-tabdriver-drop', token);
      return { mainWorldDrop: { token, ...centerOf(el), message: `Dropped ${names} onto ${ref || selector}` } };
    }
    const dt = new DataTransfer();
    for (const f of files) {
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.mime, lastModified: Date.now() }));
    }
    if (isInput) {
      el.files = dt.files;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return `Set ${names} on file input ${ref || selector}`;
    }
    const { x, y } = centerOf(el);
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt };
    el.dispatchEvent(new DragEvent('dragenter', opts));
    el.dispatchEvent(new DragEvent('dragover', opts));
    el.dispatchEvent(new DragEvent('drop', opts));
    el.dispatchEvent(new DragEvent('dragleave', { ...opts, dataTransfer: null }));
    return `Dropped ${names} onto ${ref || selector}`;
  }

  const methods = {
    snapshot, click, pointFor, type, select_option: selectOption, press_key: pressKey, scroll,
    wait_for: waitFor, get_text: getText, upload_file: uploadFiles, setControlled, showPrompt, hidePrompt,
  };

  window.__tabdriver = {
    async run(method, params) {
      try {
        const fn = methods[method];
        if (!fn) throw new Error(`Unknown page method ${method}`);
        return { ok: true, value: await fn(params || {}) };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    },
  };
})();
