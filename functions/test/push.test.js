// Jalankan: node --test test/push.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../devices");
const P = require("../push");

const TOKEN = "f".repeat(60) + ":APA91b" + "x".repeat(60);
const TOKEN2 = "g".repeat(60) + ":APA91b" + "y".repeat(60);

// ---------- Firestore + FCM palsu ----------
function makeEnv(initialDevices = {}, seed = {}) {
  const cols = { admin_devices: new Map(Object.entries(initialDevices)), reservations: new Map(Object.entries(seed.reservations || {})), reservation_requests: new Map(Object.entries(seed.reservation_requests || {})) };
  const ts = (ms) => ({ toMillis: () => ms, valueOf: () => ms });
  const ref = (c, id) => ({ id, async get() { const d = cols[c].get(id); return { exists: d !== undefined, id, data: () => d, ref: ref(c, id) }; }, async set(d) { cols[c].set(id, d); }, async delete() { cols[c].delete(id); }, async update(u) { cols[c].set(id, { ...cols[c].get(id), ...u }); } });
  const query = (c, filters = [], lim = Infinity) => ({
    where(f, op, v) { return query(c, [...filters, [f, op, v]], lim); },
    limit(n) { return query(c, filters, n); },
    async get() {
      const docs = [];
      for (const [id, data] of cols[c]) {
        const ok = filters.every(([f, op, v]) => op === "==" ? data[f] === v : op === ">=" ? data[f] >= v : op === "<=" ? Number(data[f]) <= Number(v) || data[f] <= v : false);
        if (ok) docs.push({ id, data: () => data, ref: ref(c, id) });
        if (docs.length >= lim) break;
      }
      return { docs, empty: docs.length === 0 };
    }
  });
  const sent = [];
  let failWith = null;
  const db = { collection: (c) => ({ ...query(c), doc: (id) => ref(c, id) }) };
  const admin = {
    auth: () => ({ verifyIdToken: async (t) => { if (t === "tok-admin") return { uid: "u1", email: "Admin@X.id" }; if (t === "tok-admin2") return { uid: "u2", email: "b@x.id" }; throw new Error("bad"); } }),
    firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => ts(Date.now()) }, Timestamp: { fromMillis: (ms) => ts(ms), now: () => ts(Date.now()) } }),
    messaging: () => ({ sendEachForMulticast: async (m) => {
      sent.push(m);
      return { responses: m.tokens.map((t) => (failWith && failWith(t) ? { success: false, error: { code: failWith(t) } } : { success: true })) };
    } })
  };
  return { db, admin, cols, sent, ts, setFail: (f) => { failWith = f; }, logger: { warn() {}, error() {}, info() {} } };
}

function panggil(env, mode, token, body, method = "POST") {
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ status: this.code, body: o }); } };
    D.handleDevice({ method, headers: token ? { authorization: "Bearer " + token } : {}, body, get(h) { return this.headers[h.toLowerCase()]; } }, res, env, mode);
  });
}

// ---------- registerDevice / unregisterDevice ----------
test("daftar perangkat: butuh login, token valid; tersimpan dengan uid dan email akun", async () => {
  const env = makeEnv();
  assert.equal((await panggil(env, "register", null, { token: TOKEN })).status, 401);
  assert.equal((await panggil(env, "register", "palsu", { token: TOKEN })).status, 401);
  assert.equal((await panggil(env, "register", "tok-admin", { token: "pendek" })).status, 400);
  assert.equal((await panggil(env, "register", "tok-admin", { token: { a: 1 } })).status, 400);
  assert.equal((await panggil(env, "register", "tok-admin", { token: TOKEN }, "GET")).status, 405);
  const r = await panggil(env, "register", "tok-admin", { token: TOKEN, appVersion: "1.0.0", platform: "ios" });
  assert.equal(r.status, 200);
  const d = [...env.cols.admin_devices.values()][0];
  assert.deepEqual([d.token, d.uid, d.email, d.platform, d.appVersion], [TOKEN, "u1", "admin@x.id", "android", "1.0.0"]);
});

