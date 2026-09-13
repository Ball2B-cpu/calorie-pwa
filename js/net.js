/* net.js — เรียก AI ประเมินแคล + ซิงก์ขึ้น GitHub   (ก้อนงาน: net)

   ยืนยันด้วยการยิง preflight จริงแล้ว (12 ก.ย. 2026):
     openrouter.ai  → Access-Control-Allow-Origin: *  ยอม Authorization  POST ได้
     api.github.com → Access-Control-Allow-Origin: *  ยอม Authorization  PUT ได้
   ราคาที่วัดจาก /api/v1/models: โมเดล vision ชั้นประหยัด ≈ $0.0002-0.002 ต่อรูป

   กฎเหล็ก:
   - key/PAT อ่านจาก localStorage เท่านั้น: cal.or_key · cal.gh_pat · cal.gh_repo · cal.ai_models
     ห้ามเขียนลงไฟล์ ห้าม console.log ห้ามใส่ใน URL/query string
   - ไม่มี key = แอพต้องยังใช้งานได้ทุกอย่างยกเว้นการส่ง (จดออฟไลน์ได้ตามปกติ)
   - GitHub: GET เพื่อเอา sha → mergeDay → PUT · GET ได้ 404 ถือว่าปกติ (ไฟล์วันใหม่)
     409/422 → GET ใหม่ merge ใหม่ PUT ซ้ำ ไม่เกิน 3 รอบ แล้วคาไว้ในคิว
   - base64 ต้อง encode UTF-8 เองแบบวนทีละ 32KB
     btoa(json) ตรง ๆ throw ทันทีเพราะอักษรไทยเกิน Latin-1
     และ String.fromCharCode(...arr) กับ array ใหญ่ = stack overflow (รูป 200KB ก็พัง)
   - เขียน GitHub ทีละงาน เว้น ≥1.2 วินาทีต่อครั้ง (secondary rate limit) · อ่าน retry-after ถ้ามี
   - ผล AI เขียนลงช่อง est เท่านั้น ห้ามแตะ final / garmin / closed
   - โมเดลอ่านจาก cal.ai_models (ลิสต์ fallback แก้ได้จากหน้าตั้งค่า ไม่ต้อง deploy ใหม่)
     error 400/404 model → ต้องโชว์ชื่อโมเดลตรง ๆ ไม่ใช่ "เกิดข้อผิดพลาด"

   validator ของผล AI (ล้มข้อใดข้อหนึ่ง = ไม่เขียน est แต่เก็บคำตอบดิบไว้ให้ตรวจ):
     items 1-30 รายการ · kcal/p เป็นเลข finite ≥0 · |Σitems.kcal − kcal| ≤ 5% (ไม่ตรงใช้ Σitems)
     kcal ≤ 2500 ต่อมื้อ · p ≤ 200 · conf อยู่ใน 0..1 */

import * as db from './db.js';
import * as ui from './ui.js';

/* โมเดลที่ยืนยันแล้วว่ามีอยู่จริงใน openrouter.ai/api/v1/models (เช็ก 12 ก.ย. 2026)
   เรียงตามลำดับ fallback · ต้องรับภาพ + อ่านฉลากญี่ปุ่น (kanji) ได้
   ราคาต่อรูป (prompt ~1.5k tok + out ~700 tok): flash-lite $0.00043 · qwen3-vl-32b $0.00045 · luna $0.00114
   → ใช้ 4 มื้อ/วัน ≈ $0.06/เดือน (เครดิต $3 อยู่ได้หลายปี)
   ผู้ใช้แก้ลิสต์นี้เองได้จากหน้าตั้งค่า (localStorage cal.ai_models) โดยไม่ต้อง deploy ใหม่ */
/* 13 ก.ย.: บอลเลือกเปลี่ยนตัวหลักเป็น gemini-3.8-flash — flash-lite อ่านฉลากญี่ปุ่นในรูปพลาด (ปูอัด 69 kcal/100g)
   ราคา $0.75/$3.75 ต่อ 1M tok ≈ $0.005/มื้อ ≈ $0.6/เดือน · ตัวถูกเก็บไว้เป็น fallback */
export const DEFAULT_MODELS = [
  'google/gemini-3.8-flash',
  'google/gemini-2.5-flash-lite',
  'qwen/qwen3-vl-32b-instruct',
];
// ลิสต์ default ชุดเก่า — ถ้าในเครื่องบันทึกไว้ตรงชุดนี้เป๊ะ ถือว่าไม่ได้ตั้งเอง ให้ใช้ default ใหม่
export const OLD_DEFAULT_MODELS = ['google/gemini-2.5-flash-lite', 'qwen/qwen3-vl-32b-instruct', 'openai/gpt-5.6-luna'];

export const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const GH_API = 'https://api.github.com';

const LS_OR = 'cal.or_key';
const LS_PAT = 'cal.gh_pat';
const LS_REPO = 'cal.gh_repo';
const LS_MODELS = 'cal.ai_models';
const GH_GAP_MS = 1200;
const GH_PUT_ROUNDS = 3;
const B64_CHUNK = 32 * 1024;
const PAYLOAD_MAX = 8 * 1024;
const OR_TIMEOUT_MS = 45000;
const MEAL_KCAL_MAX = 2500;
const MEAL_P_MAX = 200;

