/* ui-1a.js — ส่วนที่เพิ่มจากรีดีไซน์ 1a
   หน้าที่: วงแหวน "เหลือกินได้อีก" · แถบจดด่วน + ชีตปริมาณ ×½ ×1 ×2 · สลับ 7 วัน/ทั้งเดือน · บรรทัดตาชั่งบนหน้าแรก
   ไม่มีตรรกะข้อมูลของตัวเอง: อ่านผ่าน db.js และเขียนผ่าน ui.quickLog() เท่านั้น
   โหลดหลัง ui.js (app.js เรียก initExtras() ต่อจาก ui.init()) */

import * as db from './db.js';
import * as ui from './ui.js';

const $ = (id) => document.getElementById(id);
const CIRC = 2 * Math.PI * 66;                 // r=66 ในวงแหวน index.html
const DEFAULT_PROFILE = { limit: 1800, tdee: 2450, proteinGoal: 140, goalWeight: 87.5 };
const DEFAULT_QUICK = ['quaker_oat', 'soymilk_mucho', 'pasco_chojuku', 'whey_reys_choco', 'egg', 'rice_scoop', 'chicken_boiled', 'veg_serve'];
const PORTIONS = [0.5, 1, 1.5, 2];
const MEAL_KEYS = ['เช้า', 'กลางวัน', 'ของว่าง', 'เย็น'];
const LS_QUICK = 'cal.quick';

let foods = [];
let sel = null;
let selPortion = 1;
let selMeal = null;
let range = 'month';

function profile() {
  try {
    const o = JSON.parse(localStorage.getItem('cal.profile') || 'null');
    if (!o) return { ...DEFAULT_PROFILE };
    const n = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    return {
      limit: n(o.limit, DEFAULT_PROFILE.limit),
      tdee: n(o.tdee, DEFAULT_PROFILE.tdee),
      proteinGoal: n(o.proteinGoal, DEFAULT_PROFILE.proteinGoal),
      goalWeight: n(o.goalWeight, DEFAULT_PROFILE.goalWeight),
    };
  } catch (_) { return { ...DEFAULT_PROFILE }; }
}

function fmt(n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); }
function pad2(n) { return String(n).padStart(2, '0'); }
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function addDays(iso, k) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(y, m - 1, d + k);
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
}
function quickIds() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_QUICK) || 'null');
    if (Array.isArray(v) && v.length) return v;
  } catch (_) {}
  return DEFAULT_QUICK;
}
function bumpQuick(id) {
  const next = [id, ...quickIds().filter((x) => x !== id)].slice(0, 10);
  try { localStorage.setItem(LS_QUICK, JSON.stringify(next)); } catch (_) {}
}
function guessMealIdx() {
  const h = new Date().getHours();
  if (h < 10) return 0;
  if (h < 15) return 1;
  if (h < 17) return 2;
  return 3;
}

/* ── วงแหวน + บรรทัดตาชั่งบนหน้าแรก ─────────────────── */
export function afterDay(doc, info) {
  const p = profile();
  const eaten = (info && Number.isFinite(info.eaten)) ? info.eaten : 0;
  const ring = $('ring');
  const fill = $('ringFill');
  const pct = p.limit > 0 ? Math.min(Math.max(eaten / p.limit, 0), 1) : 0;
  if (fill) {
    fill.setAttribute('stroke-dasharray', String(CIRC.toFixed(1)));
    fill.setAttribute('stroke-dashoffset', String((CIRC * (1 - pct)).toFixed(1)));
  }
  if (ring) ring.classList.toggle('is-over', eaten > p.limit);

  const b = (doc && doc.body) || {};
  const val = (v, suffix) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) + suffix : null);
  const bits = [];
  const fat = val(b.fat, '%');
  const muscle = val(b.muscle, '');
  if (fat) bits.push('ไขมัน <b>' + fat + '</b>');
  if (muscle) bits.push('กล้าม <b>' + muscle + '</b>');
  const node = $('bodySummary');
  if (node) {
    if (bits.length) node.innerHTML = bits.join(' · ');          // ข้อความคงที่ของเราเอง ไม่ใช่ข้อมูลจาก AI
    else node.textContent = 'ตาชั่งเช้า · ยังไม่ชั่ง';
  }
  renderQuick();
}

