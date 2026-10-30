// Pesan push untuk admin dan pekerjaan terjadwalnya. Logika murni dipisah dari Firebase supaya bisa dites.
// Perhitungan pengingat memakai modul bersama (reservasi-core.js), sama persis dengan panel Pengingat di dasbor web.

const core = require("./reservasi-core");
const { kirimPush } = require("./devices");

const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const JAM_PERINGATAN_KEDALUWARSA = 6;

function tanggalPendek(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  return m ? `${+m[3]} ${BULAN[+m[2] - 1]}` : String(ymd || "");
}

function bersih(v, maks) { return String(v == null ? "" : v).replace(/[<>\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, maks); }

// d: data permintaan yang sudah tervalidasi (nama, jumlah, date, jam, tempat). Tanpa nomor HP.
function pesanPermintaanBaru(d) {
  const bagian = [`${bersih(d.nama, 40)}`, `${d.jumlah} orang`, `${tanggalPendek(d.date)} ${bersih(d.jam, 5)}`.trim(), bersih(d.tempat, 40)].filter(Boolean);
  return { channel: "permintaan_baru", title: "Permintaan reservasi baru", body: bagian.join(" · "), tab: "inbox" };
}

function pesanKedaluwarsa(n) {
  return {
    channel: "kedaluwarsa",
    title: n === 1 ? "1 permintaan hampir kedaluwarsa" : `${n} permintaan hampir kedaluwarsa`,
    body: "Segera proses supaya kursinya tidak dilepas otomatis.",
    tab: "inbox"
  };
}

// hariIni: {reservasi, tamu}; p: hasil core.daftarPengingat. Mengembalikan null bila tidak ada yang perlu disampaikan.
function pesanRingkasanPagi(hariIni, p) {
  const n = { h3: p.h3.length, h1: p.h1.length, terima: p.terimaKasih.length, exp: p.kedaluwarsa.length };
  if (!hariIni.reservasi && !n.h3 && !n.h1 && !n.terima && !n.exp) return null;
  const bagian = [];
  bagian.push(hariIni.reservasi ? `Hari ini ${hariIni.reservasi} reservasi (${hariIni.tamu} tamu)` : "Tidak ada reservasi hari ini");
  const kirim = [];
  if (n.h3) kirim.push(`${n.h3} pengingat H-3`);
  if (n.h1) kirim.push(`${n.h1} pengingat H-1`);
  if (n.terima) kirim.push(`${n.terima} ucapan terima kasih`);
  if (kirim.length) bagian.push("Perlu dikirim: " + kirim.join(", "));
  if (n.exp) bagian.push(`${n.exp} permintaan hampir kedaluwarsa`);
  return {
    channel: "pengingat",
    title: "Ringkasan hari ini",
    body: bagian.join(". ") + ".",
    tab: n.exp ? "inbox" : (n.h3 || n.h1 || n.terima ? "reminders" : "dashboard")
  };
}

async function jalankanRingkasanPagi(ctx, now = Date.now()) {
  const { admin, db } = ctx;
  const hariIni = core.ymdWib(now);
  const dari = core.tambahHari(hariIni, -7), sampai = core.tambahHari(hariIni, 3);
  const [resSnap, reqSnap] = await Promise.all([
    db.collection("reservations").where("date", ">=", dari).where("date", "<=", sampai).get(),
    db.collection("reservation_requests").get()
  ]);
  const reservasi = resSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const permintaan = reqSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const stat = { reservasi: 0, tamu: 0 };
  reservasi.forEach((r) => {
    if (r.date === hariIni && !core.isBatal(r)) { stat.reservasi++; stat.tamu += Math.max(0, parseInt(r.jumlah, 10) || 0); }
  });
  const pesan = pesanRingkasanPagi(stat, core.daftarPengingat(reservasi, permintaan, now));
  if (!pesan) return { dikirim: false };
  return { dikirim: true, ...(await kirimPush(ctx, pesan)) };
}

// Permintaan yang sisa waktunya <= JAM_PERINGATAN_KEDALUWARSA jam diperingatkan SEKALI (ditandai notifiedExpiring).
async function jalankanPeringatanKedaluwarsa(ctx, now = Date.now()) {
  const { admin, db } = ctx;
  const batas = admin.firestore.Timestamp.fromMillis(now + JAM_PERINGATAN_KEDALUWARSA * 3600 * 1000);
  const snap = await db.collection("reservation_requests").where("expiresAt", "<=", batas).get();
  const target = snap.docs.filter((d) => {
    const x = d.data();
    const exp = core.tsMillis(x.expiresAt);
    return String(x.status || "").toLowerCase() === "pending" && !x.notifiedExpiring && exp != null && exp > now;
  });
  if (!target.length) return { dikirim: false, jumlah: 0 };
  const hasil = await kirimPush(ctx, pesanKedaluwarsa(target.length));
  if (hasil.terkirim > 0) { // tanpa perangkat terdaftar, jangan ditandai agar perangkat yang mendaftar kemudian tetap diperingatkan
    for (const d of target) await d.ref.update({ notifiedExpiring: true });
  }
  return { dikirim: true, jumlah: target.length, ...hasil };
}

module.exports = { pesanPermintaanBaru, pesanKedaluwarsa, pesanRingkasanPagi, jalankanRingkasanPagi, jalankanPeringatanKedaluwarsa, tanggalPendek, JAM_PERINGATAN_KEDALUWARSA };