const SYSTEM_PROMPT = `คุณประมาณแคลอรีและโปรตีนของมื้ออาหาร ตอบเป็น JSON ตาม schema เท่านั้น ห้ามมีข้อความอื่น ห้ามใส่ markdown fence

บริบท: อาหารไทยและญี่ปุ่นของคนไทยที่ทำงานในญี่ปุ่น
หน่วยที่ใช้จริง: ทัพพี (80 g) · ชต. · ชช. · ฟอง · ลูก

ถ้ารายการตรงกับตารางอาหารด้านล่าง ใส่ foodId = id ในตาราง และ grams = กรัมที่กินจริง (ผู้ใช้พิมพ์กรัมมา ใช้ตามนั้นเป๊ะ · ไม่ได้บอก ประมาณจากรูป/หน่วยในตาราง) ตอบ basis:"label" หรือ "std" — แอพจะคูณเลขจากตารางเอง
ถ้าในรูปมีตารางโภชนาการ (栄養成分表示 100gあたり) ของรายการนั้น ใส่ labelKcal100 / labelP100 ตามฉลาก (ไม่มีฉลาก = 0) — ค่าฉลากในรูปชนะตาราง · น้ำหนักแพ็ค (内容量/正味量 เช่น 212g) ใส่ใน qty แต่ grams ต้องเป็นปริมาณที่กินจริง ถ้าผู้ใช้ไม่บอกว่ากินหมดแพ็คไหม ให้กะจากรูปและใส่ในรายการ unclear
ถ้าผู้ใช้พิมพ์แคลของรายการนั้นมาเอง (เช่น "11 กิโลแคล") ใส่ userKcal = เลขนั้น ไม่พิมพ์ = 0
รายการที่ไม่มีในตาราง: foodId "" · grams ประมาณ · kcal/p ประมาณจากความรู้อาหารทั่วไป basis "guess"
ห้ามให้ kcal 0 กับของที่มีพลังงานจริง (เช่น ปูอัด/カニカマ ~90 kcal ต่อ 100 g) — ไม่เห็นปริมาณให้ประมาณจากรูปแล้วใส่ conf ต่ำ

ตารางอาหาร:
{{FOOD_TABLE}}

จากรูปให้ดู: ปริมาณเทียบขนาดชาม/จาน · น้ำมัน/ซอสที่มองเห็น · ของที่มองไม่ชัดให้ใส่ใน unclear แทนการเดา
ห้ามเติมรายการที่ไม่มีทั้งในรูปและในข้อความที่ผู้ใช้พิมพ์
ถ้ามีฉลากในรูป (ญี่ปุ่น) ให้อ่านค่าจากฉลากเป็นหลัก และคูณตามปริมาณที่กินจริง

schema ผลลัพธ์:
{"items":[{"name":"","qty":"","foodId":"","grams":0,"userKcal":0,"labelKcal100":0,"labelP100":0,"kcal":0,"p":0,"conf":0.0,"basis":"label|std|guess","needLabel":false}],"kcal":0,"p":0,"confidence":0.0,"warnings":[],"unclear":[]}`;

const ESTIMATE_JSON_SCHEMA = {
  name: 'meal_estimate',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            qty: { type: 'string' },
            foodId: { type: 'string' },
            grams: { type: 'number' },
            userKcal: { type: 'number' },
            labelKcal100: { type: 'number' },
            labelP100: { type: 'number' },
            kcal: { type: 'number' },
            p: { type: 'number' },
            conf: { type: 'number' },
            basis: { type: 'string', enum: ['label', 'std', 'guess'] },
            needLabel: { type: 'boolean' },
          },
          required: ['name', 'qty', 'foodId', 'grams', 'userKcal', 'labelKcal100', 'labelP100', 'kcal', 'p', 'conf', 'basis', 'needLabel'],
        },
      },
      kcal: { type: 'number' },
      p: { type: 'number' },
      confidence: { type: 'number' },
      warnings: { type: 'array', items: { type: 'string' } },
      unclear: { type: 'array', items: { type: 'string' } },
    },
    required: ['items', 'kcal', 'p', 'confidence', 'warnings', 'unclear'],
  },
};

class NetError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = extra.name || 'NetError';
    this.code = extra.code || null;
    this.status = extra.status;
    this.stopRound = !!extra.stopRound;
    this.stopKind = extra.stopKind || null;
    this.defer = !!extra.defer;
    this.raw = extra.raw;
  }
}

let flushing = false;
let lastGhWriteAt = 0;
let foodsCache = null;

function lsGet(key) {
  try { return localStorage.getItem(key) || ''; } catch (_) { return ''; }
}

function orKey() { return lsGet(LS_OR).trim(); }
function ghPat() { return lsGet(LS_PAT).trim(); }
function ghRepo() { return lsGet(LS_REPO).trim().replace(/^\/+|\/+$/g, ''); }

function tail6(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 6) return '(สั้นเกินกว่าจะโชว์ท้าย)';
  return '••••' + s.slice(-6);
}

function nowISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const ah = Math.floor(Math.abs(off) / 60);
  const am = Math.abs(off) % 60;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(ah)}:${pad(am)}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

function setStatus(state, detail) {
  try { ui.setSyncStatus?.(state, detail); } catch (_) {}
}

function errText(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

function unique(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/** UTF-8 → base64 วนทีละ 32 KB — ห้าม btoa(string ไทย) และห้าม spread array ใหญ่ */
export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < u8.length; i += B64_CHUNK) {
    const end = Math.min(i + B64_CHUNK, u8.length);
    const chars = new Array(end - i);
    for (let j = 0, k = i; k < end; j++, k++) chars[j] = String.fromCharCode(u8[k]);
    binary += chars.join('');
  }
  return btoa(binary);
}

export function utf8ToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(String(text ?? '')));
}

export function base64ToUtf8(b64) {
  const clean = String(b64 || '').replace(/\s/g, '');
  if (!clean) return '';
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}

function readModels() {
  const raw = lsGet(LS_MODELS);
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p) && p.length && JSON.stringify(p) !== JSON.stringify(OLD_DEFAULT_MODELS)) return p.map(String).map((s) => s.trim()).filter(Boolean);
    } catch (_) {}
  }
  return DEFAULT_MODELS.slice();
}

function matchFoods(raw, foods) {
  const list = Array.isArray(foods) ? foods : (foods && Array.isArray(foods.foods) ? foods.foods : []);
  const text = (Array.isArray(raw) ? raw.join('\n') : String(raw || ''));
  const hay = text.toLowerCase();
  if (!hay.trim()) return [];
  const out = [];
  for (const f of list) {
    if (!f) continue;
    const needles = [f.name, f.id, ...(Array.isArray(f.alias) ? f.alias : [])];
    let hit = false;
    for (const n of needles) {
      const s = String(n || '').toLowerCase();
      if (s.length >= 2 && hay.includes(s)) { hit = true; break; }
    }
    if (!hit) continue;
    const row = { name: f.name, unit: f.unit, kcal: f.kcal, p: f.p, src: f.src };
    if (f.id) row.id = f.id;
    if (f.g != null) row.g = f.g;
    if (Array.isArray(f.alias) && f.alias.length) row.alias = f.alias;
    out.push(row);
  }
  return out;
}