test("daftar ulang token yang sama tidak membuat duplikat", async () => {
  const env = makeEnv();
  await panggil(env, "register", "tok-admin", { token: TOKEN });
  await panggil(env, "register", "tok-admin", { token: TOKEN });
  assert.equal(env.cols.admin_devices.size, 1);
});

test("maksimal 10 perangkat per akun: yang terlama dibuang", async () => {
  const env = makeEnv();
  for (let i = 0; i < 12; i++) {
    const t = String(i).padStart(2, "0").repeat(30) + ":APA91b" + "z".repeat(40);
    await panggil(env, "register", "tok-admin", { token: t });
    [...env.cols.admin_devices.values()].forEach((d) => { if (d.token === t) d.updatedAt = env.ts(1000 + i); });
  }
  const sisa = [...env.cols.admin_devices.values()].filter((d) => d.uid === "u1");
  assert.equal(sisa.length, D.MAX_PERANGKAT_PER_AKUN);
  assert.equal(sisa.some((d) => d.token.startsWith("00")), false); // yang paling awal sudah dibuang
});

test("cabut perangkat: hanya pemiliknya", async () => {
  const env = makeEnv();
  await panggil(env, "register", "tok-admin", { token: TOKEN });
  assert.equal((await panggil(env, "unregister", "tok-admin2", { token: TOKEN })).status, 200);   // akun lain: diabaikan
  assert.equal(env.cols.admin_devices.size, 1);
  assert.equal((await panggil(env, "unregister", "tok-admin", { token: TOKEN })).status, 200);
  assert.equal(env.cols.admin_devices.size, 0);
});

// ---------- kirimPush ----------
test("kirimPush: data + notifikasi + saluran Android; token mati dibuang dari daftar", async () => {
  const env = makeEnv();
  await panggil(env, "register", "tok-admin", { token: TOKEN });
  await panggil(env, "register", "tok-admin2", { token: TOKEN2 });
  env.setFail((t) => (t === TOKEN2 ? "messaging/registration-token-not-registered" : null));
  const h = await D.kirimPush(env, { channel: "permintaan_baru", title: "Judul", body: "Isi", tab: "inbox" });
  assert.deepEqual(h, { terkirim: 1, gagal: 1, dibuang: 1 });
  const m = env.sent[0];
  assert.deepEqual(m.data, { channel: "permintaan_baru", title: "Judul", body: "Isi", tab: "inbox" });
  assert.deepEqual(m.notification, { title: "Judul", body: "Isi" });
  assert.equal(m.android.priority, "high");
  assert.equal(m.android.notification.channelId, "permintaan_baru");
  assert.equal(env.cols.admin_devices.size, 1);
});

test("kirimPush: tanpa perangkat tidak mengirim apa pun; kegagalan FCM tidak melempar", async () => {
  const env = makeEnv();
  assert.deepEqual(await D.kirimPush(env, { channel: "x", title: "t", body: "b" }), { terkirim: 0, gagal: 0, dibuang: 0 });
  assert.equal(env.sent.length, 0);
  await panggil(env, "register", "tok-admin", { token: TOKEN });
  env.admin.messaging = () => { throw new Error("FCM mati"); };
  const h = await D.kirimPush(env, { channel: "x", title: "t", body: "b" });
  assert.equal(h.terkirim, 0);
});

test("kirimPush: lebih dari 500 perangkat dikirim per 500 token", async () => {
  const env = makeEnv();
  for (let i = 0; i < 3; i++) env.cols.admin_devices.set("d" + i, { token: "t".repeat(60) + i, uid: "u" });
  const h = await D.kirimPush(env, { channel: "x", title: "t", body: "b" });
  assert.equal(h.terkirim, 3);
});

