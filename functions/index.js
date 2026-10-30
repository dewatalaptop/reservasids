const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const crypto = require("crypto");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { handleBoard } = require("./board");
const { handleDevice, kirimPush } = require("./devices");
const { pesanPermintaanBaru, jalankanRingkasanPagi, jalankanPeringatanKedaluwarsa } = require("./push");
const { STATUS_BATAL, LIMITS, isCancelled, sisaKapasitas, cekAturanTempat, validateRequest } = require("./submit");

admin.initializeApp();

// dewatalaptop.github.io -> app reservasids (kalender admin). www/apex
// dolansawah.my.id -> dashboard admin (dolansawahhomepage), custom domain
// via CNAME tapi tetap dilayani GitHub Pages sehingga github.io-nya juga
// bisa diakses langsung -- keduanya diizinkan supaya tidak putus kalau
// diakses lewat salah satu.
const ALLOWED_ORIGINS = [
  "https://dewatalaptop.github.io",
  "https://www.dolansawah.my.id",
  "https://dolansawah.my.id",
  /^http:\/\/localhost:\d+$/
];
const REGION = "asia-southeast2";

async function verifyFirebaseAuth(req) {
  const header = req.get("Authorization") || "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) throw new Error("Missing Authorization header");
  await admin.auth().verifyIdToken(match[1]);
}

// ============================================================
// Proxy AI bersama (Gemini utama, z.ai fallback) -- pola yang sama
// persis dipakai di proyek dolan-sawah-ai supaya API key asli tidak
// pernah ikut ter-bundle ke JS publik di GitHub Pages. Dipakai oleh
// chatCompletions (chat bebas) dan checkReservationCompleteness
// (pengecekan kelengkapan data reservasi).
//
// Key TIDAK diduplikasi ke project ini. Secret GEMINI_API_KEY dan
// ZAI_API_KEY yang SUDAH ADA di project dolan-sawah-ai-2026 dipakai
// langsung lintas-project via Secret Manager API saat runtime --
// service account default Cloud Functions project ini diberi role
// "Secret Manager Secret Accessor" khusus pada 2 secret tsb di
// dolan-sawah-ai-2026 (lihat catatan IAM di README/memory). Jadi
// tidak perlu `firebase functions:secrets:set` sama sekali di sini,
// dan tidak ada key baru yang perlu dibuat/disalin manual.
// ============================================================

const SHARED_SECRETS_PROJECT = "dolan-sawah-ai-2026";
const secretClient = new SecretManagerServiceClient();
const secretCache = {};

async function getSharedSecret(name) {
  if (secretCache[name]) return secretCache[name];
  try {
    const [version] = await secretClient.accessSecretVersion({
      name: `projects/${SHARED_SECRETS_PROJECT}/secrets/${name}/versions/latest`
    });
    const value = version.payload.data.toString("utf8");
    secretCache[name] = value;
    return value;
  } catch (err) {
    logger.error(`getSharedSecret(${name}) gagal mengambil dari project ${SHARED_SECRETS_PROJECT}:`, err.message);
    throw err;
  }
}

const AI_MAX_TOKENS = 2000;
const ZAI_FALLBACK_MODEL = "glm-4.5-flash";
const GEMINI_MODEL = "gemini-3.6-flash";

async function callGemini(body) {
  const apiKey = await getSharedSecret("GEMINI_API_KEY");
  return fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
}

async function callZai(body) {
  const apiKey = await getSharedSecret("ZAI_API_KEY");
  return fetch("https://api.z.ai/api/paas/v4/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ ...body, model: ZAI_FALLBACK_MODEL })
  });
}

