/**
 * api/index.js — titik masuk Vercel (serverless function).
 * ------------------------------------------------------------------
 * Seluruh aplikasi Express di server.js dipakai apa adanya; vercel.json
 * meneruskan semua path ke fungsi ini.
 *
 * Wrapper di bawah sengaja ada: bila module GAGAL dimuat (dependensi hilang,
 * file tidak ikut ter-bundle, dsb.), fungsi tetap menjawab dengan JSON
 * berisi pesan + stack error, BUKAN halaman error Vercel yang kosong.
 * Jadi masalah bisa dibaca langsung dari browser/HP:  https://domain/api/...
 *
 * Catatan penting untuk Vercel:
 *   - Tidak ada disk persisten  -> ekstrak & push terjadi di memori,
 *     dalam SATU request (endpoint /api/push-upload).
 *   - Body maks 4,5 MB          -> ZIP/folder kecil saja; file besar pakai CLI.
 *   - SESSION_SECRET disarankan di-set (Dashboard -> Settings -> Environment
 *     Variables). Bila kosong aplikasi TETAP hidup dengan rahasia sementara
 *     (login bisa ter-reset tiap cold start) + peringatan di /api/health.
 */
let app = null;
let bootError = null;
try {
  app = require('../server');
} catch (err) {
  bootError = err;
}

module.exports = function handler(req, res) {
  if (bootError) {
    const body = JSON.stringify({
      error: 'Aplikasi gagal dimuat di dalam fungsi Vercel',
      message: bootError && bootError.message,
      stack: bootError && bootError.stack,
      hint: 'Periksa Runtime Logs Vercel. Penyebab umum: dependensi tidak terpasang ' +
            '(package.json tidak ter-commit), atau file lib/ & public/ tidak ikut ' +
            'ter-bundle (cek includeFiles di vercel.json dan .vercelignore).',
      node: process.version,
      region: process.env.VERCEL_REGION || null,
    });
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(body);
    return;
  }
  return app(req, res);
};
