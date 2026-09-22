/* Service worker — ทำให้แอพเปิดได้ตอนไม่มีเน็ต
   - shell ถูก precache ตอนติดตั้ง
   - Google Fonts แคชตอนออนไลน์ครั้งแรก แล้วใช้ต่อได้ตอนออฟไลน์
   - คำขอข้ามโดเมนอื่น (openrouter.ai / api.github.com) และคำขอที่ไม่ใช่ GET ไม่ถูกแตะเลย
     → ไม่มีทางได้คำตอบจากแคชมาหลอกว่าส่งสำเร็จ
   ⚠️ แก้ไฟล์ใดที่อยู่ใน SHELL ต้องเปลี่ยน VERSION ด้วยทุกครั้ง */
const VERSION = 'cal-v26';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/ui.js',
  './js/ui-1a.js',
  './js/net.js',
  './data/foods.json',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // cache:'reload' = ข้าม HTTP cache ของเบราว์เซอร์ (GitHub Pages ส่ง max-age=600)
  //   ไม่งั้นเวอร์ชันใหม่อาจเก็บ js เก่าเข้าแคชใหม่ → มือถือรันโค้ดเก่าทั้งที่ VERSION ขึ้นแล้ว (เจอ 13 ก.ย. cal-v14)
  // add ทีละไฟล์ + จับ error: ถ้าไฟล์ใดหาย (404) SW ยังติดตั้งได้ ไม่ล้มทั้งชุดแบบ addAll
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch((err) => console.warn('[sw] precache miss', u, err)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = /fonts\.(googleapis|gstatic)\.com/.test(url.host);

  // หน้าเอกสาร: network-first — กันหน้าแรกค้างเวอร์ชันเก่า (ถ้าไม่มีเน็ตค่อยใช้ของในแคช)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put('./index.html', copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('./index.html').then((hit) => hit || caches.match('./')))
    );
    return;
  }

  if (sameOrigin) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }))
    );
  } else if (isFont) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