// ---------- pesan ----------
test("pesan permintaan baru: ringkas, tanpa nomor HP, tanpa tag HTML", () => {
  const p = P.pesanPermintaanBaru({ nama: "<b>Budi</b> Santoso", jumlah: 12, date: "2026-12-05", jam: "10:00", tempat: "Pondok 1", nomorHp: "0811222333" });
  assert.equal(p.channel, "permintaan_baru");
  assert.equal(p.tab, "inbox");
  assert.equal(p.body, "b Budi /b Santoso · 12 orang · 5 Des 10:00 · Pondok 1");
  assert.equal(/[<>]/.test(p.body), false);
  assert.equal(JSON.stringify(p).includes("0811222333"), false);
  assert.ok(p.body.includes("12 orang") && p.body.includes("5 Des 10:00") && p.body.includes("Pondok 1"));
});

test("ringkasan pagi: isi, tab tujuan, dan kosong bila tidak ada apa-apa", () => {
  const kosong = { h3: [], h1: [], terimaKasih: [], kedaluwarsa: [] };
  assert.equal(P.pesanRingkasanPagi({ reservasi: 0, tamu: 0 }, kosong), null);
  const a = P.pesanRingkasanPagi({ reservasi: 3, tamu: 85 }, { ...kosong, h3: [1, 2], terimaKasih: [1] });
  assert.equal(a.title, "Ringkasan hari ini");
  assert.equal(a.channel, "pengingat");
  assert.equal(a.tab, "reminders");
  assert.ok(a.body.includes("Hari ini 3 reservasi (85 tamu)") && a.body.includes("2 pengingat H-3") && a.body.includes("1 ucapan terima kasih"));
  assert.equal(P.pesanRingkasanPagi({ reservasi: 1, tamu: 5 }, { ...kosong, kedaluwarsa: [1] }).tab, "inbox");
  assert.equal(P.pesanRingkasanPagi({ reservasi: 2, tamu: 9 }, kosong).tab, "dashboard");
  assert.ok(P.pesanRingkasanPagi({ reservasi: 0, tamu: 0 }, { ...kosong, h1: [1] }).body.includes("Tidak ada reservasi hari ini"));
});

test("pesan kedaluwarsa: tunggal dan jamak", () => {
  assert.equal(P.pesanKedaluwarsa(1).title, "1 permintaan hampir kedaluwarsa");
  assert.equal(P.pesanKedaluwarsa(3).title, "3 permintaan hampir kedaluwarsa");
  assert.equal(P.pesanKedaluwarsa(3).channel, "kedaluwarsa");
});

// ---------- pekerjaan terjadwal ----------
const NOW = Date.parse("2026-11-02T00:00:00Z"); // 07:00 WIB, 2 Nov 2026

test("ringkasan pagi: menghitung reservasi hari ini dan pengingat nyata, lalu mengirim", async () => {
  const env = makeEnv({ d1: { token: TOKEN, uid: "u1" } }, {
    reservations: {
      a: { date: "2026-11-02", jam: "12:00", jumlah: 30, nomorHp: "62811", nama: "A" },
      b: { date: "2026-11-02", jam: "10:00", jumlah: "20", nomorHp: "62822", nama: "B", status: "batal" },
      c: { date: "2026-11-05", jam: "10:00", jumlah: 5, nomorHp: "62833", nama: "C" },           // H-3
      d: { date: "2026-11-03", jam: "10:00", jumlah: 5, nomorHp: "62844", nama: "D" },           // H-1 (dan reservasi a: hari H yang belum lewat)
      e: { date: "2026-10-30", jam: "10:00", jumlah: 5, nomorHp: "62855", nama: "E" },           // terima kasih
      f: { date: "2026-12-30", jam: "10:00", jumlah: 5, nomorHp: "62866", nama: "F" }            // di luar jendela
    },
    reservation_requests: { q: { status: "pending", expiresAt: env0(NOW + 3 * 3600e3) } }
  });
  const h = await P.jalankanRingkasanPagi(env, NOW);
  assert.equal(h.dikirim, true);
  const m = env.sent[0];
  assert.equal(m.data.title, "Ringkasan hari ini");
  assert.ok(m.data.body.includes("Hari ini 1 reservasi (30 tamu)"), m.data.body);
  assert.ok(m.data.body.includes("1 pengingat H-3") && m.data.body.includes("2 pengingat H-1") && m.data.body.includes("1 ucapan terima kasih") && m.data.body.includes("1 permintaan hampir kedaluwarsa"), m.data.body);
  assert.equal(m.data.tab, "inbox");
  assert.equal(JSON.stringify(m).includes("6281"), false); // nomor HP tidak ikut
});
function env0(ms) { return { toMillis: () => ms, valueOf: () => ms }; }

