// Jalankan: node --test test/   (dari folder functions). Tanpa Firebase/emulator:
// firebase-admin diganti Firestore palsu di memori.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const S = require("../submit");

// ---------- Firestore palsu ----------
function makeDb(seed) {
  const cols = {};
  for (const [c, docs] of Object.entries(seed)) cols[c] = new Map(Object.entries(docs));
  let autoId = 0;
  const col = (name) => (cols[name] = cols[name] || new Map());
  const refOf = (name, id) => ({ _col: name, id, _isRef: true,
    async get() { const data = col(name).get(id); return { exists: data !== undefined, id, data: () => data }; } });
  const query = (name, filters = [], lim = Infinity, order = null, after = null) => ({
    _isQuery: true, name, filters, lim, order, after,
    where(f, op, v) { return query(name, [...filters, [f, op, v]], lim, order, after); },
    limit(n) { return query(name, filters, n, order, after); },
    orderBy(f) { return query(name, filters, lim, f, after); },
    startAfter(d) { return query(name, filters, lim, order, d.id); },
    async get() { return run(this); }
  });
  function run(q) {
    let docs = [];
    for (const [id, data] of col(q.name)) {
      const ok = q.filters.every(([f, op, v]) => (op === "==" ? data[f] === v : op === "<=" ? data[f] <= v : false));
      if (ok) docs.push({ id, ref: refOf(q.name, id), data: () => data });
    }
    if (q.order) docs.sort((a, b) => a.data()[q.order] - b.data()[q.order] || a.id.localeCompare(b.id));
    if (q.after) docs = docs.slice(docs.findIndex((d) => d.id === q.after) + 1);
    docs = docs.slice(0, q.lim);
    return { docs, empty: docs.length === 0, size: docs.length, forEach: (fn) => docs.forEach(fn) };
  }
  const db = {
    _cols: cols,
    collection: (name) => ({ ...query(name), doc: (id) => refOf(name, id || `auto${++autoId}`) }),
    runTransaction: async (fn) => {
      const writes = [];
      const tx = {
        get: async (x) => {
          if (x._isQuery) return run(x);
          const data = col(x._col).get(x.id);
          return { exists: data !== undefined, id: x.id, data: () => data };
        },
        update: (r, d) => writes.push(["update", r, d]),
        set: (r, d) => writes.push(["set", r, d]),
        create: (r, d) => writes.push(["create", r, d])
      };
      const out = await fn(tx);
      for (const [kind, r, d] of writes) {
        if (kind === "update") {
          const cur = { ...col(r._col).get(r.id) };
          for (const [k, v] of Object.entries(d)) { if (v === "__DEL__") delete cur[k]; else cur[k] = v; }
          col(r._col).set(r.id, cur);
        } else col(r._col).set(r.id, d);
      }
      return out;
    }
  };
  return db;
}

function load(db) {
  const adminFake = {
    initializeApp() {},
    firestore: Object.assign(() => db, {
      FieldValue: { serverTimestamp: () => "TS", delete: () => "__DEL__" },
      Timestamp: { fromMillis: (ms) => ({ ms, valueOf: () => ms }), now: () => ({ ms: Date.now(), valueOf: () => Date.now() }) }
    }),
    auth: () => ({})
  };
  const orig = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "firebase-admin") return adminFake;
    if (request === "@google-cloud/secret-manager") return { SecretManagerServiceClient: class { async accessSecretVersion() { return [{ payload: { data: Buffer.from("kunci-palsu") } }]; } } };
    return orig.call(this, request, ...rest);
  };
  delete require.cache[require.resolve("../index.js")];
  const mod = require("../index.js");
  Module._load = orig;
  load.mod = mod;
  return mod._submitReservationHandler;
}

function call(handler, body, ip = "1.2.3.4") {
  return new Promise((resolve) => {
    const res = {
      code: 200,
      status(c) { this.code = c; return this; },
      json(o) { resolve({ status: this.code, body: o }); }
    };
    handler({ method: "POST", body, ip }, res);
  });
}

