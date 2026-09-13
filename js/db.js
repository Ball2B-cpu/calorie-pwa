/* db.js — IndexedDB + mergeDay + คิวส่ง   (ก้อนงาน: db)
   อ่าน SCHEMA.md ก่อนแตะไฟล์นี้ — ตาราง ownership ในนั้นคือกฎของ mergeDay()
   ห้ามใช้ไลบรารีภายนอก · ห้ามเก็บ key/token ใน IndexedDB (key อยู่ใน localStorage เท่านั้น)

   ส่วนที่ทำเสร็จแล้ว (เป็นส่วนของสัญญา ห้ามเปลี่ยนชื่อ store/index): open(), tx(), req()
   ส่วนที่เหลือเป็นงานก้อน db — ฟังก์ชันที่ยังไม่ทำจะ throw ข้อความ 'ยังไม่ทำ' */
export const SCHEMA = 2;
export const DB_NAME = 'caldb';
export const DB_VERSION = 1;

let _db = null;

/** หุ้ม IDBRequest ให้เป็น promise */
export function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** เปิด transaction: tx(['days'],'readwrite') → {t, days}
 *  ⚠️ ห้าม await อะไรที่ไม่ใช่ request ของ tx นี้ระหว่างที่ tx ยังเปิด (IDB จะปิด tx ทิ้ง) */
export function tx(names, mode = 'readonly') {
  const t = _db.transaction(names, mode);
  const out = { t, done: new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }) };
  for (const n of names) out[n] = t.objectStore(n);
  return out;
}

/** เปิดฐานข้อมูล + สร้าง store ตาม SCHEMA.md (ครั้งแรกเท่านั้น) */
export async function open() {
  if (_db) return _db;
  const r = indexedDB.open(DB_NAME, DB_VERSION);
  r.onupgradeneeded = (e) => {
    const d = r.result;
    // ห้ามลบ store เก่าในอนาคต — ขึ้นเวอร์ชันแล้วย้ายข้อมูลเท่านั้น
    if (!d.objectStoreNames.contains('days')) {
      const s = d.createObjectStore('days', { keyPath: 'date' });
      s.createIndex('state', 'state');
      s.createIndex('rev', 'rev');
    }
    if (!d.objectStoreNames.contains('photos')) {
      const s = d.createObjectStore('photos', { keyPath: 'id' });
      s.createIndex('date', 'date');
      s.createIndex('uploaded', 'uploaded');
    }
    if (!d.objectStoreNames.contains('outbox')) {
      const s = d.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
      s.createIndex('kind', 'kind');
      s.createIndex('date', 'date');
    }
    if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
    void e;
  };
  _db = await req(r);
  _db.onversionchange = () => { _db.close(); _db = null; };
  return _db;
}

export function isOpen() { return !!_db; }

/* ---------- helpers (pure) ---------- */

const WRITERS = new Set(['app', 'ai', 'claude']);
const JOB_KINDS = new Set(['ai', 'gh-photo', 'gh-day']);
const PHOTO_MAX_BYTES = 250 * 1024;
const PHOTO_MAX_SIDE = 1024;
const HISTORY_KEEP = 50;
const ERR_MAX = 240;

function nowISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const ah = Math.floor(Math.abs(off) / 60);
  const am = Math.abs(off) % 60;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(ah)}:${pad(am)}`;
}

function clone(v) {
  if (v === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(v);
  return v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v));
}

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(typeof Blob !== 'undefined' && v instanceof Blob);
}

function equal(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !equal(a[k], b[k])) return false;
  }
  return true;
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

/** แปลง path จริง (meals[m_x].raw) เป็นรูปแบบในตาราง ownership */
function canonPath(path) {
  return String(path)
    .replace(/meals\[[^\]]+\]/g, 'meals[]')
    .replace(/items\[\d+\]/g, 'items[]');
}

/** ใครเป็นเจ้าของ path นี้ — ตามตารางใน SCHEMA.md */
function canWrite(as, path) {
  const p = canonPath(path);
  if (p === 'rev' || p === 'updatedAt' || p === 'updatedBy' || p === 'history' || p === 'state' || p === 'conflicts'
    || p.startsWith('history.') || p.startsWith('conflicts.')) return true;
  if (p === 'body' || p.startsWith('body.')
    || p === 'note' || p === 'savedAt' || p === 'submitted' || p === 'submittedAt'
    || /^meals\[\]\.(raw|time|photos|key|outside|deleted)$/.test(p)
    || /^meals\[\]\.(raw|time|photos|key|outside|deleted)\./.test(p)) return as === 'app';
  if (p === 'ai' || p.startsWith('ai.')
    || p === 'totals.est' || p.startsWith('totals.est.')
    || p === 'meals[].est' || p.startsWith('meals[].est.')
    || p === 'meals[].items[].est' || p.startsWith('meals[].items[].est.')
    || p === 'meals[].items[].name' || p.startsWith('meals[].items[].name.')) {
    return as === 'ai' || as === 'claude';
  }
  if (p === 'garmin' || p.startsWith('garmin.')
    || p === 'review' || p.startsWith('review.')
    || p === 'closed'
    || p === 'totals.final' || p.startsWith('totals.final.')
    || p === 'meals[].final' || p.startsWith('meals[].final.')
    || p === 'meals[].comment' || p.startsWith('meals[].comment.')
    || p === 'meals[].items[].final' || p.startsWith('meals[].items[].final.')) {
    return as === 'claude';
  }
  return false;
}

function pathTouches(field, path) {
  return field === path || path.startsWith(field + '.') || field.startsWith(path + '.');
}

function lastEdit(doc, path) {
  const h = doc && Array.isArray(doc.history) ? doc.history : [];
  for (let i = h.length - 1; i >= 0; i--) {
    const fields = h[i] && h[i].fields;
    if (Array.isArray(fields) && fields.some((f) => pathTouches(f, path))) return h[i];
  }
  return null;
}

function sameEntry(a, b) {
  return !!a && !!b && a.rev === b.rev && a.at === b.at && a.by === b.by;
}

function historyHas(doc, entry) {
  if (!entry) return false;
  const h = doc && Array.isArray(doc.history) ? doc.history : [];
  return h.some((e) => sameEntry(e, entry));
}

/**
 * เลือกค่าของ path ที่ `as` เป็นเจ้าของ
 * - ค่าต่างกันแต่ history ยังไม่แยกสาย → ถือว่าเป็นการเขียนรอบนี้ เอา local
 * - history สองฝั่งแยกสายของ path เดียวกัน → เข้า conflicts แล้วคง remote
 */
function resolveOwned(rv, lv, path, acc) {
  if (lv === undefined) return clone(rv);
  if (equal(rv, lv)) return rv === undefined ? clone(lv) : clone(rv);
  if (rv === undefined) {
    acc.changed.push(path);
    return clone(lv);
  }
  const rH = lastEdit(acc.remote, path);
  const lH = lastEdit(acc.local, path);
  if (!rH || !lH || sameEntry(rH, lH)) {
    acc.changed.push(path);
    return clone(lv);
  }
  const localAhead = historyHas(acc.local, rH) && !historyHas(acc.remote, lH);
  if (localAhead) {
    acc.changed.push(path);
    return clone(lv);
  }
  const remoteAhead = historyHas(acc.remote, lH) && !historyHas(acc.local, rH);
  if (remoteAhead) return clone(rv);
  acc.conflicts.push({ path, mine: clone(lv), theirs: clone(rv), at: acc.now });
  return clone(rv);
}

function pickScalar(r, l, key, as, acc) {
  const rv = r ? r[key] : undefined;
  if (!canWrite(as, key)) return clone(rv);
  if (!l || !Object.prototype.hasOwnProperty.call(l, key)) return clone(rv);
  return resolveOwned(rv, l[key], key, acc);
}

/** รวมออบเจ็กต์แบบรู้โครงสร้าง — คีย์ที่ local ไม่ส่งมา คงของ remote ไว้ (กันข้อมูลเช้าหายตอนกรอกเย็น) */
function mergeOwnedMap(rv, lv, path, as, acc, owned) {
  if (!owned) return clone(rv ?? null);
  if (lv === undefined) return clone(rv ?? null);
  if (lv === null) return resolveOwned(rv, lv, path, acc);
  if (!isPlain(lv)) return resolveOwned(rv, lv, path, acc);
  const base = isPlain(rv) ? clone(rv) : {};
  for (const k of Object.keys(lv)) {
    const p = `${path}.${k}`;
    const rSub = isPlain(rv) ? rv[k] : undefined;
    if (isPlain(lv[k]) && (isPlain(rSub) || rSub === undefined)) {
      const nested = mergeOwnedMap(rSub, lv[k], p, as, acc, true);
      if (nested !== undefined) base[k] = nested;
    } else {
      base[k] = resolveOwned(rSub, lv[k], p, acc);
    }
  }
  return base;
}

function mergeTotals(rv, lv, as, acc) {
  const r = isPlain(rv) ? rv : {};
  const l = isPlain(lv) ? lv : {};
  const out = clone(r);
  if (canWrite(as, 'totals.est') && Object.prototype.hasOwnProperty.call(l, 'est')) {
    out.est = mergeOwnedMap(r.est, l.est, 'totals.est', as, acc, true);
  }
  if (canWrite(as, 'totals.final') && Object.prototype.hasOwnProperty.call(l, 'final')) {
    out.final = mergeOwnedMap(r.final, l.final, 'totals.final', as, acc, true);
  }
  return out;
}

function mergeItems(rItems, lItems, as, mealPrefix, acc) {
  const R = Array.isArray(rItems) ? rItems : [];
  const L = Array.isArray(lItems) ? lItems : [];
  const canItem = as === 'ai' || as === 'claude';
  const len = canItem ? Math.max(R.length, L.length) : R.length;
  const out = [];
  for (let i = 0; i < len; i++) {
    const ri = R[i];
    const li = L[i];
    const ip = `${mealPrefix}.items[${i}]`;
    if (ri && li === undefined) { out.push(clone(ri)); continue; }
    if (!ri && li) {
      if (!canItem) continue;
      const item = {};
      if (Object.prototype.hasOwnProperty.call(li, 'name')) item.name = clone(li.name);
      if (Object.prototype.hasOwnProperty.call(li, 'est')) item.est = clone(li.est);
      if (as === 'claude' && Object.prototype.hasOwnProperty.call(li, 'final')) item.final = clone(li.final);
      out.push(item);
      acc.changed.push(ip);
      continue;
    }
    const item = ri ? clone(ri) : {};
    if (canItem && li) {
      if (Object.prototype.hasOwnProperty.call(li, 'name')) item.name = resolveOwned(ri && ri.name, li.name, `${ip}.name`, acc);
      if (Object.prototype.hasOwnProperty.call(li, 'est')) item.est = mergeOwnedMap(ri && ri.est, li.est, `${ip}.est`, as, acc, true);
    }
    if (as === 'claude' && li && Object.prototype.hasOwnProperty.call(li, 'final')) {
      item.final = mergeOwnedMap(ri && ri.final, li.final, `${ip}.final`, as, acc, true);
    }
    out.push(item);
  }
  return out;
}

const APP_MEAL_FIELDS = ['raw', 'time', 'photos', 'key', 'outside', 'deleted'];

function mergeOneMeal(rm, lm, as, acc) {
  const id = rm.id;
  const prefix = `meals[${id}]`;
  const out = clone(rm);
  if (as === 'app') {
    for (const f of APP_MEAL_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(lm, f)) continue;
      out[f] = resolveOwned(rm[f], lm[f], `${prefix}.${f}`, acc);
    }
  }
  if ((as === 'ai' || as === 'claude') && Object.prototype.hasOwnProperty.call(lm, 'est')) {
    out.est = mergeOwnedMap(rm.est, lm.est, `${prefix}.est`, as, acc, true);
  }
  if (as === 'claude') {
    if (Object.prototype.hasOwnProperty.call(lm, 'final')) {
      out.final = mergeOwnedMap(rm.final, lm.final, `${prefix}.final`, as, acc, true);
    }
    if (Object.prototype.hasOwnProperty.call(lm, 'comment')) {
      out.comment = resolveOwned(rm.comment, lm.comment, `${prefix}.comment`, acc);
    }
  }
  out.items = mergeItems(rm.items, lm.items, as, prefix, acc);
  return out;
}

function mergeMeals(rMeals, lMeals, as, acc) {
  const remoteMeals = Array.isArray(rMeals) ? rMeals : [];
  const localMeals = Array.isArray(lMeals) ? lMeals : [];
  const localById = new Map();
  for (const m of localMeals) {
    if (m && m.id != null && !localById.has(m.id)) localById.set(m.id, m);
  }
  const seen = new Set();
  const out = [];
  for (const rm of remoteMeals) {
    if (!rm || rm.id == null) { out.push(clone(rm)); continue; }
    seen.add(rm.id);
    const lm = localById.get(rm.id);
    out.push(lm ? mergeOneMeal(rm, lm, as, acc) : clone(rm));
  }
  if (as === 'app') {
    for (const lm of localMeals) {
      if (!lm || lm.id == null || seen.has(lm.id)) continue;
      out.push(clone(lm));
      acc.changed.push(`meals[${lm.id}]`);
      seen.add(lm.id);
    }
  }
  return out;
}

function mergeHistoryLists(rH, lH) {
  const r = Array.isArray(rH) ? rH : [];
  const l = Array.isArray(lH) ? lH : [];
  const keyOf = (e) => `${e && e.rev}|${e && e.by}|${e && e.at}|${((e && e.fields) || []).join(',')}`;
  const out = r.map(clone);
  const seen = new Set(out.map(keyOf));
  for (const e of l) {
    const k = keyOf(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(clone(e));
  }
  out.sort((a, b) => (a.rev - b.rev) || String(a.at || '').localeCompare(String(b.at || '')));
  return out;
}

function dedupeConflicts(list) {
  const out = [];
  const seen = new Set();
  for (const c of list) {
    if (!c || !c.path) continue;
    const k = `${c.path}|${JSON.stringify(c.mine)}|${JSON.stringify(c.theirs)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(clone(c));
  }
  return out;
}

