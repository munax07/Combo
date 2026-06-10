// ═══════════════════════════════════════════════
//   UNIPARTS · Service Worker · munax
//   Offline-first: cache shell + API responses
// ═══════════════════════════════════════════════
"use strict";

const CACHE_NAME    = "uniparts-v1";
const API_CACHE     = "uniparts-api-v1";

// App shell — always cached on install
const SHELL_URLS = [
  "/",
  "/dashboard"
];

// ── Install: cache the shell ──
self.addEventListener("install", evt => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

// ── Activate: clear old caches ──
self.addEventListener("activate", evt => {
  evt.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== API_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first for API, cache-first for shell ──
self.addEventListener("fetch", evt => {
  const url = new URL(evt.request.url);

  // API endpoints — network first, fall back to cache
  if (
    url.pathname.startsWith("/categories") ||
    url.pathname.startsWith("/search") ||
    url.pathname.startsWith("/health") ||
    url.pathname.startsWith("/updates") ||
    url.pathname.startsWith("/version")
  ) {
    evt.respondWith(
      fetch(evt.request)
        .then(res => {
          // Only cache successful GET responses
          if (res.ok && evt.request.method === "GET") {
            const clone = res.clone();
            caches.open(API_CACHE).then(cache => cache.put(evt.request, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(evt.request).then(cached => {
            if (cached) return cached;
            // Return offline JSON for search
            if (url.pathname.startsWith("/search")) {
              return new Response(
                JSON.stringify({ success: false, offline: true, results: [], totalMatches: 0 }),
                { headers: { "Content-Type": "application/json" } }
              );
            }
            return new Response(
              JSON.stringify({ success: false, offline: true }),
              { headers: { "Content-Type": "application/json" } }
            );
          })
        )
    );
    return;
  }

  // Shell & static assets — cache first, network fallback
  evt.respondWith(
    caches.match(evt.request).then(cached => {
      if (cached) return cached;
      return fetch(evt.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(evt.request, clone));
        }
        return res;
      });
    })
  );
});
