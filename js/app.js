/* app.js — bootstrap ของแอพ
   หน้าที่: ลงทะเบียน service worker · สลับมุมมอง · เรียกให้ ui วาด · สะกิดคิวส่งเมื่อมีจังหวะ
   ห้ามใส่ตรรกะข้อมูล (อยู่ใน db.js) หรือการเรียกเน็ต (อยู่ใน net.js) ที่นี่ */
import * as db from './db.js';
import * as ui from './ui.js';
import * as net from './net.js';
import * as extras from './ui-1a.js';

const VIEWS = ['Day', 'Month', 'Form', 'Body', 'Settings'];
const $ = (id) => document.getElementById(id);

let curView = 'Day';   // หน้าปัจจุบัน — ห้ามอ่านจาก hidden เพราะระหว่างเลื่อนหน้าเดิมยังโชว์อยู่

export function show(which) {
  curView = which;
  for (const v of VIEWS) {
    const sec = $('view' + v), tab = $('tab' + v);
    if (sec) sec.hidden = (v !== which);
    if (tab) tab.setAttribute('aria-current', v === which ? 'page' : 'false');
  }
  try { localStorage.setItem('cal.view', which); } catch (_) {}
  ui.onShow?.(which);
}

const reduceMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
const EASE = 'cubic-bezier(.22,.8,.24,1)';
let sliding = null;   // แอนิเมชันที่กำลังเล่น — ปัด/แตะซ้อนให้จบอันเก่าก่อน

const FLOAT_KEYS = ['position', 'top', 'left', 'width', 'pointerEvents', 'transform', 'willChange'];
function unfloat(el) { if (el) for (const k of FLOAT_KEYS) el.style[k] = ''; }
/** ให้หน้าลอย (absolute ใน #app) ที่ตำแหน่ง top บนจอ — ใช้ตอนสองหน้าต้องเห็นพร้อมกัน */
function float(el, top, ref) {
  el.hidden = false;
  Object.assign(el.style, {
    position: 'absolute', top: top + 'px', left: ref.offsetLeft + 'px', width: ref.offsetWidth + 'px', pointerEvents: 'none',
  });
}
const pageW = () => ($('app') && $('app').clientWidth) || window.innerWidth;

/** เปลี่ยนหน้าแบบเลื่อน: หน้าเดิมไหลออก หน้าใหม่ไหลเข้าพร้อมกัน (dir 1 = ไปขวา/ถัดไป · -1 = ย้อน)
    fromX = ตำแหน่งที่นิ้วลากหน้าเดิมค้างไว้ (px) จะได้ต่อจากจุดนั้นไม่กระตุก */
function slideTo(which, dir, fromX = 0, ms = 300) {
  const cur = currentView();
  const out = $('view' + cur), inn = $('view' + which);
  if (sliding) sliding();
  unfloat(inn);   // ถ้าหน้าใหม่โผล่มาระหว่างลาก (peek) กลับเข้า flow ก่อน
  if (which === cur || !out || !inn || !dir || reduceMotion()) {
    if (out) out.style.transform = '';
    show(which);
    window.scrollTo(0, 0);
    return;
  }
  const w = pageW();
  // หน้าเดิมลอยค้างไว้ที่ตำแหน่งเดิมบนจอ (absolute) ระหว่างที่หน้าใหม่เข้ามาแทนที่ใน flow
  const top = out.offsetTop - window.scrollY;
  show(which);
  window.scrollTo(0, 0);
  float(out, top, inn);
  out.style.transform = `translateX(${fromX}px)`;
  const a1 = out.animate(
    [{ transform: `translateX(${fromX}px)`, opacity: 1 }, { transform: `translateX(${-dir * w}px)`, opacity: 0.6 }],
    { duration: ms, easing: EASE, fill: 'forwards' });
  const a2 = inn.animate(
    [{ transform: `translateX(${dir * w + fromX}px)` }, { transform: 'translateX(0)' }],
    { duration: ms, easing: EASE });
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    sliding = null;
    try { a1.cancel(); a2.cancel(); } catch (_) {}
    out.hidden = curView !== cur;
    unfloat(out);
  };
  sliding = finish;
  a2.onfinish = finish;
  setTimeout(finish, ms + 120);   // กันกรณี onfinish ไม่มา (แท็บถูกพักกลางคัน)
}

