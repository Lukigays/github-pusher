/**
 * api/index.js — titik masuk Vercel (serverless function).
 * ------------------------------------------------------------------
 * Seluruh aplikasi Express di server.js dipakai apa adanya; vercel.json
 * meneruskan semua path (/*) ke fungsi ini.
 *
 * Catatan penting untuk Vercel:
 *   - Tidak ada disk persisten  -> ekstrak & push terjadi di memori,
 *     dalam SATU request (endpoint /api/push-upload).
 *   - Body maks 4,5 MB          -> ZIP/folder kecil saja; file besar pakai CLI.
 *   - SESSION_SECRET WAJIB di-set di Dashboard → Settings → Environment
 *     Variables, kalau tidak login tidak akan "menempel" antar-request.
 */
const app = require('../server');

module.exports = app;
