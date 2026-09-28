/**
 * lib/extractor.js
 * ------------------------------------------------------------------
 * Menangani 2 sumber file:
 *   1. File ZIP  -> diekstrak (aman dari zip-slip) memakai `yauzl`
 *   2. Folder    -> hasil upload <input webkitdirectory> / drag & drop
 *
 * Output keduanya seragam:
 *   { files: [{ path, absPath, size, mode }], root, totalSize, ... }
 * ------------------------------------------------------------------
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const yauzl = require('yauzl');
const { decodeZipName } = require('./codepage');

/* Folder/file yang umumnya tidak perlu ikut ter-push */
const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode', '.next', '.nuxt',
  '.cache', '.parcel-cache', '.turbo', '.venv', 'venv', 'env', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.ruff_cache', 'dist', 'build',
  'out', 'target', 'coverage', '.gradle', '.terraform', '.terraform.lock.hcl',
  'vendor', '.angular', '.svelte-kit', '.output', 'bin', 'obj',
]);

const DEFAULT_EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.env.local']);

/** glob super sederhana: *.log, *.tmp, file?.txt */
function minimatchLite(name, pattern) {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return re.test(name);
}

function shouldExclude(relPath, opts = {}) {
  const excludeDirs = new Set([...DEFAULT_EXCLUDE_DIRS, ...(opts.excludeDirs || [])]);
  const excludeFiles = new Set([...DEFAULT_EXCLUDE_FILES, ...(opts.excludeFiles || [])]);
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length - 1; i++) if (excludeDirs.has(parts[i])) return true;
  const base = parts[parts.length - 1];
  if (excludeFiles.has(base)) return true;
  if ((opts.excludeGlobs || []).some((g) => minimatchLite(base, g))) return true;
  return false;
}

/**
 * Normalisasi & pengamanan path entri (anti zip-slip / absolute path).
 * @returns {string|null} path relatif dengan separator '/', null bila harus dilewati
 */
function sanitizeEntryPath(rawName) {
  if (typeof rawName !== 'string' || rawName.length === 0) return null;
  let name = rawName.replace(/\\/g, '/');
  name = name.replace(/^[a-zA-Z]:\//, '').replace(/^\/+/, '');   // drive letter & leading slash
  const parts = name.split('/').filter((p) => p.length > 0);
  if (parts.some((p) => p === '..')) return null;                  // usaha keluar dari folder tujuan
  if (!parts.length) return null;
  return parts.join('/');
}

/** Deteksi 1 folder pembungkus (mis. zip unduhan GitHub: repo-main/...) */
function detectCommonRoot(paths) {
  if (!paths.length) return null;
  const idx = paths[0].indexOf('/');
  if (idx === -1) return null;
  const root = paths[0].slice(0, idx);
  return paths.every((p) => p.startsWith(root + '/')) ? root : null;
}

/**
 * Decode nama entri ZIP.
 * yauzl dipanggil dengan decodeStrings:false sehingga entry.fileName berupa Buffer.
 * - flag UTF-8 (bit 11) hidup      -> UTF-8
 * - ada extra field "up" (0x75)    -> ambil nama UTF-8 dari situ
 * - bytes valid UTF-8              -> UTF-8
 * - selain itu                     -> codepage (default cp850, bisa windows-1252/shift_jis/…)
 */
function decodeEntryName(entry, codepage) {
  const up = (entry.extraFields || []).find((f) => f.id === 0x75);
  if (up && up.data && up.data.length > 5) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(up.data.subarray(5));
    } catch (_) { /* jatuh ke path biasa */ }
  }
  const buf = Buffer.isBuffer(entry.fileName)
    ? entry.fileName
    : Buffer.from(String(entry.fileName), 'latin1');
  return decodeZipName(buf, { utf8Flag: (entry.generalPurposeBitFlag & 0x800) !== 0, codepage });
}

/**
 * Ekstrak file ZIP ke direktori tujuan.
 * @param {string} zipPath
 * @param {string} destDir
 * @param {object} opts
 *   stripRoot, excludeDirs, excludeFiles, excludeGlobs, codepage,
 *   maxFiles, maxTotalSize, maxEntrySize, onProgress(done,total)
 */
