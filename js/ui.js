/* ui.js — แดชบอร์ดรายวัน + ปฏิทินเดือน + ฟอร์มจด + รูป + หน้าตั้งค่า   (ก้อนงาน: ui)
   ยกหน้าตา/ตรรกะการแสดงผลมาจาก tools/calorie-tracker/today.html:
     renderDay 1984 · renderMonth 2087 · drawTrend 2148 · show 2196 · goDay 2238
     ฟอร์มจด IIFE 2257-2405 (ถอด claude.use("db") ที่ 2349-2354 ออก ใช้ db.js แทน)

   กฎที่ห้ามพลาด:
   - ข้อความที่มาจากข้อมูล (ชื่อรายการ/โน้ต) ใส่ด้วย textContent ห้าม innerHTML
     (ของเดิมใช้ innerHTML ได้เพราะข้อความมาจากสคริปต์เรา — ของใหม่ชื่อรายการมาจาก AI)
   - <svg> ของกราฟต้องคง attribute viewBox ไว้ (drawTrend อ่าน viewBox.baseVal.height)
   - เลขที่ยังไม่ยืนยัน (ไม่มี final) ต้องมี class "est" ทุกที่ที่แสดง
   - สถิติเดือน/ขาดดุลสะสม/ค่าเฉลี่ย ใช้ final เท่านั้น · วัน est นับแยกว่า "ยังไม่ยืนยัน n วัน"
   - ผูก event ของปุ่มไว้ต้นฟังก์ชันเสมอ (บั๊ก 10 ก.ย.: ผูกท้ายสุด โค้ดกลางทางพัง = ปุ่มตาย)
   - id ต้องไม่ซ้ำกันทั้งหน้า (บั๊ก 10 ก.ย.: id="fNote" ซ้ำ 2 ที่ ทำให้ปุ่มเงียบทั้งฟอร์ม)
   - รูป: <input type="file" accept="image/*" multiple> (ห้ามใส่ capture — iOS จะบังคับกล้องอย่างเดียว เลือกจากคลังไม่ได้) ห้ามใช้ getUserMedia */

import * as db from './db.js';
import * as net from './net.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const SHADES = ['var(--eaten)', 'var(--eaten-soft)', 'var(--eaten)', 'var(--eaten-soft)'];
const TH_DOW = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const TH_MON = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const STATE_LABEL = {
  draft: 'ยังไม่ส่ง',
  queued: 'รอเน็ต',
  sending: 'กำลังส่ง…',
  estimated: 'AI ประมาณ',
  confirmed: '✓ Claude ยืนยันแล้ว',
  error: 'ส่งไม่สำเร็จ',
  synced: 'ส่งครบแล้ว',
};
const DEFAULT_PROFILE = { limit: 1800, tdee: 2450, proteinGoal: 140, goalWeight: 87.5 };

let foodsCatalog = null;
let curDate = '';
let dayDoc = null;
let monthCache = [];
let wired = false;
let dayGen = 0;
let monthGen = 0;
let formGen = 0;
let formBuilt = false;
let mealIds = [null, null, null, null];
let mealPhotos = [[], [], [], []];
let mealOutside = [false, false, false, false];
let photoUrls = [];
let bodyRefWeight = null;
let suggestTa = null;
let writeChain = Promise.resolve();
let formLoadedDate = null;