/**
 * คิดเลขจากตารางด้วยโค้ด ไม่ให้โมเดลคูณเอง (13 ก.ย.: ข้าว 150 g ได้ 201 แทน 252, ขิงดองที่บอลพิมพ์ 11 kcal ได้ 10)
 * ลำดับ: userKcal ที่ผู้ใช้พิมพ์ > ฉลากในรูป (labelKcal100 × grams) > ตาราง (foodId × grams/g) > ค่าที่โมเดลประมาณ
 * (ปูอัด 13 ก.ย.: ฉลากในรูปเขียน 69 kcal/100g แต่ตารางทับเป็นค่ามาตรฐาน 90)
 * รวม kcal/p ของมื้อคิดใหม่จากรายการเสมอ
 */
export function applyFoodTable(raw, foods) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return raw;
  const list = Array.isArray(foods) ? foods : (foods && Array.isArray(foods.foods) ? foods.foods : []);
  const byId = new Map(list.filter((f) => f && f.id).map((f) => [String(f.id), f]));
  let changed = false;
  const items = raw.items.map((it0) => {
    const it = { ...(it0 || {}) };
    const f = it.foodId ? byId.get(String(it.foodId)) : null;
    const grams = Number(it.grams);
    const perG = f && Number(f.g) > 0 ? 1 / Number(f.g) : 0;
    if (f && perG && grams > 0) {
      it.kcal = Math.round(Number(f.kcal) * grams * perG);
      it.p = Math.round(Number(f.p) * grams * perG * 10) / 10;
      it.basis = f.src === 'label' ? 'label' : 'std';
      changed = true;
    }
    const lk = Number(it.labelKcal100);
    if (Number.isFinite(lk) && lk > 0 && grams > 0) {
      it.kcal = Math.round(lk * grams / 100);
      const lp = Number(it.labelP100);
      if (Number.isFinite(lp) && lp > 0) it.p = Math.round(lp * grams / 10) / 10;
      it.basis = 'label';
      changed = true;
    }
    const uk = Number(it.userKcal);
    if (Number.isFinite(uk) && uk > 0) {
      it.kcal = uk;
      it.basis = 'label';
      changed = true;
    }
    return it;
  });
  if (!changed) return raw;
  const sumK = items.reduce((s, x) => s + (Number(x.kcal) || 0), 0);
  const sumP = items.reduce((s, x) => s + (Number(x.p) || 0), 0);
  return { ...raw, items, kcal: sumK, p: Math.round(sumP * 10) / 10 };
}

function buildSystem(foodTableJson, extra) {
  let sys = SYSTEM_PROMPT.replace('{{FOOD_TABLE}}', foodTableJson || '(ไม่มีรายการที่ตรง)');
  if (extra) sys += '\n' + extra;
  return sys;
}

function fitPrompt(raw, foods) {
  let matched = matchFoods(raw, foods);
  const rawText = Array.isArray(raw) ? raw.join('\n') : String(raw || '');
  const pack = (table) => {
    const sys = buildSystem(table);
    const user = `วันที่และมื้ออยู่ในข้อความผู้ใช้\nที่ผู้ใช้พิมพ์:\n${rawText}`;
    return { sys, user, bytes: new TextEncoder().encode(sys + '\n' + user).length };
  };
  let table = JSON.stringify(matched);
  let built = pack(table);
  while (matched.length && built.bytes > PAYLOAD_MAX) {
    matched = matched.slice(0, -1);
    table = JSON.stringify(matched);
    built = pack(table);
  }
  if (built.bytes > PAYLOAD_MAX) {
    built = pack('(ตัดตารางออก เพราะข้อความยาวเกิน)');
  }
  return { system: built.sys, userText: built.user, foods: matched };
}

/**
 * ตรวจผล AI ตาม 6 ข้อในหัวไฟล์
 * ข้อ 3 ไม่ใช่การปฏิเสธ: ผลรวมไม่ตรงเกิน 5% → ใช้ Σitems.kcal
 * conf ที่ไม่มี → null (ห้ามถือเป็น 0)
 */
export function validateEstimate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'คำตอบไม่ใช่ object', raw };
  }
  const itemsIn = raw.items;
  if (!Array.isArray(itemsIn) || itemsIn.length < 1 || itemsIn.length > 30) {
    return { ok: false, error: 'items ต้องมี 1-30 รายการ', raw };
  }

  const items = [];
  let sumK = 0;
  let sumP = 0;
  for (let i = 0; i < itemsIn.length; i++) {
    const it = itemsIn[i] || {};
    const kcal = Number(it.kcal);
    const p = Number(it.p);
    if (!Number.isFinite(kcal) || kcal < 0) return { ok: false, error: `รายการที่ ${i + 1}: kcal ต้องเป็นเลข finite ≥0`, raw };
    if (!Number.isFinite(p) || p < 0) return { ok: false, error: `รายการที่ ${i + 1}: p ต้องเป็นเลข finite ≥0`, raw };
    let conf = null;
    if (it.conf != null && it.conf !== '') {
      const c = Number(it.conf);
      if (!Number.isFinite(c) || c < 0 || c > 1) {
        return { ok: false, error: `รายการที่ ${i + 1}: conf ต้องอยู่ใน 0..1`, raw };
      }
      conf = c;
    }
    let basis = it.basis;
    if (basis !== 'label' && basis !== 'std' && basis !== 'guess') basis = 'guess';
    sumK += kcal;
    sumP += p;
    items.push({
      name: String(it.name || ''),
      qty: it.qty == null ? '' : String(it.qty),
      foodId: it.foodId ? String(it.foodId) : '',
      grams: Number.isFinite(Number(it.grams)) && Number(it.grams) > 0 ? Number(it.grams) : 0,
      userKcal: Number.isFinite(Number(it.userKcal)) && Number(it.userKcal) > 0 ? Number(it.userKcal) : 0,
      kcal,
      p,
      conf,
      basis,
      needLabel: !!it.needLabel,
    });
  }

  let kcal = Number(raw.kcal);
  let p = Number(raw.p);
  if (!Number.isFinite(kcal) || kcal < 0) return { ok: false, error: 'kcal รวมต้องเป็นเลข finite ≥0', raw };
  if (!Number.isFinite(p) || p < 0) return { ok: false, error: 'p รวมต้องเป็นเลข finite ≥0', raw };

  const kcalTol = 0.05 * Math.max(Math.abs(sumK), Math.abs(kcal));
  if (Math.abs(sumK - kcal) > kcalTol) kcal = sumK;

  if (kcal > MEAL_KCAL_MAX) return { ok: false, error: `kcal ต่อมื้อเกิน ${MEAL_KCAL_MAX}`, raw };
  if (p > MEAL_P_MAX) return { ok: false, error: `p ต่อมื้อเกิน ${MEAL_P_MAX}`, raw };

  let confidence = null;
  if (raw.confidence != null && raw.confidence !== '') {
    const c = Number(raw.confidence);
    if (!Number.isFinite(c) || c < 0 || c > 1) {
      return { ok: false, error: 'confidence ต้องอยู่ใน 0..1', raw };
    }
    confidence = c;
  }

  const warnings = Array.isArray(raw.warnings) ? raw.warnings.map((w) => String(w)) : [];
  const unclear = Array.isArray(raw.unclear) ? raw.unclear.map((w) => String(w)) : [];

  return {
    ok: true,
    value: { items, kcal, p, confidence, warnings, unclear },
  };
}

