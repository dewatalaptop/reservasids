// Logika murni untuk fungsi submitReservation (validasi, nomor HP, hitung kapasitas).
// Dipisah dari index.js supaya bisa dites tanpa Firebase (lihat test/submit.test.js).

const STATUS_BATAL = ["batal", "dibatalkan", "cancel", "cancelled", "canceled", "ditolak", "rejected", "kedaluwarsa"];

const LIMITS = {
  maxJumlah: 500,
  maxMenuItems: 50,
  maxMenuQty: 999,
  maxHariKeDepan: 366,
  maxPendingPerNomor: 3,
  maxPerJamPerIp: 10,
  pendingTtlJam: 48
};

function isIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function todayWIB(now = Date.now()) {
  return new Date(now + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function addDays(iso, n) {
  return new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
}

// Sama dengan normalizePhone di reservasimandiri.html: 08xx -> 628xx.
function normalizePhone(phone) {
  let p = String(phone || "").replace(/\D/g, "");
  if (p.startsWith("0")) p = "62" + p.slice(1);
  if (p && !p.startsWith("62")) p = "62" + p;
  return p;
}

function isValidPhone(p) {
  const rest = p.startsWith("62") ? p.slice(2) : p;
  return /^\d{8,12}$/.test(rest);
}

function isCancelled(doc) {
  return STATUS_BATAL.includes(String(doc && doc.status != null ? doc.status : "").trim().toLowerCase());
}

// Total tamu pada satu tempat, mengabaikan yang batal/ditolak/kedaluwarsa.
function usedCapacity(docs, tempat) {
  let used = 0;
  for (const d of docs) {
    if (isCancelled(d) || d.tempat !== tempat) continue;
    used += Math.max(0, parseInt(d.jumlah, 10) || 0);
  }
  return used;
}

function fail(code, message) {
  return { ok: false, code, message };
}

// Memeriksa dan membersihkan isi permintaan. Mengembalikan {ok:true, data} atau {ok:false, code, message}.
function validateRequest(body, now = Date.now()) {
  const b = body && typeof body === "object" ? body : {};
  if (b.website) return fail("spam", "Permintaan ditolak."); // honeypot: manusia tak mengisinya

  const date = String(b.date || "");
  if (!isIsoDate(date)) return fail("tanggal", "Tanggal tidak valid.");
  const today = todayWIB(now);
  if (date < today) return fail("tanggal", "Tanggal sudah lewat.");
  if (date > addDays(today, LIMITS.maxHariKeDepan)) return fail("tanggal", "Tanggal terlalu jauh ke depan.");

  const jam = String(b.jam || "");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(jam)) return fail("jam", "Jam tidak valid.");

  const jumlah = Number(b.jumlah);
  if (!Number.isInteger(jumlah) || jumlah < 1 || jumlah > LIMITS.maxJumlah) return fail("jumlah", "Jumlah orang tidak valid.");

  const tempat = String(b.tempat || "").trim();
  if (!tempat || tempat.length > 100) return fail("tempat", "Tempat tidak valid.");

  const nama = String(b.nama || "").trim();
  if (!nama || nama.length > 80) return fail("nama", "Nama wajib diisi (maksimal 80 karakter).");

  const nomorHp = normalizePhone(b.nomorHp);
  if (!isValidPhone(nomorHp)) return fail("nomorHp", "Nomor HP tidak valid.");

  const tambahan = String(b.tambahan || "").slice(0, 500);

  const rawMenus = Array.isArray(b.menus) ? b.menus : [];
  if (rawMenus.length > LIMITS.maxMenuItems) return fail("menus", "Terlalu banyak item menu.");
  const menus = [];
  for (const m of rawMenus) {
    const name = String((m && m.name) || "").trim();
    const quantity = Number(m && m.quantity);
    if (!name || name.length > 100 || !Number.isInteger(quantity) || quantity < 1 || quantity > LIMITS.maxMenuQty) {
      return fail("menus", "Item menu tidak valid.");
    }
    menus.push({ name, quantity });
  }

  return { ok: true, data: { date, jam, jumlah, tempat, nama, nomorHp, tambahan, menus } };
}

module.exports = { STATUS_BATAL, LIMITS, isIsoDate, todayWIB, addDays, normalizePhone, isValidPhone, isCancelled, usedCapacity, validateRequest };