function emptyDoc(local) {
  return {
    schema: SCHEMA,
    date: (local && local.date) || '',
    rev: 0,
    updatedAt: null,
    updatedBy: null,
    state: 'draft',
    body: {},
    garmin: null,
    meals: [],
    note: '',
    ai: null,
    review: null,
    totals: {},
    closed: false,
    savedAt: null,
    submitted: false,
    submittedAt: null,
    conflicts: [],
    history: [],
  };
}

function errText(err) {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: type || 'image/jpeg' });
}

/* ---------- ต่อจากนี้เป็นงานก้อน db ---------- */

/** @param {string} date 'YYYY-MM-DD' @returns {Promise<object|null>} */
export async function getDay(date) {
  await open();
  const { days } = tx(['days']);
  const doc = await req(days.get(date));
  return doc ?? null;
}

/** @param {object} doc เอกสารวันตาม SCHEMA.md — เขียนทับทั้งเอกสาร (ผู้เรียก merge มาก่อนแล้ว) */
export async function putDay(doc) {
  if (!doc || !doc.date) throw new Error('putDay: เอกสารไม่มีวันที่');
  await open();
  const { days, done } = tx(['days'], 'readwrite');
  const toSave = clone(doc);
  toSave.updatedAt = nowISO();
  await req(days.put(toSave));
  await done;
  return toSave;
}