function parseJsonContent(text) {
  let s = String(text || '').trim();
  if (!s) throw new NetError('โมเดลตอบว่าง');
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  try {
    return JSON.parse(s);
  } catch (_) {}
  // มีข้อความนำหน้า/ตามหลัง JSON → ตัดเอาช่วง { ... } ที่ใหญ่สุด
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try { return JSON.parse(s.slice(i, j + 1)); } catch (_) {}
  }
  throw new NetError('โมเดลไม่ได้ตอบ JSON: ' + s.slice(0, 60).replace(/\s+/g, ' '), { raw: s.slice(0, 400) });
}

function lookRate(res) {
  const ra = res.headers && res.headers.get && (res.headers.get('retry-after') || res.headers.get('Retry-After'));
  const rem = res.headers && res.headers.get && (res.headers.get('x-ratelimit-remaining') || res.headers.get('X-RateLimit-Remaining'));
  if (res.status === 429) {
    return new NetError('ถูกจำกัดอัตราการเรียก — จะลองใหม่ทีหลัง', { status: 429, stopRound: true, code: 'rate' });
  }
  if (res.status >= 400 && ra) {
    return new NetError('ถูกขอให้รอแล้วค่อยเรียกใหม่', { status: res.status, stopRound: true, code: 'rate' });
  }
  if (rem === '0') {
    return new NetError('โควต้าเรียกหมดรอบนี้ — จะลองใหม่ทีหลัง', { status: res.status, stopRound: true, code: 'rate' });
  }
  return null;
}

function authError(kind, status) {
  let msg;
  if (kind === 'or') {
    if (status === 401) msg = 'คีย์ OpenRouter ไม่ถูกต้องหรือหมดอายุ';
    else if (status === 402) msg = 'เครดิต OpenRouter หมด — เติมที่หน้า openrouter.ai';
    else msg = 'คีย์ OpenRouter ไม่มีสิทธิ์เรียกโมเดลนี้';
  } else if (status === 401) msg = 'GitHub PAT ไม่ถูกต้องหรือหมดอายุ';
  else if (status === 402) msg = 'GitHub ปฏิเสธคำขอ (402)';
  else msg = 'GitHub PAT ไม่มีสิทธิ์เขียนรีโปนี้ — ตรวจชื่อรีโปและสิทธิ์ contents:write';
  const stopKind = kind === 'or' ? 'ai' : (kind === 'gh' ? 'gh' : kind);
  return new NetError(msg, { status, stopKind, code: 'auth' });
}

function isModelMissing(status, bodyText) {
  if (status === 404) return true;
  if (status !== 400) return false;
  const s = String(bodyText || '').toLowerCase();
  return /model|not found|no endpoints|does not exist|unknown model|invalid model/.test(s);
}

async function readBodyText(res) {
  try { return await res.text(); } catch (_) { return ''; }
}

function parseErrMsg(text) {
  if (!text) return '';
  try {
    const j = JSON.parse(text);
    const m = (j && (j.message || (j.error && (j.error.message || j.error)))) || '';
    return String(m || '').slice(0, 180);
  } catch (_) {
    return String(text).slice(0, 120);
  }
}

async function loadFoodsCatalog() {
  if (foodsCache) return foodsCache;
  const res = await fetch('./data/foods.json');
  if (!res.ok) return [];
  const data = await res.json();
  foodsCache = Array.isArray(data) ? data : (data && Array.isArray(data.foods) ? data.foods : []);
  return foodsCache;
}

async function blobDataUrl(blob) {
  const b64 = await blobToBase64(blob);
  const mime = (blob && blob.type) || 'image/jpeg';
  return `data:${mime};base64,${b64}`;
}

function referer() {
  try { return location.origin + location.pathname; } catch (_) { return ''; }
}

async function orChat({ model, system, userParts, responseFormat }) {
  const key = orKey();
  if (!key) throw new NetError('ยังไม่ได้ตั้งค่า', { code: 'nokey' });
  const body = {
    model,
    temperature: 0,
    // 13 ก.ย.: gemini-3.8-flash คิดก่อนตอบ (reasoning) กินโควตา max_tokens 1500 จน JSON ถูกตัดกลางคัน
    // → "โมเดลไม่ได้ตอบ JSON" · เพิ่มเพดาน + ขอคิดน้อย (โมเดลที่ไม่รองรับ OpenRouter จะเมินเอง)
    max_tokens: 6000,
    reasoning: { effort: 'low', exclude: true },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userParts },
    ],
  };
  if (responseFormat) body.response_format = responseFormat;
  const res = await fetch(OR_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      'HTTP-Referer': referer(),
      'X-Title': 'calorie-pwa',
    },
    body: JSON.stringify(body),
    signal: timeoutSignal(OR_TIMEOUT_MS),
  });
  const text = await readBodyText(res);
  if (res.status === 401 || res.status === 402 || res.status === 403) throw authError('or', res.status);
  const rate = lookRate(res);
  if (rate) throw rate;
  return { res, text };
}

function extractContent(text) {
  let data;
  try { data = JSON.parse(text); } catch (_) {
    throw new NetError('OpenRouter ตอบไม่ใช่ JSON', { raw: String(text).slice(0, 200) });
  }
  const ch = data && data.choices && data.choices[0];
  let content = ch && ch.message ? ch.message.content : null;
  if (Array.isArray(content)) content = content.map((c) => (c && (c.text ?? c.content)) || '').join('');
  if (ch && ch.finish_reason === 'length') {
    throw new NetError('โมเดลตอบยาวเกินเพดานจน JSON ถูกตัด', { raw: String(content || '').slice(-200) });
  }
  return content;
}

