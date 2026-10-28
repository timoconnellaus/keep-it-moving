/*
 * Shows a notification when the Worker pushes. Pushes carry no data, so
 * this asks the server which interview is waiting; with the sign-in
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
      body: "Open Keep it moving to answer.",
      icon: ICON,
      badge: BADGE,
      tag: "keep-it-moving",
      data: { url: "/" },
    });
  const waiting = sessions
    .filter((session) => session.open > 0)
    .sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
  const latest = waiting[0];
  const reply = latestReply(sessions);
  // An agent's chat reply pushes too; show it when it is the newest thing.
  if (reply && (!latest || reply.lastReply.at >= latest.lastActivity)) {
    const text = reply.lastReply.text;
    return self.registration.showNotification(
      reply.project ? `${reply.project.name} · ${reply.title}` : reply.title,
      {
        body: `Agent: ${text.length > 170 ? `${text.slice(0, 169)}…` : text}`,
        icon: ICON,
        badge: BADGE,
        tag: "keep-it-moving",
        renotify: true,
        data: { url: `/s/${reply.token}` },
      },
    );
  }
  // Every push must show something; this one is a test or already answered.
  if (!latest)
    return self.registration.showNotification("Keep it moving", {
      body: "Nothing is waiting on you right now.",
      icon: ICON,
      badge: BADGE,
      tag: "keep-it-moving",
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
      tag: "keep-it-moving",
      renotify: true,
      data: { url: `/s/${latest.token}` },
    },
  );
}

/** The active interview whose agent replied in its chat most recently. */
function latestReply(sessions) {
  return (
    sessions
      .filter((session) => session.status === "active" && session.lastReply)
      .sort((a, b) => b.lastReply.at.localeCompare(a.lastReply.at))[0] ?? null
  );
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
