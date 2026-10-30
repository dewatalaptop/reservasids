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
  const query = (name, filters = [], lim = Infinity) => ({
    _isQuery: true, name, filters, lim,
    where(f, op, v) { return query(name, [...filters, [f, op, v]], lim); },
    limit(n) { return query(name, filters, n); },
    async get() { return run(this); }
  });
  function run(q) {
    const docs = [];
    for (const [id, data] of col(q.name)) {
      const ok = q.filters.every(([f, op, v]) => (op === "==" ? data[f] === v : op === "<=" ? data[f] <= v : false));
      if (ok) docs.push({ id, ref: refOf(q.name, id), data: () => data });
      if (docs.length >= q.lim) break;
    }
    return { docs, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) };
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
          return { exists: data !== undefined, data: () => data };
        },
        set: (r, d) => writes.push(["set", r, d]),
        create: (r, d) => writes.push(["create", r, d])
      };
      const out = await fn(tx);
      for (const [, r, d] of writes) col(r._col).set(r.id, d);
      return out;
    }
  };
  return db;
}

function load(db) {
  const adminFake = {
    initializeApp() {},
    firestore: Object.assign(() => db, {
      FieldValue: { serverTimestamp: () => "TS" },
      Timestamp: { fromMillis: (ms) => ({ ms }), now: () => ({ ms: Date.now() }) }
    }),
    auth: () => ({})
  };
  const orig = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "firebase-admin") return adminFake;
    if (request === "@google-cloud/secret-manager") return { SecretManagerServiceClient: class {} };
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
  menus: { m1: { name: "Nasi Box" } },
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
