/**
 * lib/filesource.js
 * ------------------------------------------------------------------
 * Abstraksi sumber isi file agar push bisa jalan di dua mode:
 *   - MODE DISK      (VPS / localhost)  : file hasil ekstrak di folder kerja
 *   - MODE MEMORI    (Vercel serverless): buffer di RAM, sekali jalan
 *
 * pushFiles() memakai item.content (Buffer) bila ada, selain itu baca
 * dari item.absPath. Dengan begitu tidak ada perubahan besar di github.js.
 * ------------------------------------------------------------------
 */
const fsp = require('fs').promises;

/** Ambil isi file: dari memori bila tersedia, kalau tidak dari disk. */
async function getContent(item) {
  if (item.content) return item.content;
  if (item.absPath) return fsp.readFile(item.absPath);
  throw new Error(`File "${item.path}" tidak punya sumber data (content/absPath).`);
}

/** base64 untuk payload blob GitHub */
async function getContentBase64(item) {
  return (await getContent(item)).toString('base64');
}

/** Ringkasan untuk dikirim ke browser (tanpa isi file). */
function summarizeForClient(files) {
  return files.map((f) => ({ path: f.path, size: f.size, mode: f.mode }));
}

/** Hitung total ukuran */
function totalSize(files) {
  return files.reduce((a, f) => a + (f.size || (f.content ? f.content.length : 0)), 0);
}

module.exports = { getContent, getContentBase64, summarizeForClient, totalSize };