function sumMealEst(meals) {
  let kcal = 0;
  let p = 0;
  for (const m of meals || []) {
    if (!m || m.deleted) continue;
    if (m.est && Number.isFinite(Number(m.est.kcal))) kcal += Number(m.est.kcal);
    if (m.est && Number.isFinite(Number(m.est.p))) p += Number(m.est.p);
  }
  return { kcal, p };
}

async function writeEstimate(date, mealId, estimate, model, sig) {
  const existing = await db.getDay(date);
  if (!existing) throw new NetError('ไม่พบวันที่ ' + date);
  const meals = Array.isArray(existing.meals) ? existing.meals : [];
  const items = estimate.items.map((it) => ({
    name: it.name,
    est: {
      kcal: it.kcal,
      p: it.p,
      conf: it.conf,
      basis: it.basis,
      needLabel: !!it.needLabel,
    },
  }));
  const mealPatch = {
    id: mealId,
    items,
    est: sig ? { kcal: estimate.kcal, p: estimate.p, sig } : { kcal: estimate.kcal, p: estimate.p },
  };

  const after = meals.map((m) => {
    if (!m || m.id !== mealId) return m;
    return { ...m, items, est: mealPatch.est };
  });
  if (!after.some((m) => m && m.id === mealId)) after.push({ id: mealId, items, est: mealPatch.est });

  const prevAi = existing.ai && typeof existing.ai === 'object' ? existing.ai : {};
  const patch = {
    date,
    meals: [mealPatch],
    totals: { est: sumMealEst(after) },
    ai: {
      model,
      at: nowISO(),
      warnings: unique([...(prevAi.warnings || []), ...(estimate.warnings || [])]),
      unclear: unique([...(prevAi.unclear || []), ...(estimate.unclear || [])]),
    },
    state: 'estimated',
  };
  const merged = db.mergeDay(existing, patch, 'ai');
  await db.putDay(merged);
  return merged;
}

/** ประเมินมื้อด้วยโมเดล vision */
export async function estimateMeal({ date, mealId, raw, photoBlobs, foods, sig }) {
  if (!orKey()) return null;
  const foodSrc = foods || await loadFoodsCatalog();
  const { system: system0, userText } = fitPrompt(raw, foodSrc);
  const userParts = [{ type: 'text', text: `วันที่ ${date || ''} มื้อ ${mealId || ''}\n` + userText }];
  const blobs = Array.isArray(photoBlobs) ? photoBlobs : [];
  for (const blob of blobs) {
    if (!blob) continue;
    const url = await blobDataUrl(blob);
    userParts.push({ type: 'image_url', image_url: { url } });
  }

  const models = readModels();
  if (!models.length) throw new NetError('ยังไม่ได้ตั้งรายการโมเดล');

  let lastErr = null;
  const modelErrs = [];
  for (const model of models) {
    const attempts = [
      { format: { type: 'json_schema', json_schema: ESTIMATE_JSON_SCHEMA }, extra: '' },
      { format: { type: 'json_object' }, extra: '' },
      { format: { type: 'json_object' }, extra: 'ตอบ JSON ตาม schema เท่านั้น' },
    ];
    let skipModel = false;
    for (let a = 0; a < attempts.length; a++) {
      const sys = attempts[a].extra ? (system0 + '\n' + attempts[a].extra) : system0;
      let res, text;
      try {
        ({ res, text } = await orChat({
          model,
          system: sys,
          userParts,
          responseFormat: attempts[a].format,
        }));
      } catch (e) {
        if (e && (e.stopRound || e.stopKind || e.code === 'auth')) throw e;
        lastErr = e;
        if (e && e.status === 400 && a < attempts.length - 1) continue;
        if (e && isModelMissing(e.status, e.message)) { skipModel = true; break; }
        if (a < attempts.length - 1) continue;
        skipModel = true;
        break;
      }
      if (!res.ok) {
        if (isModelMissing(res.status, text)) {
          lastErr = new NetError(`โมเดล ${model} ไม่รับ (${res.status}${parseErrMsg(text) ? ': ' + parseErrMsg(text) : ''})`, { status: res.status });
          skipModel = true;
          break;
        }
        lastErr = new NetError(`โมเดล ${model} ตอบ ${res.status}${parseErrMsg(text) ? ': ' + parseErrMsg(text) : ''}`, { status: res.status, raw: text.slice(0, 400) });
        if (res.status === 400 && a < attempts.length - 1) continue;
        skipModel = true;
        break;
      }
      let checked;
      try {
        const content = extractContent(text);
        const parsed = parseJsonContent(content);
        checked = validateEstimate(applyFoodTable(parsed, foodSrc));
        if (!checked.ok) {
          throw new NetError(`ผล AI ไม่ผ่านตัวตรวจ: ${checked.error}`, { raw: JSON.stringify(parsed).slice(0, 400) });
        }
      } catch (e) {
        // คำตอบพัง → ลองรูปแบบถัดไป/โมเดลถัดไป แทนการล้มทั้งงาน (ข้อความ error บอกชื่อโมเดลด้วย)
        lastErr = new NetError(`${model}: ${errText(e)}`, { raw: e && e.raw });
        if (a < attempts.length - 1) continue;
        skipModel = true;
        break;
      }
      await writeEstimate(date, mealId, checked.value, model, sig);
      return checked.value;
    }
    if (!skipModel && lastErr) throw lastErr;
    if (lastErr) modelErrs.push(errText(lastErr).slice(0, 90));
    lastErr = null;
  }
  // รายงานทุกโมเดล ไม่ใช่แค่ตัวสุดท้าย (เดิมเห็นแค่ qwen ไม่รู้ว่า gemini ล้มเพราะอะไร)
  throw new NetError(modelErrs.length ? modelErrs.join(' · ') : 'ประเมินมื้อไม่สำเร็จ');
}

