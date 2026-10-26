# Aturan Firestore project `reservasi-dolan-sawah` — menutup baca publik data tamu

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
  allow create: if true;                    // form publik; pertahankan validasi field yang sudah ada
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
