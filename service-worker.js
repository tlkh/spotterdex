const CACHE_VERSION = "spotterdex-v5-sqlite";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const THUMB_CACHE = `${CACHE_VERSION}-thumbs`;
const PHOTO_CACHE = `${CACHE_VERSION}-photos`;
const THUMB_LIMIT = 80;
const PHOTO_LIMIT = 12;
const SHELL_PATHS = [
  "./",
  "index.html",
  "aircraft-dex.html",
  "squadrons.html",
  "airshows.html",
  "stats.html",
  "styles.css",
  "script.js",
  "manifest.webmanifest",
  "data/spotterdex-core.js",
  "assets/icons/spotterdex-app-icon.png",
  "assets/icons/spotterdex-app-icon-192.png",
  "assets/icons/spotterdex-app-icon-maskable-512.png",
  "assets/icons/spotterdex-apple-touch-icon-v3.png"
];

const scopedUrl = (path) => new URL(path, self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_PATHS.map(scopedUrl)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  const retainedCaches = new Set([SHELL_CACHE, THUMB_CACHE, PHOTO_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith("spotterdex-") && !retainedCaches.has(name)).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) {
    return;
  }
  // Keep the local catalog manager outside the site's offline shell. The
  // manager uses the same origin during local development, and cached
  // navigations here would otherwise turn /manager/ into the main app.
  if (url.pathname.startsWith(`${scope.pathname}manager/`)) {
    return;
  }

  if (request.mode === "navigate") {
    const update = updateCachedNavigation(request);
    event.respondWith(cachedNavigation(request, update));
    event.waitUntil(update.catch(() => null));
    return;
  }
  if (isCatalogData(url)) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (url.pathname.includes("/assets/generated/thumbs/")) {
    event.respondWith(runtimeMedia(request, THUMB_CACHE, THUMB_LIMIT));
    return;
  }
  if (url.pathname.includes("/assets/generated/photos/")) {
    event.respondWith(runtimeMedia(request, PHOTO_CACHE, PHOTO_LIMIT));
    return;
  }
  if (SHELL_PATHS.some((path) => scopedUrl(path) === url.href)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

async function updateCachedNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
  }
  return response;
}

async function cachedNavigation(request, update) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) {
    return cached;
  }

  try {
    return await update;
  } catch (error) {
    return await cache.match(scopedUrl("index.html"));
  }
}

function isCatalogData(url) {
  return /\/data\/spotterdex(?:-data|-map-data|-exif)?\.(?:js|json)$/.test(url.pathname);
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
    if (cached) {
      return cached;
    }
    if (request.mode === "navigate") {
      return cache.match(scopedUrl("index.html"));
    }
    throw error;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const update = fetch(request).then(async (response) => {
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);
  if (cached) {
    return cached;
  }
  return await update || Response.error();
}

async function runtimeMedia(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    await trimCache(cache, limit);
  }
  return response;
}

async function trimCache(cache, limit) {
  const keys = await cache.keys();
  const excess = keys.length - limit;
  if (excess > 0) {
    await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
  }
}