test("ringkasan pagi: hari sepi tanpa pengingat tidak mengirim apa pun", async () => {
  const env = makeEnv({ d1: { token: TOKEN, uid: "u1" } }, { reservations: { f: { date: "2026-12-30", jam: "10:00", jumlah: 5, nomorHp: "62866" } } });
  const h = await P.jalankanRingkasanPagi(env, NOW);
  assert.equal(h.dikirim, false);
  assert.equal(env.sent.length, 0);
});

test("peringatan kedaluwarsa: sekali per permintaan, hanya yang pending dan masih akan kedaluwarsa dalam 6 jam", async () => {
  const env = makeEnv({ d1: { token: TOKEN, uid: "u1" } }, { reservation_requests: {
    dekat: { status: "pending", expiresAt: env0(NOW + 3 * 3600e3) },
    dekat2: { status: "pending", expiresAt: env0(NOW + 1 * 3600e3) },
    jauh: { status: "pending", expiresAt: env0(NOW + 30 * 3600e3) },
    lewat: { status: "pending", expiresAt: env0(NOW - 1 * 3600e3) },
    ditolak: { status: "ditolak", expiresAt: env0(NOW + 3600e3) },
    sudah: { status: "pending", expiresAt: env0(NOW + 3600e3), notifiedExpiring: true }
  } });
  const h1 = await P.jalankanPeringatanKedaluwarsa(env, NOW);
  assert.deepEqual([h1.dikirim, h1.jumlah], [true, 2]);
  assert.equal(env.sent[0].data.title, "2 permintaan hampir kedaluwarsa");
  assert.equal(env.cols.reservation_requests.get("dekat").notifiedExpiring, true);
  assert.equal(env.cols.reservation_requests.get("jauh").notifiedExpiring, undefined);
  const h2 = await P.jalankanPeringatanKedaluwarsa(env, NOW);   // jalan lagi: tidak mengirim ulang
  assert.equal(h2.dikirim, false);
  assert.equal(env.sent.length, 1);
});

test("peringatan kedaluwarsa tanpa perangkat terdaftar: tidak ditandai (perangkat yang mendaftar kemudian tetap diperingatkan)", async () => {
  const env = makeEnv({}, { reservation_requests: { dekat: { status: "pending", expiresAt: env0(NOW + 3600e3) } } });
  await P.jalankanPeringatanKedaluwarsa(env, NOW);
  assert.equal(env.cols.reservation_requests.get("dekat").notifiedExpiring, undefined);
});

test("kirimPush: messaging/invalid-argument (muatan cacat) TIDAK menghapus perangkat", async () => {
  const env = makeEnv();
  await panggil(env, "register", "tok-admin", { token: TOKEN });
  await panggil(env, "register", "tok-admin2", { token: TOKEN2 });
  env.setFail(() => "messaging/invalid-argument");
  const h = await D.kirimPush(env, { channel: "permintaan_baru", title: "t", body: "b", tab: "inbox" });
  assert.equal(h.dibuang, 0);
  assert.equal(h.gagal, 2);
});
