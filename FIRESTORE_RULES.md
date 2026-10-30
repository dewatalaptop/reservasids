# Aturan Firestore project `reservasi-dolan-sawah` — menutup baca publik data tamu

## STATUS 2026-10-30 — semua klien sudah siap, aturan BELUM diterbitkan
Pemeriksaan anonim (`bash scripts/verify-firestore-rules.sh`, hanya membaca kode status) menunjukkan **daftar `reservations`
dan `reservation_requests` masih bisa dibaca siapa pun tanpa login** (nama + nomor HP tamu terbuka). Yang sudah live dan membuat
penutupan ini aman:

| Pembaca/penulis | Cara sekarang |
|---|---|
| Form tamu `reservasimandiri.html`, `pesantempat.html` | ketersediaan lewat fungsi `publicAvailability`; kirim permintaan lewat fungsi `submitReservation` (Admin SDK) |
| Pelacak tamu `reservasi.html?r=` | fungsi `reservationStatus` (tanpa data pribadi) |
| Halaman tamu `reservasi.html?id=` | `get` satu dokumen `reservations` (ID acak) — tetap diizinkan |
| Dasbor admin, kalender admin, papan staf | login Firebase Auth |
| Fungsi AI, `dolan-sawah-ai` | Admin SDK (mengabaikan aturan) |

Efek samping yang diterima: halaman lama yang masih tersimpan di cache browser tamu (form versi V9) akan gagal mengirim sampai dimuat ulang
(GitHub Pages meng-cache sekitar 10 menit). Salinan lama di repo `testwebsite1` akan rusak bila dipakai.

### Prosedur terbit (urut, ±5 menit)
1. Firebase Console → Firestore → Rules. **Salin seluruh aturan yang berlaku sekarang** ke berkas aman (cadangan; tombol riwayat juga menyimpannya).
2. Ubah HANYA dua blok di bawah (bagian "Perubahan aturan"). Untuk `reservation_requests` pakai `allow create: if false;` — hanya fungsi
   `submitReservation` yang menulis; form publik tidak lagi menulis langsung. Sisanya jangan diubah.
3. Terbitkan (Publish).
4. Jalankan `bash scripts/verify-firestore-rules.sh` — semua baris harus OK (LIST reservations/reservation_requests = 403).
5. Uji manual: (a) buka form reservasi mandiri dan kirim satu permintaan uji → harus berhasil dan muncul di inbox admin; (b) buka tautan pelacak yang
   muncul; (c) login di dasbor admin: inbox, kalender, Pengingat tetap terisi; (d) buka satu `reservasi.html?id=<ID valid>`.
6. Bila ada yang rusak: Console → Rules → riwayat → pulihkan versi lama (satu klik). Tidak ada data yang berubah oleh aturan.

### Opsi pengetatan tambahan (disarankan)
`request.auth != null` berarti SIAPA PUN yang punya akun Firebase Auth lolos. Bila pendaftaran mandiri terbuka di Authentication → Settings,
orang asing bisa membuat akun lalu membaca semua reservasi. Pilih salah satu:
- tutup pendaftaran mandiri (Authentication → Settings → User actions → matikan "Enable create (sign-up)"), atau
- batasi dengan daftar email staf di aturan, mis. `request.auth.token.email in ['admin1@…', 'admin2@…']` (ganti dengan email staf sebenarnya).

## Masalahnya
Koleksi `reservations` dan `reservation_requests` dulu bisa dibaca siapa saja tanpa login
(nama, nomor HP, menu, catatan, DP). Halaman publik membacanya langsung dari browser,
dan dua papan staf (`ds-information-board.html`, `upgradeteam.html`) juga tanpa login.

## Yang sudah diubah di kode (harus live SEBELUM aturan diterbitkan)
| Pembaca | Sebelum | Sesudah |
|---|---|---|
| `pesantempat.html` (publik) | baca `reservations` langsung | fungsi `publicAvailability` (hanya tanggal, jam, tempat, jumlah) |
| `reservasimandiri.html` (publik) | baca `reservations` + `reservation_requests` | fungsi `publicAvailability` |
| `ds-information-board.html`, `upgradeteam.html` (staf) | tanpa login | wajib login email/password staf |
| `reservasi.html` (halaman tamu) | `get` satu dokumen berdasarkan ID acak | tidak berubah (tetap `get`) |
| `upgradeV2.html`, `index.html`, `5672231.html`, `test-reservasi` (admin) | sudah login | tidak berubah |
| `dolan-sawah-ai` (fungsi lintas project, Admin SDK) | mengabaikan aturan | tidak berubah |

## Urutan rilis (jangan dibalik)
1. Deploy fungsi: `firebase deploy --only functions:publicAvailability` (dari folder `reservasids`).
2. Push `dolansawahhomepage` (pesantempat + reservasimandiri) dan `reservasids` (dua papan staf).
3. Pastikan staf sudah login sekali di layar dapur/kasir (sesi tersimpan di perangkat).
4. **Terakhir**: terbitkan aturan di Firebase Console → Firestore → Rules.

## Perubahan aturan (hanya dua blok ini; sisanya jangan diubah)
```
match /reservations/{id} {
  allow get: if true;                       // halaman tamu reservasi.html (ID dokumen acak)
  allow list: if request.auth != null;      // admin & papan staf
  allow create, update, delete: if request.auth != null;   // samakan dengan aturan tulis yang berlaku sekarang
}
match /reservation_requests/{id} {
  allow create: if false;                   // hanya fungsi submitReservation (Admin SDK) yang menulis; form publik tidak menulis langsung
  allow read, update, delete: if request.auth != null;
}
```
Catatan:
- Salin aturan **tulis/validasi yang sudah ada**; blok di atas hanya menunjukkan bagian baca yang berubah.
- `request.auth != null` berarti siapa pun yang punya akun Firebase Auth. Pastikan di Console → Authentication →
  Settings, pendaftaran mandiri tidak dibuka, atau batasi dengan daftar email staf.
- Uji setelah terbit (tanpa login): `reservasi.html?id=<id valid>` masih terbuka; `pesantempat.html` dan
  `reservasimandiri.html` menampilkan ketersediaan; membaca daftar `reservations` lewat REST anonim harus 403.
- Rollback cepat bila ada yang rusak: kembalikan aturan lama dari tombol riwayat di Console.

## Efek yang perlu diketahui
- `pesantempat.html` tidak lagi menampilkan nama, nomor HP, menu, dan catatan tamu lain; hanya "Reservasi 1, 2…" dengan jam dan jumlah tamu.
- Reservasi berstatus batal tidak lagi dihitung di kapasitas publik.
- Salinan lama di repo `testwebsite1` (reservasimandiri, 5672231, DS-ops) masih membaca langsung dan akan rusak
  bila dipakai setelah aturan terbit.
