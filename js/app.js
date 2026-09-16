/* app.js — bootstrap ของแอพ
   หน้าที่: ลงทะเบียน service worker · สลับมุมมอง · เรียกให้ ui วาด · สะกิดคิวส่งเมื่อมีจังหวะ
   ห้ามใส่ตรรกะข้อมูล (อยู่ใน db.js) หรือการเรียกเน็ต (อยู่ใน net.js) ที่นี่ */
import * as db from './db.js';
import * as ui from './ui.js';
import * as net from './net.js';
import * as extras from './ui-1a.js';

const VIEWS = ['Day', 'Month', 'Form', 'Body', 'Settings'];
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

/* ดึงหน้าจอลงจากบนสุดแล้วปล่อย = รีเฟรช (เช็คโค้ดใหม่ + ดึงข้อมูลใหม่) แทนปิด-เปิดแอพเอง
   ทำงานเองทั้งหมด (ไม่พึ่ง native pull-to-refresh ของ iOS ซึ่งใน standalone PWA ไม่มีให้) */
function wirePullRefresh() {
  const appEl = $('app'), ind = $('pullRefresh'), icon = $('pullRefreshIcon'), text = $('pullRefreshText');
  if (!appEl || !ind || !icon || !text) return;
  const MAX = 88, TRIGGER = 62;
  let startY = 0, curPull = 0, dragging = false, refreshing = false, hapticFired = false;

  const setPull = (px) => {
    curPull = px;
    appEl.style.transform = px ? `translateY(${px}px)` : '';
    ind.style.opacity = px > 2 ? String(Math.min(px / TRIGGER, 1)) : '0';
    ind.style.transform = `translateY(${Math.min(px, MAX) - 40}px)`;
    if (!refreshing) text.textContent = px >= TRIGGER ? 'ปล่อยเพื่อรีเฟรช' : 'ดึงลงเพื่อรีเฟรช';
    icon.textContent = px >= TRIGGER ? '↑' : '↓';
    // สั่นเบาๆ ตอนดึงถึงจุดปล่อยได้พอดี (ครั้งเดียวต่อการดึง) เผื่อไม่ได้มองจอ จะได้รู้ว่าปล่อยแล้วรีเฟรชแน่
    if (px >= TRIGGER && !hapticFired) { hapticFired = true; try { navigator.vibrate?.(15); } catch (_) {} }
    else if (px < TRIGGER) hapticFired = false;
  };
  const snapBack = () => {
    appEl.style.transition = 'transform .25s cubic-bezier(.2,.8,.2,1)';
    ind.style.transition = 'transform .25s ease, opacity .2s ease';
    setPull(0);
    setTimeout(() => { appEl.style.transition = ''; ind.style.transition = ''; }, 260);
  };

  document.addEventListener('touchstart', (e) => {
    if (refreshing || window.scrollY > 0) { dragging = false; return; }
    if (e.target?.closest?.('#estDetail, #foodSuggest, input, textarea, select')) { dragging = false; return; }
    startY = e.touches[0].clientY;
    dragging = true;
    hapticFired = false;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!dragging || refreshing) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) { if (curPull) snapBack(); dragging = false; return; }
    appEl.style.transition = 'none';
    ind.style.transition = 'none';
    setPull(Math.min(dy * 0.45, MAX));
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    if (curPull >= TRIGGER) doRefresh(); else snapBack();
  });
  document.addEventListener('touchcancel', () => { if (dragging) { dragging = false; snapBack(); } });

  async function doRefresh() {
    refreshing = true;
    icon.classList.add('spin');
    icon.textContent = '⟳';
    text.textContent = 'กำลังรีเฟรช…';
    appEl.style.transition = 'transform .2s ease';
    ind.style.transition = 'transform .2s ease, opacity .2s ease';
    setPull(48);
    try {
      try { const reg = await navigator.serviceWorker?.getRegistration?.(); if (reg) await reg.update(); } catch (_) {}
      try { await net.flush?.('pull'); } catch (e) { console.warn('[pull-refresh] flush', e); }
      let v = 'Day';
      try { v = localStorage.getItem('cal.view') || 'Day'; } catch (_) {}
      ui.onShow?.(v);
    } finally {
      icon.classList.remove('spin');
      refreshing = false;
      snapBack();
    }
  }
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
  await tryStep('extras.init', () => extras.initExtras());
  wireTabs();
  let v = 'Day';
  try { v = localStorage.getItem('cal.view') || 'Day'; } catch (_) {}
  show(VIEWS.includes(v) ? v : 'Day');
  document.documentElement.setAttribute('data-booted', '1');   // บอก error boundary ว่ารอดแล้ว
  wireSync();
  wirePullRefresh();

  const st = $('syncStatus');
  if (st && !(ok.db && ok.ui)) {
    st.textContent = 'โครงแอพพร้อม · ส่วนที่ยังไม่ได้ทำ: '
      + [!ok.db && 'ฐานข้อมูล', !ok.ui && 'หน้าจอ'].filter(Boolean).join(' / ');
  }

  if ('serviceWorker' in navigator) {
    try {
      const hadController = !!navigator.serviceWorker.controller;
      // SW ใหม่ activate แล้ว แต่หน้านี้ยังรัน js เก่าอยู่ → โหลดใหม่ 1 ครั้ง (ยกเว้นกำลังอยู่หน้าจด กันพิมพ์ค้างหาย)
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloaded) return;
        let v = 'Day';
        try { v = localStorage.getItem('cal.view') || 'Day'; } catch (_) {}
        if (v === 'Form') return;
        reloaded = true;
        location.reload();
      });
      const reg = await navigator.serviceWorker.register('./sw.js');
      try { reg.update(); } catch (_) {}
    } catch (e) { console.warn('[sw] register ไม่สำเร็จ', e); }
  }
}

boot();
