// Desktop glue for the hosted site: native notifications and a dock badge
// for interviews waiting on you (web push doesn't reach a webview), links that leave the
// site open in the default browser, and Cmd+R to reload.
(() => {
  if (location.origin !== window.__KIM_ORIGIN__ || window.top !== window)
    return;
  const tauri = window.__TAURI__;
  if (!tauri) return;

  const POLL_MS = 30_000;

  const { getCurrentWindow } = tauri.window;
  const notification = tauri.notification;
  let seen = null;

  async function notify(session) {
    if (document.hasFocus()) return;
    let granted = await notification.isPermissionGranted();
    if (!granted)
      granted = (await notification.requestPermission()) === "granted";
    if (granted)
      notification.sendNotification({
        title: session.title,
        body: `${session.open} question${session.open === 1 ? "" : "s"} waiting`,
      });
  }

  async function poll() {
    try {
      const response = await fetch("/api/browser/overview", {
        credentials: "same-origin",
      });
      if (!response.ok) return;
      const { sessions } = await response.json();
      const waiting = sessions.filter((session) => session.open > 0);
      await getCurrentWindow().setBadgeCount(waiting.length || undefined);
      // The first load only learns what's there; later ones announce what's new.
      if (seen)
        for (const session of waiting)
          if (!seen.has(session.id)) await notify(session);
      seen = new Set(waiting.map((session) => session.id));
    } catch {
      // Offline or signed out; try again next time.
    }
  }

  void poll();
  setInterval(poll, POLL_MS);
  window.addEventListener("focus", () => void poll());

  let windows = 0;
  function open(href) {
    const url = new URL(href, location.href);
    if (url.origin === location.origin) {
      new tauri.webviewWindow.WebviewWindow(`page-${Date.now()}-${windows++}`, {
        url: url.href,
        title: "Keep it moving",
        width: 1100,
        height: 760,
      });
    } else if (/^(https?|mailto):$/.test(url.protocol)) {
      void tauri.opener.openUrl(url.href);
    }
  }

  window.open = (href) => {
    if (href) open(String(href));
    return null;
  };

  document.addEventListener(
    "click",
    (event) => {
      const link =
        event.target instanceof Element && event.target.closest("a[href]");
      if (!link || event.defaultPrevented) return;
      const url = new URL(link.href, location.href);
      const external = url.origin !== location.origin;
      const newTab = link.target === "_blank" || event.metaKey || event.ctrlKey;
      if (!external && !newTab) return;
      event.preventDefault();
      open(url.href);
    },
    true,
  );

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "r") {
      event.preventDefault();
      location.reload();
    }
  });
})();