function profile() {
  try {
    const raw = localStorage.getItem('cal.profile');
    if (!raw) return { ...DEFAULT_PROFILE };
    const o = JSON.parse(raw);
    return {
      limit: num(o.limit) ?? DEFAULT_PROFILE.limit,
      tdee: num(o.tdee) ?? DEFAULT_PROFILE.tdee,
      proteinGoal: num(o.proteinGoal) ?? DEFAULT_PROFILE.proteinGoal,
      goalWeight: num(o.goalWeight) ?? DEFAULT_PROFILE.goalWeight,
    };
  } catch (_) {
    return { ...DEFAULT_PROFILE };
  }
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoFromParts(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function todayISO() {
  const d = new Date();
  return isoFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function addDays(iso, step) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + step);
  return isoFromParts(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

function parseISO(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return { y, m, d, date: new Date(y, m - 1, d) };
}

function formatFull(iso) {
  const { y, m, d, date } = parseISO(iso);
  if (!y) return '—';
  return `${TH_DOW[date.getDay()]} ${d} ${TH_MON[m]} ${y + 543}`;
}

function formatMonth(ym) {
  const [y, m] = String(ym || '').split('-').map(Number);
  if (!y) return '—';
  return `${TH_MON[m]} ${y + 543}`;
}

function fmt(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

function fmtP(n) {
  const v = num(n);
  if (v == null) return '—';
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function setText(node, text) {
  if (node) node.textContent = text == null ? '' : String(text);
}

function layer(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const kcal = num(obj.kcal);
  const p = num(obj.p);
  if (kcal == null && p == null) return null;
  return { kcal: kcal ?? 0, p: p ?? 0 };
}

function itemNums(it) {
  if (!it) return null;
  const fin = layer(it.final);
  if (fin) return { ...fin, est: false };
  const est = layer(it.est);
  if (est) return { ...est, est: true };
  return null;
}

/** final ที่ยังตรงกับข้อความ/รูปปัจจุบัน (sig เดียวกับ mealSig ใน net.js) · ไม่มี sig = ของเก่า ถือว่าใช้ได้ */
function freshFinal(m) {
  const fin = layer(m && m.final);
  if (!fin) return null;
  if (m.final.sig && m.final.sig !== JSON.stringify([m.raw || [], m.photos || []])) return null;
  return fin;
}

function mealNums(m) {
  if (!m) return { kcal: 0, p: 0, est: false };
  const fin = freshFinal(m);
  if (fin) return { ...fin, est: false };
  const est = layer(m.est);
  if (est) return { ...est, est: true };
  const stale = layer(m.final);
  if (stale) return { ...stale, est: true };
  let kcal = 0, p = 0, any = false, usedEst = false;
  for (const it of m.items || []) {
    const n = itemNums(it);
    if (!n) continue;
    any = true;
    kcal += n.kcal;
    p += n.p;
    if (n.est) usedEst = true;
  }
  if (any) return { kcal, p, est: usedEst };
  return { kcal: 0, p: 0, est: false };
}

function visibleMeals(d) {
  return ((d && d.meals) || []).filter((m) => m && !m.deleted);
}

/** เลขแสดงผลรายวัน: final → est → Σ มื้อ.est → Σ มื้อที่คำนวณได้ */
function kcalOf(d) {
  // 13 ก.ย.: เดิม totals.est ชนะ → มื้อที่ Claude ยืนยันแล้ว (531) ไม่ถูกนับ ยอดวันโชว์ ~388
  // ใหม่: ปิดยอด/มี totals.final ใช้ final · ไม่งั้นรวมรายมื้อ (final ?? est ?? Σรายการ)
  if (!d) return { v: 0, est: false };
  const fin = layer(d.totals && d.totals.final);
  if (fin) return { v: fin.kcal, est: false };
  let sum = 0, any = false, anyEst = false;
  for (const m of visibleMeals(d)) {
    const n = mealNums(m);
    if (!n.kcal && !n.p && !layer(m.final) && !layer(m.est)) continue;
    any = true;
    sum += n.kcal;
    if (n.est) anyEst = true;
  }
  if (any) return { v: sum, est: anyEst };
  const est = layer(d.totals && d.totals.est);
  if (est) return { v: est.kcal, est: true };
  return { v: 0, est: false };
}

function pOf(d) {
  // 13 ก.ย.: เดิม totals.est ชนะ → มื้อที่ Claude ยืนยันแล้ว (531) ไม่ถูกนับ ยอดวันโชว์ ~388
  // ใหม่: ปิดยอด/มี totals.final ใช้ final · ไม่งั้นรวมรายมื้อ (final ?? est ?? Σรายการ)
  if (!d) return { v: 0, est: false };
  const fin = layer(d.totals && d.totals.final);
  if (fin) return { v: fin.p, est: false };
  let sum = 0, any = false, anyEst = false;
  for (const m of visibleMeals(d)) {
    const n = mealNums(m);
    if (!n.kcal && !n.p && !layer(m.final) && !layer(m.est)) continue;
    any = true;
    sum += n.p;
    if (n.est) anyEst = true;
  }
  if (any) return { v: Math.round(sum * 10) / 10, est: anyEst };
  const est = layer(d.totals && d.totals.est);
  if (est) return { v: est.p, est: true };
  return { v: 0, est: false };
}

function finalOf(d) {
  if (!d || d.closed !== true) return null;
  const fin = layer(d.totals && d.totals.final);
  return fin;
}

function ceilOf(d) {
  const p = profile();
  const burn = d && d.garmin ? num(d.garmin.burn) : null;
  return Math.min(p.tdee, burn ?? p.tdee);
}

function statusOf(d) {
  const eaten = kcalOf(d).v;
  const p = profile();
  if (eaten <= p.limit) return 'good';
  if (eaten <= ceilOf(d)) return 'warn';
  return 'bad';
}

function bodyNum(d, field) {
  const b = d && d.body;
  if (!b) return null;
  return num(b[field]);
}

function markEst(node, isEst, clickable) {
  if (!node) return node;
  node.classList.toggle('est', !!isEst);
  if (isEst && clickable) node.setAttribute('role', 'button');
  else node.removeAttribute('role');
  return node;
}

function mealSub(m) {
  const parts = [];
  if (m.time) parts.push(m.time);
  if (m.outside) parts.push('มื้อนอกบ้าน');
  const names = (m.items || []).map((it) => it && it.name).filter(Boolean);
  if (names.length) parts.push(names.join(' · '));
  else if (Array.isArray(m.raw) && m.raw.length) parts.push(m.raw.filter(Boolean).join(' · '));
  return parts.join(' · ');
}

function hideEstDetail() {
  const pop = $('estDetail');
  if (pop) pop.hidden = true;
}

function showEstDetail(d) {
  const pop = $('estDetail');
  const body = $('estDetailBody');
  if (!pop || !body) return;
  body.textContent = '';
  if (!d) {
    body.appendChild(el('div', 'est-line', 'ยังไม่มีข้อมูลวันนี้'));
    pop.hidden = false;
    return;
  }

  const confs = [];
  for (const m of visibleMeals(d)) {
    for (const it of m.items || []) {
      if (!it || !it.est) continue;
      const conf = num(it.est.conf);
      confs.push({
        name: it.name || '(ไม่มีชื่อ)',
        conf,
        basis: it.est.basis || '',
      });
    }
  }
  const warnings = (d.ai && Array.isArray(d.ai.warnings)) ? d.ai.warnings : [];
  const unclear = (d.ai && Array.isArray(d.ai.unclear)) ? d.ai.unclear : [];

  if (!confs.length && !warnings.length && !unclear.length) {
    body.appendChild(el('div', 'est-line', 'เลขประมาณจาก AI ยังไม่มีรายละเอียดความมั่นใจ'));
  }

  if (confs.length) {
    body.appendChild(el('div', 'est-k', 'ความมั่นใจต่อรายการ'));
    for (const c of confs) {
      const line = el('div', 'est-line');
      const n = el('span', 'n');
      n.textContent = c.name;
      line.appendChild(n);
      const pct = c.conf == null ? '—' : `${Math.round(c.conf * 100)}%`;
      line.appendChild(document.createTextNode(` · ${pct}${c.basis ? ` · ${c.basis}` : ''}`));
      body.appendChild(line);
    }
  }
  if (warnings.length) {
    body.appendChild(el('div', 'est-k', 'คำเตือนจาก AI'));
    for (const w of warnings) {
      const line = el('div', 'est-line');
      line.textContent = String(w);
      body.appendChild(line);
    }
  }
  if (unclear.length) {
    body.appendChild(el('div', 'est-k', 'รายการที่ไม่ชัด'));
    for (const u of unclear) {
      const line = el('div', 'est-line');
      line.textContent = String(u);
      body.appendChild(line);
    }
  }
  pop.hidden = false;
}

function mealHasFinal(m) {
  if (!m) return false;
  if (freshFinal(m)) return true;
  if (layer(m.final)) return false;
  const items = m.items || [];
  if (!items.length) return false;
  return items.every((it) => layer(it && it.final));
}

function mealHasEstNum(m) {
  if (!m) return false;
  if ((layer(m.est) || layer(m.final)) && !freshFinal(m)) return true;
  for (const it of m.items || []) {
    if (it && layer(it.est) && !layer(it.final)) return true;
  }
  return false;
}

function setDayState(d) {
  const chip = $('dayState');
  if (!chip) return;
  chip.className = 'daystate';
  if (!d) {
    chip.hidden = false;
    chip.classList.add('empty');
    chip.textContent = 'ยังไม่มีข้อมูลวันนี้';
    return;
  }
  const meals = visibleMeals(d);
  let cls = 'draft';
  let label = 'ยังไม่ส่ง';
  if (d.closed === true) {
    cls = 'confirmed';
    label = '✓ Claude ยืนยันแล้ว';
  } else if (meals.length && meals.every(mealHasFinal)) {
    cls = 'confirmed';
    label = 'ตรวจแล้ว รอปิดยอด';
  } else if (kcalOf(d).est || meals.some(mealHasEstNum) || layer(d.totals && d.totals.est)) {
    cls = 'estimated';
    label = 'AI ประมาณ';
  } else if (!kcalOf(d).v && !meals.some((m) => layer(m.final) || layer(m.est))) {
    const st = d.state;
    if (st === 'queued' || st === 'sending' || st === 'error') {
      cls = st;
      label = STATE_LABEL[st] || st;
    } else {
      cls = d.submitted ? 'queued' : 'draft';
      label = d.submitted ? (STATE_LABEL.queued) : 'ยังไม่ส่ง';
    }
  } else {
    cls = 'draft';
    label = 'ยังไม่ส่ง';
  }
  chip.hidden = false;
  chip.classList.add(cls);
  chip.textContent = label;
}

function updateDayNav() {
  const today = todayISO();
  const prev = $('prevDay');
  const next = $('nextDay');
  const back = $('backToday');
  if (next) next.disabled = curDate >= today;
  if (prev) prev.disabled = false;
  if (back) back.hidden = curDate === today;
}

function fillBignum(left, isEst, over) {
  const wrap = $('bigwrap');
  const node = $('bignum');
  if (wrap) wrap.classList.toggle('is-over', over);
  if (!node) return;
  node.textContent = '';
  const val = el('span', isEst ? 'est' : '');
  val.textContent = fmt(Math.abs(left));
  markEst(val, isEst, true);
  const unit = el('span', 'unit', 'kcal');
  node.append(val, unit);
}

function paintGauge(d, eaten) {
  const p = profile();
  const ceil = ceilOf(d);
  const scale = Math.max(p.tdee, eaten, ceil) * 1.02;
  const pct = (v) => (v / scale) * 100;
  const zone = $('zoneover');
  if (zone) {
    zone.style.left = pct(p.limit) + '%';
    zone.style.width = Math.max(0, pct(ceil) - pct(p.limit)) + '%';
  }
  const track = $('track');
  if (track) {
    track.querySelectorAll('.seg').forEach((s) => s.remove());
    let acc = 0;
    visibleMeals(d).forEach((m, k) => {
      const mk = mealNums(m).kcal;
      const under = Math.max(0, Math.min(mk, p.limit - acc));
      const over = mk - under;
      if (under > 0) {
        const s = el('div', 'seg');
        s.style.width = pct(under) + '%';
        s.style.background = SHADES[k % SHADES.length];
        track.appendChild(s);
      }
      if (over > 0) {
        const s = el('div', 'seg over');
        s.style.width = pct(over) + '%';
        track.appendChild(s);
      }
      acc += mk;
    });
  }
  const tickL = $('tickLimit');
  const tickLL = $('tickLimitLabel');
  const tickT = $('tickTdee');
  const tickTL = $('tickTdeeLabel');
  const limPct = pct(p.limit);
  const ceilPct = pct(ceil);
  const tight = Math.abs(ceilPct - limPct) < 30;
  const gauge = tickLL && tickLL.parentElement;
  if (gauge && gauge.classList.contains('gauge')) gauge.classList.toggle('is-tight', tight);
  if (tickL) tickL.style.left = limPct + '%';
  if (tickLL) {
    tickLL.style.left = limPct + '%';
    tickLL.textContent = 'ลิมิต ' + p.limit.toLocaleString('en-US');
    tickLL.classList.toggle('up', tight);
    if (tight) tickLL.style.transform = 'translateX(calc(-100% - 5px))'; // ขึ้นแถวบนแล้วต้องหลบเส้นขีด ไม่งั้นเส้นทับตัวเลข (ไอโฟน 13 ก.ย.)
    else if (limPct < 18) tickLL.style.transform = 'translateX(0)';
    else if (limPct > 82) tickLL.style.transform = 'translateX(-100%)';
    else tickLL.style.transform = 'translateX(-50%)';
  }
  if (tickT) tickT.style.left = ceilPct + '%';
  if (tickTL) {
    tickTL.style.left = ceilPct + '%';
    const burn = d && d.garmin ? num(d.garmin.burn) : null;
    tickTL.textContent = (burn != null && ceil === burn ? 'เผาจริง ' : 'TDEE ') + ceil.toLocaleString('en-US');
    tickTL.classList.remove('up');
    if (tight || ceilPct > 82) tickTL.style.transform = 'translateX(-100%)';
    else if (ceilPct < 18) tickTL.style.transform = 'translateX(0)';
    else tickTL.style.transform = 'translateX(-50%)';
  }
}

function paintMeals(d) {
  const wrap = $('meals');
  if (!wrap) return;
  wrap.textContent = '';
  const meals = visibleMeals(d);
  meals.forEach((m, k) => {
    const nums = mealNums(m);
    const row = el('button', 'meal');
    row.type = 'button';
    row.setAttribute('aria-expanded', 'false');

    const swatch = el('span', 'swatch');
    swatch.style.background = SHADES[k % SHADES.length];

    const mname = el('span', 'mname', m.key || '');
    const sub = el('span');
    sub.textContent = mealSub(m);
    mname.appendChild(sub);

    const mnums = el('span', 'mnums');
    const kb = el('b');
    // ยังไม่มีเลขจาก AI/Claude เลย → โชว์ "—" ไม่ใช่ 0 (0 ดูเหมือนคิดแล้วว่าไม่มีแคล)
    const noNum = !layer(m.final) && !layer(m.est) && !(m.items || []).some((it) => itemNums(it));
    kb.textContent = noNum ? '—' : fmt(nums.kcal);
    markEst(kb, nums.est, true);
    mnums.append(kb, document.createTextNode(' kcal'));
    const pline = el('span');
    pline.append(document.createTextNode('P '));
    const pb = el('span');
    pb.textContent = noNum ? '—' : fmtP(nums.p);
    markEst(pb, nums.est, true);
    pline.append(pb, document.createTextNode(' g'));
    mnums.appendChild(pline);

    row.append(swatch, mname, mnums, el('span', 'chev', '▶'));

    const list = el('div', 'items');
    list.hidden = true;
    const items = Array.isArray(m.items) ? m.items : [];
    if (items.length) {
      for (const it of items) {
        const item = el('div', 'item');
        const n = el('span', 'n');
        n.textContent = (it && it.name) || '';
        const v = el('span', 'v');
        const nms = itemNums(it) || { kcal: 0, p: 0, est: !!(it && it.est && !it.final) };
        const ib = el('b');
        ib.textContent = fmt(nms.kcal);
        markEst(ib, nms.est, true);
        v.append(ib, document.createTextNode(' kcal · P '));
        const ip = el('span');
        ip.textContent = fmtP(nms.p);
        markEst(ip, nms.est, true);
        v.append(ip);
        item.append(n, v);
        list.appendChild(item);
      }
    } else if (Array.isArray(m.raw) && m.raw.length) {
      for (const line of m.raw) {
        const item = el('div', 'item');
        const n = el('span', 'n');
        n.textContent = line;
        item.appendChild(n);
        list.appendChild(item);
      }
    } else {
      list.appendChild(el('div', 'item', 'ไม่มีรายละเอียดรายการในไดอารีวันนี้'));
    }
    if (m.comment) {
      const c = el('div', 'item comment');
      c.textContent = m.comment;
      list.appendChild(c);
    }

    row.addEventListener('click', () => {
      const open = row.getAttribute('aria-expanded') === 'true';
      row.setAttribute('aria-expanded', String(!open));
      list.hidden = open;
    });
    wrap.appendChild(row);
    wrap.appendChild(list);
  });

  if (d && !d.closed) {
    const p = el('div', 'pending');
    const got = new Set(meals.map((m) => m.key));
    const missing = ['เช้า', 'กลางวัน', 'เย็น'].filter((n) => !got.has(n));
    p.textContent = missing.length ? 'ยังไม่ได้จด: ' + missing.join(' · ') : 'ยังไม่ปิดยอดวัน';
    wrap.appendChild(p);
  }
}

async function paintDay() {
  const gen = ++dayGen;
  try {
  const p = profile();
  setText($('limit'), p.limit.toLocaleString('en-US'));
  setText($('pgoal'), String(p.proteinGoal));
  setText($('date'), formatFull(curDate));
  updateDayNav();

  let d = null;
  try {
    d = await db.getDay(curDate);
  } catch (_) {
    d = null;
  }
  if (gen !== dayGen) return;
  dayDoc = d;

  const eaten = kcalOf(d);
  const protein = pOf(d);
  const left = p.limit - eaten.v;
  const w = bodyNum(d, 'weight');

  setText($('weight'), w != null ? w.toFixed(1) + ' กก.' : 'ไม่ได้ชั่ง');
  setText($('biglabel'), left >= 0 ? (d && d.closed ? 'ต่ำกว่างบ' : 'เหลือวันนี้') : 'เกินลิมิตแล้ว');
  fillBignum(left, eaten.est, left < 0);

  const eatenEl = $('eaten');
  if (eatenEl) {
    eatenEl.textContent = fmt(eaten.v);
    markEst(eatenEl, eaten.est, true);
  }

  paintGauge(d, eaten.v);

  const pnow = $('pnow');
  if (pnow) {
    pnow.textContent = fmtP(protein.v);
    markEst(pnow, protein.est, true);
  }
  const pfill = $('pfill');
  if (pfill) pfill.style.width = Math.min(100, ((protein.v || 0) / p.proteinGoal) * 100) + '%';
  const pleft = p.proteinGoal - (protein.v || 0);
  setText($('pnote'), pleft > 0
    ? 'ขาดอีก ' + fmtP(pleft) + ' g ≈ อกไก่ ' + Math.round(pleft / 23 * 100) + ' g'
    : 'ถึงเป้าแล้ว');

  setDayState(d);
  paintMeals(d);
  hideEstDetail();
  try { const x = await import('./ui-1a.js'); x.afterDay(d, { eaten: eaten.v }); } catch (_) {}
  } catch (_) {
    if (gen !== dayGen) return;
    console.warn('[ui] renderDay failed');
  }
}

function setSum(node, main, small, cls) {
  if (!node) return;
  node.textContent = '';
  node.className = 'v' + (cls ? ' ' + cls : '');
  node.appendChild(document.createTextNode(main));
  if (small) {
    const s = document.createElement('small');
    s.textContent = small;
    node.appendChild(s);
  }
}

function move(diff, unit, span) {
  return Math.abs(diff) < 0.05
    ? 'คงที่ใน ' + span
    : (diff < 0 ? 'ลง ' : 'ขึ้น ') + Math.abs(diff).toFixed(1) + unit + ' ใน ' + span;
}

function drawTrend(days, field, svgId, rangeId, noteId, color, unit, noteFn) {
  const ds = days.filter((d) => bodyNum(d, field) != null);
  const svg = $(svgId);
  const range = $(rangeId);
  const note = $(noteId);
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (ds.length < 2) {
    setText(range, ds.length ? bodyNum(ds[0], field).toFixed(1) + unit : '—');
    setText(note, 'ยังบันทึกไม่พอจะวาดเส้น');
    return;
  }
  const vals = ds.map((d) => bodyNum(d, field));
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.25 || 0.5;
  const bot = svg.viewBox.baseVal.height - 6, top = 6;
  const x = (k) => 6 + (k / (ds.length - 1)) * 288;
  const y = (v) => bot - ((v - (lo - pad)) / ((hi + pad) - (lo - pad))) * (bot - top);
  const poly = document.createElementNS(SVG_NS, 'polyline');
  poly.setAttribute('points', ds.map((d, k) => x(k) + ',' + y(bodyNum(d, field))).join(' '));
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', color);
  poly.setAttribute('stroke-width', '2');
  poly.setAttribute('stroke-linecap', 'round');
  poly.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(poly);
  ds.forEach((d, k) => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', String(x(k)));
    c.setAttribute('cy', String(y(bodyNum(d, field))));
    c.setAttribute('r', k === ds.length - 1 ? '4' : '2.5');
    c.setAttribute('fill', color);
    svg.appendChild(c);
  });
  const first = vals[0], last = vals[vals.length - 1];
  setText(range, first.toFixed(1) + ' → ' + last.toFixed(1) + unit);
  setText(note, noteFn(last - first, last, ds.length));
}

function goToDay(date) {
  curDate = date;
  const tab = $('tabDay');
  if (tab) tab.click();
  else renderDay();
}

async function paintMonth() {
  const gen = ++monthGen;
  try {
  const p = profile();
  const ym = (curDate || todayISO()).slice(0, 7);
  setText($('monthTitle'), formatMonth(ym));

  let days = [];
  try {
    days = await db.listDays(ym);
  } catch (_) {
    days = [];
  }
  if (gen !== monthGen) return;
  monthCache = days;

  const closed = [];
  for (const d of days) {
    const fin = finalOf(d);
    if (fin) closed.push({ d, fin });
  }
  const openN = days.filter((d) => !finalOf(d)).length;
  setText($('monthMeta'), days.length + ' วันที่บันทึก');

  if (!closed.length) {
    setSum($('sAvg'), '—', '', '');
    setSum($('sUnder'), '—', '', '');
    setSum($('sDeficit'), '—', '', '');
    setSum($('sProtein'), '—', '', '');
    setText($('sDeficitK'), 'ขาดดุลสะสม (เทียบ TDEE)');
  } else {
    const n = closed.length;
    const avg = closed.reduce((s, x) => s + x.fin.kcal, 0) / n;
    setSum($('sAvg'), fmt(avg), 'kcal', avg <= p.limit ? 'good' : avg <= p.tdee ? '' : 'bad');

    const under = closed.filter((x) => x.fin.kcal <= p.limit).length;
    setSum($('sUnder'), String(under), '/ ' + n + ' วัน', under * 2 >= n ? 'good' : '');

    const deficit = closed.reduce((s, x) => s + (ceilOf(x.d) - x.fin.kcal), 0);
    setText($('sDeficitK'), (deficit >= 0 ? 'ขาดดุลสะสม' : 'เกินดุลสะสม') + ' (เทียบ TDEE)');
    setSum($('sDeficit'), fmt(Math.abs(deficit)), 'kcal', deficit >= 0 ? 'good' : 'bad');

    const hitP = closed.filter((x) => x.fin.p >= p.proteinGoal).length;
    setSum($('sProtein'), String(hitP), '/ ' + n + ' วัน', hitP === n ? 'good' : '');
  }

  const openWrap = $('sOpenWrap');
  const openEl = $('sOpen');
  if (openWrap) openWrap.hidden = openN <= 0;
  if (openEl && openN > 0) setSum(openEl, String(openN), 'วัน', 'warn');

  const grid = $('grid');
  if (grid) {
    grid.textContent = '';
    const [year, mon] = ym.split('-').map(Number);
    const daysInMonth = new Date(year, mon, 0).getDate();
    const lead = (new Date(year, mon - 1, 1).getDay() + 6) % 7;
    const byDay = new Map(days.map((d) => [Number(d.date.slice(8, 10)), d]));

    for (let k = 0; k < lead; k++) {
      grid.appendChild(el('div', 'cell blank'));
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const d = byDay.get(day);
      if (!d) {
        const b = el('div', 'cell future');
        b.appendChild(el('span', 'dd', String(day)));
        grid.appendChild(b);
        continue;
      }
      const eaten = kcalOf(d);
      const protein = pOf(d);
      const cell = el('button', 'cell ' + statusOf(d) + (d.closed ? '' : ' open'));
      cell.type = 'button';
      cell.setAttribute('aria-current', d.date === curDate ? 'true' : 'false');
      cell.setAttribute('aria-label',
        formatFull(d.date) + ' · ' + fmt(eaten.v) + ' kcal · โปรตีน ' + fmtP(protein.v) + ' g'
        + (d.closed ? '' : ' · ยังไม่ยืนยัน'));
      cell.appendChild(el('span', 'dd', String(day)));
      const kk = el('span', 'kk');
      kk.textContent = fmt(eaten.v);
      markEst(kk, eaten.est, false);
      cell.appendChild(kk);
      const pp = el('span', 'pp');
      pp.append(document.createTextNode('P '));
      const pv = el('span');
      pv.textContent = fmtP(protein.v);
      markEst(pv, protein.est, false);
      pp.appendChild(pv);
      cell.appendChild(pp);
      cell.addEventListener('click', () => goToDay(d.date));
      grid.appendChild(cell);
    }
  }

  try { const x = await import('./ui-1a.js'); await x.afterMonth(); } catch (_) {}

  drawTrend(days, 'weight', 'spark', 'wRange', 'wNote', 'var(--eaten)', ' กก.',
    (diff, last, n) => move(diff, ' กก.', n + ' วัน') + ' · เหลือถึงเป้า '
      + p.goalWeight + ' กก. อีก ' + (last - p.goalWeight).toFixed(1) + ' กก.');

  drawTrend(days, 'muscle', 'sparkM', 'mRange', 'mNote', 'var(--protein)', ' กก.',
    (diff, last, n) => move(diff, ' กก.', n + ' วันที่วัด') + ' · '
      + (diff <= -0.3 ? 'กำลังเสียกล้ามเนื้อ ต้องเพิ่มโปรตีน'
        : diff < -0.05 ? 'ลงนิดหน่อย ยังอยู่ในช่วงแกว่งของเครื่อง — เฝ้าดูต่อ'
        : 'ทรงตัวดี น้ำหนักที่ลงเป็นไขมัน'));

  drawTrend(days, 'fat', 'sparkF', 'fRange', 'fatNote', 'var(--warn)', '%',
    (diff, last, n) => move(diff, ' จุด', n + ' วันที่วัด')
      + ' · เครื่อง BIA อ่านต่ำกว่าจริง ดูทิศทางอย่างเดียว');

  paintWaist().catch(() => {});
  } catch (_) {
    if (gen !== monthGen) return;
    console.warn('[ui] renderMonth failed');
  }
}

function wire() {
  if (wired) return;
  wired = true;

  $('fSave')?.addEventListener('click', () => writeForm(false));
  $('fSend')?.addEventListener('click', () => writeForm(true));
  $('bSave')?.addEventListener('click', async () => {
    await writeForm(false);
    setStatus($('bStatus'), 'บันทึกตาชั่งแล้ว', 'ok');
  });
  $('fDate')?.addEventListener('change', () => {
    const v = $('fDate') && $('fDate').value;
    if (v) curDate = v;
    renderForm();
  });
  $('fWeight')?.addEventListener('input', updateDelta);

  $('sOrKey')?.addEventListener('change', () => saveSecret('cal.or_key', 'sOrKey', 'sOrKeyHint'));
  $('sGhPat')?.addEventListener('change', () => saveSecret('cal.gh_pat', 'sGhPat', 'sGhPatHint'));
  $('sGhRepo')?.addEventListener('change', () => {
    const v = ($('sGhRepo').value || '').trim();
    setLs('cal.gh_repo', v);
  });
  $('sAiModels')?.addEventListener('change', saveModels);
  $('sTestOr')?.addEventListener('click', () => testNet('or'));
  $('sTestGh')?.addEventListener('click', () => testNet('gh'));
  $('sExport')?.addEventListener('click', exportData);
  $('sImport')?.addEventListener('click', () => $('sImportFile') && $('sImportFile').click());
  $('sImportFile')?.addEventListener('change', importData);
  $('sResetCache')?.addEventListener('click', resetCacheAndReload);

  $('prevDay')?.addEventListener('click', () => goDay(-1));
  $('nextDay')?.addEventListener('click', () => goDay(1));
  $('backToday')?.addEventListener('click', () => {
    curDate = todayISO();
    renderDay();
  });
  $('estDetailClose')?.addEventListener('click', hideEstDetail);
  $('estDetail')?.addEventListener('click', (e) => {
    if (e.target === $('estDetail')) hideEstDetail();
  });
  $('viewDay')?.addEventListener('click', (e) => {
    const t = e.target.closest('.est');
    if (!t || !$('viewDay').contains(t)) return;
    e.preventDefault();
    e.stopPropagation();
    showEstDetail(dayDoc);
  }, true);
}

async function loadFoods() {
  try {
    const res = await fetch('./data/foods.json');
    if (!res.ok) return;
    const data = await res.json();
    foodsCatalog = Array.isArray(data) ? data : (data && Array.isArray(data.foods) ? data.foods : null);
  } catch (_) {
    foodsCatalog = null;
  }
}

/** เตรียม DOM ของทุกมุมมอง + โหลดคลังอาหาร + ผูก event (เรียกครั้งเดียวตอนบูต) */
export async function init() {
  wire();
  buildForm();
  curDate = todayISO();
  if ($('fDate') && !$('fDate').value) $('fDate').value = curDate;
  await loadFoods();
}

/** ถูกเรียกทุกครั้งที่สลับมุมมอง — วาดมุมมองนั้นให้เป็นปัจจุบัน */
export function onShow(which) {
  if (which !== 'Form') {
    hideSuggest();
    revokePhotoUrls();
  }
  if (which === 'Day') renderDay();
  else if (which === 'Month') renderMonth();
  else if (which === 'Form') {
    const d = $('fDate') && $('fDate').value;
    if (!d || formLoadedDate !== d) renderForm();
    else paintAllPhotos();
  } else if (which === 'Body') {
    const d = $('fDate') && $('fDate').value;
    if (!d || formLoadedDate !== d) renderForm();
  } else if (which === 'Settings') renderSettings();
}

/** เลื่อนวันในมุมมองรายวัน (step -1/+1) */
export function goDay(step) {
  const view = $('viewDay');
  if (view && view.hidden) return;
  const n = Number(step) || 0;
  if (!n) return;
  if (!curDate) curDate = todayISO();
  const next = addDays(curDate, n);
  if (next > todayISO()) return;
  curDate = next;
  renderDay();
}

export function renderDay(i) {
  if (typeof i === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(i)) curDate = i;
  else if (typeof i === 'number' && Number.isFinite(i) && monthCache[i]) curDate = monthCache[i].date;
  if (!curDate) curDate = todayISO();
  return paintDay();
}

export function renderMonth() {
  if (!curDate) curDate = todayISO();
  return paintMonth();
}

/** แถบสถานะบนสุด: 'draft'|'queued'|'sending'|'estimated'|'confirmed'|'error'
 *  ทุกสถานะต้องมีข้อความที่คนอ่านรู้เรื่อง ห้ามมีสถานะที่หายเงียบ */
export function setSyncStatus(state, detail) {
  const box = $('syncStatus');
  if (!box) return;
  const label = STATE_LABEL[state] || (state ? String(state) : '');
  const extra = detail == null || detail === '' ? '' : String(detail);
  box.textContent = extra ? (label ? label + ' · ' + extra : extra) : (label || '—');
  if (state) box.dataset.state = String(state);
  else delete box.dataset.state;
}

/* ── ฟอร์มจด + รูป + หน้าตั้งค่า ───────────────────────── */

const OUTSIDE_LABEL = 'มื้อนี้ไม่ได้ทำเอง';
const MEALS = [
  { key: 'เช้า', time: '07:00', chips: ['ข้าวต้มโอ๊ต (โอ๊ต 3 ชต.)', 'ไข่ไก่ 2 ฟอง', 'อกไก่สับ 3 ชต.', 'นมถั่วเหลือง 無調整 250 ml', 'กล้วย 1 ลูก'] },
  { key: 'กลางวัน', time: '12:20', chips: ['ข้าวสวยชามดง', 'ご飯少なめ', 'ซุปมิโสะ', 'キャベツ千切り', 'ひじき煮'] },
  { key: 'ของว่าง', time: '15:30', chips: ['ขนมปัง Pasco 1 แผ่น', 'เนยถั่ว Kanpy 1 ชช.', 'กาแฟดำไม่หวาน'] },
  { key: 'เย็น', time: '19:00', chips: ['ลาบสันในหมู 200 g', 'บร็อคโคลีต้ม 170 g', 'อกไก่ 150 g', 'ข้าวสวย 1 ทัพพี', 'ไข่ต้ม 1 ฟอง'] },
];
const NUMS = ['fWeight', 'fBmi', 'fFat', 'fMuscle', 'fVisceral', 'fWater', 'fBone', 'fBmr', 'fMage', 'fWaist'];
const KEY = { fWeight: 'weight', fBmi: 'bmi', fFat: 'fat', fMuscle: 'muscle', fVisceral: 'visceral', fWater: 'water', fBone: 'bone', fBmr: 'bmr', fMage: 'mage', fWaist: 'waist' };
const PHOTO_MAX_SIDE = 1024;
const PHOTO_MAX_BYTES = 250 * 1024;
const LS_OR = 'cal.or_key';
const LS_PAT = 'cal.gh_pat';
const LS_REPO = 'cal.gh_repo';
const LS_MODELS = 'cal.ai_models';

function stampNow() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const ah = Math.floor(Math.abs(off) / 60);
  const am = Math.abs(off) % 60;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${pad2(ah)}:${pad2(am)}`;
}

function hhmm(iso) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return String(iso || '');
  return pad2(t.getHours()) + ':' + pad2(t.getMinutes());
}

function newId(prefix) {
  return prefix + Math.random().toString(36).slice(2, 9);
}

function getLs(k) {
  try { return localStorage.getItem(k) || ''; } catch (_) { return ''; }
}

function setLs(k, v) {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch (_) {}
}

function maskSecret(v) {
  if (!v) return 'ยังไม่ใส่';
  if (v.length <= 6) return 'บันทึกแล้ว · ' + '•'.repeat(Math.max(4, v.length));
  return 'บันทึกแล้ว · ••••' + v.slice(-6);
}

function sayForm(msg, err) {
  const node = $('fStatus');
  if (!node) return;
  node.textContent = msg || '';
  node.className = 'fstatus' + (err ? ' err' : '');
}

function setStatus(node, msg, kind) {
  if (!node) return;
  node.textContent = msg || '';
  node.className = 'sstatus' + (kind ? ' ' + kind : '');
}

function revokePhotoUrls() {
  for (const u of photoUrls) {
    try { URL.revokeObjectURL(u); } catch (_) {}
  }
  photoUrls = [];
}

function resetMealState() {
  mealIds = [null, null, null, null];
  mealPhotos = [[], [], [], []];
  mealOutside = [false, false, false, false];
}

function ensureMealId(i) {
  if (!mealIds[i]) mealIds[i] = newId('m_');
  return mealIds[i];
}

function linesOf(ta) {
  if (!ta) return [];
  return String(ta.value || '').split('\n').map((x) => x.trim()).filter(Boolean);
}

function currentLine(ta) {
  const v = ta.value || '';
  const pos = ta.selectionStart || 0;
  const a = v.lastIndexOf('\n', pos - 1) + 1;
  let b = v.indexOf('\n', pos);
  if (b < 0) b = v.length;
  return { a, b, line: v.slice(a, b) };
}

function hideSuggest() {
  const box = $('foodSuggest');
  if (box) box.hidden = true;
  suggestTa = null;
}

function searchFoods(q) {
  const s = String(q || '').trim().toLowerCase();
  if (s.length < 2 || !Array.isArray(foodsCatalog)) return [];
  const scored = [];
  for (const f of foodsCatalog) {
    if (!f) continue;
    const name = String(f.name || '').toLowerCase();
    const alias = Array.isArray(f.alias) ? f.alias : [];
    let score = 0;
    if (name === s) score = 4;
    else if (name.includes(s)) score = 3;
    else if (alias.some((a) => String(a).toLowerCase() === s)) score = 2;
    else if (alias.some((a) => String(a).toLowerCase().includes(s))) score = 1;
    if (score) scored.push({ f, score, name });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'th'));
  return scored.slice(0, 8).map((x) => x.f);
}

function showSuggest(ta, items) {
  const box = $('foodSuggest');
  if (!box) return;
  box.textContent = '';
  if (!items.length) {
    box.hidden = true;
    suggestTa = null;
    return;
  }
  suggestTa = ta;
  for (const f of items) {
    const b = el('button', 'food-item');
    b.type = 'button';
    const n = el('span', 'n');
    n.textContent = (f.name || '') + (f.unit ? ' · ' + f.unit : '');
    const src = el('span', 'src ' + (f.src === 'label' ? 'label' : 'std'));
    src.textContent = f.src === 'label' ? 'ฉลากจริง' : 'ค่าประมาณ';
    b.append(n, src);
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applyFood(ta, f);
      hideSuggest();
    });
    box.appendChild(b);
  }
  const r = ta.getBoundingClientRect();
  box.style.left = Math.round(r.left) + 'px';
  box.style.top = Math.round(r.bottom + 4) + 'px';
  box.style.width = Math.round(r.width) + 'px';
  box.hidden = false;
}

function applyFood(ta, f) {
  const { a, b } = currentLine(ta);
  const unit = f.unit ? String(f.unit) : '';
  const text = unit ? (String(f.name || '') + ' ' + unit) : String(f.name || '');
  ta.value = ta.value.slice(0, a) + text + ta.value.slice(b);
  const pos = a + text.length;
  ta.selectionStart = ta.selectionEnd = pos;
  ta.focus();
  sayForm('ใส่แล้ว · ' + (f.src === 'label' ? 'ฉลากจริง' : 'ค่าประมาณ'));
}

function onMealTyped(ta) {
  const { line } = currentLine(ta);
  const q = line.trim();
  if (q.length < 2) { hideSuggest(); return; }
  showSuggest(ta, searchFoods(q));
}

function addChipText(i, text) {
  const ta = $('fM' + i);
  if (!ta) return;
  ta.value = (ta.value.replace(/\s+$/, '') + '\n' + text).replace(/^\n/, '');
  ta.focus();
}

function setOutsideChip(i, on) {
  mealOutside[i] = !!on;
  const chip = document.querySelector('#fMeals .fmeal[data-i="' + i + '"] .fchip-out');
  if (chip) {
    chip.classList.toggle('on', !!on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function buildForm() {
  if (formBuilt) return;
  formBuilt = true;
  const host = $('fMeals');
  if (!host) return;

  MEALS.forEach((m, i) => {
    const box = el('div', 'fmeal');
    box.dataset.i = String(i);

    const head = el('div', 'h');
    head.appendChild(el('b', '', m.key));
    const tm = document.createElement('input');
    tm.type = 'time';
    tm.id = 'fT' + i;
    tm.value = m.time;
    tm.setAttribute('aria-label', 'เวลามื้อ' + m.key);
    head.appendChild(tm);
    box.appendChild(head);

    const chips = el('div', 'fchips');
    for (const c of m.chips) {
      const b = el('button', 'fchip', '+ ' + c);
      b.type = 'button';
      b.dataset.add = c;
      chips.appendChild(b);
    }
    const out = el('button', 'fchip fchip-out', OUTSIDE_LABEL);
    out.type = 'button';
    out.setAttribute('aria-pressed', 'false');
    chips.appendChild(out);
    box.appendChild(chips);

    const ta = document.createElement('textarea');
    ta.id = 'fM' + i;
    ta.rows = 4;
    ta.setAttribute('aria-label', 'รายการมื้อ' + m.key);
    ta.placeholder = 'เช่น\nข้าวสวย 1 ทัพพี\nอกไก่ผัดกะหล่ำ 100 g';
    box.appendChild(ta);

    const pic = document.createElement('input');
    pic.type = 'file';
    pic.accept = 'image/*';
    pic.multiple = true;
    pic.className = 'fpic';
    pic.id = 'fPic' + i;
    pic.setAttribute('aria-label', 'ถ่ายรูปมื้อ' + m.key);
    box.appendChild(pic);

    const addPic = el('button', 'faddpic', 'เพิ่มรูป / ถ่ายรูป');
    addPic.type = 'button';
    box.appendChild(addPic);

    const thumbs = el('div', 'fthumbs');
    thumbs.id = 'fThumbs' + i;
    box.appendChild(thumbs);

    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-add]');
      if (b && box.contains(b)) addChipText(i, b.dataset.add);
    });
    out.addEventListener('click', () => setOutsideChip(i, !mealOutside[i]));
    ta.addEventListener('input', () => onMealTyped(ta));
    ta.addEventListener('blur', () => setTimeout(hideSuggest, 180));
    addPic.addEventListener('click', () => pic.click());
    pic.addEventListener('change', () => onPhotoFiles(i, pic));

    host.appendChild(box);
  });

  const hint = el('p', 'fhint',
    'มื้อที่ทำเอง: บอกปริมาณคร่าว ๆ ก็พอ (ทัพพี · ชต. · กรัม · ฟอง) ไม่ต้องกรอกแคลกับโปรตีน · มื้อที่ไม่ได้ทำเอง: กดชิพด้านบน แล้วถ่ายรูปไว้ · ของยี่ห้อใหม่ที่มีฉลาก ถ่ายฉลากมาครั้งแรกครั้งเดียว');
  host.appendChild(hint);

  document.addEventListener('click', (e) => {
    const box = $('foodSuggest');
    if (!box || box.hidden) return;
    if (box.contains(e.target) || e.target === suggestTa) return;
    hideSuggest();
  });
}

function applyRef(doc) {
  bodyRefWeight = doc ? bodyNum(doc, 'weight') : null;
  const fat = doc ? bodyNum(doc, 'fat') : null;
  const muscle = doc ? bodyNum(doc, 'muscle') : null;
  const bmi = doc ? bodyNum(doc, 'bmi') : null;
  setText($('fRef'), bodyRefWeight != null
    ? 'ล่าสุด ' + (doc.date || '') + ' = ' + bodyRefWeight.toFixed(1) + ' กก.'
    : '');
  setText($('rFat'), fat != null ? fat.toFixed(1) : '');
  setText($('rMuscle'), muscle != null ? muscle.toFixed(1) : '');
  setText($('rBmi'), bmi != null ? bmi.toFixed(1) : '');
  updateDelta();
}

function updateDelta() {
  const node = $('fDelta');
  if (!node) return;
  node.className = 'fdelta';
  const w = parseFloat($('fWeight') && $('fWeight').value);
  if (!Number.isFinite(w) || bodyRefWeight == null) {
    node.textContent = '—';
    return;
  }
  const d = w - bodyRefWeight;
  node.textContent = (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d).toFixed(1) + ' กก.';
  if (d < -0.05) node.classList.add('down');
  else if (d > 0.05) node.classList.add('up');
}

async function lastBodyRef(beforeDate) {
  const tryMonth = async (ym) => {
    const days = await db.listDays(ym);
    for (let i = days.length - 1; i >= 0; i--) {
      const d = days[i];
      if (d && d.date < beforeDate && bodyNum(d, 'weight') != null) return d;
    }
    return null;
  };
  const ym = String(beforeDate || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(ym)) return null;
  const hit = await tryMonth(ym);
  if (hit) return hit;
  const [y, m] = ym.split('-').map(Number);
  const prev = m === 1 ? (y - 1) + '-12' : y + '-' + pad2(m - 1);
  return tryMonth(prev);
}

/** รอบเอว วัดสัปดาห์ละครั้ง ไม่ใช่ทุกวัน — ไล่ย้อนข้ามเดือนหาสองค่าล่าสุด (ไม่ใช้ paintMonth's days เพราะอาจไม่พอ) */
async function lastWaistPair() {
  const found = [];
  let ym = todayISO().slice(0, 7);
  for (let i = 0; i < 8 && found.length < 2; i++) {
    if (!/^\d{4}-\d{2}$/.test(ym)) break;
    let days = [];
    try { days = await db.listDays(ym); } catch (_) { days = []; }
    for (let k = days.length - 1; k >= 0 && found.length < 2; k--) {
      const d = days[k];
      if (d && bodyNum(d, 'waist') != null) found.push(d);
    }
    const [y, m] = ym.split('-').map(Number);
    ym = m === 1 ? (y - 1) + '-12' : y + '-' + pad2(m - 1);
  }
  return found;
}

async function paintWaist() {
  const range = $('waistRange');
  const note = $('waistNote');
  if (!range || !note) return;
  const gen = monthGen;
  const [latest, prev] = await lastWaistPair();
  if (gen !== monthGen) return;
  if (!latest) {
    setText(range, '—');
    setText(note, 'ยังไม่มีข้อมูล');
    return;
  }
  const wLatest = bodyNum(latest, 'waist');
  const { d, m } = parseISO(latest.date);
  setText(range, wLatest.toFixed(1) + ' ซม.');
  let msg = '(' + d + ' ' + TH_MON[m] + ')';
  if (prev) {
    const wPrev = bodyNum(prev, 'waist');
    const diff = wLatest - wPrev;
    msg += ' · ' + (Math.abs(diff) < 0.05 ? 'คงที่' : (diff < 0 ? '−' : '+') + Math.abs(diff).toFixed(1)) + ' จากครั้งก่อน';
  }
  setText(note, msg);
}

function clearBodyInputs() {
  for (const id of NUMS) {
    if ($(id)) $(id).value = '';
  }
}

function fillForm(o) {
  if (!o) return;
  const b = o.body || {};
  if (b.weighedAt && $('fTime')) $('fTime').value = b.weighedAt;
  for (const id of NUMS) {
    const k = KEY[id];
    if (typeof b[k] === 'number' && Number.isFinite(b[k]) && $(id)) $(id).value = String(b[k]);
  }
  if ($('fNote')) $('fNote').value = o.note || '';
  const used = new Set();
  for (const meal of o.meals || []) {
    if (!meal || meal.deleted) continue;
    const i = MEALS.findIndex((x) => x.key === meal.key);
    if (i < 0 || used.has(i)) continue;
    used.add(i);
    mealIds[i] = meal.id || null;
    mealOutside[i] = !!meal.outside;
    mealPhotos[i] = Array.isArray(meal.photos) ? meal.photos.slice() : [];
    if (meal.time && $('fT' + i)) $('fT' + i).value = meal.time;
    if ($('fM' + i)) $('fM' + i).value = Array.isArray(meal.raw) ? meal.raw.join('\n') : '';
    setOutsideChip(i, mealOutside[i]);
  }
  renderSent(o);
  renderResult(o);
}

function renderSent(o) {
  const node = $('fSent');
  if (!node) return;
  node.textContent = '';
  node.className = 'fsent';
  const sentAt = o && o.submittedAt;
  if (!sentAt) {
    node.textContent = 'ยังไม่ได้คำนวณ — กดบันทึกไว้ก่อนได้ ข้อมูลไม่หาย';
    return;
  }
  const dirty = !!(o.savedAt && o.savedAt > sentAt);
  if (dirty) node.classList.add('dirty');
  if (dirty) {
    node.appendChild(document.createTextNode('มีการแก้หลังคำนวณ — กดคำนวณอีกครั้ง'));
    const b = el('b', '', ' · คำนวณล่าสุด ' + hhmm(sentAt));
    node.appendChild(b);
  } else {
    node.appendChild(document.createTextNode('คำนวณแล้วตอน '));
    node.appendChild(el('b', '', hhmm(sentAt)));
  }
}

/** ผลคำนวณใต้ปุ่ม — วาดเองในหน้าฟอร์ม (refreshView ของ net.js ห้ามวาดทับหน้านี้ บอลอาจกำลังพิมพ์)
 *  msg = ข้อความระหว่างรอ · o = เอกสารวันนั้นหลัง AI คิดเสร็จ */
function renderResult(o, msg) {
  const node = $('fResult');
  if (!node) return;
  node.textContent = '';
  node.className = 'fresult';
  if (msg) {
    node.hidden = false;
    node.appendChild(el('div', 'fr-wait', msg));
    return;
  }
  if (!o) { node.hidden = true; return; }
  const rows = [];
  let pSum = 0;
  for (const m of visibleMeals(o)) {
    const n = mealNums(m);
    if (!n.kcal && !n.p) continue;
    pSum += n.p || 0;
    rows.push({ name: m.key || 'มื้ออื่น', kcal: n.kcal, p: n.p, est: n.est });
  }
  if (!rows.length) {
    node.hidden = false;
    node.appendChild(el('div', 'fr-wait', 'ยังไม่ได้เลขจาก AI — เช็คเน็ต/คีย์ในหน้าตั้งค่า แล้วกดคำนวณอีกครั้ง'));
    return;
  }
  const tot = kcalOf(o);
  const top = el('div', 'fr-top');
  top.appendChild(el('span', 'fr-k' + (tot.est ? ' est' : ''), fmt(tot.v)));   // "~" มาจาก .est::before ใน css ห้ามเติมซ้ำ
  top.appendChild(el('span', 'fr-u', 'kcal วันนี้ · โปรตีน ' + fmtP(pSum) + ' g'));
  node.appendChild(top);
  const list = el('div', 'fr-list');
  for (const r of rows) {
    const line = el('div', 'fr-row');
    line.appendChild(el('span', 'fr-n', r.name));
    line.appendChild(el('span', 'fr-v' + (r.est ? ' est' : ''), fmt(r.kcal) + ' kcal'));
    list.appendChild(line);
  }
  node.appendChild(list);
  if (rows.some((r) => r.est)) node.appendChild(el('div', 'fr-note', '~ = เลขประมาณจาก AI ยังไม่ยืนยัน'));
  node.hidden = false;
}

function collectBody() {
  const body = {};
  const t = $('fTime') && $('fTime').value;
  if (t) body.weighedAt = t;
  for (const id of NUMS) {
    const node = $(id);
    const v = node ? String(node.value).trim() : '';
    if (v === '') continue;
    const n = parseFloat(v);
    if (!Number.isFinite(n)) continue;
    body[KEY[id]] = n;
  }
  return body;
}

function collectMeals() {
  const out = [];
  MEALS.forEach((m, i) => {
    const raw = linesOf($('fM' + i));
    const photos = (mealPhotos[i] || []).slice();
    const outside = !!mealOutside[i];
    const time = $('fT' + i) ? $('fT' + i).value : m.time;
    const had = !!mealIds[i];
    if (!had && !raw.length && !photos.length && !outside) return;
    out.push({
      id: ensureMealId(i),
      key: m.key,
      time: time || m.time,
      raw,
      photos,
      outside,
    });
  });
  return out;
}

async function fileToSource(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (_) {
      try { return await createImageBitmap(file); } catch (_) {}
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    if (!canvas.toBlob) {
      reject(new Error('รูปนี้ใช้ไม่ได้ ถ่ายใหม่'));
      return;
    }
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
  });
}

async function compressPhoto(file) {
  let src = null;
  try {
    src = await fileToSource(file);
  } catch (_) {
    throw new Error('รูปนี้ใช้ไม่ได้ ถ่ายใหม่');
  }
  try {
    const sw = src.width || src.naturalWidth || 0;
    const sh = src.height || src.naturalHeight || 0;
    if (!sw || !sh) throw new Error('รูปนี้ใช้ไม่ได้ ถ่ายใหม่');
    const side = Math.max(sw, sh);
    let dw = sw, dh = sh;
    if (side > PHOTO_MAX_SIDE) {
      const scale = PHOTO_MAX_SIDE / side;
      dw = Math.max(1, Math.round(sw * scale));
      dh = Math.max(1, Math.round(sh * scale));
    }
    const canvas = document.createElement('canvas');
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('รูปนี้ใช้ไม่ได้ ถ่ายใหม่');
    ctx.drawImage(src, 0, 0, dw, dh);
    let blob = null;
    for (const q of [0.7, 0.6, 0.5]) {
      blob = await canvasToBlob(canvas, q);
      if (blob && blob.size <= PHOTO_MAX_BYTES) break;
    }
    if (!blob || blob.size > PHOTO_MAX_BYTES) throw new Error('รูปนี้ใช้ไม่ได้ ถ่ายใหม่');
    return { blob, w: dw, h: dh, bytes: blob.size };
  } finally {
    if (src && typeof src.close === 'function') {
      try { src.close(); } catch (_) {}
    }
  }
}

async function paintMealPhotos(i) {
  const host = $('fThumbs' + i);
  if (!host) return;
  host.textContent = '';
  for (const id of mealPhotos[i] || []) {
    let p = null;
    try { p = await db.getPhoto(id); } catch (_) { p = null; }
    const wrap = el('div', 'fthumb');
    if (p && p.blob) {
      const url = URL.createObjectURL(p.blob);
      photoUrls.push(url);
      const img = document.createElement('img');
      img.alt = '';
      img.src = url;
      wrap.appendChild(img);
    } else {
      wrap.appendChild(el('span', '', 'เสีย'));
    }
    const uploaded = !!(p && p.uploaded);
    wrap.appendChild(el('div', 'pbadge' + (uploaded ? ' ok' : ''), uploaded ? 'ขึ้นแล้ว' : 'ยังไม่ขึ้น'));
    if (!uploaded) {
      const del = el('button', 'pdel', '×');
      del.type = 'button';
      del.setAttribute('aria-label', 'ลบรูป');
      del.addEventListener('click', () => removePhoto(i, id));
      wrap.appendChild(del);
    }
    host.appendChild(wrap);
  }
}

async function paintAllPhotos() {
  for (let i = 0; i < MEALS.length; i++) await paintMealPhotos(i);
}

async function addPhoto(i, file) {
  const date = $('fDate') && $('fDate').value;
  if (!date) throw new Error('รูปนี้ใช้ไม่ได้ ถ่ายใหม่');
  const mealId = ensureMealId(i);
  const c = await compressPhoto(file);
  const id = newId('p_');
  await db.putPhoto({
    id,
    date,
    mealId,
    blob: c.blob,
    w: c.w,
    h: c.h,
    bytes: c.bytes,
  });
  mealPhotos[i].push(id);
}

async function onPhotoFiles(i, input) {
  const files = Array.from((input && input.files) || []);
  if (input) input.value = '';
  if (!files.length) return;
  sayForm('กำลังย่อรูป…');
  let ok = 0, bad = 0;
  for (const file of files) {
    try {
      await addPhoto(i, file);
      ok++;
    } catch (_) {
      bad++;
    }
  }
  await paintMealPhotos(i);
  if (bad) sayForm('รูปนี้ใช้ไม่ได้ ถ่ายใหม่', true);
  else sayForm(ok ? 'เก็บรูปแล้ว ' + ok + ' ใบ' : '');
  if (ok) await writeForm(false, { quiet: true });
}

async function removePhoto(i, id) {
  mealPhotos[i] = (mealPhotos[i] || []).filter((x) => x !== id);
  await paintMealPhotos(i);
  await writeForm(false, { quiet: true });
}

function writeForm(sending, opts) {
  const job = writeChain.then(() => writeFormNow(sending, opts));
  writeChain = job.catch(() => {});
  return job;
}

async function writeFormNow(sending, opts) {
  const quiet = !!(opts && opts.quiet);
  const date = $('fDate') && $('fDate').value;
  if (!date) {
    if (!quiet) sayForm('ยังไม่ได้เลือกวันที่', true);
    return;
  }
  const body = collectBody();
  const meals = collectMeals();
  const note = ($('fNote') && $('fNote').value || '').trim();
  const meaningful = body.weight != null || note
    || meals.some((m) => (m.raw && m.raw.length) || (m.photos && m.photos.length) || m.outside)
    || NUMS.some((id) => id !== 'fWeight' && $(id) && String($(id).value).trim() !== '');

  $('fSave') && ($('fSave').disabled = true);
  $('fSend') && ($('fSend').disabled = true);
  if (!quiet) sayForm(sending ? 'กำลังคำนวณ…' : 'กำลังบันทึก…');
  try {
    let existing = null;
    try { existing = await db.getDay(date); } catch (_) { existing = null; }
    if (!existing && !meaningful) {
      if (!quiet) sayForm('ยังไม่มีอะไรให้บันทึก', true);
      return;
    }
    const local = {
      schema: 2,
      date,
      body,
      note,
      meals,
      savedAt: stampNow(),
      state: sending ? 'queued' : 'draft',
    };
    if (sending) {
      local.submitted = true;
      local.submittedAt = stampNow();
    }
    const merged = db.mergeDay(existing, local, 'app');
    const saved = await db.putDay(merged);
    // 21 ก.ย.: ชั่งน้ำหนักเช้าแล้วไม่ได้กดส่ง เลขค้างในเครื่องทั้งวัน (ฝั่ง repo ไม่เห็น ดูแนวโน้มไม่ได้)
    //   → body เปลี่ยนเมื่อไหร่ ดันขึ้น GitHub เลย ไม่ต้องรอกด "คำนวณแคล"
    if (!sending) {
      const b0 = (existing && existing.body) || {};
      const b1 = saved.body || {};
      const bodyChanged = ['weighedAt', ...Object.values(KEY)]
        .some((k) => (b0[k] == null ? null : b0[k]) !== (b1[k] == null ? null : b1[k]));
      // รอบเอว (fWaist) วัดสัปดาห์ละครั้ง อาจกรอกวันที่ไม่ได้ชั่งน้ำหนัก — ต้อง sync ได้เหมือนกัน
      if (bodyChanged && (b1.weight != null || b1.waist != null)) {
        await db.enqueue({ kind: 'gh-day', date });
        net.flush('body').catch(() => {});
      }
    }
    if (sending) {
      await db.enqueue({ kind: 'ai', date });
      const seen = new Set();
      for (const m of saved.meals || []) {
        if (!m || m.deleted || !Array.isArray(m.photos)) continue;
        for (const id of m.photos) {
          if (!id || seen.has(id)) continue;
          seen.add(id);
          let p = null;
          try { p = await db.getPhoto(id); } catch (_) { p = null; }
          if (p && !p.uploaded) await db.enqueue({ kind: 'gh-photo', date, photoId: id });
        }
      }
      await db.enqueue({ kind: 'gh-day', date });
    }
    renderSent(saved);
    curDate = date;
    if (sending) {
      // 16 ก.ย.: ปุ่มนี้คือ "คำนวณแคล" — รอ AI คิดจนจบแล้ววาดเลขให้ดูตรงนี้เลย
      //   (เดิมยิงคิวแล้วปล่อย refreshView ข้ามหน้าฟอร์มเสมอ บอลต้องรีเฟรชแอพเองถึงจะเห็นเลข)
      renderResult(null, 'กำลังคำนวณ… AI กำลังอ่านรูปและรายการอาหาร');
      // วนได้ถึง 3 รอบ: ถ้ามีรอบซิงก์ค้างอยู่ก่อนกด flush จะคืน promise ของรอบนั้น
      //   ซึ่งอาจเริ่มก่อนงานของเราเข้าคิว → งาน ai ของวันนี้ยังค้าง ต้องยิงรอบใหม่
      for (let round = 0; round < 3; round++) {
        try {
          await net.flush?.('submit');
        } catch (e) {
          console.warn('[sync] submit', e);
          break;
        }
        let left = [];
        try { left = await db.listOutbox(); } catch (_) { left = []; }
        const job = left.find((j) => j && j.kind === 'ai' && j.date === date);
        if (!job) break;
        if ((job.tries || 0) > 0) break;   // ลองแล้วพัง — อย่ายิง AI ซ้ำเปลืองโทเคน ให้คิวไปต่อเอง
      }
      let after = null;
      try { after = await db.getDay(date); } catch (_) { after = null; }
      renderResult(after || saved);
      if (!quiet) {
        const n = kcalOf(after || saved);
        sayForm(n.v ? ('คำนวณแล้ว ' + (n.est ? '~' : '') + fmt(n.v) + ' kcal') : 'ส่งแล้ว รอเลขจาก AI');
      }
      return;
    }
    const t = new Date();
    if (!quiet) {
      sayForm('บันทึกแล้ว ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()));
    }
  } catch (e) {
    if (!quiet) {
      sayForm((sending ? 'คำนวณไม่สำเร็จ: ' : 'บันทึกไม่สำเร็จ: ') + ((e && e.message) || 'ลองใหม่อีกครั้ง'), true);
    }
  } finally {
    $('fSave') && ($('fSave').disabled = false);
    $('fSend') && ($('fSend').disabled = false);
  }
}

async function renderForm() {
  const gen = ++formGen;
  buildForm();
  hideSuggest();
  revokePhotoUrls();
  resetMealState();
  clearBodyInputs();
  if ($('fNote')) $('fNote').value = '';
  const now = new Date();
  if ($('fTime')) $('fTime').value = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
  MEALS.forEach((m, i) => {
    if ($('fM' + i)) $('fM' + i).value = '';
    if ($('fT' + i)) $('fT' + i).value = m.time;
    setOutsideChip(i, false);
  });

  let date = $('fDate') && $('fDate').value;
  if (!date) {
    date = curDate || todayISO();
    if ($('fDate')) $('fDate').value = date;
  }
  curDate = date;

  let ref = null;
  try { ref = await lastBodyRef(date); } catch (_) { ref = null; }
  if (gen !== formGen) return;
  applyRef(ref);

  let doc = null;
  try { doc = await db.getDay(date); } catch (_) { doc = null; }
  if (gen !== formGen) return;
  if (doc) {
    fillForm(doc);
    sayForm('โหลดของที่จดไว้แล้วมาให้');
  } else {
    renderSent(null);
    renderResult(null);
    sayForm('วันนี้ยังไม่มีที่จดไว้');
  }
  updateDelta();
  await paintAllPhotos();
  if (gen !== formGen) return;
  formLoadedDate = date;
}

function saveSecret(lsKey, inputId, hintId) {
  const input = $(inputId);
  const v = input ? String(input.value || '').trim() : '';
  if (v) {
    setLs(lsKey, v);
    if (input) input.value = '';
  }
  setText($(hintId), maskSecret(getLs(lsKey)));
}

function saveModels() {
  const ta = $('sAiModels');
  if (!ta) return;
  const list = String(ta.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const isDefault = JSON.stringify(list) === JSON.stringify(net.DEFAULT_MODELS || []);
  setLs(LS_MODELS, list.length && !isDefault ? JSON.stringify(list) : '');
}

function readModels() {
  const raw = getLs(LS_MODELS);
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p) && p.length && JSON.stringify(p) !== JSON.stringify(net.OLD_DEFAULT_MODELS || [])) return p.map(String);
    } catch (_) {}
  }
  return (net.DEFAULT_MODELS || []).slice();
}

async function testNet(which) {
  const msg = $(which === 'or' ? 'sTestOrMsg' : 'sTestGhMsg');
  setStatus(msg, 'กำลังทดสอบ…', '');
  try {
    const r = which === 'or' ? await net.testOpenRouter() : await net.testGitHub();
    const text = r && r.msg != null ? String(r.msg) : (r && r.ok ? 'ผ่าน' : 'ไม่ผ่าน');
    setStatus(msg, text, r && r.ok ? 'ok' : 'err');
  } catch (e) {
    setStatus(msg, String((e && e.message) || e), 'err');
  }
}

async function exportData() {
  const msg = $('sBackupMsg');
  setStatus(msg, 'กำลังส่งออก…', '');
  try {
    const data = await db.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'calorie-export-' + todayISO() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1500);
    setStatus(msg, 'ส่งออกแล้ว ' + ((data.days || []).length) + ' วัน · ' + ((data.photos || []).length) + ' รูป', 'ok');
  } catch (e) {
    setStatus(msg, 'ส่งออกไม่สำเร็จ: ' + ((e && e.message) || e), 'err');
  }
}

async function importData(ev) {
  const input = ev && ev.target;
  const file = input && input.files && input.files[0];
  if (input) input.value = '';
  const msg = $('sBackupMsg');
  if (!file) return;
  setStatus(msg, 'กำลังนำเข้า…', '');
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    const r = await db.importAll(json);
    setStatus(msg, 'นำเข้าแล้ว ' + r.days + ' วัน · ' + r.photos + ' รูป'
      + (r.skipped ? ' (ข้าม ' + r.skipped + ')' : ''), 'ok');
  } catch (e) {
    setStatus(msg, 'นำเข้าไม่สำเร็จ: ' + ((e && e.message) || e), 'err');
  }
}

function resetCacheAndReload() {
  const btn = $('sResetCache');
  if (btn) btn.textContent = 'กำลังล้าง…';
  const jobs = [];
  if (window.caches) {
    jobs.push(caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))));
  }
  if (navigator.serviceWorker) {
    jobs.push(navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))));
  }
  Promise.all(jobs).catch(() => {}).then(() => {
    location.replace(location.pathname + '?r=' + Date.now());
  });
}

async function readSwVersion() {
  try {
    const res = await fetch('./sw.js');
    const txt = await res.text();
    const m = txt.match(/cal-v\d+/);
    return m ? m[0] : 'ไม่ทราบ';
  } catch (_) {
    return 'อ่านไม่ได้';
  }
}

async function countStoredDays() {
  const now = new Date();
  let n = 0;
  let empty = 0;
  for (let i = 0; i < 60; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = isoFromParts(d.getFullYear(), d.getMonth() + 1, 1).slice(0, 7);
    let list = [];
    try { list = await db.listDays(ym); } catch (_) { list = []; }
    n += list.length;
    if (list.length === 0) {
      empty++;
      if (empty >= 3 && i >= 2) break;
    } else empty = 0;
  }
  return n;
}

function isStandalone() {
  try {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch (_) {}
  return window.navigator.standalone === true;
}

async function renderSettings() {
  setText($('sOrKeyHint'), maskSecret(getLs(LS_OR)));
  setText($('sGhPatHint'), maskSecret(getLs(LS_PAT)));
  if ($('sOrKey')) $('sOrKey').value = '';
  if ($('sGhPat')) $('sGhPat').value = '';
  if ($('sGhRepo')) $('sGhRepo').value = getLs(LS_REPO);
  if ($('sAiModels')) $('sAiModels').value = readModels().join('\n');
  if ($('sTestOrMsg')) $('sTestOrMsg').textContent = '';
  if ($('sTestGhMsg')) $('sTestGhMsg').textContent = '';
  if ($('sBackupMsg')) $('sBackupMsg').textContent = '';

  setText($('sDevSw'), 'กำลังอ่าน…');
  setText($('sDevDays'), '…');
  setText($('sDevQueue'), '…');
  const stand = isStandalone();
  setText($('sDevMode'), stand ? 'ติดตั้งแล้ว (standalone)' : 'แท็บเบราว์เซอร์');
  setText($('sDevModeHint'), stand
    ? 'เปิดจากไอคอนบนจอหลัก — นี่คือที่เก็บข้อมูลของแอพ'
    : 'กำลังเปิดในแท็บเบราว์เซอร์ ข้อมูลคนละที่กับไอคอนที่ติดตั้ง ถ้าเพิ่งจดในอีกทาง อาจเหมือนข้อมูลหาย');

  try { setText($('sDevSw'), await readSwVersion()); }
  catch (_) { setText($('sDevSw'), 'อ่านไม่ได้'); }
  try { setText($('sDevDays'), String(await countStoredDays())); }
  catch (_) { setText($('sDevDays'), '—'); }
  try {
    const q = await db.listOutbox();
    setText($('sDevQueue'), String((q || []).length));
  } catch (_) { setText($('sDevQueue'), '—'); }
}

/** ให้ ui-1a.js อ่านวันที่กำลังดูอยู่ */
export function currentDate() { return curDate; }

/** จดด่วนจากหน้าแรก: ต่อบรรทัดเข้ามื้อที่เลือก แล้วเซฟเงียบ ๆ (ไม่ส่ง AI) */
export async function quickLog(text, mealIdx) {
  if (!text) return;
  const i = Number.isInteger(mealIdx) ? Math.min(Math.max(mealIdx, 0), MEALS.length - 1) : 1;
  const target = curDate || todayISO();
  // จดลงวันที่กำลังดูบนหน้าแรก — ถ้าฟอร์มค้างวันอื่นอยู่ เซฟของเดิมก่อนสลับ กันข้อความที่พิมพ์ค้างหาย
  if ($('fDate') && $('fDate').value && $('fDate').value !== target && formLoadedDate === $('fDate').value) {
    await writeForm(false, { quiet: true });
  }
  if ($('fDate')) $('fDate').value = target;
  if (formLoadedDate !== ($('fDate') && $('fDate').value)) await renderForm();
  const ta = $('fM' + i);
  if (!ta) return;
  ta.value = (String(ta.value || '').replace(/\s+$/, '') + '\n' + text).replace(/^\n/, '');
  await writeForm(false, { quiet: true });
  await renderDay();
}
