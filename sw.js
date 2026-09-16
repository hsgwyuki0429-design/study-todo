// オフラインでも起動できるよう、アプリシェルをキャッシュする。
// 学習データは IndexedDB にあるため、Service Worker はデータを扱わない。
const CACHE = 'aochart-v28';
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
  './src/study-timing.js',
  './src/record-actions.js',
  './src/records.js',
  './src/schedule.js',
  './src/settings.js',
  './src/cloud-sync.js',
  './src/plan-items.js',
  './src/goals.js',
  './src/availability.js',
  './src/estimates.js',
  './src/records-model.js',
  './src/settings-plan.js',
  './src/squares.js',
  './src/day-detail.js',
  './src/day-model.js',
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

  // 画面そのものの読み込みかどうか。オフラインのときに index.html を代わりに返せるのは、
  // これだけである。JS や JSON の代わりに HTML を返すと、
  // 「モジュールのはずが HTML だった」という分かりにくい失敗になるため、
  // 見つからなければ素直に失敗させる。
  const isNavigation = e.request.mode === 'navigate'
    || (e.request.destination === '' && (e.request.headers.get('accept') ?? '').includes('text/html'));

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(e.request);
        if (hit) return hit;
        if (isNavigation) {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        return new Response('', { status: 504, statusText: 'offline' });
      })
  );
});
