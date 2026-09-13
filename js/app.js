/* app.js — bootstrap ของแอพ
   หน้าที่: ลงทะเบียน service worker · สลับมุมมอง · เรียกให้ ui วาด · สะกิดคิวส่งเมื่อมีจังหวะ
   ห้ามใส่ตรรกะข้อมูล (อยู่ใน db.js) หรือการเรียกเน็ต (อยู่ใน net.js) ที่นี่ */
import * as db from './db.js';
import * as ui from './ui.js';
import * as net from './net.js';

const VIEWS = ['Day', 'Month', 'Form', 'Settings'];
const $ = (id) => document.getElementById(id);

export function show(which) {
  for (const v of VIEWS) {
    const sec = $('view' + v), tab = $('tab' + v);
    if (sec) sec.hidden = (v !== which);
    if (tab) tab.setAttribute('aria-current', v === which ? 'page' : 'false');
  }
  try { localStorage.setItem('cal.view', which); } catch (_) {}
  ui.onShow?.(which);
}

function wireTabs() {
  for (const v of VIEWS) $('tab' + v)?.addEventListener('click', () => show(v));
  document.addEventListener('keydown', (e) => {
    if (e.target?.matches?.('input,textarea,select')) return;
    if (e.key === 'ArrowLeft') ui.goDay?.(-1);
    if (e.key === 'ArrowRight') ui.goDay?.(1);
  });
}

/* คิวส่ง: iOS ไม่มี Background Sync → ต้องสะกิดเองทุกจังหวะที่แอพได้กลับมาทำงาน */
function wireSync() {
  let last = 0;
  const flush = (why) => {
    const now = Date.now();
    if (why === 'visible' && now - last < 60000) return;   // debounce 60 วิ
    last = now;
    Promise.resolve(net.flush?.(why)).catch((e) => console.warn('[sync]', why, e));
  };
  addEventListener('online', () => flush('online'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) flush('visible'); });
  setInterval(() => { if (!document.hidden) flush('timer'); }, 300000);
  flush('start');
}

/* ระหว่างที่ยังสร้างไม่เสร็จ: โมดูลที่ยังไม่ทำจะ throw 'ยังไม่ทำ'
   ต้องไม่ทำให้แอพเปิดไม่ขึ้น (ไม่งั้นทดสอบ PWA/ออฟไลน์ไม่ได้เลย) — จับไว้แล้วบอกสถานะ */
async function tryStep(label, fn) {
  try { await fn(); return true; }
  catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('ยังไม่ทำ')) { console.info('[wip]', label, msg); return false; }
    throw e;
  }
}

async function boot() {
  const ok = { db: await tryStep('db.open', () => db.open()), ui: await tryStep('ui.init', () => ui.init?.()) };
  wireTabs();
  let v = 'Day';
  try { v = localStorage.getItem('cal.view') || 'Day'; } catch (_) {}
  show(VIEWS.includes(v) ? v : 'Day');
  document.documentElement.setAttribute('data-booted', '1');   // บอก error boundary ว่ารอดแล้ว
  wireSync();

  const st = $('syncStatus');
  if (st && !(ok.db && ok.ui)) {
    st.textContent = 'โครงแอพพร้อม · ส่วนที่ยังไม่ได้ทำ: '
      + [!ok.db && 'ฐานข้อมูล', !ok.ui && 'หน้าจอ'].filter(Boolean).join(' / ');
  }

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch (e) { console.warn('[sw] register ไม่สำเร็จ', e); }
  }
}

boot();
