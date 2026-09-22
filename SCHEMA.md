# SCHEMA — สัญญาโครงสร้างข้อมูล (v2)

ไฟล์นี้คือ **สัญญา** ที่ทั้งแอพ (JS) และสคริปต์ฝั่งคอม (Python) ต้องยึดตรงกัน
แก้ไฟล์นี้ = แก้สัญญา ต้องแก้ทั้งสองฝั่งพร้อมกัน และเพิ่มเลข `schema`

## หลักการเดียวที่ต้องจำ: เลขมี 3 ชั้น อยู่คนละ key ทับกันไม่ได้

| ชั้น | ใครเขียน | ความหมาย |
|---|---|---|
| `raw` | แอพ (คนพิมพ์เอง) | ข้อความที่ผู้ใช้พิมพ์ — **ความจริงตั้งต้น ไม่มีใครมีสิทธิ์ลบหรือแก้** |
| `est` | AI (ผ่านแอพ) | เลขประมาณ ได้ทันทีตอนกดส่ง — แสดงพร้อมเครื่องหมาย `~` เสมอ |
| `final` | Claude (ฝั่งคอม) | เลขที่ตรวจกับตารางฉลากจริงแล้ว — เลขที่เอาไปคิดสถิติได้ |

กฎอ่านค่า: `kcalOf(d) = d.totals.final?.kcal ?? d.totals.est?.kcal ?? null`
**สถิติเดือน / ขาดดุลสะสม / เฉลี่ย ใช้ `final` เท่านั้น** — วันที่ยังเป็น `est` นับแยกว่า "ยังไม่ยืนยัน n วัน"

---

## เอกสารหนึ่งวัน — `days/YYYY-MM-DD.json`

เก็บใน IndexedDB store `days` ด้วยรูปเดียวกันเป๊ะ (ไม่มีการแปลงร่างระหว่างมือถือกับคอม)

```jsonc
{
  "schema": 2,
  "date": "2026-09-12",            // = doc key
  "rev": 7,                        // ทุกครั้งที่เขียน: rev = max(local, remote) + 1
  "updatedAt": "2026-09-12T21:40:11+09:00",
  "updatedBy": "phone",            // phone | ai | claude
  "state": "estimated",            // draft | queued | estimated | confirmed

  "body": {                        // 👤 แอพเท่านั้น (ฟอร์มเช้า — ใส่เฉพาะช่องที่กรอก)
    "weighedAt": "07:05",
    "weight": 92.7, "bmi": 30.6, "fat": 26.2, "muscle": 42.6,
    "visceral": 13, "water": 54.2, "bone": 3.1, "bmr": 1890, "mage": 52,
    "waist": 104.5                 // รอบเอว ซม. — วัดสัปดาห์ละครั้ง ไม่ต้องกรอกทุกวัน
  },

  "garmin": {                      // 🤖 Claude เท่านั้น (ดึงจาก Garmin ผ่าน Chrome — แอพทำแทนไม่ได้)
    "burn": 2520, "rest": 2276, "active": 244, "steps": 8123,
    "sleepScore": 78, "sleepHours": 6.5, "at": "2026-09-12T07:30:00+09:00"
  },

  "meals": [{
    "id": "m_k7x2q",               // 🔒 กุญแจของการ merge — สร้างครั้งเดียว ห้ามเปลี่ยน ห้ามใช้ซ้ำ
    "key": "เช้า",                 // เช้า | กลางวัน | ของว่าง | เย็น  (ค่าอื่นห้าม)
    "time": "07:20",
    "raw": ["ข้าวต้มโอ๊ต (โอ๊ต 3 ชต.)", "ไข่ไก่ 2 ฟอง"],   // 👤 แอพ
    "photos": ["p_a91f3"],         // 👤 แอพ — id ใน store photos
    "outside": false,              // 👤 แอพ — true = มื้อที่ไม่ได้ทำเอง (เลขจะแม่นน้อยกว่า)
    "items": [{
      "name": "ข้าวโอ๊ต Quaker 24 g",                                  // 🤖 AI เสนอ · Claude แก้ได้
      "est":  { "kcal": 97, "p": 3.0, "conf": 0.6, "basis": "std", "needLabel": false },
      "final":{ "kcal": 97, "p": 3.0, "src": "label", "foodId": "quaker_oat" }
    }],
    "est":   { "kcal": 462, "p": 39 },      // 🤖 AI — ผลรวมมื้อ
    "final": { "kcal": 470, "p": 40 },      // 🤖 Claude
    "comment": "ไม่ใส่น้ำมัน"               // 🤖 Claude — คอมเมนต์ต่อมื้อที่เคยพิมพ์มือในไดอารี
  }],

  "note": "",                      // 👤 แอพ — โน้ตท้ายวันของผู้ใช้
  "ai": {                          // 🤖 AI
    "model": "…", "at": "…", "warnings": [], "unclear": []
  },
  "review": {                      // 🤖 Claude — สิ่งที่เคยพิมพ์เป็นบรรทัด "คอมเมนต์" ท้ายวันในไดอารี
    "comment": "", "advice": "", "checkedAt": "", "by": "claude-opus-5"
  },

  "totals": { "est": { "kcal": 1712, "p": 132 }, "final": { "kcal": 1748, "p": 141 } },
  "closed": false,                 // 🤖 Claude เท่านั้น — true = ปิดยอดวันแล้ว (ตรวจครบ)

  "savedAt": "…",                  // 👤 แอพ — ทุกครั้งที่กด "บันทึกไว้ก่อน"
  "submitted": true,               // 👤 แอพ
  "submittedAt": "…",              // 👤 แอพ — ถ้า savedAt > submittedAt = แก้หลังส่ง (ขึ้นเตือนเหลือง)
  "conflicts": [],                 // [{path, mine, theirs, at}] — ไม่เลือกให้เอง ให้ผู้ใช้กดเลือก
  "history": []                    // [{at, by, fields:[], rev}] เก็บท้ายสุด 50 รายการ
}
```