function ghHeaders(pat) {
  return {
    Authorization: 'Bearer ' + pat,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function ghContentsUrl(repo, path) {
  return `${GH_API}/repos/${repo}/contents/${path}?ref=main`;
}

async function ghRequest(url, opts) {
  const res = await fetch(url, opts);
  const text = await readBodyText(res);
  const ra = res.headers && res.headers.get && (res.headers.get('retry-after') || res.headers.get('Retry-After'));
  if (res.status === 403 && ra) {
    throw new NetError('ถูกจำกัดอัตราการเรียก GitHub — จะลองใหม่ทีหลัง', { status: 403, stopRound: true, code: 'rate' });
  }
  if (res.status === 401 || res.status === 402 || res.status === 403) {
    // แนบข้อความจริงของ GitHub + method/path — 403 มีหลายสาเหตุ (สิทธิ์ / secondary rate limit / repo ถูกล็อก)
    // เดิมทิ้งข้อความไป บอลเจอ 403 ทั้งที่ token ถูกต้องแล้ววินิจฉัยไม่ได้ (13 ก.ย.)
    const err = authError('gh', res.status);
    const gm = parseErrMsg(text);
    const where = `${(opts && opts.method) || 'GET'} ${String(url).replace(GH_API, '').split('?')[0]}`;
    err.message += ` [${res.status} ${where}${gm ? ' · ' + gm : ''}]`;
    throw err;
  }
  const rate = lookRate(res);
  if (rate && res.status !== 404) throw rate;
  return { res, text };
}

async function ghGet(repo, pat, path) {
  const { res, text } = await ghRequest(ghContentsUrl(repo, path), {
    method: 'GET',
    headers: ghHeaders(pat),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new NetError(`อ่าน GitHub ไม่ได้ (${res.status}${parseErrMsg(text) ? ': ' + parseErrMsg(text) : ''})`, { status: res.status, raw: text.slice(0, 200) });
  }
  let data;
  try { data = JSON.parse(text); } catch (_) {
    throw new NetError('GitHub ตอบไม่ใช่ JSON');
  }
  return data;
}

async function beforeGhWrite() {
  const wait = lastGhWriteAt + GH_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
}

async function ghPut(repo, pat, path, body) {
  await beforeGhWrite();
  const { res, text } = await ghRequest(`${GH_API}/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: { ...ghHeaders(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  lastGhWriteAt = Date.now();
  return { res, text };
}

/** รวมเอกสารตอนซิงก์กับ GitHub — ของในเครื่องมีทั้งส่วนของ app (raw/body) และ ai (est)
 *  merge แค่ 'app' รอบเดียว = est ถูกทิ้งทั้งบน repo และในเครื่อง จึงต้อง 2 รอบแล้วรวมเป็น rev เดียว
 *  final/garmin/closed/review ของ Claude ไม่มีรอบไหนเขียนทับได้ (base = remote) */
export function syncMerge(remote, local) {
  const a = db.mergeDay(remote, local, 'app');
  const b = db.mergeDay(a, local, 'ai');
  const last = b.history.pop();
  const prev = b.history[b.history.length - 1];
  if (prev && prev.rev === a.rev && last) {
    prev.fields = [...new Set([...(prev.fields || []), ...(last.fields || [])])];
  }
  b.rev = a.rev;
  b.updatedBy = 'app';
  return b;
}

async function assertPhotosUploaded(date) {
  const photos = await db.listPhotos(date);
  const pending = (photos || []).filter((p) => p && !p.uploaded);
  if (pending.length) {
    throw new NetError(`รอรูปขึ้นครบก่อน (ค้าง ${pending.length} ใบ)`, { defer: true, code: 'photos' });
  }
}

/** ดัน/ดึงข้อมูลกับ repo ส่วนตัว */
export async function pushDay(date) {
  const pat = ghPat();
  const repo = ghRepo();
  if (!pat || !repo) return null;
  await assertPhotosUploaded(date);
  const local = await db.getDay(date);
  if (!local) throw new NetError('ไม่พบวันที่ ' + date);

  const path = `days/${date}.json`;
  let lastErr = null;
  for (let round = 0; round < GH_PUT_ROUNDS; round++) {
    const remoteFile = await ghGet(repo, pat, path);
    let remote = null;
    if (remoteFile && remoteFile.content) {
      try { remote = JSON.parse(base64ToUtf8(remoteFile.content)); } catch (_) {
        throw new NetError('ถอดไฟล์วันจาก GitHub ไม่ได้');
      }
    }
    const merged = syncMerge(remote, local);
    const body = {
      message: `calorie-pwa: ${date} rev ${merged.rev}`,
      content: utf8ToBase64(JSON.stringify(merged, null, 2)),
      branch: 'main',
    };
    if (remoteFile && remoteFile.sha) body.sha = remoteFile.sha;
    const { res, text } = await ghPut(repo, pat, path, body);
    if (res.ok) {
      await db.putDay(merged);
      return merged;
    }
    if (res.status === 409 || res.status === 422) {
      lastErr = new NetError(`GitHub ชนกัน (${res.status})`, { status: res.status });
      continue;
    }
    throw new NetError(`เขียนวันที่ขึ้น GitHub ไม่ได้ (${res.status}${parseErrMsg(text) ? ': ' + parseErrMsg(text) : ''})`, { status: res.status, raw: text.slice(0, 200) });
  }
  throw lastErr || new NetError('GitHub ชนกัน 3 รอบ ยังเขียนไม่ได้ จะลองใหม่ทีหลัง');
}

function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ดึงวันล่าสุด n วันที่ยังไม่ปิดยอดในเครื่อง → true ถ้ามีวันไหน rev เปลี่ยน */
export async function pullRecent(n) {
  let changed = false;
  for (let i = 0; i < n; i++) {
    const date = isoDaysAgo(i);
    const local = await db.getDay(date);
    if (local && local.closed) continue;
    const before = local ? local.rev : null;
    const after = await pullDay(date);
    const doc = after && typeof after === 'object' ? after : await db.getDay(date);
    if (doc && doc.rev !== before) changed = true;
  }
  return changed;
}

function refreshView() {
  try {
    let v = 'Day';
    try { v = localStorage.getItem('cal.view') || 'Day'; } catch (_) {}
    if (v !== 'Form') ui.onShow?.(v);   // หน้าฟอร์มห้ามวาดทับ บอลอาจกำลังพิมพ์
  } catch (_) {}
}

export async function pullDay(date) {
  const pat = ghPat();
  const repo = ghRepo();
  if (!pat || !repo) return null;
  const path = `days/${date}.json`;
  const remoteFile = await ghGet(repo, pat, path);
  if (!remoteFile || !remoteFile.content) return null;
  let remote;
  try { remote = JSON.parse(base64ToUtf8(remoteFile.content)); } catch (_) {
    throw new NetError('ถอดไฟล์วันจาก GitHub ไม่ได้');
  }
  const local = await db.getDay(date);
  const merged = syncMerge(remote, local || { schema: 2, date });
  // merge ทุกครั้ง rev +1 เสมอ → ถ้าเนื้อหาไม่ต่างจากในเครื่อง ไม่ต้องบันทึก (ไม่งั้น rev วิ่งทุก 5 นาที)
  if (local && sameContent(merged, local)) return local;
  return db.putDay(merged);
}

function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

export function sameContent(a, b) {
  const strip = (d) => {
    const { rev, updatedAt, updatedBy, history, savedAt, ...rest } = d || {};
    return canon(rest);
  };
  return strip(a) === strip(b);
}

export async function pushPhoto(photoId) {
  const pat = ghPat();
  const repo = ghRepo();
  if (!pat || !repo) return null;
  const photo = await db.getPhoto(photoId);
  if (!photo) throw new NetError('ไม่พบรูป id=' + photoId);
  if (!photo.blob) throw new NetError('รูปไม่มีไฟล์');
  const date = photo.date;
  const path = `photos/${date}/${photo.id}.jpg`;
  const remoteFile = await ghGet(repo, pat, path);
  const body = {
    message: `calorie-pwa photo: ${photo.id}`,
    content: await blobToBase64(photo.blob),
    branch: 'main',
  };
  if (remoteFile && remoteFile.sha) body.sha = remoteFile.sha;
  const { res, text } = await ghPut(repo, pat, path, body);
  if (!res.ok) {
    if (res.status === 409 || res.status === 422) {
      throw new NetError(`GitHub ชนกันตอนส่งรูป (${res.status})`, { status: res.status });
    }
    throw new NetError(`ส่งรูปขึ้น GitHub ไม่ได้ (${res.status}${parseErrMsg(text) ? ': ' + parseErrMsg(text) : ''})`, { status: res.status });
  }
  await db.markPhotoUploaded(photo.id, path);
  return path;
}

function ghReady() { return !!(ghPat() && ghRepo()); }

/** repo ข้อมูลต้องไม่ใช่ repo โค้ด (public) — 13 ก.ย. บอลใส่ calorie-pwa ในช่อง repo แล้วแอพพยายามดันรูปอาหารขึ้น repo สาธารณะ
 *  (รอดเพราะ token ผูกแค่ calorie-data) */
function ghRepoProblem(repo) {
  const name = String(repo || '').split('/').pop().toLowerCase();
  if (name === 'calorie-pwa') return 'ช่อง repo ใส่ calorie-pwa (repo โค้ด เป็น public) — ต้องเป็น Ball2B-cpu/calorie-data';
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(repo || ''))) return 'ชื่อ repo ต้องเป็นรูป owner/name เช่น Ball2B-cpu/calorie-data';
  return '';
}

async function runAiJob(job) {
  const date = job.date;
  const day = await db.getDay(date);
  if (!day) throw new NetError('ไม่พบวันที่ ' + date);
  const foods = await loadFoodsCatalog();
  const meals = (day.meals || []).filter((m) => (
    m && !m.deleted && (
      (Array.isArray(m.raw) && m.raw.length) ||
      (Array.isArray(m.photos) && m.photos.length)
    )
  ));
  // 13 ก.ย.: เดิมคิดใหม่ทุกมื้อทุกครั้ง และมื้อแรกที่ล้ม (กลางวัน "ไม่ได้กิน") ทำให้มื้อหลังจากนั้นไม่ถูกคิดเลย
  // ใหม่: ข้ามมื้อที่มีเลขแล้วและข้อความ/รูปไม่เปลี่ยน · มื้อไหนล้มไปต่อมื้อถัดไป แล้วค่อยรายงานรวม
  const errors = [];
  for (const meal of meals) {
    const sig = mealSig(meal);
    // final ที่มี sig ไม่ตรง = บอลแก้มื้อหลัง Claude ยืนยัน -> คิดใหม่ (เดิมข้ามเสมอ กดส่งแล้วเงียบ 13 ก.ย.)
    if (meal.final && Number.isFinite(Number(meal.final.kcal)) && (!meal.final.sig || meal.final.sig === sig)) continue;
    if (meal.est && meal.est.sig === sig) continue;
    try {
      if (isNotEaten(meal)) {
        await writeEstimate(date, meal.id, { items: [], kcal: 0, p: 0, confidence: 1, warnings: [], unclear: [] }, 'rule:not-eaten', sig);
        continue;
      }
      const blobs = [];
      for (const pid of meal.photos || []) {
        if (!pid) continue;
        const ph = await db.getPhoto(pid);
        if (ph && ph.blob) blobs.push(ph.blob);
      }
      await estimateMeal({ date, mealId: meal.id, raw: meal.raw || [], photoBlobs: blobs, foods, sig });
    } catch (e) {
      if (e && (e.stopRound || e.stopKind || e.code === 'auth')) throw e;
      errors.push(`${meal.key || meal.id}: ${errText(e)}`);
    }
  }
  if (errors.length) throw new NetError(errors.join(' | '));
}

function mealSig(meal) {
  return JSON.stringify([meal.raw || [], meal.photos || []]);
}

function isNotEaten(meal) {
  if (Array.isArray(meal.photos) && meal.photos.length) return false;
  const s = (meal.raw || []).join(' ').trim();
  return /^(ไม่ได้กิน|ไม่กิน|งด|ข้าม|-|—)$/.test(s);
}

/** ทำคิวให้หมด (เรียกจาก app.js: start/online/visible/timer หรือปุ่มซิงก์) */
export async function flush(why) {
  if (flushing) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setStatus('queued', 'ออฟไลน์');
    return;
  }
  flushing = true;
  const skipKind = new Set();
  let lastState = 'sending';
  let lastDetail = why ? String(why) : '';
  try {
    setStatus('sending', lastDetail);
    const jobs = await db.listOutbox();
    for (const job of jobs) {
      if (!job || job.id == null) continue;
      const kind = job.kind;
      const group = kind === 'ai' ? 'ai' : (kind === 'gh-photo' || kind === 'gh-day' ? 'gh' : kind);
      if (skipKind.has(kind) || skipKind.has(group)) continue;

      if (kind === 'ai' && !orKey()) {
        skipKind.add('ai');
        lastState = 'queued';
        lastDetail = 'ยังไม่ได้ตั้งค่า';
        setStatus(lastState, lastDetail);
        continue;
      }
      if ((kind === 'gh-photo' || kind === 'gh-day') && ghReady() && ghRepoProblem(ghRepo())) {
        skipKind.add('gh');
        lastState = 'error';
        lastDetail = ghRepoProblem(ghRepo());
        setStatus(lastState, lastDetail);
        continue;
      }
      if ((kind === 'gh-photo' || kind === 'gh-day') && !ghReady()) {
        skipKind.add('gh');
        lastState = 'queued';
        lastDetail = 'ยังไม่ได้ตั้งค่า';
        setStatus(lastState, lastDetail);
        continue;
      }

      try {
        if (kind === 'ai') await runAiJob(job);
        else if (kind === 'gh-photo') await pushPhoto(job.photoId);
        else if (kind === 'gh-day') await pushDay(job.date);
        else throw new NetError('ชนิดงานไม่รู้จัก: ' + kind);
        await db.completeJob(job.id);
        lastState = kind === 'ai' ? 'estimated' : 'sending';
        lastDetail = kind === 'ai' ? 'AI ประมาณแล้ว' : 'ซิงก์แล้ว';
        setStatus(lastState, lastDetail);
      } catch (e) {
        if (e && e.defer) {
          lastState = 'queued';
          lastDetail = errText(e);
          setStatus(lastState, lastDetail);
          continue;
        }
        try { await db.failJob(job.id, e); } catch (_) {}
        lastState = 'error';
        lastDetail = errText(e);
        setStatus(lastState, lastDetail);
        if (e && e.stopRound) break;
        if (e && e.stopKind) {
          skipKind.add(e.stopKind);
          if (e.stopKind === 'gh') {
            skipKind.add('gh-photo');
            skipKind.add('gh-day');
          }
          continue;
        }
      }
    }
    // ดึงเลขที่ Claude ยืนยัน (final/closed) กลับมาที่มือถือ — เดิมไม่มีใครเรียก pullDay เลย
    // เลขยืนยันจะไม่มาจนกว่าวันนั้นมีงาน gh-day ใหม่ (เจอ 13 ก.ย.)
    if (ghReady() && !ghRepoProblem(ghRepo()) && !skipKind.has('gh')) {
      try {
        if (await pullRecent(3)) refreshView();
      } catch (e) {
        if (e && e.code === 'auth') { lastState = 'error'; lastDetail = errText(e); }
      }
    }
    if (lastState === 'estimated') refreshView();
    const left = await db.listOutbox();
    if (left.length) {
      const detail = lastDetail === 'ยังไม่ได้ตั้งค่า' || lastState === 'error'
        ? lastDetail
        : ('ค้าง ' + left.length + ' งาน');
      setStatus('queued', detail);
    } else if (lastState === 'error') setStatus('error', lastDetail);
    else if (lastState === 'sending') setStatus('synced', 'คิวว่าง');
    else setStatus(lastState, lastDetail || 'คิวว่าง');
  } finally {
    flushing = false;
  }
}

/** ปุ่มทดสอบในหน้าตั้งค่า → {ok:boolean, msg:string} · ห้ามคืนค่า key กลับมาในข้อความ */
export async function testOpenRouter() {
  const key = orKey();
  if (!key) return { ok: false, msg: 'ยังไม่ได้ตั้งค่า' };
  const headers = {
    Authorization: 'Bearer ' + key,
    'HTTP-Referer': referer(),
    'X-Title': 'calorie-pwa',
  };
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', { headers, signal: timeoutSignal(15000) });
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      return { ok: false, msg: authError('or', res.status).message + ' · ลงท้าย ' + tail6(key) };
    }
    if (res.ok) {
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      const d = data && data.data ? data.data : data;
      const bits = ['คีย์ใช้ได้'];
      const remaining = d && (d.limit_remaining ?? d.limitRemaining);
      const limit = d && d.limit;
      const usage = d && d.usage;
      if (remaining != null) bits.push('เหลือ ' + remaining);
      else if (limit != null) bits.push('ลิมิต ' + limit);
      if (usage != null && remaining == null) bits.push('ใช้ไป ' + usage);
      bits.push('ลงท้าย ' + tail6(key));
      return { ok: true, msg: bits.join(' · ') };
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, msg: 'หมดเวลารอ OpenRouter' };
  }

  try {
    const res = await fetch(OR_URL, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: readModels()[0] || DEFAULT_MODELS[0],
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: timeoutSignal(15000),
    });
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      return { ok: false, msg: authError('or', res.status).message + ' · ลงท้าย ' + tail6(key) };
    }
    if (res.ok || res.status === 400) {
      return { ok: true, msg: 'คีย์ใช้ได้ · ลงท้าย ' + tail6(key) };
    }
    return { ok: false, msg: 'OpenRouter ตอบ ' + res.status + ' · ลงท้าย ' + tail6(key) };
  } catch (e) {
    return { ok: false, msg: (e && e.name === 'AbortError') ? 'หมดเวลารอ OpenRouter' : 'เชื่อม OpenRouter ไม่ได้' };
  }
}

export async function testGitHub() {
  const pat = ghPat();
  const repo = ghRepo();
  if (!pat || !repo) return { ok: false, msg: 'ยังไม่ได้ตั้งค่า' };
  if (ghRepoProblem(repo)) return { ok: false, msg: ghRepoProblem(repo) };
  try {
    const res = await fetch(`${GH_API}/repos/${repo}`, {
      headers: ghHeaders(pat),
      signal: timeoutSignal(15000),
    });
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      return { ok: false, msg: authError('gh', res.status).message + ' · ลงท้าย ' + tail6(pat) };
    }
    if (res.status !== 200) {
      return { ok: false, msg: 'GitHub ตอบ ' + res.status + ' · ลงท้าย ' + tail6(pat) };
    }
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    const name = (data && (data.full_name || data.name)) || repo;
    const priv = data && data.private === true ? 'private' : 'public';
    if (priv !== 'private') {
      return { ok: false, msg: 'repo ' + name + ' เป็น public — ห้ามเก็บข้อมูลสุขภาพ ใช้ repo private (calorie-data)' };
    }
    return { ok: true, msg: 'เข้าถึงได้ · ' + name + ' · ' + priv + ' · ลงท้าย ' + tail6(pat) };
  } catch (e) {
    return { ok: false, msg: (e && e.name === 'AbortError') ? 'หมดเวลารอ GitHub' : 'เชื่อม GitHub ไม่ได้' };
  }
}
