// GAICANI service worker
// Two rules that matter more than the caching strategy itself:
//   1. Never touch Socket.io or API requests — they must always hit the
//      network directly. Caching or delaying a websocket upgrade or an
//      API call would break real-time chat/games in ways that are hard
//      to notice until someone's mid-game.
//   2. Network-first for everything else, not cache-first. This site
//      changes often; cache-first would mean people keep seeing an old
//      version after every update until the cache happens to expire.
//      The cache here exists so the app still opens (even to a "you're
//      offline" experience) with no connection — not to serve stale
//      pages when a connection IS available.

const CACHE_NAME = "gaicani-v1";
const PRECACHE_URLS = [
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

function shouldBypass(url) {
  return (
    url.pathname.startsWith("/socket.io/") ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/f") || // obfuscated admin routes look like this
    url.pathname.startsWith("/x") ||
    url.pathname.startsWith("/y") ||
    url.pathname.startsWith("/z")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never touch POST/PUT etc.

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // only handle same-origin
  if (shouldBypass(url)) return; // let Socket.io / API calls go straight through, untouched

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Network worked — use it, and quietly refresh the cache copy
        // for next time we're offline.
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        // Only reached when the network request itself failed (offline)
        caches.match(req).then((cached) => cached || caches.match("/dashboard.html"))
      )
  );
});
