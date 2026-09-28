#!/usr/bin/env node
/**
 * cli/push.js — push folder atau ZIP ke repository GitHub lewat terminal
 * ------------------------------------------------------------------
 * Tidak butuh `git`. Cukup Personal Access Token (scope `repo`).
 *
 * Contoh:
 *   node cli/push.js ./dist --repo saya/web --branch gh-pages
 *   node cli/push.js ./proyek.zip --repo saya/web --dest assets --strip-root
 *   node cli/push.js ./src --repo saya/web --branch fitur/x --create-branch --base main
 *   node cli/push.js ./dist --repo saya/web --dry-run
 *
 * Token: --token=ghp_xxx  atau  env GITHUB_TOKEN  atau  file .env
 * ------------------------------------------------------------------
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { extractZip, shouldExclude, detectCommonRoot } = require('../lib/extractor');
// lib/github membaca GITHUB_API_URL saat dimuat -> require dilakukan setelah arg diproses
let GitHub = null;

const C = { r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', r2: '\x1b[31m', c: '\x1b[36m' };

function parseArgs(argv) {
  const out = { _: [] };
  const norm = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        out[norm(a.slice(2, eq))] = a.slice(eq + 1);
      } else {
        const key = norm(a.slice(2));
        const next = argv[i + 1];
        // "--repo owner/nama" (nilai terpisah) atau "--dry-run" (flag boolean)
        if (next !== undefined && !next.startsWith('-')) { out[key] = next; i++; }
        else out[key] = true;
      }
    } else out._.push(a);
  }
  return out;
}

function help() {
  console.log(`${C.b}github-zip-pusher CLI${C.r} — push folder/ZIP ke repo GitHub tanpa git

${C.b}Pakai:${C.r}
  node cli/push.js <folder|file.zip> [opsi]

${C.b}Opsi:${C.r}
  --repo=owner/nama          Repository tujuan            ${C.y}(wajib)${C.r}
                             (boleh juga: --repo owner/nama)
  --branch=nama              Branch tujuan                ${C.y}(wajib)${C.r}
  --dest=path/dalam/repo     Folder tujuan (default: root)
  --message="pesan commit"   Pesan commit
  --token=ghp_xxx            GitHub PAT (atau env GITHUB_TOKEN / .env)
  --base=main                Branch basis saat membuat branch baru
  --create-branch            Buat branch baru bila belum ada
  --strip-root / --no-strip-root   Buang folder pembungkus ZIP (default: ya)
  --no-overwrite             Gagal bila file tujuan sudah ada
  --delete-existing          Hapus file lama di folder tujuan yang tak terupload
  --include-node-modules     Jangan filter node_modules/.git/dist/build/dsb
  --dry-run                  Tampilkan rencana saja, tidak push
  --concurrency=5            Jumlah upload paralel (1-10)
  --api-url=URL              Untuk GitHub Enterprise Server
  -h, --help                 Bantuan ini
`);
}

async function walkDir(dir, base = dir, out = []) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (e.isDirectory()) await walkDir(abs, base, out);
    else if (e.isFile()) {
      const st = await fsp.stat(abs);
      out.push({ path: rel, absPath: abs, size: st.size, mode: st.mode & 0o111 ? 0o755 : 0o644 });
    }
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h || !args._.length) return help();

  const target = path.resolve(args._[0]);
  const repo = String(args.repo || '');
  const branch = String(args.branch || '');
  const destPath = String(args.dest || '').replace(/^\/+|\/+$/g, '');
  const message = String(args.message || `Upload ${path.basename(target)} via CLI (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`);
  const token = String(args.token || process.env.GITHUB_TOKEN || '').trim();

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return console.error(`${C.r2}✖ --repo wajib diisi dengan format owner/nama-repo${C.r}`), process.exit(1);
  if (!branch) return console.error(`${C.r2}✖ --branch wajib diisi${C.r}`), process.exit(1);
  if (!fs.existsSync(target)) return console.error(`${C.r2}✖ Path tidak ditemukan: ${target}${C.r}`), process.exit(1);
  if (args.concurrency) process.env.GITHUB_CONCURRENCY = String(args.concurrency);
  if (args.apiUrl) process.env.GITHUB_API_URL = String(args.apiUrl);
  ({ GitHub } = require('../lib/github'));

  if (!token) {
    console.error(`${C.r2}✖ Token GitHub belum ada.${C.r}
  Buat PAT: ${C.c}https://github.com/settings/tokens/new?scopes=repo${C.r}
  Lalu: ${C.b}export GITHUB_TOKEN=ghp_xxx${C.r}  atau  ${C.b}--token=ghp_xxx${C.r}  atau isi di ${C.b}.env${C.r}`);
    process.exit(1);
  }

  /* ---- kumpulkan file ---- */
  const isZip = fs.statSync(target).isFile() && /\.zip$/i.test(target);
  const stripRoot = args.stripRoot !== false && args.noStripRoot !== true;
  const keepAll = !!args.includeNodeModules;
  const opts = {
    stripRoot,
    maxFiles: Number(args.maxFiles || 20000),
    ...(keepAll ? { excludeDirs: [], excludeFiles: [], excludeGlobs: [] } : {}),
  };
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gzp-cli-'));

  let files = [];
  let root = null;
  console.log(`${C.b}▶ Sumber:${C.r} ${target} ${C.dim}(${isZip ? 'arsip ZIP' : 'folder'})${C.r}`);

  if (isZip) {
    const res = await extractZip(target, tmp, {
      ...opts,
      // keepAll: ekstrak apa adanya tanpa filter bawaan
      ...(keepAll ? { excludeDirs: ['__tidak_ada__'] } : {}),
      onProgress: (d, t) => process.stdout.write(`\r  mengekstrak… ${d}/${t}`),
    });
    files = res.files; root = res.root;
    console.log(`\r  ekstrak selesai: ${files.length} file${root ? ` (folder "${root}" dibuang)` : ''}          `);
  } else {
    const all = await walkDir(target);
    const paths = all.map((f) => f.path);
    root = stripRoot ? detectCommonRoot(paths) : null;
    for (const f of all) {
      const rel = root ? f.path.slice(root.length + 1) : f.path;
      if (!rel) continue;
      if (!keepAll && shouldExclude(rel, opts)) continue;
      files.push({ ...f, path: rel });
    }
    console.log(`  terbaca: ${files.length} file${all.length !== files.length ? ` ${C.dim}(${all.length - files.length} dilewati: node_modules/.git/dist/dsb)${C.r}` : ''}`);
  }

  if (!files.length) {
    console.error(`${C.r2}✖ Tidak ada file untuk di-push.${C.r}`);
    await fsp.rm(tmp, { recursive: true, force: true });
    process.exit(1);
  }

  const bytes = files.reduce((a, f) => a + f.size, 0);
  const tooBig = files.filter((f) => f.size > 100 * 1024 * 1024);
  if (tooBig.length) {
    console.error(`${C.r2}✖ File > 100 MB tidak didukung GitHub API:${C.r} ${tooBig.map((f) => f.path).join(', ')}`);
    process.exit(1);
  }

  console.log(`${C.b}▶ Tujuan:${C.r} ${C.c}${repo}${C.r} @ ${C.c}${branch}${C.r}${destPath ? '/' + destPath : ''}`);
  console.log(`  ${files.length} file · ${(bytes / 1048576).toFixed(2)} MB · pesan: "${message}"`);

  if (args.dryRun) {
    console.log(`\n${C.y}DRY-RUN — tidak ada yang dikirim ke GitHub.${C.r}`);
    files.slice(0, 40).forEach((f) => console.log(`  ${C.dim}📄${C.r} ${destPath ? destPath + '/' : ''}${f.path}`));
    if (files.length > 40) console.log(`  ${C.dim}… +${files.length - 40} file lainnya${C.r}`);
    await fsp.rm(tmp, { recursive: true, force: true });
    return;
  }

  /* ---- push ---- */
  const gh = new GitHub(token);
  try {
    const me = await gh.me();
    console.log(`  login sebagai ${C.b}${me.login}${C.r} ${C.dim}(scope: ${me.scopes.join(', ') || '-'})${C.r}`);
  } catch (e) {
    console.error(`${C.r2}✖ Token tidak valid:${C.r} ${e.message}`); process.exit(1);
  }

  const t0 = Date.now();
  try {
    const res = await gh.pushFiles({
      owner: repo.split('/')[0],
      repo: repo.split('/')[1],
      branch, destPath, message, files,
      createBranch: !!args.createBranch || args.createBranch === '',
      baseBranch: args.base ? String(args.base) : null,
      overwrite: args.overwrite !== false && args.noOverwrite !== true,
      deleteExisting: !!args.deleteExisting,
      onProgress: (stage, d) => {
        const label = {
          start: 'menyiapkan commit…',
          blobs: `mengunggah blob ${d.done}/${d.total}…`,
          tree: 'menyusun tree…',
          commit: 'membuat commit…',
          ref: d.createBranch ? 'membuat branch…' : 'memperbarui branch…',
          done: 'selesai.',
          warn: '⚠ ' + (d.message || ''),
        }[stage] || stage;
        process.stdout.write(`\r  ${label}        `);
      },
    });
    console.log(`\r  ${' '.repeat(50)}\r${C.g}✔ Berhasil${C.r} commit ${C.b}${res.shortSha}${C.r} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (res.branchCreated) console.log(`  ${C.g}+${C.r} branch baru dibuat: ${C.b}${res.branch}${C.r}`);
    if (res.overwritten.length) console.log(`  ${C.y}~${C.r} ${res.overwritten.length} file ditimpa`);
    if (res.removed.length) console.log(`  ${C.y}-${C.r} ${res.removed.length} file lama dihapus`);
    console.log(`  ${C.c}${res.commitUrl}${C.r}`);
    console.log(`  ${C.c}${res.treeUrl}${C.r}`);
  } catch (e) {
    console.error(`\n${C.r2}✖ Push gagal:${C.r} ${e.message}`);
    if (e.status === 404) console.error(`  ${C.dim}Petunjuk: repo/branch tidak ada, atau token tidak punya scope 'repo'.${C.r}`);
    if (e.status === 422 || e.status === 409) console.error(`  ${C.dim}Petunjuk: branch mungkin dilindungi (protected). Coba --branch lain atau --create-branch.${C.r}`);
    if (e.status === 403) console.error(`  ${C.dim}Petunjuk: rate limit atau izin ditolak.${C.r}`);
    process.exitCode = 1;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
})();
