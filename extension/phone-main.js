// Registered while a tab is in phone view (Firefox), in the page's own JS world: makes the phone
// frame look like a phone to scripts. CSS (hover/pointer) queries can't be changed from here.
(() => {
  if (window === top || parent !== top || !window.name.startsWith('tabdriver-phone:')) return;
  let c;
  try { c = JSON.parse(window.name.slice('tabdriver-phone:'.length)); } catch { return; }
  const set = (obj, values) => {
    for (const [k, v] of Object.entries(values)) {
      try { Object.defineProperty(obj, k, { get: () => v, configurable: true, enumerable: true }); } catch {}
    }
  };
  set(Navigator.prototype, { maxTouchPoints: 5 });
  if (c.ua) set(Navigator.prototype, { userAgent: c.ua, appVersion: c.ua.replace(/^Mozilla\//, ''), platform: c.platform });
  set(Screen.prototype, { width: c.w, height: c.h, availWidth: c.w, availHeight: c.h });
  set(window, { devicePixelRatio: c.dpr, orientation: c.w > c.h ? 90 : 0 });
  for (const k of ['ontouchstart', 'ontouchmove', 'ontouchend', 'ontouchcancel']) if (!(k in window)) window[k] = null;
  const yes = '(min-width: 0px)', no = '(max-width: 0px)';
  const matchMedia = window.matchMedia;
  window.matchMedia = function (q) {
    return matchMedia.call(window, String(q)
      .replace(/\((any-)?pointer:\s*coarse\)/gi, yes).replace(/\((any-)?pointer:\s*fine\)/gi, no)
      .replace(/\((any-)?hover:\s*none\)/gi, yes).replace(/\((any-)?hover:\s*hover\)/gi, no));
  };
})();