// ============================================================
// Tetap 100% gratis (tidak upgrade billing) -- jadi pertahanan yang relevan
// di sini BUKAN soal biaya, tapi soal kecepatan: begitu Gemini kena limit
// harian gratisnya (429), kemungkinan besar akan 429 lagi untuk permintaan
// berikutnya sampai kuota reset (harian). Daripada tiap panggilan baru
// tetap nunggu Gemini gagal dulu (buang waktu) sebelum jatuh ke z.ai,
// begitu 429 terjadi kita "ingat" untuk sementara dan langsung ke z.ai.
//
// In-memory per instance warm (bukan Firestore) -- ini sengaja: cukup untuk
// tujuannya (skip percobaan yang hampir pasti gagal) dan tidak menambah
// round-trip database di jalur tercepat. minInstances:1 membuat sebagian
// besar traffic tetap kena instance yang sama sehingga cooldown ini efektif.
// ============================================================
const GEMINI_COOLDOWN_MS = 30 * 60 * 1000; // 30 menit
let geminiRateLimitedUntil = 0;

async function callZaiOnly(body) {
  const zaiRes = await callZai(body);
  const zaiData = await zaiRes.json();
  if (!zaiRes.ok) logger.error(`AI proxy: z.ai gagal (${zaiRes.status}):`, JSON.stringify(zaiData));
  return { ok: zaiRes.ok, status: zaiRes.status, data: zaiData };
}

// Coba Gemini dulu, jatuh ke z.ai kalau limit (429), error server (5xx),
// atau masih dalam jendela cooldown sejak 429 terakhir. Mengembalikan
// { ok, status, data } supaya pemanggil tidak perlu tahu provider mana
// yang akhirnya menjawab.
async function callAiWithFallback(body) {
  if (Date.now() < geminiRateLimitedUntil) {
    logger.info("AI proxy: masih cooldown rate-limit Gemini, langsung z.ai.");
    return callZaiOnly(body);
  }

  const geminiRes = await callGemini(body);
  if (geminiRes.status === 429 || geminiRes.status >= 500) {
    if (geminiRes.status === 429) geminiRateLimitedUntil = Date.now() + GEMINI_COOLDOWN_MS;
    logger.warn(`AI proxy: Gemini gagal (${geminiRes.status}), coba fallback ke z.ai.`);
    return callZaiOnly(body);
  }
  if (!geminiRes.ok) {
    const errText = await geminiRes.clone().text();
    logger.error(`AI proxy: Gemini gagal (${geminiRes.status}), TIDAK fallback (bukan 429/5xx):`, errText);
  }
  const data = await geminiRes.json();
  return { ok: geminiRes.ok, status: geminiRes.status, data };
}

// chatCompletions: proxy chat bebas format OpenAI-compatible, dipakai
// untuk fitur AI lain di masa depan (mis. panel tanya-jawab staf).
// Diproteksi login admin (verifyFirebaseAuth) karena beda dari proyek
// dolan-sawah-ai yang publik -- app ini murni internal admin.
exports.chatCompletions = onRequest(
  {
    region: REGION,
    cors: ALLOWED_ORIGINS
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      await verifyFirebaseAuth(req);
    } catch (err) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      const { status, data } = await callAiWithFallback(req.body);
      res.status(status).json(data);
    } catch (err) {
      logger.error("chatCompletions gagal:", err);
      res.status(502).json({ error: "Proxy ke AI gagal" });
    }
  }
);

// ============================================================
// checkReservationCompleteness: asisten AI aktif untuk kelengkapan
// data reservasi. Dipanggil client SEBELUM simpan (non-blocking --
// hasil hanya peringatan, staf tetap bisa lanjut simpan).
//
// Dua lapis pemeriksaan:
// 1. Rule-based (instan, gratis) -- field wajib yang kosong/tidak
//    konsisten. Sama sekali tidak butuh AI, dihitung di sini supaya
//    client tidak perlu duplikasi logic ini.
// 2. AI (Gemini/z.ai) -- HANYA untuk membaca teks bebas "tambahan"
//    (request tambahan) dan mendeteksi apakah menyebut item yang
//    kemungkinan berbayar tapi belum masuk ke paket menu terstruktur
//    (sumber masalah asli: staf nulis "tambah kerupuk 20" di catatan
//    bebas, harga tidak pernah ke-input, orderTotal jadi kurang).
//    AI diberi daftar nama menu yang benar-benar ada di koleksi
//    `menus` supaya bisa mencocokkan (fuzzy) alih-alih menebak bebas.
// ============================================================

