const CACHE_NAME = "nexus-aurea-remote-v0.9.2-velora";
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys
      .filter((key) => key.startsWith("nexus-aurea-remote-") && key !== CACHE_NAME)
      .map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  const localScope = new URL("./", self.location.href);
  if (requestUrl.origin !== self.location.origin || !requestUrl.pathname.startsWith(localScope.pathname)) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