/** @param {string} month 'YYYY-MM' @returns {Promise<object[]>} เรียงตามวันที่ */
export async function listDays(month) {
  await open();
  const { days } = tx(['days']);
  const range = IDBKeyRange.bound(`${month}-`, `${month}-\uffff`);
  const list = await req(days.getAll(range));
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return list;
}

/** รวมเอกสารสองฝั่งตามตาราง ownership ใน SCHEMA.md
 *  @param {object|null} remote ใช้เป็นฐาน
 *  @param {object} local ของที่จะเขียนเข้าไป
 *  @param {'app'|'ai'|'claude'} as ผู้เขียน — เขียนทับได้เฉพาะ path ที่ตัวเองเป็นเจ้าของ
 *  @returns {object} เอกสารใหม่ (rev = max+1 · updatedBy = as · ต่อ history · เก็บ conflicts ถ้าชนกัน)
 *  meals จับคู่ด้วย id เท่านั้น (ห้ามใช้ตำแหน่งใน array ห้ามใช้ key) · มื้อที่มีแค่ฝั่ง remote ห้ามหาย */
export function mergeDay(remote, local, as) {
  if (!WRITERS.has(as)) throw new Error(`mergeDay: ผู้เขียนไม่รู้จัก '${as}'`);
  if (!local || typeof local !== 'object') throw new Error('mergeDay: local ต้องเป็นเอกสาร');
  const now = nowISO();
  const r = remote && typeof remote === 'object' ? remote : emptyDoc(local);
  const acc = { remote: r, local, now, changed: [], conflicts: [] };

  const out = {
    schema: r.schema ?? local.schema ?? SCHEMA,
    date: r.date || local.date,
    rev: Math.max(r.rev ?? 0, local.rev ?? 0) + 1,
    updatedAt: now,
    updatedBy: as,
    state: pickScalar(r, local, 'state', as, acc),
    body: mergeOwnedMap(r.body, local.body, 'body', as, acc, as === 'app'),
    garmin: mergeOwnedMap(r.garmin, local.garmin, 'garmin', as, acc, as === 'claude'),
    meals: mergeMeals(r.meals, local.meals, as, acc),
    note: pickScalar(r, local, 'note', as, acc),
    ai: mergeOwnedMap(r.ai, local.ai, 'ai', as, acc, as === 'ai' || as === 'claude'),
    review: mergeOwnedMap(r.review, local.review, 'review', as, acc, as === 'claude'),
    totals: mergeTotals(r.totals, local.totals, as, acc),
    closed: pickScalar(r, local, 'closed', as, acc),
    savedAt: pickScalar(r, local, 'savedAt', as, acc),
    submitted: pickScalar(r, local, 'submitted', as, acc),
    submittedAt: pickScalar(r, local, 'submittedAt', as, acc),
    conflicts: [],
    history: [],
  };

  out.conflicts = dedupeConflicts([...(r.conflicts || []), ...(local.conflicts || []), ...acc.conflicts]);
  const hist = mergeHistoryLists(r.history, local.history);
  hist.push({ at: now, by: as, fields: unique(acc.changed), rev: out.rev });
  out.history = hist.length > HISTORY_KEEP ? hist.slice(-HISTORY_KEEP) : hist;
  return out;
}