function wireTabs() {
  for (const v of VIEWS) {
    $('tab' + v)?.addEventListener('click', () => {
      const d = VIEWS.indexOf(v) - VIEWS.indexOf(currentView());
      slideTo(v, Math.sign(d), 0, 260);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.target?.matches?.('input,textarea,select')) return;
    if (e.key === 'ArrowLeft') ui.goDay?.(-1);
    if (e.key === 'ArrowRight') ui.goDay?.(1);
  });
}

/* ปัดซ้าย/ขวา = เปลี่ยนหน้าตามลำดับแถบล่าง (ปัดซ้าย → หน้าถัดไป · ปัดขวา → หน้าก่อน · ไม่วนรอบ)
   ไม่ทำงานเมื่อเริ่มปัดบน: ช่องที่กำลังพิมพ์อยู่ (โฟกัส) · ตัวเลื่อน/ดรอปดาวน์ · แถบที่เลื่อนแนวนอนได้ (จดด่วน) · ป๊อปอัป/ชีต
   ช่องพิมพ์ที่ยังไม่โฟกัสปัดผ่านได้ — หน้าจด/ตาชั่งเต็มไปด้วยช่องพิมพ์ ไม่งั้นแทบปัดออกจากหน้านั้นไม่ได้
   ต้องแนวนอนชัด ๆ (|dx| ≥ 60 px และ ≥ 1.5×|dy|) ไม่งั้นการเลื่อนจอขึ้นลงจะกลายเป็นเปลี่ยนหน้า */
const SWIPE_MIN = 60;   // สะบัดเร็วใช้ครึ่งหนึ่งของระยะนี้
const SWIPE_SKIP = 'select, input[type=range], [contenteditable], #estDetail, #foodSuggest, #quickSheet, .sheet, .est-pop-card';

function scrollsSideways(node) {
  for (let n = node; n && n !== document.body; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
  }
  return false;
}

function currentView() {
  return curView;
}

