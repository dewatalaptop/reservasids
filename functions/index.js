const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");

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

// Coba Gemini dulu, jatuh ke z.ai kalau limit (429) atau error server (5xx).
// Mengembalikan { ok, status, data } supaya pemanggil tidak perlu tahu
// provider mana yang akhirnya menjawab.
async function callAiWithFallback(body) {
  const geminiRes = await callGemini(body);
  if (geminiRes.status === 429 || geminiRes.status >= 500) {
    logger.warn(`AI proxy: Gemini gagal (${geminiRes.status}), coba fallback ke z.ai.`);
    const zaiRes = await callZai(body);
    const zaiData = await zaiRes.json();
    if (!zaiRes.ok) logger.error(`AI proxy: z.ai juga gagal (${zaiRes.status}):`, JSON.stringify(zaiData));
    return { ok: zaiRes.ok, status: zaiRes.status, data: zaiData };
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

async function analyzeTambahanWithAi({ tambahan, knownMenuNames, existingMenus }) {
  if (!tambahan || !tambahan.trim()) return { items: [] };

  const selectedMenuNames = (existingMenus || []).map((m) => m.name);
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
    temperature: 0.1
  };

  const { ok, data } = await callAiWithFallback(body);
  if (!ok) return { items: [], error: "AI tidak bisa diakses saat ini." };

  const content = data?.choices?.[0]?.message?.content;
  const parsed = extractJsonFromAiText(content);
  if (!parsed || !Array.isArray(parsed.items)) {
    return { items: [], error: "Jawaban AI tidak bisa dibaca." };
  }
  return parsed;
}

exports.checkReservationCompleteness = onRequest(
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