/* ── ย้อนหลัง: 7 วัน / ทั้งเดือน ─────────────────────── */
export async function afterMonth() {
  applyRange();
  if (range !== 'week') return;
  const p = profile();
  const end = ui.currentDate ? (ui.currentDate() || todayISO()) : todayISO();
  const dates = [];
  for (let k = 6; k >= 0; k--) dates.push(addDays(end, -k));

  const months = [...new Set(dates.map((d) => d.slice(0, 7)))];
  const byDate = new Map();
  for (const ym of months) {
    let days = [];
    try { days = await db.listDays(ym); } catch (_) { days = []; }
    for (const d of days) byDate.set(d.date, d);
  }

  const rows = dates.map((date) => {
    const doc = byDate.get(date);
    const kcal = doc ? sumKcal(doc) : null;
    return { date, kcal, dow: 'จอพฤศสอา'.slice(0, 0) };
  });
  const TH = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  const top = Math.max(p.tdee, ...rows.map((r) => r.kcal || 0)) * 1.05;

  const host = $('weekBars');
  if (host) {
    host.textContent = '';
    for (const r of rows) {
      const [y, m, d] = r.date.split('-').map(Number);
      const wrap = document.createElement('div');
      const cls = r.kcal == null ? 'none' : r.kcal <= p.limit ? '' : r.kcal <= p.tdee ? 'warn' : 'bad';
      wrap.className = 'wbar' + (cls ? ' ' + cls : '');
      const bar = document.createElement('i');
      bar.style.height = Math.max(3, ((r.kcal || 0) / top) * 100) + '%';
      const lab = document.createElement('span');
      lab.textContent = TH[new Date(y, m - 1, d).getDay()];
      wrap.append(bar, lab);
      wrap.title = r.kcal == null ? r.date + ' · ยังไม่จด' : r.date + ' · ' + fmt(r.kcal) + ' kcal';
      host.appendChild(wrap);
    }
  }

  const logged = rows.filter((r) => r.kcal != null);
  const inBudget = logged.filter((r) => r.kcal <= p.limit).length;
  const avg = logged.length ? logged.reduce((s, r) => s + r.kcal, 0) / logged.length : null;
  const note = $('weekNote');
  if (note) {
    note.textContent = '';
    const add = (t) => { const s = document.createElement('span'); s.textContent = t; note.appendChild(s); };
    add(avg == null ? 'ยังไม่มีวันที่จด' : 'เฉลี่ย ' + fmt(avg) + ' kcal');
    add('อยู่ในงบ ' + inBudget + ' / ' + logged.length + ' วัน');
    if (logged.length < 7) add('ยังไม่จด ' + (7 - logged.length) + ' วัน');
  }
}

/** รวมแคลของวัน: final → est → Σ มื้อ (กฎเดียวกับ kcalOf ใน ui.js แบบย่อ) */
function sumKcal(d) {
  const lay = (o) => (o && Number.isFinite(o.kcal) ? o.kcal : null);
  const fin = lay(d.totals && d.totals.final);
  if (fin != null) return fin;
  let sum = 0, any = false;
  for (const m of (d.meals || [])) {
    if (!m || m.deleted) continue;
    const v = lay(m.final) ?? lay(m.est);
    if (v != null) { sum += v; any = true; continue; }
    for (const it of (m.items || [])) {
      const iv = lay(it && it.final) ?? lay(it && it.est);
      if (iv != null) { sum += iv; any = true; }
    }
  }
  if (any) return sum;
  return lay(d.totals && d.totals.est);
}

function applyRange() {
  const wk = range === 'week';
  const wp = $('weekPane'), mp = $('monthPane');
  if (wp) wp.hidden = !wk;
  if (mp) mp.hidden = wk;
  $('rangeWeek')?.setAttribute('aria-pressed', String(wk));
  $('rangeMonth')?.setAttribute('aria-pressed', String(!wk));
}