const futureDate = () => S.addDays(S.todayWIB(), 10);
const good = (over = {}) => ({
  date: futureDate(), jam: "10:00", jumlah: 10, tempat: "Gazebo A", nama: "Budi",
  nomorHp: "081234567890", tambahan: "", menus: [{ name: "Nasi Box", quantity: 10 }], ...over
});
const baseSeed = () => ({
  locations: { l1: { name: "Gazebo A", capacity: 30 } },
  menus: { "Nasi Box": { price: 25000 } }, // bentuk nyata: nama = ID dokumen, hanya field price
  reservations: {}, reservation_requests: {}, date_status: {}, rate_limits: {}
});

// ---------- validasi murni ----------
test("validateRequest: normalisasi nomor dan isi baku", () => {
  const r = S.validateRequest(good());
  assert.equal(r.ok, true);
  assert.equal(r.data.nomorHp, "6281234567890");
});
test("validateRequest: honeypot, tanggal lewat, jauh, jam, jumlah, HP, menu", () => {
  const bad = (o) => S.validateRequest(good(o));
  assert.equal(bad({ website: "x" }).code, "spam");
  assert.equal(bad({ date: "2020-01-01" }).code, "tanggal");
  assert.equal(bad({ date: S.addDays(S.todayWIB(), 400) }).code, "tanggal");
  assert.equal(bad({ date: "2026-02-31" }).code, "tanggal");
  assert.equal(bad({ jam: "25:00" }).code, "jam");
  assert.equal(bad({ jumlah: 0 }).code, "jumlah");
  assert.equal(bad({ jumlah: 1.5 }).code, "jumlah");
  assert.equal(bad({ jumlah: 9999 }).code, "jumlah");
  assert.equal(bad({ nomorHp: "123" }).code, "nomorHp");
  assert.equal(bad({ nama: "  " }).code, "nama");
  assert.equal(bad({ menus: [{ name: "x", quantity: -1 }] }).code, "menus");
});
test("usedCapacity mengabaikan batal, ditolak, kedaluwarsa, tempat lain", () => {
  const docs = [
    { tempat: "A", jumlah: 10 }, { tempat: "A", jumlah: 5, status: "kedaluwarsa" },
    { tempat: "A", jumlah: 7, status: "Batal" }, { tempat: "B", jumlah: 99 }, { tempat: "A", jumlah: "4" }
  ];
  assert.equal(S.usedCapacity(docs, "A"), 14);
});

