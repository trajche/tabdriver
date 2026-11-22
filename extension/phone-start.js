// Registered while a tab is in phone view (Firefox): tells the background a page starts in the phone frame.
if (window !== top && parent === top && window.name.startsWith('tabdriver-phone:')) {
  browser.runtime.sendMessage({ type: 'phone-start' }).catch(() => {});
}