### ตาราง ownership = กฎของ `mergeDay()`

| path | แอพ | AI | Claude |
|---|---|---|---|
| `body.*` · `note` · `savedAt` · `submitted` · `submittedAt` · `meals[].raw/time/photos/key/outside` | ✍️ | — | — |
| `meals[].items[].est` · `meals[].est` · `totals.est` · `ai.*` · `meals[].items[].name` | — | ✍️ | ✍️ |
| `meals[].items[].final` · `meals[].final` · `totals.final` · `meals[].comment` · `garmin` · `review` · `closed` | — | — | ✍️ |
| `rev` · `updatedAt` · `updatedBy` · `history` · `state` · `conflicts` | ✍️ | ✍️ | ✍️ |

`mergeDay(remote, local, as)` โดย `as ∈ {app, ai, claude}`:
1. เริ่มจาก **remote เป็นฐาน**
2. เขียนทับได้เฉพาะ path ที่ `as` เป็นเจ้าของ (ตามตาราง)
3. `meals` จับคู่ด้วย **`id`** เท่านั้น (ห้ามใช้ตำแหน่งใน array ห้ามใช้ `key` — มื้อเดียวกันมีได้หลายรอบ)
   - มื้อที่มีแค่ฝั่ง local และ `as==='app'` → เพิ่มเข้าไป
   - มื้อที่มีแค่ฝั่ง remote → **เก็บไว้ ห้ามลบ** (การลบมื้อทำได้จากแอพเท่านั้น ผ่าน `deleted:true` ไม่ใช่หายไปเงียบ)
4. `rev = max(remote.rev, local.rev) + 1` · `updatedBy = as` · push `history`
5. ถ้าสองฝั่งแก้ field ของ **เจ้าของเดียวกัน** ให้ค่าต่างกัน (เกิดได้เมื่อจดจาก 2 เครื่อง) → **ห้ามเลือกให้เอง** เก็บลง `conflicts[]` แล้วให้ผู้ใช้กดเลือก

> ฝั่งคอม (Python) **ไม่มี merge engine** — git ทำให้เป็นลำดับอยู่แล้ว: `pull` → อ่านไฟล์ → เขียนเฉพาะ path ของ `claude` → `rev+1` → `push`
> merge engine มีที่เดียวคือ `js/db.js` (เทียบ local กับ remote บนมือถือ)

---

## รูป — store `photos` (IndexedDB) + `photos/YYYY-MM-DD/<id>.jpg` (repo)

```jsonc
{ "id": "p_a91f3", "date": "2026-09-12", "mealId": "m_k7x2q",
  "blob": Blob, "w": 1024, "h": 768, "bytes": 148231,
  "uploaded": false, "remotePath": null, "createdAt": "…" }
```
- ย่อ **ตอนเลือกรูป** ไม่ใช่ตอนส่ง: ด้านยาว ≤ 1024 px, JPEG q0.7, **บังคับ ≤ 250 KB** (ถ้าเกินลดคุณภาพลงอีกขั้น)
- ย่อไม่สำเร็จ → **ห้ามเก็บไฟล์ดิบ** ให้แจ้งผู้ใช้ "รูปนี้ใช้ไม่ได้ ถ่ายใหม่"
- เงื่อนไขสำคัญ: **วันจะถือว่า "ส่งแล้ว" ได้เมื่อรูปทุกใบของวันนั้น `uploaded === true`** — ถ้ารูปไม่ถึงคอม Claude ตรวจเลขไม่ได้ วงจรทั้งหมดพัง

## คิวงาน — store `outbox`
```jsonc
{ "id": 1, "kind": "ai" | "gh-photo" | "gh-day", "date": "2026-09-12",
  "photoId": null, "tries": 0, "lastError": null, "createdAt": "…" }
```
ทำทีละงานเรียงกัน (ห้ามขนาน) · เว้น ≥ 1.2 วินาทีต่อการเขียน GitHub · ล้มแล้วคาไว้ในคิว ลองใหม่ตอน: เปิดแอพ / `online` / `visibilitychange` (debounce 60 วิ) / กดปุ่มซิงก์
**ห้ามทิ้งงานเงียบ ๆ** — ล้มเกิน 5 ครั้งให้ขึ้นข้อความพร้อมปุ่ม "ลองใหม่"

## ค่าตั้งต้น — `profile.json` (อยู่ใน repo ส่วนตัว ไม่ใช่ repo โค้ด)
```json
{ "limit": 1800, "tdee": 2450, "proteinGoal": 140, "goalWeight": 87.5 }
```
เพดานตัดสินสีของวัน: `ceil = min(tdee, garmin.burn ?? tdee)` (เอาค่าที่เข้มกว่าเสมอ)

## key/token — localStorage เท่านั้น (ห้ามลง IndexedDB ห้ามลงไฟล์ใน repo)
`cal.or_key` · `cal.gh_pat` · `cal.gh_repo` · `cal.ai_models`
**ไฟล์ Export ต้องไม่มีสตริงเหล่านี้** (มีเทสต์บังคับ)
