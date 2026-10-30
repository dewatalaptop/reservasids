// Jalankan: node --test test/board.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../board");

const NOW = Date.parse("2026-11-01T03:00:00Z"); // 10:00 WIB, 1 Nov 2026

function fakeAdmin(docs) {
  return { firestore: () => ({ collection: () => ({ where: (f, op, v) => ({ limit: () => ({ get: async () => {
    const hasil = docs.filter((d) => d.data[f] === v);
    return { forEach: (fn) => hasil.forEach((d) => fn({ id: d.id, data: () => d.data })) };
  } }) }) }) }) };
}

function panggil(docs, query, method = "GET") {
  return new Promise((resolve) => {
    const res = { code: 200, headers: {}, set(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(o) { resolve({ status: this.code, body: o, headers: this.headers }); } };
    B.handleBoard({ method, query }, res, { admin: fakeAdmin(docs), logger: { error() {} }, now: NOW });
  });
}

const DOC = (id, extra = {}) => ({ id, data: { date: "2026-11-05", nama: "Budi", nomorHp: "0811222333", jam: "10:00", tempat: "Pondok 1", jumlah: "12",
  menus: [{ name: "Paket A", quantity: 12 }], tambahan: "tidak pedas", dp: 100000, tipeDp: "QRIS", lunas: false, requestId: "rq", createdAt: "x", ...extra } });

test("hanya kolom papan yang keluar; nomor HP dan data internal TIDAK ada", async () => {
  const r = await panggil([DOC("a")], { date: "2026-11-05" });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.items[0]).sort(), ["dp", "id", "jam", "jumlah", "menus", "nama", "tambahan", "tempat"]);
  const json = JSON.stringify(r.body);
  for (const rahasia of ["0811222333", "QRIS", "requestId", "createdAt", "lunas", "tipeDp"]) assert.equal(json.includes(rahasia), false, rahasia);
  assert.equal(r.body.items[0].jumlah, 12);   // angka
  assert.equal(r.headers["Cache-Control"].includes("max-age=10"), true);
});

test("reservasi batal/ditolak/kedaluwarsa tidak tampil; tanggal lain tidak ikut", async () => {
  const r = await panggil([DOC("a"), DOC("b", { status: "batal" }), DOC("c", { status: "Ditolak" }), DOC("d", { date: "2026-11-06" }), DOC("e", { status: "approved" })], { date: "2026-11-05" });
  assert.deepEqual(r.body.items.map((i) => i.id).sort(), ["a", "e"]);
});

test("item menu: harga custom ikut, kolom lain tidak; dipotong 50 item", async () => {
  const menus = [{ name: "Custom X", quantity: "3", price: 15000, rahasia: "x" }, ...Array.from({ length: 80 }, (_, i) => ({ name: "M" + i, quantity: 1 }))];
  const r = await panggil([DOC("a", { menus })], { date: "2026-11-05" });
  assert.deepEqual(r.body.items[0].menus[0], { name: "Custom X", quantity: 3, price: 15000 });
  assert.equal(r.body.items[0].menus.length, 50);
});

test("validasi: tanggal wajib valid dan dalam rentang (-30..+180 hari); metode selain GET 405", async () => {
  assert.equal((await panggil([], {})).status, 400);
  assert.equal((await panggil([], { date: "2026-02-31" })).status, 400);
  assert.equal((await panggil([], { date: "bukan" })).status, 400);
  assert.equal((await panggil([], { date: "2026-11-01" })).status, 200);
  assert.equal((await panggil([], { date: "2026-10-02" })).status, 200);       // 30 hari ke belakang
  assert.equal((await panggil([], { date: "2026-10-01" })).body.code, "rentang");
  assert.equal((await panggil([], { date: "2027-04-30" })).status, 200);       // 180 hari ke depan
  assert.equal((await panggil([], { date: "2027-05-01" })).body.code, "rentang");
  assert.equal((await panggil([], { date: "2026-11-05" }, "POST")).status, 405);
});

test("kolom aneh/kosong tidak merusak: tanpa jam, jumlah teks, dp teks", async () => {
  const r = await panggil([{ id: "x", data: { date: "2026-11-05", nama: null, jumlah: "abc", dp: "150000", menus: "bukan-array" } }], { date: "2026-11-05" });
  assert.deepEqual(r.body.items[0], { id: "x", nama: "", jam: "", tempat: "", jumlah: 0, menus: [], tambahan: "", dp: 150000 });
});
