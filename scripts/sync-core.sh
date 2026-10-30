#!/usr/bin/env bash
# Menyalin modul aturan bisnis bersama dari repo dolansawahhomepage (sumber) ke repo ini.
# Jalankan setiap kali dolansawahhomepage/assets/reservasi-core.js berubah, lalu commit reservasi-core.js di sini.
set -eu
SRC="$(cd "$(dirname "$0")/../.." && pwd)/dolansawahhomepage/assets/reservasi-core.js"
cp "$SRC" "$(dirname "$0")/../reservasi-core.js"
cp "$SRC" "$(dirname "$0")/../functions/reservasi-core.js"
echo "Disalin dari $SRC"
