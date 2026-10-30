// Menjaga dua salinan logika kapasitas tetap sama: server (functions/submit.js) dan klien
// (dolansawahhomepage/assets/reservasi-core.js). Dilewati bila repo klien tidak ada di sebelah repo ini.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const S = require("../submit");

const corePath = path.resolve(__dirname, "../../../dolansawahhomepage/assets/reservasi-core.js");
const ada = fs.existsSync(corePath);

test("paritas server vs klien: sisaKapasitas sama pada 5000 kasus acak", { skip: !ada && "repo dolansawahhomepage tidak ditemukan" }, () => {
  const C = require(corePath);
  assert.equal(C.JENDELA_BENTROK_MENIT, S.JENDELA_BENTROK_MENIT);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const jamAcak = () => (rnd() < 0.1 ? "" : String(Math.floor(rnd() * 24)).padStart(2, "0") + ":" + (rnd() < 0.5 ? "00" : "30"));
  const statusAcak = () => ["", "approved", "pending", "batal", "ditolak", "kedaluwarsa", undefined][Math.floor(rnd() * 7)];
  for (let n = 0; n < 5000; n++) {
    const items = Array.from({ length: Math.floor(rnd() * 6) }, () => ({
      tempat: rnd() < 0.7 ? "A" : "B", jumlah: Math.floor(rnd() * 80), jam: jamAcak(), status: statusAcak()
    }));
    const jam = jamAcak(), kap = 20 + Math.floor(rnd() * 100), jendela = rnd() < 0.2 ? [30, 60, 1440][Math.floor(rnd() * 3)] : undefined;
    assert.deepEqual(C.sisaKapasitas(items, "A", jam, kap, jendela), S.sisaKapasitas(items, "A", jam, kap, jendela), JSON.stringify({ items, jam, kap, jendela }));
  }
});

test("salinan reservasi-core.js di reservasids sama persis dengan sumbernya (dolansawahhomepage)", { skip: !ada && "repo dolansawahhomepage tidak ditemukan" }, () => {
  const salinan = fs.readFileSync(path.resolve(__dirname, "../../reservasi-core.js"), "utf8").replace(/\r\n/g, "\n");
  const sumber = fs.readFileSync(corePath, "utf8").replace(/\r\n/g, "\n");
  assert.equal(salinan, sumber, "reservasi-core.js tidak sinkron; jalankan scripts/sync-core.sh");
});
