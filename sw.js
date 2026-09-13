// オフラインでも起動できるよう、アプリシェルをキャッシュする。
// 学習データは IndexedDB にあるため、Service Worker はデータを扱わない。
const CACHE = 'aochart-v4';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './src/app.js',
  './src/api.js',
  './src/idb.js',
  './src/seed.js',
  './src/state.js',
  './src/ui.js',
  './src/home.js',
  './src/records.js',
  './src/schedule.js',
  './src/settings.js',
  './src/cloud-sync.js',
  './src/settings-cloud.js',
  './src/datetime.js',
  './src/hash.js',
  './src/question-order.js',
  './data/questions.json',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** 同期・MCP・OAuth の応答はキャッシュしない（古い結果を返すと同期が壊れるため）。 */
function isApiRequest(url) {
  return url.pathname === '/mcp'
    || url.pathname.startsWith('/api/')
    || url.pathname.startsWith('/oauth/')
    || url.pathname.startsWith('/.well-known/');
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // 別のオリジン（同期サーバー）やAPIには、Service Worker は関与しない。
  if (url.origin !== self.location.origin || isApiRequest(url)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
