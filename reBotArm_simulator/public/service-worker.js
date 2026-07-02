// [Modified by fanhao375 2026-07-01] bump ->v11（新增 /sim3d/ 3D 物理仿真页，其资源走网络优先）
const CACHE_NAME = 'rebot-arm-pwa-v11';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.png',
  '/css/rebot-sim.css',
  '/css/station-shell.css',
  '/js/station-shell.js',
  '/js/pwa.js',
  '/js/rebot-sim.js?v=20260520-cn-status',
  '/js/ros/rebot-ros-client.js?v=20260520-cn-status',
  '/js/ros/rebot-ros-ui.js?v=20260520-cn-status',
  '/js/platform-notice.js?v=20260629-fh',
  '/js/teleop-launcher.js?v=20260629-fh',
  '/lib/three-r128.min.js',
  '/lib/STLLoader-umd.js',
  '/lib/URDFLoader.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // [Modified by fanhao375 2026-06-30] HTML 文档（页面）网络优先：保证 cockpit.html/train.html 等页面改动立即生效，离线回退缓存
  const isDoc = request.mode === 'navigate' || request.destination === 'document' || url.pathname.endsWith('.html');
  if (isDoc) {
    event.respondWith(
      fetch(request).then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => caches.match(request))
    );
    return;
  }

  // [Added by fanhao375 2026-07-01] /sim3d/ 3D 仿真页在积极开发，其 JS/MJCF/网格走网络优先：改了立即生效，离线回退缓存。
  // （跨域 CDN 的 three/mujoco-js 因 origin 不同在上面 line 44 已直接放行，不进 SW 缓存。）
  if (url.pathname.startsWith('/sim3d/')) {
    event.respondWith(
      fetch(request).then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => caches.match(request))
    );
    return;
  }

  // 其余静态资源（库 / 网格 / CSS / JS）缓存优先：快且可离线
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response || response.status !== 200) return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});
