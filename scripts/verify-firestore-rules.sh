#!/usr/bin/env bash
# Memeriksa aturan Firestore project reservasi-dolan-sawah dari sisi PENGUNJUNG ANONIM (tanpa login).
# Hanya membaca KODE STATUS HTTP; isi respons tidak pernah dicetak (data tamu tidak boleh bocor ke log).
# Tidak menulis apa pun. Jalankan sebelum dan sesudah menerbitkan aturan baru.
#
#   bash scripts/verify-firestore-rules.sh
#
# Hasil yang DIHARAPKAN setelah aturan baru terbit:
#   LIST reservations / reservation_requests  -> 403  (daftar data tamu tertutup)
#   GET dokumen reservations (ID acak)        -> 200 atau 404  (halaman tamu reservasi.html tetap jalan)
#   LIST menus / locations / date_status      -> 200  (form publik masih butuh)
#   fungsi publicAvailability                 -> 200  (ketersediaan tanpa data pribadi)
set -u
PROJECT="reservasi-dolan-sawah"
DB="https://firestore.googleapis.com/v1/projects/$PROJECT/databases/(default)/documents"
FN="https://asia-southeast2-$PROJECT.cloudfunctions.net"
TODAY="$(date -u +%F)"

code() { curl -s -m 25 -o /dev/null -w "%{http_code}" "$1"; }
cek() { # nama, url, kode-yang-diharapkan (dipisah |)
  local got; got="$(code "$2")"
  if [[ "|$3|" == *"|$got|"* ]]; then printf "OK     %-46s %s\n" "$1" "$got"; else printf "GAGAL  %-46s %s (diharapkan %s)\n" "$1" "$got" "$3"; FAIL=1; fi
}
FAIL=0
cek "LIST reservations (anonim)"              "$DB/reservations?pageSize=1"            "403"
cek "LIST reservation_requests (anonim)"      "$DB/reservation_requests?pageSize=1"    "403"
cek "GET reservations/<ID fiktif> (anonim)"   "$DB/reservations/ZZZZZZZZZZZZZZZZZZZZ"  "200|404"
cek "LIST menus (anonim)"                     "$DB/menus?pageSize=1"                   "200"
cek "LIST locations (anonim)"                 "$DB/locations?pageSize=1"               "200"
cek "LIST date_status (anonim)"               "$DB/date_status?pageSize=1"             "200"
cek "fungsi publicAvailability"               "$FN/publicAvailability?from=$TODAY&to=$TODAY" "200"
cek "fungsi reservationStatus (id fiktif)"    "$FN/reservationStatus?id=ZZZZZZZZZZZZZZZZZZZZ" "404"
[[ $FAIL -eq 0 ]] && echo "Semua pemeriksaan sesuai harapan." || echo "Ada yang tidak sesuai harapan (lihat GAGAL di atas)."
exit $FAIL