// ---------- handler ----------
test("handler: permintaan sah tersimpan dengan status pending dan expiresAt", async () => {
  const db = makeDb(baseSeed());
  const r = await call(load(db), good());
  assert.equal(r.status, 200);
  const saved = [...db._cols.reservation_requests.values()][0];
  assert.equal(saved.status, "pending");
  assert.equal(saved.nomorHp, "6281234567890");
  assert.ok(saved.expiresAt.ms > Date.now());
});
test("handler: kapasitas penuh ditolak (409) dan kursi terhitung dari pending + confirmed", async () => {
  const seed = baseSeed();
  seed.reservations.r1 = { date: futureDate(), tempat: "Gazebo A", jumlah: 15 };
  seed.reservation_requests.q1 = { date: futureDate(), tempat: "Gazebo A", jumlah: 10, nomorHp: "62811", status: "pending" };
  const h = load(makeDb(seed));
  const r = await call(h, good({ jumlah: 6 })); // sisa 5
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "kapasitas_penuh");
});
test("handler: dua permintaan berurutan memperebutkan kursi terakhir, hanya satu lolos", async () => {
  const seed = baseSeed();
  seed.locations.l1.capacity = 10;
  const db = makeDb(seed);
  const h = load(db);
  const a = await call(h, good({ jumlah: 10, nomorHp: "081111111111" }), "9.9.9.1");
  const b = await call(h, good({ jumlah: 10, nomorHp: "082222222222" }), "9.9.9.2");
  assert.deepEqual([a.status, b.status], [200, 409]);
});
test("handler: permintaan kedaluwarsa tidak menahan kursi", async () => {
  const seed = baseSeed();
  seed.locations.l1.capacity = 10;
  seed.reservation_requests.q1 = { date: futureDate(), tempat: "Gazebo A", jumlah: 10, nomorHp: "62811", status: "kedaluwarsa" };
  const r = await call(load(makeDb(seed)), good({ jumlah: 10 }));
  assert.equal(r.status, 200);
});
test("handler: tanggal ditutup admin, tempat/menu tak dikenal, duplikat", async () => {
  const seed = baseSeed();
  seed.date_status.d1 = { date: futureDate(), isFull: true };
  assert.equal((await call(load(makeDb(seed)), good())).body.code, "ditutup");

  const h = load(makeDb(baseSeed()));
  assert.equal((await call(h, good({ tempat: "Tidak Ada" }))).body.code, "tempat");
  assert.equal((await call(h, good({ menus: [{ name: "Menu Palsu", quantity: 1 }] }))).body.code, "menus");

  const h2 = load(makeDb(baseSeed()));
  assert.equal((await call(h2, good())).status, 200);
  const dup = await call(h2, good({ jumlah: 2 }));
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "duplikat");
});
test("handler: batas permintaan per nomor dan per IP", async () => {
  const h = load(makeDb(baseSeed()));
  const ok = [];
  for (let i = 0; i < 4; i++) {
    ok.push((await call(h, good({ tempat: "Gazebo A", date: S.addDays(S.todayWIB(), 10 + i), jumlah: 1 }), `5.5.5.${i}`)).status);
  }
  assert.deepEqual(ok, [200, 200, 200, 200]); // pembatas nomor dihitung per tanggal; 4 tanggal berbeda lolos

  const h2 = load(makeDb(baseSeed()));
  let last;
  for (let i = 0; i < 11; i++) {
    last = await call(h2, good({ date: S.addDays(S.todayWIB(), 10 + i), nomorHp: `08111000${String(i).padStart(4, "0")}`, jumlah: 1 }), "7.7.7.7");
  }
  assert.equal(last.status, 429);
});
test("handler: honeypot dan metode salah", async () => {
  const h = load(makeDb(baseSeed()));
  assert.equal((await call(h, good({ website: "http://spam" }))).status, 403);
  const res = { status(c) { this.c = c; return this; }, json() {} };
  await h({ method: "GET" }, res);
  assert.equal(res.c, 405);
});

// ---------- reservationStatus ----------
function getStatus(h, id) {
  return new Promise((resolve) => {
    const res = { code: 200, set() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ status: this.code, body: o }); } };
    h({ method: "GET", query: { id } }, res);
  });
}
test("reservationStatus: menunggu, ditolak, kedaluwarsa, disetujui, batal, tak ada, id buruk", async () => {
  const seed = baseSeed();
  const D = futureDate();
  seed.reservation_requests.AAAAAAAAAAAAAAAAAAAA = { date: D, jam: "10:00", tempat: "Gazebo A", jumlah: 5, nama: "Budi", nomorHp: "62811", status: "pending" };
  seed.reservation_requests.BBBBBBBBBBBBBBBBBBBB = { date: D, tempat: "G", jumlah: 1, nama: "x", status: "ditolak" };
  seed.reservation_requests.CCCCCCCCCCCCCCCCCCCC = { date: D, tempat: "G", jumlah: 1, nama: "x", status: "kedaluwarsa" };
  seed.reservations.res1 = { requestId: "DDDDDDDDDDDDDDDDDDDD", date: D, tempat: "G", jumlah: 2, nama: "y", nomorHp: "6282", status: "approved" };
  seed.reservations.res2 = { requestId: "EEEEEEEEEEEEEEEEEEEE", date: D, tempat: "G", jumlah: 2, nama: "z", status: "batal" };
  load(makeDb(seed));
  const h = load.mod._reservationStatusHandler;
  const a = await getStatus(h, "AAAAAAAAAAAAAAAAAAAA");
  assert.equal(a.body.status, "menunggu");
  assert.equal(a.body.nomorHp, undefined); // data pribadi tidak bocor
  assert.equal((await getStatus(h, "BBBBBBBBBBBBBBBBBBBB")).body.status, "ditolak");
  assert.equal((await getStatus(h, "CCCCCCCCCCCCCCCCCCCC")).body.status, "kedaluwarsa");
  const d = await getStatus(h, "DDDDDDDDDDDDDDDDDDDD");
  assert.deepEqual([d.body.status, d.body.reservationId], ["disetujui", "res1"]);
  assert.equal(d.body.nomorHp, undefined);
  const e = await getStatus(h, "EEEEEEEEEEEEEEEEEEEE");
  assert.deepEqual([e.body.status, e.body.reservationId], ["dibatalkan", null]);
  assert.equal((await getStatus(h, "ZZZZZZZZZZZZZZZZZZZZ")).status, 404);
  assert.equal((await getStatus(h, "../x")).status, 400);
});