function assertPhotoOk(photo) {
  if (!photo || typeof photo !== 'object') throw new Error('รูปไม่ถูกต้อง: ไม่มีข้อมูลรูป');
  if (typeof Blob === 'undefined' || !(photo.blob instanceof Blob)) {
    throw new Error('รูปไม่ถูกต้อง: ต้องเป็นไฟล์รูป (Blob) ไม่ใช่ชนิดอื่น — ถ่ายใหม่หรือเลือกไฟล์รูป');
  }
  const bytes = photo.bytes != null ? photo.bytes : photo.blob.size;
  if (bytes > PHOTO_MAX_BYTES) {
    throw new Error(`รูปใหญ่เกินกำหนด (${Math.ceil(bytes / 1024)} KB > 250 KB) กรุณาย่อหรือถ่ายใหม่`);
  }
  if (photo.blob.size > PHOTO_MAX_BYTES) {
    throw new Error(`รูปใหญ่เกินกำหนด (${Math.ceil(photo.blob.size / 1024)} KB > 250 KB) กรุณาย่อหรือถ่ายใหม่`);
  }
  const side = Math.max(Number(photo.w) || 0, Number(photo.h) || 0);
  if (side > PHOTO_MAX_SIDE) {
    throw new Error(`รูปมีด้านยาวเกิน 1024 พิกเซล (${side} px) กรุณาย่อหรือถ่ายใหม่`);
  }
}

/** รูป: เก็บ Blob ที่ย่อแล้ว (≤1024px · ≤250KB) — ย่อไม่สำเร็จห้ามเก็บ ให้แจ้งผู้ใช้ถ่ายใหม่ */
export async function putPhoto(photo) {
  assertPhotoOk(photo);
  if (!photo.id) throw new Error('รูปไม่ถูกต้อง: ไม่มีรหัสรูป');
  await open();
  const { photos, done } = tx(['photos'], 'readwrite');
  const rec = {
    id: photo.id,
    date: photo.date,
    mealId: photo.mealId ?? null,
    blob: photo.blob,
    w: photo.w,
    h: photo.h,
    bytes: photo.bytes != null ? photo.bytes : photo.blob.size,
    uploaded: photo.uploaded ?? false,
    remotePath: photo.remotePath ?? null,
    createdAt: photo.createdAt ?? nowISO(),
  };
  await req(photos.put(rec));
  await done;
  return rec;
}

export async function getPhoto(id) {
  await open();
  const { photos } = tx(['photos']);
  const p = await req(photos.get(id));
  return p ?? null;
}

export async function listPhotos(date) {
  await open();
  const { photos } = tx(['photos']);
  const list = await req(photos.index('date').getAll(date));
  return list;
}

export async function markPhotoUploaded(id, remotePath) {
  await open();
  const { photos, done } = tx(['photos'], 'readwrite');
  const p = await req(photos.get(id));
  if (!p) throw new Error('ไม่พบรูป id=' + id);
  p.uploaded = true;
  p.remotePath = remotePath;
  await req(photos.put(p));
  await done;
  return p;
}

