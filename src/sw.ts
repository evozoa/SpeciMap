/// <reference lib="webworker" />
/**
 * Service worker (Workbox injectManifest).
 *
 * - Precaches the app shell so /s/:tagId opens offline once installed.
 * - Caches map tiles CacheFirst for passive offline map coverage.
 * - Never caches Supabase API traffic: the Dexie queue owns all retries
 *   (exactly one retry system in this app).
 */
import { clientsClaim } from 'workbox-core'
import { ExpirationPlugin } from 'workbox-expiration'
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'

declare let self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// SPA navigation fallback: every route serves the shell.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/auth\/callback/],
  }),
)

// Map tiles: passive offline coverage of areas the user has viewed.
registerRoute(
  ({ url }) =>
    /tile\.openstreetmap\.org$/.test(url.hostname) ||
    url.pathname.match(/\/\d+\/\d+\/\d+(@\dx)?\.(png|jpg|webp)$/) != null,
  new CacheFirst({
    cacheName: 'map-tiles',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 1000,
        maxAgeSeconds: 30 * 24 * 60 * 60,
        purgeOnQuotaError: true,
      }),
    ],
  }),
)

// registerType: 'prompt' — the page shows a reload prompt and calls skipWaiting.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    void self.skipWaiting()
  }
})

clientsClaim()
