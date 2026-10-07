/*
 * Shows a notification when the Worker pushes. Pushes carry no data, so
 * this asks the server which interview is waiting; with the Access session
 * expired that request fails and a plain "needs you" opens the home page.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

const ICON = "/icons/icon-192.png";
const BADGE = "/icons/badge-96.png";

async function waitingNotification() {
  let sessions = null;
  try {
    const response = await fetch("/api/browser/overview", {
      credentials: "same-origin",
      redirect: "error",
    });
    if (response.ok) sessions = (await response.json()).sessions;
  } catch {
    /* signed out or offline */
  }
  if (!sessions)
    return self.registration.showNotification("An interview needs you", {
      body: "Open the interviewer to answer.",
      icon: ICON,
      badge: BADGE,
      tag: "interviewer",
      data: { url: "/" },
    });
  const waiting = sessions
    .filter((session) => session.open > 0)
    .sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
  const latest = waiting[0];
  // Every push must show something; this one is a test or already answered.
  if (!latest && !(await newestInboxItem()))
    return self.registration.showNotification("Interviewer", {
      body: "Nothing is waiting on you right now.",
      icon: ICON,
      badge: BADGE,
      tag: "interviewer",
      data: { url: "/" },
    });
  // Keep it moving pushes for other inbox items too (an agent waiting, a
  // failed check); show whichever is newer, that or the interview.
  const item = await newestInboxItem();
  if (item && (!latest || item.since > latest.lastActivity))
    return self.registration.showNotification(item.title, {
      body:
        item.brief.length > 180 ? `${item.brief.slice(0, 179)}…` : item.brief,
      icon: ICON,
      badge: BADGE,
      tag: "interviewer",
      renotify: true,
      data: { url: "/" },
    });
  const others = waiting.length - 1;
  return self.registration.showNotification(
    latest.project ? `${latest.project.name} · ${latest.title}` : latest.title,
    {
      body:
        `${latest.open} question${latest.open === 1 ? "" : "s"} waiting` +
        (others
          ? ` · ${others} more interview${others === 1 ? "" : "s"} need you`
          : ""),
      icon: ICON,
      badge: BADGE,
      tag: "interviewer",
      renotify: true,
      data: { url: `/s/${latest.token}` },
    },
  );
}

/** The newest inbox item other than a request (those are interviews). */
async function newestInboxItem() {
  try {
    const response = await fetch("/api/browser/kim/inbox", {
      credentials: "same-origin",
      redirect: "error",
    });
    if (!response.ok) return null;
    const { items } = await response.json();
    return (
      items
        .filter((item) => item.kind !== "request")
        .sort((a, b) => b.since.localeCompare(a.since))[0] ?? null
    );
  } catch {
    return null;
  }
}

self.addEventListener("push", (event) =>
  event.waitUntil(waitingNotification()),
);

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin)
    .href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const open = windows.find((client) => client.url === url);
      if (open) return open.focus();
      const any = windows[0];
      if (any) {
        await any.navigate(url);
        return any.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