function buildRuleFlags({ reservation, capacity }) {
  const flags = [];
  const r = reservation || {};

  if (!r.nomorHp) {
    flags.push({
      field: "nomorHp",
      severity: "warning",
      message: "Nomor HP kosong -- tidak bisa kirim konfirmasi/ucapan terima kasih via WhatsApp."
    });
  }

  if ((r.dp || 0) > 0 && !r.tipeDp) {
    flags.push({
      field: "tipeDp",
      severity: "warning",
      message: "DP diisi tapi tipe pembayaran DP belum dipilih."
    });
  }

  if (!Array.isArray(r.menus) || r.menus.length === 0) {
    flags.push({
      field: "menus",
      severity: "warning",
      message: "Belum ada paket menu dipilih -- estimasi total akan Rp0."
    });
  }

  if (typeof capacity === "number" && r.jumlah && r.jumlah > capacity) {
    flags.push({
      field: "jumlah",
      severity: "warning",
      message: `Jumlah peserta (${r.jumlah}) melebihi kapasitas tempat (${capacity} orang).`
    });
  }

  return flags;
}

function extractJsonFromAiText(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json\s*|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

// Cache in-memory per instance warm (bukan lintas instance/persisten) --
// kalau catatan+konteks menu yang SAMA persis dicek ulang dalam waktu dekat
// (mis. admin klik Chat lalu langsung Terima pada request yang sama), jawaban
// lama dipakai lagi tanpa memanggil Gemini/z.ai ulang. TTL pendek supaya tidak
// menyembunyikan perubahan harga/menu master yang baru saja di-update admin.
const aiResultCache = new Map();
const AI_CACHE_TTL_MS = 5 * 60 * 1000;
const AI_CACHE_MAX_ENTRIES = 200;

function buildAiCacheKey(tambahan, knownMenuNames, selectedMenuNames) {
  return JSON.stringify([
    tambahan,
    (knownMenuNames || []).slice().sort(),
    (selectedMenuNames || []).slice().sort()
  ]);
}

async function analyzeTambahanWithAi({ tambahan, knownMenuNames, existingMenus }) {
  if (!tambahan || !tambahan.trim()) return { items: [] };

  const selectedMenuNames = (existingMenus || []).map((m) => m.name);

  const cacheKey = buildAiCacheKey(tambahan, knownMenuNames, selectedMenuNames);
  const cached = aiResultCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < AI_CACHE_TTL_MS) {
    logger.info("checkReservationCompleteness: cache hit, skip panggilan AI.");
    return cached.result;
  }
  const systemPrompt = `Kamu asisten admin restoran/tempat reservasi bernama Dolan Sawah.
Tugasmu HANYA membaca catatan "Request Tambahan" (teks bebas dari staf/pelanggan) dan
mendeteksi apakah ada permintaan barang/menu tambahan yang KEMUNGKINAN berbayar tapi
belum dimasukkan sebagai paket menu terstruktur (sehingga tidak ikut terhitung harga).

Daftar nama menu yang SAH ada di sistem (cocokkan ke sini kalau relevan): ${JSON.stringify(knownMenuNames || [])}
Menu yang SUDAH dipilih di reservasi ini: ${JSON.stringify(selectedMenuNames)}

Balas HANYA dengan JSON valid, tanpa markdown, format persis:
{"items": [{"mentionedText": "kutipan singkat dari catatan", "possibleMatch": "nama menu dari daftar sah jika cocok, atau null", "suggestedQuantity": angka jumlah yang disebutkan di catatan (mis. "kerupuk 20pcs" -> 20, "es teh 5 gelas" -> 5), atau null kalau tidak disebutkan, "note": "penjelasan singkat kenapa ini perlu dicek staf"}]}
Kalau catatan hanya berisi permintaan non-berbayar (misal: "tolong tidak pedas", "dekat pintu masuk", "request ulang tahun tanpa tambahan barang"), balas {"items": []}.
Jangan mengarang menu yang tidak ada di daftar sah. Kalau tidak yakin ada di daftar, isi possibleMatch: null.`;

  const body = {
    model: GEMINI_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Catatan Request Tambahan: "${tambahan}"` }
    ],
    temperature: 0.1,
    // Jawaban JSON-nya pendek, TAPI model Gemini memakai token "berpikir" tersembunyi yang ikut dihitung dalam batas ini
    // (terukur 2026-10-30: 14 token terlihat + ~400 token berpikir = terpotong di 400, finish_reason "length", JSON tak terbaca,
    // sehingga item tambahan di catatan tidak pernah terdeteksi). Batas 2000 menghasilkan jawaban lengkap.
    max_tokens: AI_MAX_TOKENS
  };

  const { ok, data } = await callAiWithFallback(body);
  if (!ok) return { items: [], error: "AI tidak bisa diakses saat ini." };

  const content = data?.choices?.[0]?.message?.content;
  const parsed = extractJsonFromAiText(content);
  if (!parsed || !Array.isArray(parsed.items)) {
    return { items: [], error: "Jawaban AI tidak bisa dibaca." };
  }

  if (aiResultCache.size >= AI_CACHE_MAX_ENTRIES) {
    const oldestKey = aiResultCache.keys().next().value;
    aiResultCache.delete(oldestKey);
  }
  aiResultCache.set(cacheKey, { result: parsed, at: Date.now() });

  return parsed;
}

exports.checkReservationCompleteness = onRequest(
  {
    region: REGION,
    cors: ALLOWED_ORIGINS,
    // minInstances sengaja TIDAK dipakai: 1 instance siaga 24 jam menghabiskan sekitar Rp 40-55 ribu/bulan (lebih besar dari
    // seluruh budget project). Konsekuensinya: panggilan pertama setelah lama sepi bisa 1-3 detik lebih lambat (cold start).
    memory: "256MiB"
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      await verifyFirebaseAuth(req);
    } catch (err) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      const { reservation, capacity, knownMenuNames } = req.body || {};
      if (!reservation) {
        res.status(400).json({ error: "Field 'reservation' wajib diisi." });
        return;
      }

      const ruleFlags = buildRuleFlags({ reservation, capacity });

      let aiResult = { items: [] };
      try {
        aiResult = await analyzeTambahanWithAi({
          tambahan: reservation.tambahan,
          knownMenuNames,
          existingMenus: reservation.menus
        });
      } catch (err) {
        logger.error("checkReservationCompleteness: analisis AI gagal:", err);
        aiResult = { items: [], error: "Analisis AI gagal, cek manual saja." };
      }

      res.status(200).json({ ruleFlags, tambahanAnalysis: aiResult });
    } catch (err) {
      logger.error("checkReservationCompleteness gagal:", err);
      res.status(502).json({ error: "Gagal memeriksa kelengkapan reservasi" });
    }
  }
);

// ============================================================
// publicAvailability: ketersediaan tempat TANPA data pribadi.
//
// Halaman publik (pesantempat.html, reservasimandiri.html) dulu membaca
// koleksi reservations/reservation_requests langsung dari browser, sehingga
// nama, nomor HP, menu, dan catatan semua tamu terbaca siapa saja. Fungsi ini
// membaca lewat Admin SDK dan hanya mengembalikan field yang aman:
// tanggal, jam, tempat, jumlah tamu, jenis (confirmed/pending). Dengan begitu
// aturan Firestore boleh menutup baca publik (list) pada kedua koleksi itu.
// ============================================================
const AVAIL_MAX_DAYS = 62;
const AVAIL_MAX_DOCS = 3000;
const CANCELLED_STATUSES = STATUS_BATAL;

function isIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function toAvailabilityItems(snap, kind) {
  const out = [];
  snap.forEach((doc) => {
    const x = doc.data() || {};
    if (CANCELLED_STATUSES.includes(String(x.status == null ? "" : x.status).trim().toLowerCase())) return;
    out.push({
      date: String(x.date || ""),
      jam: typeof x.jam === "string" ? x.jam.slice(0, 5) : "",
      tempat: String(x.tempat || "").slice(0, 100),
      jumlah: Math.max(0, parseInt(x.jumlah, 10) || 0),
      kind
    });
  });
  return out;
}

exports.publicAvailability = onRequest(
  {
    region: REGION,
    cors: ALLOWED_ORIGINS,
    memory: "256MiB",
    maxInstances: 5
  },
  async (req, res) => {
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    const from = String(req.query.from || "");
    const to = String(req.query.to || req.query.from || "");
    if (!isIsoDate(from) || !isIsoDate(to) || from > to) {
      res.status(400).json({ error: "Parameter from/to harus YYYY-MM-DD dan from <= to." });
      return;
    }
    const spanDays = (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 864e5;
    if (spanDays > AVAIL_MAX_DAYS) {
      res.status(400).json({ error: `Rentang maksimal ${AVAIL_MAX_DAYS} hari.` });
      return;
    }
    try {
      const db = admin.firestore();
      const q = (col) => db.collection(col).where("date", ">=", from).where("date", "<=", to).limit(AVAIL_MAX_DOCS).get();
      const [confirmed, pending] = await Promise.all([q("reservations"), q("reservation_requests")]);
      res.set("Cache-Control", "public, max-age=10, s-maxage=10");
      res.status(200).json({ items: [...toAvailabilityItems(confirmed, "confirmed"), ...toAvailabilityItems(pending, "pending")] });
    } catch (err) {
      logger.error("publicAvailability gagal:", err);
      res.status(502).json({ error: "Gagal memuat ketersediaan." });
    }
  }
);


// ============================================================
// submitReservation: satu-satunya jalan tamu mengirim permintaan reservasi.
//
// Sebelumnya form publik mengecek kapasitas di browser lalu menulis langsung
// ke reservation_requests. Dua tamu yang mengirim bersamaan sama-sama lolos
// (balapan), dan siapa pun bisa menulis permintaan palsu yang menahan kursi.
// Di sini: validasi isi, cek tanggal ditutup, kapasitas, duplikat, dan batas
// laju dilakukan di server dalam SATU transaksi.
// ============================================================
class SubmitError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function findLocation(tx, db, tempat) {
  for (const col of ["locations", "Locations"]) {
    const snap = await tx.get(db.collection(col).where("name", "==", tempat).limit(1));
    if (!snap.empty) return snap.docs[0].data();
  }
  return null;
}

async function submitReservationHandler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const v = validateRequest(req.body);
  if (!v.ok) {
    res.status(v.code === "spam" ? 403 : 400).json({ code: v.code, message: v.message });
    return;
  }
  const d = v.data;
  const db = admin.firestore();
  // Di Cloud Run, req.ip bisa berupa IP proxy Google. Elemen TERAKHIR X-Forwarded-For ditambahkan oleh infrastruktur Google
  // (yang pertama bisa dipalsukan klien), jadi itu yang dipakai; req.ip hanya cadangan.
  const xff = String((req.headers && req.headers["x-forwarded-for"]) || "").split(",").map((x) => x.trim()).filter(Boolean);
  const clientIp = xff.length ? xff[xff.length - 1] : String(req.ip || "unknown");
  const ipHash = crypto.createHash("sha256").update(clientIp).digest("hex").slice(0, 24);
  const hourKey = new Date().toISOString().slice(0, 13);
  const rlRef = db.collection("rate_limits").doc(`${ipHash}_${hourKey}`);
  const reqRef = db.collection("reservation_requests").doc();

  try {
    await db.runTransaction(async (tx) => {
      // Semua pembacaan dulu, baru penulisan (aturan transaksi Firestore).
      const [rlSnap, loc, closedSnap, confirmedSnap, pendingSnap, menusSnap] = await Promise.all([
        tx.get(rlRef),
        findLocation(tx, db, d.tempat),
        tx.get(db.collection("date_status").where("date", "==", d.date)),
        tx.get(db.collection("reservations").where("date", "==", d.date)),
        tx.get(db.collection("reservation_requests").where("date", "==", d.date)),
        d.menus.length ? tx.get(db.collection("menus")) : Promise.resolve(null)
      ]);

      if ((rlSnap.exists ? rlSnap.data().n : 0) >= LIMITS.maxPerJamPerIp) {
        throw new SubmitError(429, "terlalu_sering", "Terlalu banyak permintaan. Coba lagi satu jam lagi atau hubungi admin via WhatsApp.");
      }
      if (!loc) throw new SubmitError(400, "tempat", "Tempat tidak ditemukan.");
      if (closedSnap.docs.some((x) => x.data().isFull === true)) {
        throw new SubmitError(409, "ditutup", "Tanggal ini sudah ditutup oleh admin.");
      }
      if (menusSnap) {
        // Di koleksi menus, NAMA menu adalah ID dokumen (field hanya price); field name tidak ada di data nyata.
      const known = new Set(menusSnap.docs.flatMap((x) => [String(x.id).trim(), String(x.data().name || "").trim()]).filter(Boolean));
        const unknown = d.menus.find((m) => !known.has(m.name));
        if (unknown) throw new SubmitError(400, "menus", `Menu "${unknown.name}" tidak dikenal.`);
      }

      const pendingDocs = pendingSnap.docs.map((x) => x.data());
      const mine = pendingDocs.filter((x) => x.nomorHp === d.nomorHp && !isCancelled(x));
      const approvedSame = confirmedSnap.docs.some((x) => { const y = x.data(); return y.nomorHp === d.nomorHp && y.tempat === d.tempat && !isCancelled(y); });
      if (approvedSame || mine.some((x) => x.tempat === d.tempat)) {
        throw new SubmitError(409, "duplikat", "Permintaan/reservasi untuk tanggal dan tempat ini sudah kami terima. Admin akan menghubungi WhatsApp Anda.");
      }
      if (mine.length >= LIMITS.maxPendingPerNomor) {
        throw new SubmitError(429, "terlalu_sering", "Permintaan dari nomor ini sudah banyak yang menunggu. Hubungi admin via WhatsApp.");
      }

      const capParsed = parseInt(loc.capacity, 10);
      const capacity = Number.isFinite(capParsed) ? capParsed : 50; // data kapasitas kosong/rusak -> bawaan 50, bukan tak terbatas
      const semuaHariItu = [...confirmedSnap.docs.map((x) => x.data()), ...pendingDocs];
      const aturan = cekAturanTempat(semuaHariItu, d.tempat, d.jumlah);
      if (aturan) throw new SubmitError(409, aturan.code, aturan.message);
      // Kapasitas per jendela waktu (reservasi yang jamnya berdekatan), bukan jumlah seharian.
      const { sisa: remaining } = sisaKapasitas(semuaHariItu, d.tempat, d.jam, capacity);
      if (remaining < d.jumlah) {
        throw new SubmitError(409, "kapasitas_penuh", `Tempat "${d.tempat}" pada jam ${d.jam} (reservasi berdurasi 2,5 jam dengan jeda 2 jam antar reservasi) sudah tidak tersedia untuk ${d.jumlah} orang (sisa ${Math.max(0, remaining)}). Silakan pilih tempat atau jam lain.`);
      }

      tx.set(rlRef, { n: (rlSnap.exists ? rlSnap.data().n : 0) + 1, expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + 2 * 3600 * 1000) });
      tx.create(reqRef, {
        ...d,
        status: "pending",
        via: "Web App V10",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + LIMITS.pendingTtlJam * 3600 * 1000)
      });
    });
    // Beri tahu admin lewat push (tidak boleh menggagalkan atau menunda lama respons ke tamu).
    try {
      await Promise.race([
        kirimPush({ admin, db, logger }, pesanPermintaanBaru(d)),
        new Promise((resolve) => setTimeout(resolve, 4000))
      ]);
    } catch (e) { logger.warn("push permintaan baru gagal:", e && e.message); }
    res.status(200).json({ ok: true, id: reqRef.id });
  } catch (err) {
    if (err instanceof SubmitError) {
      res.status(err.status).json({ code: err.code, message: err.message });
      return;
    }
    logger.error("submitReservation gagal:", err);
    res.status(502).json({ code: "server", message: "Gagal mengirim permintaan. Silakan coba lagi." });
  }
}

exports.submitReservation = onRequest(
  {
    region: REGION,
    cors: ALLOWED_ORIGINS,
    memory: "256MiB",
    maxInstances: 10
  },
  submitReservationHandler
);
exports._submitReservationHandler = submitReservationHandler; // untuk tes
exports._analyzeTambahanWithAi = analyzeTambahanWithAi; // untuk tes

// ============================================================
// expirePendingRequests: permintaan yang tidak diproses admin dalam
// pendingTtlJam dilepas dari kapasitas (status -> kedaluwarsa), bukan dihapus,
// supaya tamu masih bisa melihat statusnya. Hanya dokumen yang punya
// expiresAt (dibuat lewat submitReservation); permintaan lama tidak disentuh.
// Query satu field saja (tanpa indeks gabungan); status disaring di kode.
// ============================================================
async function expirePendingHandler() {
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();
  let last = null, expired = 0;
  // Berhalaman: dokumen non-pending yang masih punya expiresAt lampau tidak boleh menutup jalan pending (limit 400 tanpa halaman).
  for (let page = 0; page < 25; page++) {
    let q = db.collection("reservation_requests").where("expiresAt", "<=", now).orderBy("expiresAt").limit(400);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    last = snap.docs[snap.docs.length - 1];
    for (const x of snap.docs) {
      if (String(x.data().status || "").toLowerCase() !== "pending") continue;
      // Cek ulang status di dalam transaksi: admin mungkin baru saja menyetujui/menolak/menghapusnya.
      const done = await db.runTransaction(async (tx) => {
        const cur = await tx.get(x.ref);
        if (!cur.exists || String(cur.data().status || "").toLowerCase() !== "pending") return false;
        tx.update(x.ref, { status: "kedaluwarsa", expiredAt: admin.firestore.FieldValue.serverTimestamp(), expiresAt: admin.firestore.FieldValue.delete() });
        return true;
      });
      if (done) expired++;
    }
    if (snap.size < 400) break;
  }
  if (expired) logger.info(`expirePendingRequests: ${expired} permintaan kedaluwarsa`);
  return expired;
}

exports.expirePendingRequests = onSchedule(
  { region: REGION, schedule: "every 60 minutes", timeZone: "Asia/Jakarta", memory: "256MiB" },
  expirePendingHandler
);
exports._expirePendingHandler = expirePendingHandler; // untuk tes

// Bersihkan penghitung batas laju yang sudah lewat (cukup 1 kali sehari).
exports.cleanupRateLimits = onSchedule(
  { region: REGION, schedule: "every 24 hours", timeZone: "Asia/Jakarta", memory: "256MiB" },
  async () => {
    const db = admin.firestore();
    const snap = await db.collection("rate_limits").where("expireAt", "<=", admin.firestore.Timestamp.now()).limit(400).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((x) => batch.delete(x.ref));
    await batch.commit();
  }
);

// ============================================================
// reservationStatus: tamu melihat status permintaannya lewat ID permintaan
// (dikirim balik oleh submitReservation). Koleksi reservation_requests tidak
// boleh dibaca publik, jadi hanya field aman yang dikembalikan: tanggal, jam,
// tempat, jumlah, nama, status. Tanpa nomor HP, menu, atau catatan.
// ============================================================
async function reservationStatusHandler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const id = String(req.query.id || "");
  if (!/^[A-Za-z0-9]{15,40}$/.test(id)) {
    res.status(400).json({ code: "id", message: "Tautan tidak valid." });
    return;
  }
  try {
    const db = admin.firestore();
    res.set("Cache-Control", "no-store");
    const pick = (x) => ({ date: String(x.date || ""), jam: String(x.jam || "").slice(0, 5), tempat: String(x.tempat || "").slice(0, 100), jumlah: Math.max(0, parseInt(x.jumlah, 10) || 0), nama: String(x.nama || "").slice(0, 80) });

    const reqSnap = await db.collection("reservation_requests").doc(id).get();
    if (reqSnap.exists) {
      const x = reqSnap.data() || {};
      const s = String(x.status || "pending").toLowerCase();
      const status = s === "ditolak" ? "ditolak" : s === "kedaluwarsa" ? "kedaluwarsa" : "menunggu";
      res.status(200).json({ status, ...pick(x) });
      return;
    }
    // Sudah disetujui: dokumen permintaan dihapus, reservasi menyimpan requestId.
    const ok = await db.collection("reservations").where("requestId", "==", id).limit(1).get();
    if (!ok.empty) {
      const doc = ok.docs[0];
      const x = doc.data() || {};
      const batal = isCancelled(x);
      res.status(200).json({ status: batal ? "dibatalkan" : "disetujui", reservationId: batal ? null : doc.id, ...pick(x) });
      return;
    }
    res.status(404).json({ code: "tidak_ada", message: "Permintaan tidak ditemukan." });
  } catch (err) {
    logger.error("reservationStatus gagal:", err);
    res.status(502).json({ code: "server", message: "Gagal memuat status." });
  }
}

exports.reservationStatus = onRequest(
  { region: REGION, cors: ALLOWED_ORIGINS, memory: "256MiB", maxInstances: 5 },
  reservationStatusHandler
);
exports._reservationStatusHandler = reservationStatusHandler; // untuk tes

// ============================================================
// boardReservations: data untuk papan karyawan (ds-information-board.html, upgradeteam.html) TANPA login.
// Hanya kolom yang dipakai papan; tanpa nomor HP. Logika: functions/board.js.
// ============================================================
exports.boardReservations = onRequest(
  { region: REGION, cors: ALLOWED_ORIGINS, memory: "256MiB", maxInstances: 5 },
  (req, res) => handleBoard(req, res, { admin, logger })
);

// ============================================================
// Notifikasi untuk aplikasi Android admin.
//  - registerDevice / unregisterDevice: aplikasi mendaftarkan token FCM dengan token login admin.
//  - pengingatPagi: tiap 07:00 WIB, ringkasan hari ini + jumlah pengingat H-3/H-1/terima kasih + permintaan hampir kedaluwarsa.
//  - peringatanKedaluwarsa: tiap jam, peringatan SEKALI untuk permintaan yang sisa waktunya <= 6 jam.
// Permintaan baru dikirim langsung dari submitReservation. Logika: functions/devices.js, functions/push.js.
// ============================================================
exports.registerDevice = onRequest(
  { region: REGION, cors: ALLOWED_ORIGINS, memory: "256MiB", maxInstances: 3 },
  (req, res) => handleDevice(req, res, { admin, db: admin.firestore(), logger }, "register")
);
exports.unregisterDevice = onRequest(
  { region: REGION, cors: ALLOWED_ORIGINS, memory: "256MiB", maxInstances: 3 },
  (req, res) => handleDevice(req, res, { admin, db: admin.firestore(), logger }, "unregister")
);
exports.pengingatPagi = onSchedule(
  { region: REGION, schedule: "0 7 * * *", timeZone: "Asia/Jakarta", memory: "256MiB" },
  async () => {
    const hasil = await jalankanRingkasanPagi({ admin, db: admin.firestore(), logger });
    logger.info("pengingatPagi:", JSON.stringify(hasil));
  }
);
exports.peringatanKedaluwarsa = onSchedule(
  { region: REGION, schedule: "every 60 minutes", timeZone: "Asia/Jakarta", memory: "256MiB" },
  async () => {
    const hasil = await jalankanPeringatanKedaluwarsa({ admin, db: admin.firestore(), logger });
    if (hasil.dikirim) logger.info("peringatanKedaluwarsa:", JSON.stringify(hasil));
  }
);
