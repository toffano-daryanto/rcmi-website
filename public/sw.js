// RCMI app: makes the site installable, opens fast (and offline) from cache, and shows push notifications.
const CACHE = "rcmi-v1";
const SHELL = ["/", "/manifest.webmanifest", "/img/icon-192.png", "/img/logo-white.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Pages, scripts and styles: newest from the network, the cached copy when offline.
// Images and region lists: cached copy straight away, refreshed in the background.
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/__/")) return;   // Firebase's own reserved paths
  const put = (res) => { if (res && res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req.mode === "navigate" ? "/" : req, copy)); } return res; };
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(put).catch(() => caches.match("/")));
    return;
  }
  if (/^\/(img|wilayah)\//.test(url.pathname)) {
    e.respondWith(caches.match(req).then(hit => {
      const net = fetch(req).then(put).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  e.respondWith(fetch(req).then(put).catch(() => caches.match(req)));
});

// Push notifications (sent by the site through Firebase Cloud Messaging as data messages).
self.addEventListener("push", (e) => {
  let p = {};
  try { const j = e.data ? e.data.json() : {}; p = j.data || j.notification || j; } catch (err) { p = { body: e.data ? e.data.text() : "" }; }
  const title = p.title || "RCMI";
  e.waitUntil(self.registration.showNotification(title, {
    body: p.body || "",
    icon: "/img/icon-192.png",
    badge: "/img/icon-64.png",
    tag: p.tag || undefined,
    renotify: !!p.tag,
    data: { link: p.link || "/" }
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const link = new URL(e.notification.data?.link || "/", location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (new URL(c.url).origin === location.origin) { c.focus(); return c.navigate ? c.navigate(link) : null; }
    }
    return self.clients.openWindow(link);
  }));
});
