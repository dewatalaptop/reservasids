// Perangkat Android admin untuk notifikasi push (FCM) dan pengirimannya.
//
// - registerDevice / unregisterDevice: dipanggil aplikasi Android dengan token login Firebase admin (Bearer). Hanya akun yang
//   login yang bisa mendaftarkan perangkat. Token FCM disimpan di koleksi admin_devices (hanya Admin SDK; aturan Firestore
//   menolak semua akses klien ke koleksi ini).
// - kirimPush: mengirim satu pesan ke semua perangkat terdaftar dan membuang token yang sudah mati.
// Pesan TIDAK memuat nomor HP; hanya nama, jumlah, tanggal, jam, tempat.

const crypto = require("crypto");

const MAX_PERANGKAT_PER_AKUN = 10;
const TOKEN_RE = /^[A-Za-z0-9:_\-]{50,4096}$/;
const KODE_TOKEN_MATI = ["messaging/registration-token-not-registered", "messaging/invalid-registration-token"];  // invalid-argument sengaja tidak termasuk: bisa muncul karena muatan pesan cacat, bukan token rusak (akan menghapus semua perangkat)

function docIdUntuk(token) { return crypto.createHash("sha256").update(token).digest("hex"); }

async function authenticate(req, admin) {
  const m = String((req.get ? req.get("Authorization") : (req.headers && req.headers.authorization)) || "").match(/^Bearer (.+)$/);
  if (!m) return null;
  try {
    const d = await admin.auth().verifyIdToken(m[1], true);
    return { uid: d.uid, email: String(d.email || "").toLowerCase() };
  } catch (e) { return null; }
}

async function handleDevice(req, res, { admin, db, logger }, mode) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const who = await authenticate(req, admin);
  if (!who) { res.status(401).json({ code: "auth", message: "Perlu login." }); return; }
  const b = req.body && typeof req.body === "object" ? req.body : {};
  if (typeof b.token !== "string" || !TOKEN_RE.test(b.token)) { res.status(400).json({ code: "token", message: "Token perangkat tidak valid." }); return; }
  const id = docIdUntuk(b.token);
  try {
    if (mode === "unregister") {
      const ref = db.collection("admin_devices").doc(id);
      const snap = await ref.get();
      if (snap.exists && snap.data().uid === who.uid) await ref.delete(); // hanya pemilik yang bisa mencabut
      res.status(200).json({ ok: true });
      return;
    }
    const appVersion = typeof b.appVersion === "string" ? b.appVersion.slice(0, 20) : "";
    await db.collection("admin_devices").doc(id).set({
      token: b.token, uid: who.uid, email: who.email, platform: "android", appVersion,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    // Batasi jumlah perangkat per akun: yang paling lama dibuang.
    const mine = await db.collection("admin_devices").where("uid", "==", who.uid).get();
    if (mine.docs.length > MAX_PERANGKAT_PER_AKUN) {
      const urut = mine.docs.slice().sort((x, y) => {
        const tx = x.data().updatedAt && x.data().updatedAt.toMillis ? x.data().updatedAt.toMillis() : 0;
        const ty = y.data().updatedAt && y.data().updatedAt.toMillis ? y.data().updatedAt.toMillis() : 0;
        return tx - ty;
      });
      for (const d of urut.slice(0, mine.docs.length - MAX_PERANGKAT_PER_AKUN)) {
        if (d.id !== id) await d.ref.delete();
      }
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    if (logger) logger.error("registerDevice gagal:", e && e.message);
    res.status(502).json({ code: "server", message: "Gagal memproses." });
  }
}

function potong(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// pesan: {channel, title, body, tab}. Mengembalikan {terkirim, gagal, dibuang}. Tidak pernah melempar (aksi utama tidak boleh gagal karena push).
async function kirimPush({ admin, db, logger }, pesan) {
  const hasil = { terkirim: 0, gagal: 0, dibuang: 0 };
  try {
    const snap = await db.collection("admin_devices").limit(500).get();
    const tokens = snap.docs.map((d) => d.data().token).filter((t) => typeof t === "string" && t);
    if (!tokens.length) return hasil;
    const data = { channel: String(pesan.channel || ""), title: String(pesan.title || ""), body: String(pesan.body || ""), tab: String(pesan.tab || "") };
    const mati = [];
    for (const kelompok of potong(tokens, 500)) {
      const r = await admin.messaging().sendEachForMulticast({
        tokens: kelompok,
        data,
        notification: { title: data.title, body: data.body },
        android: { priority: "high", notification: { channelId: data.channel } }
      });
      r.responses.forEach((x, i) => {
        if (x.success) hasil.terkirim++;
        else {
          hasil.gagal++;
          if (x.error && KODE_TOKEN_MATI.includes(x.error.code)) mati.push(kelompok[i]);
        }
      });
    }
    for (const t of mati) { await db.collection("admin_devices").doc(docIdUntuk(t)).delete(); hasil.dibuang++; }
  } catch (e) {
    if (logger) logger.warn("kirimPush gagal:", e && e.message);
  }
  return hasil;
}

module.exports = { MAX_PERANGKAT_PER_AKUN, docIdUntuk, handleDevice, kirimPush };