// ---------- regresi dari penguji independen ----------
test("menu bentuk nyata (nama = ID dokumen) lolos; menu palsu ditolak", async () => {
  const h = load(makeDb(baseSeed()));
  assert.equal((await call(h, good())).status, 200);
  assert.equal((await call(h, good({ nomorHp: "082999999999", menus: [{ name: "Menu Palsu", quantity: 1 }] }), "8.8.8.8")).body.code, "menus");
});
test("kapasitas lokasi rusak/kosong memakai bawaan 50, bukan tak terbatas", async () => {
  for (const cap of ["abc", undefined, null]) {
    const seed = baseSeed();
    seed.locations.l1.capacity = cap;
    const h = load(makeDb(seed));
    assert.equal((await call(h, good({ jumlah: 51 }))).body.code, "kapasitas_penuh", String(cap));
    assert.equal((await call(h, good({ jumlah: 50 }))).status, 200, String(cap));
  }
});
test("duplikat juga terhadap reservasi yang sudah disetujui", async () => {
  const seed = baseSeed();
  seed.reservations.r1 = { date: futureDate(), tempat: "Gazebo A", jumlah: 5, nomorHp: "6281234567890", status: "approved" };
  assert.equal((await call(load(makeDb(seed)), good())).body.code, "duplikat");
});
test("jam hari ini yang sudah lewat ditolak; jam esok tidak", () => {
  const noon = Date.parse("2026-11-02T06:00:00Z"); // 13:00 WIB
  const base = good({ date: "2026-11-02", jam: "10:00" });
  assert.equal(S.validateRequest(base, noon).code, "jam");
  assert.equal(S.validateRequest({ ...base, jam: "13:30" }, noon).ok, true);
  assert.equal(S.validateRequest({ ...base, date: "2026-11-03", jam: "10:00" }, noon).ok, true);
});
test("batas laju memakai elemen terakhir X-Forwarded-For (tidak bisa dipalsukan di depan)", async () => {
  const h = load(makeDb(baseSeed()));
  let last;
  for (let i = 0; i < 11; i++) {
    last = await new Promise((resolve) => {
      const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ status: this.code, body: o }); } };
      h({ method: "POST", ip: "10.0.0.1", headers: { "x-forwarded-for": `palsu${i}, 203.0.113.9` },
          body: good({ date: S.addDays(S.todayWIB(), 10 + i), nomorHp: `08111000${String(i).padStart(4, "0")}`, jumlah: 1 }) }, res);
    });
  }
  assert.equal(last.status, 429);
});

