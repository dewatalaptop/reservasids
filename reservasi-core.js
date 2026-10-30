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

  return {
    PPN_RATE: PPN_RATE, DP_RATE: DP_RATE, DP_MINIMUM_OTS: DP_MINIMUM_OTS,
    isOtsMenu: isOtsMenu, isCustomMenu: isCustomMenu,
    hitungSubtotal: hitungSubtotal, hitungPpn: hitungPpn, hitungGrandTotal: hitungGrandTotal,
    estimasiDp: estimasiDp, statusBayar: statusBayar,
    isBatal: isBatal, tsMillis: tsMillis, ymdWib: ymdWib, tambahHari: tambahHari, selisihHari: selisihHari,
    daftarPengingat: daftarPengingat, nomorWa: nomorWa, pesanPengingat: pesanPengingat,
    buatCatatanAudit: buatCatatanAudit,
    DURASI_RESERVASI_MENIT: DURASI_RESERVASI_MENIT, JEDA_ANTAR_RESERVASI_MENIT: JEDA_ANTAR_RESERVASI_MENIT, JENDELA_BENTROK_MENIT: JENDELA_BENTROK_MENIT, menitDariJam: menitDariJam, sisaKapasitas: sisaKapasitas
  };
});