async function extractZip(zipPath, destDir, opts = {}) {
  await fsp.mkdir(destDir, { recursive: true });
  return extractZipCore(await yauzl.openPromise(zipPath, zipOpenOptions()), destDir, opts);
}

/**
 * Versi serverless: ZIP berupa Buffer (multer memoryStorage) dan hasilnya
 * tetap di memori (Buffer) — tidak menulis apa pun ke disk.
 */
async function extractZipBuffer(zipBuffer, opts = {}) {
  return extractZipCore(await yauzl.fromBufferPromise(zipBuffer, zipOpenOptions()), null, { ...opts, inMemory: true });
}

function zipOpenOptions() {
  return {
    autoClose: false,
    lazyEntries: true,
    decodeStrings: false,   // nama file kita decode sendiri (lihat decodeEntryName)
    validateEntrySizes: true,
    strictFileNames: false,
  };
}

/** Inti ekstraksi: ke disk (destDir) atau ke memori (opts.inMemory). */
async function extractZipCore(zipfile, destDir, opts = {}) {
  const {
    stripRoot = true,
    maxFiles = 20000,
    maxTotalSize = 4 * 1024 * 1024 * 1024,
    maxEntrySize = 100 * 1024 * 1024,
    inMemory = false,
    onProgress,
  } = opts;

  try {
    /* ---- Tahap 1: baca entri, saring, hitung ---- */
    const planned = [];
    let entryCount = 0;
    let totalSize = 0;

    for await (const entry of zipfile.eachEntry()) {
      entryCount++;
      if (entryCount > maxFiles) throw new Error(`Jumlah entri ZIP melebihi batas (${maxFiles}).`);

      const name = decodeEntryName(entry, opts.codepage);
      if (name.endsWith('/')) continue;                                   // folder eksplisit
      if (entry.isEncrypted && entry.isEncrypted()) {
        throw new Error(`File "${name}" di ZIP terenkripsi (berpassword) — tidak bisa di-push ke GitHub.`);
      }
      if ((((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000)) continue; // symlink

      const rel = sanitizeEntryPath(name);
      if (!rel) continue;
      if (shouldExclude(rel, opts)) continue;

      if (entry.uncompressedSize > maxEntrySize) {
        throw new Error(`File "${rel}" berukuran ${(entry.uncompressedSize / 1048576).toFixed(1)} MB, melebihi batas ${Math.round(maxEntrySize / 1048576)} MB (batas API GitHub).`);
      }
      totalSize += entry.uncompressedSize;
      if (totalSize > maxTotalSize) throw new Error('Total ukuran hasil ekstrak melebihi batas yang diizinkan.');

      planned.push({ entry, rel });
    }

    /* ---- Tahap 2: buang folder pembungkus bila ada ---- */
    const root = stripRoot ? detectCommonRoot(planned.map((p) => p.rel)) : null;
    const finalList = planned
      .map((p) => {
        const rel = root ? p.rel.slice(root.length + 1) : p.rel;
        return rel ? { entry: p.entry, rel } : null;
      })
      .filter(Boolean);

    /* ---- Tahap 3: tulis ke disk ATAU simpan di memori ---- */
    const files = [];
    let done = 0;
    for (const item of finalList) {
      const readStream = await zipfile.openReadStreamPromise(item.entry);
      const content = await streamToBuffer(readStream);
      const unixMode = (item.entry.externalFileAttributes >>> 16) & 0o7777;
      const executable = (unixMode & 0o111) !== 0 || /\.(sh|bash|py|pl|rb|phar)$/i.test(item.rel);

      if (inMemory) {
        files.push({ path: item.rel, content, size: content.length, mode: executable ? 0o755 : 0o644 });
      } else {
        const outPath = path.join(destDir, item.rel);
        await fsp.mkdir(path.dirname(outPath), { recursive: true });
        await fsp.writeFile(outPath, content);
        if (executable) await fsp.chmod(outPath, 0o755);
        const stat = await fsp.stat(outPath);
        files.push({ path: item.rel, absPath: outPath, size: stat.size, mode: executable ? 0o755 : 0o644 });
      }

      done++;
      if (onProgress && (done % 25 === 0 || done === finalList.length)) onProgress(done, finalList.length);
    }

    return {
      files,
      root,
      entryCount,
      skipped: entryCount - finalList.length,
      totalSize: files.reduce((a, f) => a + f.size, 0),
    };
  } finally {
    zipfile.close();
  }
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Salin folder hasil upload (multer) ke direktori kerja, susun daftar file.
 * @param {Array} uploadedFiles - req.files: [{ originalname, path }]
 * @param {object} opts - { stripRoot, relPaths, excludeDirs, excludeFiles, onProgress }
 *   relPaths: array path relatif dari browser (cadangan bila originalname tanpa path)
 */
async function collectFolder(uploadedFiles, destDir, opts = {}) {
  await fsp.mkdir(destDir, { recursive: true });
  const records = (uploadedFiles || []).filter(Boolean);
  if (!records.length) return { files: [], root: null, totalSize: 0, skipped: 0 };

  const relPaths = Array.isArray(opts.relPaths) && opts.relPaths.length === records.length ? opts.relPaths : null;
  const list = records
    .map((f, i) => {
      // 1) pakai relPaths dari browser bila ada, 2) fallback ke originalname (preservePath)
      const candidates = [relPaths && relPaths[i], f.originalname, f.filename];
      for (const c of candidates) {
        const rel = sanitizeEntryPath(c);
        if (rel) return { src: f.path, rel };
      }
      return null;
    })
    .filter(Boolean);

  // webkitdirectory mengirim "namaFolder/sub/file.txt" -> buang folder pembungkusnya
  const root = opts.stripRoot === false ? null : detectCommonRoot(list.map((l) => l.rel));
  const files = [];
  let skipped = 0;
  let i = 0;
  for (const item of list) {
    const rel = root ? item.rel.slice(root.length + 1) : item.rel;
    if (!rel || shouldExclude(rel, opts)) { skipped++; continue; }
    const outPath = path.join(destDir, rel);
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.copyFile(item.src, outPath);
    const stat = await fsp.stat(outPath);
    const executable = (stat.mode & 0o111) !== 0 || /\.(sh|bash|py|pl|rb|phar)$/i.test(rel);
    files.push({ path: rel, absPath: outPath, size: stat.size, mode: executable ? 0o755 : 0o644 });
    i++;
    if (opts.onProgress && (i % 25 === 0 || i === list.length)) opts.onProgress(i, list.length);
  }
  return { files, root, skipped, totalSize: files.reduce((a, f) => a + f.size, 0) };
}

/**
 * Versi serverless untuk upload folder: file berupa Buffer di memori
 * (multer memoryStorage) -> tidak menulis ke disk.
 * @param {Array} uploadedFiles - [{ originalname, buffer }]
 * @param {object} opts - { stripRoot, relPaths, onProgress }
 */
function collectFolderMemory(uploadedFiles, opts = {}) {
  const records = (uploadedFiles || []).filter(Boolean);
  if (!records.length) return { files: [], root: null, totalSize: 0, skipped: 0 };

  const relPaths = Array.isArray(opts.relPaths) && opts.relPaths.length === records.length ? opts.relPaths : null;
  const list = records
    .map((f, i) => {
      for (const c of [relPaths && relPaths[i], f.originalname, f.filename]) {
        const rel = sanitizeEntryPath(c);
        if (rel) return { content: f.buffer, rel };
      }
      return null;
    })
    .filter(Boolean);

  const root = opts.stripRoot === false ? null : detectCommonRoot(list.map((l) => l.rel));
  const files = [];
  let skipped = 0;
  for (const item of list) {
    const rel = root ? item.rel.slice(root.length + 1) : item.rel;
    if (!rel || shouldExclude(rel, opts)) { skipped++; continue; }
    const executable = /\.(sh|bash|py|pl|rb|phar)$/i.test(rel);
    files.push({ path: rel, content: item.content, size: item.content.length, mode: executable ? 0o755 : 0o644 });
  }
  return { files, root, skipped, totalSize: files.reduce((a, f) => a + f.size, 0) };
}

module.exports = {
  extractZip, extractZipBuffer, collectFolder, collectFolderMemory,
  sanitizeEntryPath, shouldExclude, detectCommonRoot, decodeEntryName, DEFAULT_EXCLUDE_DIRS,
};
