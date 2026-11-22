// The Firefox phone view: the site in a phone-sized frame at the page's top left corner (phone.js
// captures that rectangle). The sandbox only stops the site from navigating this page away.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const q = new URLSearchParams(location.search);
  const isWebUrl = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
  const url = q.get('url');
  if (!isWebUrl(url)) return;
  document.title = `Phone view · ${new URL(url).host}`;
  const frame = document.createElement('iframe');
  frame.name = q.get('name');
  frame.style.width = `${Number(q.get('w'))}px`;
  frame.style.height = `${Number(q.get('h'))}px`;
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups ' +
    'allow-popups-to-escape-sandbox allow-pointer-lock allow-presentation allow-orientation-lock');
  frame.allow = 'fullscreen; clipboard-write; web-share';
  // Lay the frame out before loading: in a hidden tab the page would otherwise start at 0x0.
  document.body.append(frame);
  frame.getBoundingClientRect();
  frame.addEventListener('load', () => api.runtime.sendMessage({ type: 'phone-loaded' }).catch(() => {}));
  frame.src = url;
  api.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'phone-go' && msg.tabId === Number(q.get('tab')) && isWebUrl(msg.url)) frame.src = msg.url;
  });
})();