/** คิวส่ง: kind = 'ai' | 'gh-photo' | 'gh-day' — ทำทีละงาน ห้ามทิ้งงานเงียบ ๆ */
export async function enqueue(job) {
  if (!job || !JOB_KINDS.has(job.kind)) {
    throw new Error(`ชนิดงานไม่รู้จัก: ${job && job.kind != null ? job.kind : '(ไม่มี)'} (ต้องเป็น ai, gh-photo หรือ gh-day)`);
  }
  await open();
  const { outbox, done } = tx(['outbox'], 'readwrite');
  const rec = {
    kind: job.kind,
    date: job.date ?? null,
    photoId: job.photoId ?? null,
    tries: job.tries ?? 0,
    lastError: job.lastError ?? null,
    createdAt: job.createdAt ?? nowISO(),
  };
  const id = await req(outbox.add(rec));
  await done;
  return id;
}

export async function listOutbox() {
  await open();
  const { outbox } = tx(['outbox']);
  const list = await req(outbox.getAll());
  list.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return list;
}

export async function completeJob(id) {
  await open();
  const { outbox, done } = tx(['outbox'], 'readwrite');
  await req(outbox.delete(id));
  await done;
}

export async function failJob(id, err) {
  await open();
  const { outbox, done } = tx(['outbox'], 'readwrite');
  const job = await req(outbox.get(id));
  if (!job) throw new Error('ไม่พบงานในคิว id=' + id);
  job.tries = (job.tries || 0) + 1;
  job.lastError = errText(err).slice(0, ERR_MAX);
  await req(outbox.put(job));
  await done;
  return job;
}

/** ส่งออก/นำเข้าทั้งก้อน (ตัวกันข้อมูลหายตัวจริง) — ไฟล์ที่ส่งออกต้องไม่มี key/token */
export async function exportAll() {
  await open();
  const { days, photos } = tx(['days', 'photos']);
  const allDays = await req(days.getAll());
  const allPhotos = await req(photos.getAll());
  allDays.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const photosOut = [];
  for (const p of allPhotos) {
    const blob = p.blob;
    const rest = {
      id: p.id,
      date: p.date,
      mealId: p.mealId ?? null,
      w: p.w,
      h: p.h,
      bytes: p.bytes,
      uploaded: p.uploaded,
      remotePath: p.remotePath ?? null,
      createdAt: p.createdAt,
    };
    rest.blobBase64 = blob instanceof Blob ? await blobToBase64(blob) : '';
    photosOut.push(rest);
  }
  return {
    app: 'calorie-pwa',
    schema: SCHEMA,
    exportedAt: nowISO(),
    days: allDays,
    photos: photosOut,
  };
}

export async function importAll(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || typeof data !== 'object') throw new Error('ไฟล์นำเข้าไม่ถูกต้อง');
  await open();

  const incomingDays = Array.isArray(data.days) ? data.days : [];
  const incomingPhotos = Array.isArray(data.photos) ? data.photos : [];
  let skipped = 0;

  const { days } = tx(['days']);
  const existingList = await req(days.getAll());
  const existingMap = Object.create(null);
  for (const d of existingList) existingMap[d.date] = d;

  const mergedDays = [];
  for (const incoming of incomingDays) {
    if (!incoming || !incoming.date) { skipped++; continue; }
    const existing = existingMap[incoming.date] || null;
    // วันใหม่ในเครื่อง: ใช้ incoming เป็นฐาน — ถ้าใช้เอกสารเปล่า as=claude มื้อ/body ของแอพจะถูกทิ้ง
    const base = existing || incoming;
    mergedDays.push(mergeDay(base, incoming, 'claude'));
  }

  if (mergedDays.length) {
    const w = tx(['days'], 'readwrite');
    for (const d of mergedDays) w.days.put(d);
    await w.done;
  }

  let nPhotos = 0;
  for (const p of incomingPhotos) {
    if (!p || !p.id) { skipped++; continue; }
    try {
      let blob = p.blob;
      if (!(typeof Blob !== 'undefined' && blob instanceof Blob)) {
        if (!p.blobBase64) { skipped++; continue; }
        blob = base64ToBlob(p.blobBase64);
      }
      await putPhoto({
        id: p.id,
        date: p.date,
        mealId: p.mealId ?? null,
        blob,
        w: p.w,
        h: p.h,
        bytes: p.bytes != null ? p.bytes : blob.size,
        uploaded: p.uploaded ?? false,
        remotePath: p.remotePath ?? null,
        createdAt: p.createdAt,
      });
      nPhotos++;
    } catch {
      skipped++;
    }
  }

  return { days: mergedDays.length, photos: nPhotos, skipped };
}
