/* Aturan bisnis reservasi Dolan Sawah -- SATU sumber kebenaran untuk perhitungan uang.
 *
 * Dipakai di browser (<script src="assets/reservasi-core.js">, objek global ReservasiCore)
 * dan di Node (require) untuk tes. Murni: tanpa Firebase, tanpa DOM.
 *
 * Aturan (jangan diubah tanpa konfirmasi pemilik):
 *  - orderTotal & harga menu tersimpan SEBELUM PPN. PPN 10% dihitung saat ditampilkan; jangan simpan total setelah PPN.
 *  - DP normal = 50% dari (menu + PPN).
 *  - Menu penanda "OTS" / "Custom" berharga Rp 0 (BUKAN item sungguhan). Dikenali dari NAMA, bukan dari harga nol.
 *    Reservasi OTS/Custom/tanpa menu -> DP minimal Rp 200.000 (naik ke 50% bila 50%-nya lebih besar; bukan selalu 200rb).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ReservasiCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var PPN_RATE = 0.10;
  var DP_RATE = 0.5;
  var DP_MINIMUM_OTS = 200000;

  function namaUpper(m) { return String((m && m.name) || "").trim().toUpperCase(); }
  function isOtsMenu(m) { return namaUpper(m) === "OTS"; }
  // Custom = menu master "Custom" ATAU item bebas yang membawa harga sendiri (dari Asisten AI/admin).
  function isCustomMenu(m) { return namaUpper(m) === "CUSTOM" || typeof (m && m.price) === "number"; }

  function hargaItem(m, menuPrices) {
    if (typeof m.price === "number") return m.price;
    return (menuPrices && menuPrices[m.name]) || 0;
  }

  // Total sebelum PPN. Urutan: orderTotal tersimpan -> jumlah item menus -> field lama `menu` (satu nama).
  function hitungSubtotal(r, menuPrices) {
    r = r || {};
    if (typeof r.orderTotal === "number") return r.orderTotal;
    if (Array.isArray(r.menus) && r.menus.length > 0) {
      return r.menus.reduce(function (s, m) { return s + hargaItem(m, menuPrices) * (parseInt(m.quantity, 10) || 0); }, 0);
    }
    if (r.menu) return (menuPrices && menuPrices[r.menu]) || 0;
    return 0;
  }

  function hitungPpn(subtotal) { return Math.round(subtotal * PPN_RATE); }
  function hitungGrandTotal(subtotal) { return subtotal + hitungPpn(subtotal); }

  // menus: [{name, quantity, price?}]. Opsi: { ots: true } memaksa aturan OTS (mis. tempat/via mengandung "OTS").
  function estimasiDp(menus, menuPrices, opsi) {
    menus = Array.isArray(menus) ? menus : [];
    var subtotal = hitungSubtotal({ menus: menus }, menuPrices);
    var total = hitungGrandTotal(subtotal);
    var minimal = !!(opsi && opsi.ots) || menus.length === 0 || menus.some(isOtsMenu) || menus.some(isCustomMenu);
    var normal = Math.round(total * DP_RATE);
    return { subtotal: subtotal, ppn: hitungPpn(subtotal), total: total, dpNormal: normal, dp: minimal ? Math.max(DP_MINIMUM_OTS, normal) : normal, minimal: minimal };
  }

  // Status pembayaran terhadap total SETELAH PPN.
  function statusBayar(r, total) {
    var dp = Math.max(0, +(r && r.dp) || 0);
    if ((r && r.lunas === true) || (total > 0 && dp >= total)) return { kode: "lunas", label: "LUNAS", dibayar: total > 0 ? Math.max(total, dp) : dp, sisa: 0 };
    if (dp > 0) return { kode: "dp", label: "DP DIBAYAR", dibayar: dp, sisa: total > 0 ? Math.max(0, total - dp) : null };
    return { kode: "belum", label: "BELUM ADA PEMBAYARAN", dibayar: 0, sisa: total > 0 ? total : null };
  }

  // ---------- Kapasitas tempat per jendela waktu ----------
  // Keputusan pemilik (2026-10-31): tiap reservasi berlangsung 2,5 jam dan di tempat yang sama diberi jeda 2 jam, jadi dua
  // reservasi bentrok bila jam mulainya berbeda < 4,5 jam (270 menit); hanya yang bentrok dijumlahkan, bukan seharian. SALINAN dari reservasids/functions/submit.js
  // (server = penentu); reservasids/functions/test/parity-core.test.js menjaga keduanya sama.
  var DURASI_RESERVASI_MENIT = 150;
  var JEDA_ANTAR_RESERVASI_MENIT = 120;
  var JENDELA_BENTROK_MENIT = DURASI_RESERVASI_MENIT + JEDA_ANTAR_RESERVASI_MENIT;
  function menitDariJam(t) {
    var m = /^(\d{1,2}):(\d{2})/.exec(String(t || ""));
    return m ? (+m[1]) * 60 + (+m[2]) : NaN;
  }
  function sisaKapasitas(items, tempat, jam, kapasitas, jendela) {
    var w = jendela == null ? JENDELA_BENTROK_MENIT : jendela;
    var dasar = menitDariJam(jam), terpakai = 0;
    (items || []).forEach(function (it) {
      if (!it || it.tempat !== tempat || isBatal(it)) return;
      var j = menitDariJam(it.jam);
      if (isNaN(j) || isNaN(dasar) || Math.abs(j - dasar) < w) terpakai += Math.max(0, parseInt(it.jumlah, 10) || 0);
    });
    return { terpakai: terpakai, sisa: kapasitas - terpakai };
  }

  // ---------- Audit log (siapa mengubah apa) ----------
  // Dipakai dasbor admin dan kalender admin. Hanya field operasional yang disimpan beserta nilainya; data pribadi (nama,
  // nomor HP, catatan) hanya ditandai "diubah" tanpa nilai. Nomor HP tidak pernah masuk log.
  var FIELD_AUDIT = ["date", "jam", "tempat", "jumlah", "dp", "tipeDp", "status", "lunas", "orderTotal"];
  var FIELD_PRIBADI = ["nama", "nomorHp", "tambahan"];

  function ringkasMenu(ms) {
    if (!Array.isArray(ms) || !ms.length) return "";
    return ms.map(function (m) { return (m && m.name) + " x" + (m && m.quantity); }).join(", ").slice(0, 300);
  }

  function nilaiAudit(v) { return v === undefined ? null : v; }

  // aksi: tambah | ubah | hapus | setujui | tolak. sebelum/sesudah: objek reservasi (atau null).
  function buatCatatanAudit(aksi, koleksi, dokId, sebelum, sesudah, oleh) {
    var a = sebelum || {}, b = sesudah || {}, perubahan = {};
    FIELD_AUDIT.forEach(function (f) {
      var dari = nilaiAudit(a[f]), ke = nilaiAudit(b[f]);
      var beda = (dari === null || ke === null) ? dari !== ke : String(dari) !== String(ke);
      if (beda) perubahan[f] = { dari: dari, ke: ke };
    });
    var mDari = ringkasMenu(a.menus), mKe = ringkasMenu(b.menus);
    if (mDari !== mKe) perubahan.menus = { dari: mDari || null, ke: mKe || null };
    FIELD_PRIBADI.forEach(function (f) {
      if (sebelum && sesudah && String(a[f] || "") !== String(b[f] || "")) perubahan[f] = "diubah";
    });
    var acuan = sesudah || sebelum || {};
    return {
      aksi: aksi, koleksi: koleksi, dokId: String(dokId || ""),
      nama: String(acuan.nama || "").slice(0, 80), tanggal: String(acuan.date || ""),
      oleh: String(oleh || "").slice(0, 120), perubahan: perubahan
    };
  }

  // ---------- Laporan operasional ----------
  // Okupansi per tempat untuk satu bulan ("YYYY-MM"): jumlah reservasi, total tamu, rata-rata tamu per reservasi dan
  // rata-rata tamu dibanding kapasitas. kapasitas: { namaTempat: angka }. Reservasi batal/ditolak/kedaluwarsa diabaikan.
  function laporanOkupansi(reservations, kapasitas, bulan) {
    var per = {}, jam = {}, totalRes = 0, totalTamu = 0;
    (reservations || []).forEach(function (r) {
      if (!r || !r.date || String(r.date).slice(0, 7) !== bulan || isBatal(r)) return;
      var t = r.tempat || "(tanpa tempat)", n = Math.max(0, parseInt(r.jumlah, 10) || 0);
      var e = per[t] = per[t] || { tempat: t, reservasi: 0, tamu: 0 };
      e.reservasi++; e.tamu += n; totalRes++; totalTamu += n;
      if (r.jam) jam[r.jam] = (jam[r.jam] || 0) + 1;
    });
    var baris = Object.keys(per).map(function (t) {
      var e = per[t], kap = (kapasitas && kapasitas[t]) || 0;
      e.rataTamu = e.reservasi ? Math.round(e.tamu / e.reservasi) : 0;
      e.kapasitas = kap || null;
      e.okupansiPersen = kap ? Math.round(100 * e.rataTamu / kap) : null;
      return e;
    }).sort(function (a, b) { return b.tamu - a.tamu; });
    var jamTersibuk = Object.keys(jam).map(function (j) { return { jam: j, jumlah: jam[j] }; })
      .sort(function (a, b) { return b.jumlah - a.jumlah || a.jam.localeCompare(b.jam); }).slice(0, 3);
    return { baris: baris, totalReservasi: totalRes, totalTamu: totalTamu, jamTersibuk: jamTersibuk };
  }

  // Konversi permintaan tamu: hanya permintaan lewat alur baru (submitReservation) yang bisa dilacak sampai akhir;
  // reservasi disetujui dikenali dari field requestId. Permintaan lama dihapus saat disetujui, jadi tidak bisa dihitung mundur.
  function laporanKonversi(requests, reservations) {
    var c = { menunggu: 0, ditolak: 0, kedaluwarsa: 0, disetujui: 0 };
    (requests || []).forEach(function (q) {
      var s = String((q && q.status) || "pending").toLowerCase();
      if (s === "ditolak") c.ditolak++; else if (s === "kedaluwarsa") c.kedaluwarsa++; else c.menunggu++;
    });
    (reservations || []).forEach(function (r) { if (r && r.requestId) c.disetujui++; });
    c.total = c.menunggu + c.ditolak + c.kedaluwarsa + c.disetujui;
    c.persenDisetujui = c.total ? Math.round(100 * c.disetujui / c.total) : null;
    return c;
  }

  // ---------- Pengingat (dipakai panel dasbor web; aplikasi Android memakai logika yang sama) ----------
  var STATUS_BATAL = ["batal", "dibatalkan", "cancel", "cancelled", "canceled", "ditolak", "rejected", "kedaluwarsa"];
  function isBatal(r) { return STATUS_BATAL.indexOf(String((r && r.status) == null ? "" : r.status).trim().toLowerCase()) >= 0; }

  // Firestore Timestamp / {seconds} / angka -> milidetik (null bila tak ada).
  function tsMillis(t) {
    if (t == null) return null;
    if (typeof t === "number") return t;
    if (typeof t.toMillis === "function") return t.toMillis();
    if (typeof t.seconds === "number") return t.seconds * 1000;
    return null;
  }
  function ymdWib(ms) { return new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10); }
  function tambahHari(ymd, n) { return new Date(Date.parse(ymd + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10); }
  function selisihHari(ymd, hariIni) { return Math.round((Date.parse(ymd + "T00:00:00Z") - Date.parse(hariIni + "T00:00:00Z")) / 864e5); }

  var JAM_SEBELUM_KEDALUWARSA = 12; // permintaan pending diperingatkan bila sisa waktunya <= ini

  function waktuReservasi(r) { return r.jam ? Date.parse(r.date + "T" + r.jam + ":00+07:00") : NaN; }

  // reservations: dokumen reservasi disetujui; requests: reservation_requests. now: ms.
  // Mengembalikan daftar yang perlu tindakan admin (urut tanggal terdekat).
  function daftarPengingat(reservations, requests, now) {
    var hariIni = ymdWib(now);
    var out = { kedaluwarsa: [], h3: [], h1: [], terimaKasih: [] };
    (reservations || []).forEach(function (r) {
      if (!r || !r.date || isBatal(r) || !r.nomorHp) return; // tanpa nomor HP tidak bisa dikirimi WhatsApp
      var d = selisihHari(r.date, hariIni);
      var sent = r.reminders || {};
      if (d >= 2 && d <= 3) { if (!sent.h3) out.h3.push(r); }
      else if (d >= 0 && d <= 1 && !sent.h1) {
        // Pada hari H, pengingat 'kami tunggu kedatangan' hanya masuk akal bila jam reservasi belum lewat.
        var tw = waktuReservasi(r);
        if (d === 1 || isNaN(tw) || tw > now) out.h1.push(r);
      }
      // Ucapan terima kasih: 3 jam setelah jam reservasi, sampai 7 hari ke belakang (sama dengan notifikasi di kalender admin).
      if (d <= 0 && d >= -7 && r.thankYouSent !== true) {
        var t = waktuReservasi(r);
        if (!isNaN(t) && now > t + 3 * 3600000) out.terimaKasih.push(r);
      }
    });
    (requests || []).forEach(function (q) {
      if (!q || String(q.status || "pending").toLowerCase() !== "pending") return;
      var exp = tsMillis(q.expiresAt);
      if (exp == null) return; // permintaan lama tanpa batas waktu
      var sisaJam = (exp - now) / 3600000;
      if (sisaJam <= JAM_SEBELUM_KEDALUWARSA) out.kedaluwarsa.push({ req: q, sisaJam: Math.max(0, sisaJam) });
    });
    var byDate = function (a, b) { return String(a.date).localeCompare(String(b.date)) || String(a.jam || "").localeCompare(String(b.jam || "")); };
    out.h3.sort(byDate); out.h1.sort(byDate); out.terimaKasih.sort(byDate);
    out.kedaluwarsa.sort(function (a, b) { return a.sisaJam - b.sisaJam; });
    return out;
  }

  function nomorWa(hp) {
    var p = String(hp || "").replace(/\D/g, "");
    if (p.indexOf("0") === 0) p = "62" + p.slice(1);
    return p;
  }

  var LINK_TAMU = "https://www.dolansawah.my.id/reservasi.html?id=";
  function pesanPengingat(jenis, r) {
    var nama = r.nama || "Kak";
    var rinci = "📅 " + r.date + (r.jam ? ", " + r.jam : "") + "\n📍 " + (r.tempat || "-") + "\n👥 " + (r.jumlah || "-") + " orang";
    var link = LINK_TAMU + encodeURIComponent(r.id || "");
    if (jenis === "h3")
      return "Halo Kak *" + nama + "*,\n\nPengingat reservasi di *Dolan Sawah*:\n" + rinci + "\n\nPerubahan jadwal (reschedule) dan pembatalan dengan DP kembali penuh dapat dilakukan paling lambat H-3. Jika ada perubahan, mohon kabari kami hari ini ya.\n\nDetail & peraturan: " + link;
    if (jenis === "h1")
      return "Halo Kak *" + nama + "*,\n\nKami tunggu kedatangan Kakak di *Dolan Sawah*:\n" + rinci + "\n\nMohon tidak membawa makanan/minuman dari luar. Jumlah menu kami sesuaikan dengan pesanan; silakan minta petugas menghitung ulang sebelum dikonsumsi.\n\nDetail & peraturan: " + link;
    return "Halo Kak *" + nama + "*,\n\nTerima kasih banyak atas kunjungannya ke *Dolan Sawah*. Semoga Kakak dan rombongan menikmati hidangan dan suasananya. Kami tunggu kedatangan Kakak kembali!";
  }

  // ---- Deteksi item berbayar di catatan bebas, TANPA AI (instan, gratis) ----
  // Menangkap pola "nama + jumlah" ("sate ayam 30", "30 tusuk sate", "es teh x5", "tumpeng 2 tampah").
  // Jaring pengaman ketika AI sibuk/lambat, sekaligus digabung dengan hasil AI. Bukan pengganti AI:
  // permintaan tanpa angka ("tambah kerupuk") tetap mengandalkan AI.
  var SATUAN = "pcs|pc|biji|bh|buah|porsi|psi|prs|tusuk|tsk|gelas|gls|cup|botol|btl|bungkus|bks|box|dus|kotak|pack|pak|ekor|potong|ptg|kg|ons|liter|ltr|lusin|loyang|tampah|piring|mangkok|mangkuk|pkt|set|x";
  var RE_SATUAN_AWAL = new RegExp("^(" + SATUAN + ")\\b\\s*");
  var RE_SATUAN_AKHIR = new RegExp("\\s*\\b(" + SATUAN + ")$");
  var KATA_ORANG = /\b(orang|org|pax|peserta|anak|dewasa|lansia|balita|bayi|tamu|rombongan|siswa|murid|guru)\b/;
  var KATA_BUKAN_ITEM = /\b(jam|pukul|wib|menit|hari|tgl|tanggal|bulan|tahun|thn|meja|kursi|lantai|lt|nomor|no|km|meter|ultah|hp|wa|rek|rekening|dp|lunas|bayar|transfer)\b|ulang\s+tahun/;
  var KATA_PENGISI = /^(?:(?:tambah|tambahan|minta|pesan|pesen|order|request|req|mohon|tolong|plus|extra|ekstra|sama|juga|mau|ada|dengan|dan|untuk|utk|buat|ya|sekalian)\b\s*)+|\s*\b(?:(?:ya|juga|saja|aja|dong|kak|tambahan|lagi)\s*)+$/g;

  function normNama(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/(\d)([a-z])/g, "$1 $2").replace(/([a-z])(\d)/g, "$1 $2").replace(/\s+/g, " ").trim();
  }
  // Nama item tanpa angka & satuan, untuk membandingkan "sate ayam 30" dengan item custom "Sate ayam".
  function intiNama(s) {
    var t = normNama(s).replace(/\b(x)?\d+(x)?\b/g, " ").replace(/\s+/g, " ").trim();
    var lama;
    do { lama = t; t = t.replace(RE_SATUAN_AWAL, "").replace(RE_SATUAN_AKHIR, "").replace(KATA_PENGISI, "").trim(); } while (t !== lama);
    return t;
  }

  function cocokkanMenu(nama, knownMenuNames) {
    var n = normNama(nama);
    if (n.length < 3) return null;
    var kandidat = (knownMenuNames || []).filter(function (m) {
      var k = normNama(m);
      if (!k || k === "ots" || k === "custom") return false;
      return k === n || (" " + n + " ").indexOf(" " + k + " ") >= 0 || (n.length >= 4 && (" " + k + " ").indexOf(" " + n + " ") >= 0);
    });
    if (kandidat.length === 1) return kandidat[0];
    var persis = kandidat.filter(function (m) { return normNama(m) === n; });
    return persis.length === 1 ? persis[0] : null;
  }

  // note: teks catatan; knownMenuNames: nama menu master; selectedMenus: [{name, quantity}] yang sudah ada di pesanan.
  // Hasil: [{mentionedText, possibleMatch, suggestedQuantity, note, sumber: "aturan"}] (format sama dengan hasil AI).
  function deteksiItemCatatan(note, knownMenuNames, selectedMenus) {
    var sudah = (selectedMenus || []).map(function (m) { return intiNama(m && m.name); }).filter(Boolean);
    var hasil = [], dilihat = {};
    String(note || "").split(/[\n,;+&/]|\s-\s|\bdan\b/i).forEach(function (bagian) {
      var asli = bagian.trim();
      if (/\b\d{1,2}[.:]\d{2}\b/.test(asli)) return;                    // jam
      var s = " " + normNama(asli.replace(/(\d)[.,](\d{3})\b/g, "$1$2")) + " ";
      if (!/\d/.test(s)) return;
      if (/\b(rp|ribu|rb|jt|juta|k)\b/.test(s) || /\d\s*(rb|k)\b/.test(s)) return; // uang
      if (KATA_ORANG.test(s) || KATA_BUKAN_ITEM.test(s) || /\bke\s*\d/.test(s)) return;
      var angka = s.match(/\d+/g) || [];
      if (angka.length !== 1) return;                                   // dua angka atau lebih: terlalu ambigu
      var qty = parseInt(angka[0], 10);
      if (!(qty >= 1 && qty <= 999)) return;                            // nomor HP/tahun bukan jumlah
      var nama = intiNama(s);
      if (!/[a-z]{3,}/.test(nama) || nama.split(" ").length > 5) return;
      var cocok = cocokkanMenu(nama, knownMenuNames);
      var kunci = cocok ? normNama(cocok) : nama;
      if (dilihat[kunci]) return;
      var sudahAda = sudah.some(function (x) { return x === nama || x === kunci || (x.length >= 4 && (nama.indexOf(x) >= 0 || x.indexOf(nama) >= 0)); });
      if (sudahAda) return;
      dilihat[kunci] = 1;
      hasil.push({
        mentionedText: asli.slice(0, 80), possibleMatch: cocok, suggestedQuantity: qty,
        note: cocok ? "Menu ini disebut di catatan tapi belum ada di pesanan." : "Disebut dengan jumlah di catatan, kemungkinan berbayar. Isi harga bila memang dijual.",
        sumber: "aturan"
      });
    });
    return hasil;
  }

  // Gabungkan hasil AI dan hasil aturan tanpa dobel (item yang sama dari dua sumber -> satu, data AI diutamakan).
  function gabungItemCatatan(aiItems, aturanItems) {
    var out = [], kunciAda = [];
    function kunci(it) { return it.possibleMatch ? "m:" + normNama(it.possibleMatch) : "n:" + intiNama(it.mentionedText); }
    function sama(a, b) {
      if (a === b) return true;
      var x = a.slice(2), y = b.slice(2);
      return x.length >= 4 && y.length >= 4 && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0);
    }
    (aiItems || []).concat(aturanItems || []).forEach(function (it) {
      if (!it || !it.mentionedText) return;
      var k = kunci(it), i = -1;
      for (var j = 0; j < kunciAda.length; j++) if (sama(kunciAda[j], k)) { i = j; break; }
      if (i < 0) { out.push(Object.assign({}, it)); kunciAda.push(k); return; }
      if (out[i].suggestedQuantity == null && it.suggestedQuantity != null) out[i].suggestedQuantity = it.suggestedQuantity;
      if (!out[i].possibleMatch && it.possibleMatch) out[i].possibleMatch = it.possibleMatch;
    });
    return out;
  }

  // Nama rapi untuk item custom dari catatan: "Tambah sate ayam 30 tusuk ya" -> "Sate ayam" (jumlah sudah di kolom sendiri).
  function namaItemCatatan(mentionedText) {
    var n = intiNama(mentionedText);
    if (!/[a-z]{3,}/.test(n)) return String(mentionedText || "").trim();
    return n.charAt(0).toUpperCase() + n.slice(1);
  }

  return {
    deteksiItemCatatan: deteksiItemCatatan, gabungItemCatatan: gabungItemCatatan, intiNama: intiNama, namaItemCatatan: namaItemCatatan,
    PPN_RATE: PPN_RATE, DP_RATE: DP_RATE, DP_MINIMUM_OTS: DP_MINIMUM_OTS,
    isOtsMenu: isOtsMenu, isCustomMenu: isCustomMenu,
    hitungSubtotal: hitungSubtotal, hitungPpn: hitungPpn, hitungGrandTotal: hitungGrandTotal,
    estimasiDp: estimasiDp, statusBayar: statusBayar,
    isBatal: isBatal, tsMillis: tsMillis, ymdWib: ymdWib, tambahHari: tambahHari, selisihHari: selisihHari,
    daftarPengingat: daftarPengingat, nomorWa: nomorWa, pesanPengingat: pesanPengingat,
    buatCatatanAudit: buatCatatanAudit, laporanOkupansi: laporanOkupansi, laporanKonversi: laporanKonversi,
    DURASI_RESERVASI_MENIT: DURASI_RESERVASI_MENIT, JEDA_ANTAR_RESERVASI_MENIT: JEDA_ANTAR_RESERVASI_MENIT, JENDELA_BENTROK_MENIT: JENDELA_BENTROK_MENIT, menitDariJam: menitDariJam, sisaKapasitas: sisaKapasitas
  };
});