function wireSwipe() {
  // ลากตามนิ้ว: ล็อกทิศครั้งแรกที่ขยับเกิน 10 px · แนวนอน → หน้าเลื่อนตามนิ้ว (สุดขอบมีแรงต้าน)
  // ปล่อยนิ้ว: ลากเกิน 1/4 จอ หรือสะบัดเร็ว → เปลี่ยนหน้า · ไม่งั้นเด้งกลับ
  let x0 = 0, y0 = 0, t0 = 0, on = false, lock = '', dx = 0, sec = null, idx = 0;
  let peek = null, peekDir = 0;   // หน้าข้าง ๆ ที่โผล่ตามนิ้วมา (ยังไม่วาดใหม่ — โชว์เนื้อหาล่าสุดที่มีอยู่)
  const dropPeek = () => { if (peek) { unfloat(peek); peek.hidden = peek !== $('view' + curView); } peek = null; peekDir = 0; };
  const DEAD = 10;
  document.addEventListener('touchstart', (e) => {
    on = false;
    if (e.touches.length !== 1) return;
    const t = e.target;
    if (t?.closest?.(SWIPE_SKIP) || scrollsSideways(t)) return;
    const ae = document.activeElement;
    if (ae && ae.matches?.('input, textarea') && (ae === t || ae.contains?.(t))) return;
    // ป๊อปอัปเปิดค้างอยู่ (ทับทั้งจอ) → ไม่เปลี่ยนหน้า
    if (document.querySelector('.sheet:not([hidden]), #estDetail:not([hidden])')) return;
    if (sliding) sliding();
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    t0 = performance.now();
    lock = '';
    dx = 0;
    idx = VIEWS.indexOf(currentView());
    sec = $('view' + VIEWS[idx]);
    on = !!sec;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!on) return;
    const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
    if (!lock) {
      if (Math.abs(mx) < DEAD && Math.abs(my) < DEAD) return;
      lock = Math.abs(mx) > Math.abs(my) * 1.2 ? 'x' : 'y';
      if (lock === 'y') { on = false; return; }
      sec.style.willChange = 'transform';
    }
    e.preventDefault();   // ล็อกแนวนอนแล้ว ห้ามจอเลื่อนขึ้นลงตาม
    const atEdge = (mx > 0 && idx === 0) || (mx < 0 && idx === VIEWS.length - 1);
    dx = atEdge ? mx * 0.25 : mx;
    sec.style.transform = `translateX(${dx}px)`;
    const d = mx < 0 ? 1 : -1;
    const n = VIEWS[idx + d];
    if (d !== peekDir) {
      dropPeek();
      if (n) {
        peek = $('view' + n);
        peekDir = d;
        // วางให้ตรงกับตำแหน่งหลังเปลี่ยนหน้า (หน้าใหม่เริ่มบนสุดเสมอ)
        if (peek) { float(peek, sec.offsetTop + window.scrollY, sec); peek.style.willChange = 'transform'; }
      }
    }
    if (peek) peek.style.transform = `translateX(${dx + peekDir * pageW()}px)`;
  }, { passive: false });
  const release = (cancel) => {
    if (!on) return;
    on = false;
    if (lock !== 'x') return;
    sec.style.willChange = '';
    const w = window.innerWidth;
    const v = dx / Math.max(1, performance.now() - t0);   // px/ms
    const dir = dx < 0 ? 1 : -1;
    const next = idx + dir;
    const go = !cancel && next >= 0 && next < VIEWS.length
      && (Math.abs(dx) > w * 0.25 || (Math.abs(dx) > SWIPE_MIN / 2 && Math.abs(v) > 0.45));
    if (go && peekDir !== dir) dropPeek();
    if (go) {
      peek = null;
      peekDir = 0;
      // เวลาที่เหลือสั้นลงตามระยะที่ลากมาแล้ว — ลากมาไกล/สะบัดเร็ว หน้าใหม่ก็เข้าเร็ว
      const ms = Math.round(Math.max(180, Math.min(320, 320 * (1 - Math.abs(dx) / w))));
      slideTo(VIEWS[next], dir, dx, ms);
      return;
    }
    const s0 = sec, from = dx, p0 = peek, pd = peekDir;
    peek = null;
    peekDir = 0;
    s0.style.transform = '';
    if (from && !reduceMotion()) {
      s0.animate([{ transform: `translateX(${from}px)` }, { transform: 'translateX(0)' }], { duration: 220, easing: EASE });
    }
    if (p0) {
      const end = () => { unfloat(p0); p0.hidden = p0 !== $('view' + curView); };
      if (reduceMotion()) end();
      else {
        const a = p0.animate([{ transform: `translateX(${from + pd * pageW()}px)` }, { transform: `translateX(${pd * pageW()}px)` }],
          { duration: 220, easing: EASE, fill: 'forwards' });
        a.onfinish = () => { a.cancel(); end(); };
      }
    }
  };
  document.addEventListener('touchend', () => release(false));
  document.addEventListener('touchcancel', () => release(true));
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
  let startX = 0, startY = 0, curPull = 0, dragging = false, refreshing = false, hapticFired = false;

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
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dragging = true;
    hapticFired = false;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!dragging || refreshing) return;
    const dy = e.touches[0].clientY - startY;
    const dx = e.touches[0].clientX - startX;
    // ปัดแนวนอน (เปลี่ยนหน้า) ไม่ใช่ดึงรีเฟรช
    if (!curPull && Math.abs(dx) > Math.abs(dy)) { dragging = false; return; }
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
  wireSwipe();

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
