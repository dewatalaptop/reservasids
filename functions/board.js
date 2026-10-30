// boardReservations: data reservasi untuk PAPAN KARYAWAN (ds-information-board.html, upgradeteam.html) TANPA login.
//
// Papan ini dipakai karyawan untuk membaca kebutuhan reservasi, jadi tidak boleh meminta login. Sejak daftar `reservations`
// ditutup untuk umum di aturan Firestore, papan membaca lewat fungsi ini (Admin SDK) dan hanya mendapat kolom yang dipakai papan:
// nama, jam, tempat, jumlah, menu, catatan, DP. TIDAK ADA nomor HP, tipe pembayaran, atau data internal lain.
// Satu tanggal per permintaan, dibatasi jendela tanggal; tidak bisa mengambil seluruh koleksi.
//
// Catatan jujur: siapa pun yang tahu alamat fungsi ini bisa membaca nama/menu/catatan tamu per tanggal (tanpa nomor HP).
// Itu keputusan pemilik (papan harus bisa dibuka tanpa login). Pengetatan opsional: kunci/PIN di alamat.

const { isCancelled } = require("./submit");

const HARI_KE_BELAKANG = 30;
const HARI_KE_DEPAN = 180;

function isIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function tanggalWib(now = Date.now(), tambahHari = 0) {
  return new Date(now + 7 * 3600 * 1000 + tambahHari * 864e5).toISOString().slice(0, 10);
}

// Hanya kolom yang dibutuhkan papan; semua dipotong panjangnya.
function pilihFieldPapan(id, x) {
  const menus = Array.isArray(x.menus) ? x.menus.slice(0, 50).map((m) => {
    const o = { name: String((m && m.name) || "").slice(0, 100), quantity: parseInt(m && m.quantity, 10) || 0 };
    if (m && typeof m.price === "number") o.price = m.price;
    return o;
  }) : [];
  return {
    id: String(id),
    nama: String(x.nama || "").slice(0, 80),
    jam: typeof x.jam === "string" ? x.jam.slice(0, 5) : "",
    tempat: String(x.tempat || "").slice(0, 100),
    jumlah: Math.max(0, parseInt(x.jumlah, 10) || 0),
    menus,
    tambahan: String(x.tambahan || "").slice(0, 1000),
    dp: typeof x.dp === "number" ? x.dp : (parseFloat(x.dp) || 0)
  };
}

async function handleBoard(req, res, { admin, logger, now = Date.now() }) {
  if (req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }
  const date = String((req.query && req.query.date) || "");
  if (!isIsoDate(date)) { res.status(400).json({ code: "tanggal", message: "Parameter date harus YYYY-MM-DD." }); return; }
  if (date < tanggalWib(now, -HARI_KE_BELAKANG) || date > tanggalWib(now, HARI_KE_DEPAN)) {
    res.status(400).json({ code: "rentang", message: "Tanggal di luar rentang yang tersedia." });
    return;
  }
  try {
    const snap = await admin.firestore().collection("reservations").where("date", "==", date).limit(500).get();
    const items = [];
    snap.forEach((doc) => {
      const x = doc.data() || {};
      if (isCancelled(x)) return;
      items.push(pilihFieldPapan(doc.id, x));
    });
    res.set("Cache-Control", "public, max-age=10, s-maxage=10");
    res.status(200).json({ items });
  } catch (err) {
    if (logger) logger.error("boardReservations gagal:", err && err.message);
    res.status(502).json({ code: "server", message: "Gagal memuat data." });
  }
}

module.exports = { HARI_KE_BELAKANG, HARI_KE_DEPAN, pilihFieldPapan, handleBoard };