// ---------- expirePendingRequests ----------
test("expirePending: 450 non-pending berexpiresAt lampau tidak menutup jalan pending", async () => {
  const seed = baseSeed();
  const old = Date.now() - 3 * 3600 * 1000;
  for (let i = 0; i < 450; i++) seed.reservation_requests["d" + String(i).padStart(4, "0")] = { status: "ditolak", expiresAt: { ms: old - 1000 + i, valueOf: () => old - 1000 + i } };
  seed.reservation_requests.p1 = { status: "pending", date: futureDate(), expiresAt: { ms: old, valueOf: () => old } };
  seed.reservation_requests.p2 = { status: "pending", date: futureDate(), expiresAt: { ms: Date.now() + 1e7, valueOf: () => Date.now() + 1e7 } };
  const db = makeDb(seed);
  load(db);
  const n = await load.mod._expirePendingHandler();
  assert.equal(n, 1);
  const p1 = db._cols.reservation_requests.get("p1");
  assert.equal(p1.status, "kedaluwarsa");
  assert.equal(p1.expiresAt, undefined); // tidak ikut dipindai lagi
  assert.equal(db._cols.reservation_requests.get("p2").status, "pending");
});
test("expirePending: dokumen yang sudah disetujui/dihapus saat jalan tidak ditimpa", async () => {
  const seed = baseSeed();
  const old = Date.now() - 1000;
  seed.reservation_requests.a = { status: "ditolak", expiresAt: { ms: old, valueOf: () => old } };
  const db = makeDb(seed);
  load(db);
  assert.equal(await load.mod._expirePendingHandler(), 0);
  assert.equal(db._cols.reservation_requests.get("a").status, "ditolak");
});

// ---------- sanitasi (lapisan kedua XSS) ----------
test("sanitasi: tag HTML dibuang dari nama dan catatan; baris baru catatan tetap; nama kosong setelah dibersihkan ditolak", () => {
  const r = S.validateRequest(good({ nama: "<img src=x onerror=alert(1)>Budi", tambahan: "Kursi bayi <script>x</script>\nlantai 1" }));
  assert.equal(r.ok, true);
  assert.equal(/[<>]/.test(r.data.nama), false);
  assert.ok(r.data.nama.endsWith("Budi"));
  assert.equal(/[<>]/.test(r.data.tambahan), false);
  assert.ok(r.data.tambahan.includes("\n")); // baris baru dipertahankan
  assert.equal(S.validateRequest(good({ nama: "<<>>" })).code, "nama");
  assert.equal(S.validateRequest(good({ nama: "A".repeat(81) })).code, "nama");
  assert.equal(S.validateRequest(good({ nama: "  Siti   Aminah  " })).data.nama, "Siti Aminah");
  assert.equal(S.validateRequest(good({ nama: "Bud\u0000i" })).data.nama, "Budi"); // karakter kontrol dibuang
});

// ---------- analisis catatan AI ----------
test("analisis AI memberi ruang token untuk 'berpikir' (400 memotong jawaban) dan menerima jawaban lengkap", async () => {
  load(makeDb(baseSeed()));
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    calls.push(body);
    // meniru Gemini: token berpikir ~400 ikut dihitung; di bawah 1000 jawabannya terpotong
    const content = body.max_tokens >= 1000
      ? '{"items": [{"mentionedText": "es jeruk", "possibleMatch": null, "suggestedQuantity": 3}]}'
      : '{"items": [{"mentionedText": "es jeruk", "possibleMatch';
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }), clone() { return this; }, text: async () => "" };
  };
  try {
    const r = await load.mod._analyzeTambahanWithAi({ tambahan: "tambah 3 es jeruk " + Math.random(), knownMenuNames: [], existingMenus: [] });
    assert.ok(calls[0].max_tokens >= 1500, "max_tokens terlalu kecil: " + calls[0].max_tokens);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].suggestedQuantity, 3);
  } finally { global.fetch = realFetch; }
});