/* ── จดด่วน ──────────────────────────────────────────── */
function foodById(id) { return foods.find((f) => f && f.id === id) || null; }

function renderQuick() {
  const host = $('quickRow');
  if (!host) return;
  host.textContent = '';
  const list = quickIds().map(foodById).filter(Boolean).slice(0, 8);
  if (!list.length) { $('quick') && ($('quick').hidden = true); return; }
  $('quick') && ($('quick').hidden = false);
  for (const f of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'qchip';
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = f.name || '';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = fmt(f.kcal) + ' kcal · ' + (f.unit || '1 ที่');
    b.append(n, k);
    b.addEventListener('click', () => openSheet(f));
    host.appendChild(b);
  }
}

function openSheet(f) {
  sel = f;
  selPortion = 1;
  selMeal = MEAL_KEYS[guessMealIdx()];
  const sheet = $('quickSheet');
  if (!sheet) return;
  $('qsName').textContent = f.name || '';
  $('qsUnit').textContent = (f.unit || '') + (f.src === 'label' ? ' · ฉลากจริง' : ' · ค่าประมาณ');
  paintPicks();
  sheet.hidden = false;
}

function closeSheet() {
  const sheet = $('quickSheet');
  if (sheet) sheet.hidden = true;
  sel = null;
}

function paintPicks() {
  if (!sel) return;
  const kcal = Math.round((Number(sel.kcal) || 0) * selPortion);
  const prot = (Number(sel.p) || 0) * selPortion;
  $('qsKcal').textContent = fmt(kcal);
  $('qsMeta').textContent = 'kcal · โปรตีน ' + (Math.round(prot * 10) / 10) + ' g';

  const pHost = $('qsPortions');
  pHost.textContent = '';
  for (const k of PORTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = k === 0.5 ? '×½' : k === 1.5 ? '×1.5' : '×' + k;
    if (k === selPortion) b.classList.add('on');
    b.addEventListener('click', () => { selPortion = k; paintPicks(); });
    pHost.appendChild(b);
  }
  const mHost = $('qsMeals');
  mHost.textContent = '';
  for (const key of MEAL_KEYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = key;
    if (key === selMeal) b.classList.add('on');
    b.addEventListener('click', () => { selMeal = key; paintPicks(); });
    mHost.appendChild(b);
  }
}

async function commitQuick() {
  if (!sel) return;
  const unit = sel.unit ? String(sel.unit) : '';
  const mult = selPortion === 1 ? '' : ' ×' + (selPortion === 0.5 ? '½' : selPortion);
  const text = (sel.name || '') + (unit ? ' ' + unit : '') + mult;
  const idx = Math.max(0, MEAL_KEYS.indexOf(selMeal));
  bumpQuick(sel.id);
  closeSheet();
  try { await ui.quickLog(text, idx); } catch (e) { console.warn('[1a] quickLog', e); }
}

/* ── ผูก event ─────────────────────────────────────── */
export async function initExtras() {
  try {
    const res = await fetch('./data/foods.json');
    if (res.ok) {
      const data = await res.json();
      foods = Array.isArray(data) ? data : (data && Array.isArray(data.foods) ? data.foods : []);
    }
  } catch (_) { foods = []; }

  $('quickMore')?.addEventListener('click', () => $('tabForm')?.click());
  $('toBody')?.addEventListener('click', () => $('tabBody')?.click());
  $('qsClose')?.addEventListener('click', closeSheet);
  $('qsGo')?.addEventListener('click', commitQuick);
  $('quickSheet')?.addEventListener('click', (e) => { if (e.target === $('quickSheet')) closeSheet(); });
  $('rangeWeek')?.addEventListener('click', () => { range = 'week'; ui.renderMonth(); });
  $('rangeMonth')?.addEventListener('click', () => { range = 'month'; ui.renderMonth(); });
  applyRange();
  renderQuick();
}