// ---------- kapasitas per jendela waktu (keputusan pemilik 2026-10-31) ----------
test("sisaKapasitas: durasi 2,5 jam + jeda 2 jam = jendela 270 menit; batas tepat 270 tidak bentrok", () => {
  assert.equal(S.JENDELA_BENTROK_MENIT, 270);
  const items = [
    { tempat: "A", jumlah: 30, jam: "10:00" },
    { tempat: "A", jumlah: 20, jam: "14:30" },        // tepat 270 menit dari 10:00 -> tidak bentrok dengan jam 10:00
    { tempat: "A", jumlah: 15, jam: "19:00" },
    { tempat: "B", jumlah: 99, jam: "10:00" },        // tempat lain
    { tempat: "A", jumlah: 50, jam: "10:30", status: "batal" },
    { tempat: "A", jumlah: 40, jam: "10:15", status: "kedaluwarsa" }
  ];
  assert.equal(S.sisaKapasitas(items, "A", "10:00", 100).terpakai, 30);        // 14:30 tepat 270 -> tidak ikut
  assert.equal(S.sisaKapasitas(items, "A", "13:00", 100).terpakai, 50);        // 10:00 (180) dan 14:30 (90) ikut
  assert.equal(S.sisaKapasitas(items, "A", "14:29", 100).terpakai, 50);        // 10:00 (269) ikut, 14:30 ikut
  assert.equal(S.sisaKapasitas(items, "A", "23:50", 100).terpakai, 0);         // 19:00 = 290 -> tidak ikut
  assert.equal(S.sisaKapasitas(items, "A", "23:00", 100).terpakai, 15);        // 19:00 = 240 -> ikut
  assert.equal(S.sisaKapasitas(items, "A", "17:00", 100, 1440).terpakai, 65);  // jendela seharian = aturan lama
});

test("sisaKapasitas: data lama tanpa jam dihitung penuh; jam baru tak valid -> hitung semua (hati-hati)", () => {
  const items = [{ tempat: "A", jumlah: 10 }, { tempat: "A", jumlah: 5, jam: "08:00" }];
  assert.equal(S.sisaKapasitas(items, "A", "20:00", 50).terpakai, 10);
  assert.equal(S.sisaKapasitas(items, "A", "", 50).terpakai, 15);
});

test("handler: jam berjauhan di tempat yang sama diterima walau total seharian melebihi kapasitas", async () => {
  const seed = baseSeed();
  seed.locations.l1.capacity = 30;
  seed.reservations.r1 = { date: futureDate(), tempat: "Gazebo A", jumlah: 25, jam: "10:00", nomorHp: "62811" };
  const h = load(makeDb(seed));
  assert.equal((await call(h, good({ jam: "16:30", jumlah: 25 }))).status, 200);                 // aturan lama: ditolak
  const dekat = await call(h, good({ jam: "11:30", jumlah: 10, nomorHp: "082999999990" }), "7.7.0.1");
  assert.equal(dekat.status, 409);
  assert.equal(dekat.body.code, "kapasitas_penuh");
  assert.ok(dekat.body.message.includes("11:30"));
  const jeda = await call(h, good({ jam: "14:00", jumlah: 10, nomorHp: "082999999991" }), "7.7.0.2");
  assert.equal(jeda.status, 409);                                                                  // 240 menit < 270: jeda 2 jam belum terpenuhi
});

test("handler: Full Blok minimal 200 orang; Lantai 1 bagian tertutup bila Full Blok dipesan (seharian)", async () => {
  const FB = "Lantai 1 Full Blok (peserta wajib di atas 200 orang)";
  const seed = baseSeed();
  seed.locations.l2 = { name: FB, capacity: 340 };
  seed.locations.l3 = { name: "Lantai 1 depan", capacity: 110 };
  const h = load(makeDb(seed));
  const kecil = await call(h, good({ tempat: FB, jumlah: 150, menus: [] }), "6.0.0.1");
  assert.deepEqual([kecil.status, kecil.body.code], [409, "min_200"]);
  assert.equal((await call(h, good({ tempat: FB, jumlah: 220, menus: [], nomorHp: "081300000001" }), "6.0.0.2")).status, 200);
  const bagian = await call(h, good({ tempat: "Lantai 1 depan", jam: "18:00", jumlah: 10, menus: [], nomorHp: "081300000002" }), "6.0.0.3");
  assert.deepEqual([bagian.status, bagian.body.code], [409, "full_blok_terisi"]);
});

test("cekAturanTempat: Full Blok yang batal tidak menutup bagian Lantai 1", () => {
  const items = [{ tempat: "Lantai 1 Full Blok (peserta wajib di atas 200 orang)", jumlah: 250, status: "batal" }];
  assert.equal(S.cekAturanTempat(items, "Lantai 1 tengah", 20), null);
  assert.equal(S.cekAturanTempat([], "Pondok 1", 5), null);
});
