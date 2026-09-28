/**
 * server.js — GitHub ZIP/Folder Pusher
 * ==================================================================
 * Login   : GitHub OAuth (dapat token push otomatis) atau Google
 *           (+ hubungkan Personal Access Token GitHub).
 * Upload  : file ZIP  ATAU  folder (drag & drop / pilih folder).
 * Proses  : ZIP diekstrak di server (yauzl, aman dari zip-slip).
 * Push    : GitHub REST API (Git Data API) -> 1 commit berisi semua file.
 *           Tidak membutuhkan `git` terpasang di server.
 *
 * Runtime : (a) VPS / localhost  -> sesi express-session + file di disk
 *           (b) Vercel serverless -> sesi cookie bertanda tangan + semua
 *               proses di memori, upload & push dalam SATU request
 *               (karena /tmp tidak persisten & body maks 4,5 MB).
 * ==================================================================
 */
require('dotenv').config();

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const multer = require('multer');

const { extractZip, extractZipBuffer, collectFolder, collectFolderMemory } = require('./lib/extractor');
const { cookieSession } = require('./lib/cookiesession');
const { GitHub, API, MAX_API_FILE_BYTES, createMockGitHub } = require('./lib/github');
const { verifyIdToken } = require('./lib/google');

/* ------------------------------------------------------------------ */
/* Konfigurasi                                                         */
/* ------------------------------------------------------------------ */
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const TMP_DIR = path.resolve(process.env.TMP_DIR || './data/tmp');
const GH_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GH_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GH_SCOPE = process.env.GITHUB_SCOPE || 'repo';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const DEMO_MODE = !GH_CLIENT_ID || !GH_CLIENT_SECRET; // tanpa kredensial -> mode demo

/* Lingkungan serverless (Vercel). Bisa dipaksa: SERVERLESS=1 */
const IS_VERCEL = !!process.env.VERCEL;
const SERVERLESS = IS_VERCEL || String(process.env.SERVERLESS || '') === '1';
/* Vercel menolak body > 4,5 MB sebelum fungsi terpanggil (413 FUNCTION_PAYLOAD_TOO_LARGE).
   Angka di bawah sengaja sedikit lebih kecil agar pesan error datang dari aplikasi kita. */
/* MB -> byte harus integer (multer menolak angka pecahan) */
const UPLOAD_MB = IS_VERCEL
  ? 4.3 // Vercel menolak > 4,5 MB (413) sebelum fungsi terpanggil — tidak bisa dinaikkan
  : SERVERLESS
    ? Math.min(Number(process.env.MAX_UPLOAD_MB || 4.3), 4.3) // serverless lain: ikuti batas aman
    : Number(process.env.MAX_UPLOAD_MB || 512);
const FILES_LIMIT = SERVERLESS
  ? Math.min(Number(process.env.MAX_FILES || 300), 300)   // semua file ditampung di RAM fungsi
  : Number(process.env.MAX_FILES || 20000);

if (SERVERLESS && !process.env.SESSION_SECRET) {
  // rahasia acak per-instance = cookie sesi tidak pernah terbaca lagi di request berikutnya
  console.error('[FATAL] SESSION_SECRET wajib diisi di environment Vercel (Dashboard → Settings → Environment Variables).');
  if (IS_VERCEL) process.exit(1);
}
// Izinkan "push ke GitHub tiruan" (in-memory) agar alur bisa dicoba tanpa token.
// Set ALLOW_MOCK_PUSH=0 di .env bila tidak diinginkan.
const MOCK_ENABLED = String(process.env.ALLOW_MOCK_PUSH === undefined ? DEMO_MODE : process.env.ALLOW_MOCK_PUSH === '1') === 'true';

if (!SERVERLESS) fs.mkdirSync(TMP_DIR, { recursive: true });

const app = express();
app.set('trust proxy', 1); // di belakang proxy (nginx / preview sandbox / HTTPS)
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());
if (SERVERLESS) {
  // Tanpa penyimpanan antar-request: sesi disimpan di cookie bertanda tangan (HMAC).
  app.use(cookieSession({ secret: process.env.SESSION_SECRET }));
} else {
  app.use(session({
    name: 'gzp.sid',
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',          // HTTPS di produksi, HTTP saat development
      maxAge: 1000 * 60 * 60 * 8, // 8 jam
    },
  }));
}
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

/* ------------------------------------------------------------------ */
/* Helper                                                              */
/* ------------------------------------------------------------------ */
const publicUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
const callbackUrl = (req) => `${publicUrl(req)}/auth/github/callback`;

function uid() { return crypto.randomBytes(12).toString('hex'); }
function uploadDir(id) { return path.join(TMP_DIR, id); }

/* GitHub tiruan (mode demo) disimpan per sesi di memori server.
   Sengaja TIDAK ditaruh di req.session agar tidak ikut diserialisasi. */
const mockStore = new Map();
function getMockGitHub(req) {
  const id = req.session.id;
  let m = mockStore.get(id);
  if (!m) { m = { gh: createMockGitHub(DEMO_REPOS), lastUsed: Date.now() }; mockStore.set(id, m); }
  m.lastUsed = Date.now();
  return m.gh;
}
function dropMockGitHub(req) { if (req.session && req.session.id) mockStore.delete(req.session.id); }

/**
 * Klien GitHub "efektif" untuk sebuah request:
 *  - sesi demo  -> GitHub tiruan (in-memory), atau null bila mock dimatikan
 *  - sesi nyata -> OAuth token / PAT / GITHUB_TOKEN
 */
function effectiveGitHub(req) {
  if (isDemoSession(req)) return { gh: MOCK_ENABLED ? getMockGitHub(req) : null, source: 'mock' };
  const g = getGitHub(req);
  return { gh: g.gh, source: g.source };
}
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [k, v] of mockStore) if (v.lastUsed < cutoff) mockStore.delete(k);
}, 30 * 60 * 1000).unref();

const saveSession = (req) => { if (typeof req.sessionSave === 'function') req.sessionSave(); };

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Belum login. Silakan login GitHub atau Google.' });
  next();
}

/** Ambil token GitHub (dari OAuth, PAT yang dihubungkan, atau PAT env). */
function getGitHub(req) {
  const s = req.session;
  const token = s.githubToken || s.pat || process.env.GITHUB_TOKEN || '';
  return { gh: token ? new GitHub(token) : null, token, source: s.githubToken ? 'oauth' : s.pat ? 'pat' : process.env.GITHUB_TOKEN ? 'env' : null };
}

function isDemoSession(req) {
  return DEMO_MODE && req.session.user && req.session.user.provider === 'demo';
}

function asyncH(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function apiError(res, err) {
  const status = err.status || 500;
  const payload = { error: err.message || 'Terjadi kesalahan' };
  if (err.status === 403 && /rate limit/i.test(err.message || '')) payload.hint = 'Rate limit GitHub tercapai. Tunggu beberapa menit lalu coba lagi.';
  if (err.status === 404) payload.hint = 'Repo/branch tidak ditemukan, atau token tidak punya akses ke repo tersebut (cek scope `repo`).';
  if (err.status === 409) payload.hint = 'Konflik: branch dilindungi (protected branch) atau file sudah ada.';
  if (err.status === 422) payload.hint = 'Permintaan ditolak GitHub (422). Biasanya branch dilindungi atau payload tidak valid.';
  if (err.details && err.details.errors) payload.details = err.details.errors;
  return res.status(status).json(payload);
}

/* Rate limiter super ringan per IP+path */
const hits = new Map();
function rateLimit(key, max, windowMs) {
  return (req, res, next) => {
    const k = `${key}:${req.ip}:${req.path}`;
    const now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi sebentar.' });
    arr.push(now); hits.set(k, arr); next();
  };
}

/* ------------------------------------------------------------------ */
/* Multer                                                              */
/* ------------------------------------------------------------------ */
/* Serverless: semua di memori (tidak ada disk persisten di Vercel). */
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.floor(UPLOAD_MB * 1024 * 1024), files: FILES_LIMIT, fieldSize: 4 * 1024 * 1024 },
});

const zipUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = uploadDir(req.session.uploadId || (req.session.uploadId = uid()));
      fsp.mkdir(dir, { recursive: true }).then(() => cb(null, dir)).catch(cb);
    },
    filename: (req, file, cb) => cb(null, `upload-${Date.now()}.zip`),
  }),
  limits: { fileSize: Math.floor(UPLOAD_MB * 1024 * 1024), files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /\.zip$/i.test(file.originalname) || file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed';
    cb(ok ? null : new Error('File harus berformat .zip'), ok);
  },
});

const folderUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(uploadDir(req.session.uploadId || (req.session.uploadId = uid())), 'folder-upload');
      fsp.mkdir(dir, { recursive: true }).then(() => cb(null, dir)).catch(cb);
    },
    // nama file di disk dibuat acak -> originalname (yang berisi path) tidak pernah dipakai sebagai path
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`),
  }),
  // WAJIB true: agar struktur folder (webkitRelativePath) tidak dibuang oleh busboy.
  // Aman karena path selalu dinormalisasi + ditolak bila mengandung ".." (lihat sanitizeEntryPath).
  preservePath: true,
  limits: { fileSize: MAX_API_FILE_BYTES, files: FILES_LIMIT, fieldSize: 8 * 1024 * 1024 },
});

/* ------------------------------------------------------------------ */
/* ROUTE: konfigurasi publik & status login                            */
/* ------------------------------------------------------------------ */
app.get('/api/config', (req, res) => {
  res.json({
    githubEnabled: !DEMO_MODE,
    googleEnabled: !!GOOGLE_CLIENT_ID,
    googleClientId: GOOGLE_CLIENT_ID || null,
    demoMode: DEMO_MODE,
    mockEnabled: MOCK_ENABLED,
    maxUploadMB: UPLOAD_MB,
    maxFiles: FILES_LIMIT,
    serverless: SERVERLESS,
    oneshot: SERVERLESS,       // UI: upload + push dalam satu request
    vercel: IS_VERCEL,
    maxApiFileMB: MAX_API_FILE_BYTES / 1048576,
    githubScope: GH_SCOPE,
    githubApiUrl: API,
  });
});

app.get('/api/me', (req, res) => {
  const u = req.session.user;
  if (!u) return res.json({ loggedIn: false, demoMode: DEMO_MODE });
  const { source } = getGitHub(req);
  res.json({
    loggedIn: true,
    provider: u.provider,
    profile: { login: u.login, name: u.name, avatar: u.avatar, email: u.email, html_url: u.html_url },
    github: {
      connected: !!source,
      via: source,                 // 'oauth' | 'pat' | 'env'
      scopes: u.scopes || null,
    },
    hasUpload: !!req.session.uploadId,
    upload: req.session.uploadInfo || null,
  });
});

app.post('/api/logout', (req, res) => {
  const id = req.session.uploadId;
  dropMockGitHub(req);
  const finish = () => {
    if (id && !SERVERLESS) fsp.rm(uploadDir(id), { recursive: true, force: true }).catch(() => {});
    res.clearCookie('gzp.sid');
    res.json({ ok: true });
  };
  if (typeof req.sessionDestroy === 'function') req.sessionDestroy(finish);
  else if (typeof req.session.destroy === 'function') req.session.destroy(finish);
  else finish();
});

/* ------------------------------------------------------------------ */
/* ROUTE: login GitHub (OAuth authorization code flow)                 */
/* ------------------------------------------------------------------ */
app.get('/auth/github', rateLimit('gh', 20, 60_000), (req, res) => {
  if (DEMO_MODE) {
    // Tanpa kredensial OAuth -> masuk sebagai akun demo (semua push = dry-run)
    req.session.user = {
      provider: 'demo', login: 'demo-user', name: 'Demo User',
      avatar: null, email: 'demo@example.com', html_url: 'https://github.com/',
    };
    saveSession(req);
    return res.redirect('/?notice=demo-login');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.oauthCallback = callbackUrl(req); // harus identik saat tukar kode
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', GH_CLIENT_ID);
  url.searchParams.set('redirect_uri', req.session.oauthCallback);
  url.searchParams.set('scope', GH_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'true');
  res.redirect(url.toString());
});

app.get('/auth/github/callback', asyncH(async (req, res) => {
  if (DEMO_MODE) return res.redirect('/');
  const { code, state, error, error_description } = req.query;
  if (error) return res.redirect(`/?notice=oauth-error&msg=${encodeURIComponent(error_description || error)}`);
  if (!code || !state || state !== req.session.oauthState) {
    return res.redirect('/?notice=state-mismatch');
  }
  delete req.session.oauthState;

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: GH_CLIENT_ID,
      client_secret: GH_CLIENT_SECRET,
      code,
      redirect_uri: req.session.oauthCallback || callbackUrl(req),
    }),
  });
  const tok = await tokenRes.json();
  if (!tok.access_token) {
    return res.redirect(`/?notice=oauth-error&msg=${encodeURIComponent(tok.error_description || tok.error || 'Gagal menukar kode')}`);
  }

  const gh = new GitHub(tok.access_token);
  const me = await gh.me();
  req.session.githubToken = tok.access_token;
  req.session.user = {
    provider: 'github', login: me.login, name: me.name, avatar: me.avatar,
    email: me.email, html_url: me.html_url, scopes: me.scopes,
  };
  saveSession(req);
  res.redirect('/?notice=logged-in');
}));

/* ------------------------------------------------------------------ */
/* ROUTE: login Google (ID token diverifikasi di server)               */
/* ------------------------------------------------------------------ */
app.post('/auth/google', rateLimit('gg', 20, 60_000), asyncH(async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(400).json({ error: 'GOOGLE_CLIENT_ID belum diisi di .env, login Google dinonaktifkan.' });
  const { credential, nonce } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'Parameter "credential" wajib diisi.' });
  const profile = await verifyIdToken(credential, GOOGLE_CLIENT_ID.split(',').map((s) => s.trim()), nonce);
  if (!profile.emailVerified) return res.status(403).json({ error: 'Email Google belum diverifikasi.' });

  req.session.user = {
    provider: 'google', login: profile.email, name: profile.name || profile.email,
    avatar: profile.picture, email: profile.email, html_url: null, scopes: null,
  };
  saveSession(req);
  res.json({
    ok: true,
    profile: req.session.user,
    warning: 'Login Google tidak memberi akses ke GitHub. Hubungkan Personal Access Token (scope repo) untuk bisa push.',
  });
}));

/* ------------------------------------------------------------------ */
/* ROUTE: hubungkan / lepas Personal Access Token                      */
/* ------------------------------------------------------------------ */

/**
 * Login hanya dengan PAT (tanpa OAuth App).
 * Cocok untuk self-host / internal tool: user cukup punya token GitHub.
 */
app.post('/auth/token', rateLimit('patlogin', 10, 60_000), asyncH(async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!/^(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9]{20,}$/.test(token)) {
    return res.status(400).json({ error: 'Format token tidak dikenali. Gunakan classic PAT (ghp_...) atau fine-grained (github_pat_...).' });
  }
  const gh = new GitHub(token);
  const me = await gh.me(); // validasi token sekaligus ambil profil
  req.session.githubToken = null;
  req.session.pat = token;
  req.session.user = {
    provider: 'pat', login: me.login, name: me.name, avatar: me.avatar,
    email: me.email, html_url: me.html_url, scopes: me.scopes,
  };
  const canPush = !me.scopes.length || me.scopes.some((s) => ['repo', 'public_repo'].includes(s));
  saveSession(req);
  res.json({
    ok: true,
    profile: req.session.user,
    warning: me.scopes.length && !canPush ? 'Token tidak punya scope `repo` — push ke repo privat akan gagal.' : null,
  });
}));

app.post('/api/link-token', rateLimit('pat', 10, 60_000), requireAuth, asyncH(async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!/^(ghp|github_pat)_[A-Za-z0-9]{20,}$/.test(token)) {
    return res.status(400).json({ error: 'Format token tidak dikenali. Gunakan classic PAT (ghp_...) atau fine-grained (github_pat_...).' });
  }
  const gh = new GitHub(token);
  const me = await gh.me(); // sekaligus validasi token
  const canPush = !me.scopes.length || me.scopes.some((s) => ['repo', 'public_repo'].includes(s));
  req.session.pat = token;
  req.session.user.login = req.session.user.login || me.login;
  saveSession(req);
  res.json({
    ok: true,
    githubLogin: me.login,
    scopes: me.scopes,
    warning: me.scopes.length && !canPush
      ? 'Token tidak punya scope `repo` — push ke repo privat akan gagal.'
      : null,
  });
}));

app.post('/api/unlink-token', requireAuth, (req, res) => {
  delete req.session.pat;
  saveSession(req);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* ROUTE: daftar repo, branch, isi folder                              */
/* ------------------------------------------------------------------ */
const DEMO_REPOS = [
  { full_name: 'demo-user/website-portofolio', name: 'website-portofolio', owner: 'demo-user', private: false, default_branch: 'main', permission: 'admin', pushed_at: new Date().toISOString(), html_url: 'https://github.com/demo-user/website-portofolio' },
  { full_name: 'demo-user/tugas-kuliah', name: 'tugas-kuliah', owner: 'demo-user', private: true, default_branch: 'master', permission: 'push', pushed_at: new Date().toISOString(), html_url: 'https://github.com/demo-user/tugas-kuliah' },
];

app.get('/api/repos', requireAuth, asyncH(async (req, res) => {
  if (isDemoSession(req)) return res.json({ demo: true, repos: DEMO_REPOS });
  const { gh } = getGitHub(req);
  if (!gh) return res.status(400).json({ error: 'Token GitHub belum ada. Login GitHub atau hubungkan PAT.' });

  const [mine, orgs] = await Promise.all([
    gh.listRepos({ perPage: 100, type: 'all', sort: 'pushed' }),
    req.query.includeOrgs === '1' ? gh.listOrgPushRepos() : Promise.resolve([]),
  ]);
  const seen = new Set();
  const repos = [...mine, ...orgs].filter((r) => {
    if (seen.has(r.full_name)) return false;
    seen.add(r.full_name); return true;
  }).sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));

  res.json({
    repos,
    canPush: repos.filter((r) => r.permission !== 'pull').length,
    notice: repos.length >= 100 ? 'Hanya 100 repo pertama yang ditampilkan. Gunakan pencarian bila repo tidak muncul.' : null,
  });
}));

app.get('/api/branches/:owner/:repo', requireAuth, asyncH(async (req, res) => {
  const { owner, repo } = req.params;
  const { gh } = effectiveGitHub(req);
  if (!gh) return res.status(400).json({ error: 'Token GitHub belum ada.' });
  const [branches, info] = await Promise.all([gh.listBranches(owner, repo), gh.repoPermission(owner, repo)]);
  res.json({ demo: gh.isMock || undefined, branches, default_branch: info.default_branch, permission: info.permission, private: info.private });
}));

app.get('/api/tree/:owner/:repo', requireAuth, asyncH(async (req, res) => {
  const { owner, repo } = req.params;
  const p = String(req.query.path || '');
  const { gh } = effectiveGitHub(req);
  if (!gh) return res.status(400).json({ error: 'Token GitHub belum ada.' });
  res.json({ entries: await gh.tree(owner, repo, p) });
}));
app.post('/api/repos', requireAuth, rateLimit('newrepo', 5, 60_000), asyncH(async (req, res) => {
  const { gh } = effectiveGitHub(req);
  if (!gh) return res.status(400).json({ error: isDemoSession(req) ? 'Mode demo tanpa mock dinonaktifkan.' : 'Token GitHub belum ada.' });
  const name = String(req.body?.name || '').trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) return res.status(400).json({ error: 'Nama repo tidak valid (huruf/angka/titik/strip, maks 100 karakter).' });
  const created = await gh.createRepo({
    name,
    private: !!req.body?.private,
    description: String(req.body?.description || '').slice(0, 300),
    org: String(req.body?.org || '').trim() || undefined,
  });
  res.json({ ok: true, repo: created });
}));

/* ------------------------------------------------------------------ */
/* ROUTE: upload ZIP / folder -> ekstrak -> daftar file                */
/* ------------------------------------------------------------------ */
async function ensureSessionUpload(req) {
  if (!req.session.uploadId) req.session.uploadId = uid();
  const dir = uploadDir(req.session.uploadId);
  const work = path.join(dir, 'files');
  await fsp.mkdir(work, { recursive: true });
  // bersihkan hasil upload sebelumnya
  await fsp.rm(work, { recursive: true, force: true });
  await fsp.mkdir(work, { recursive: true });
  return { dir, work };
}

function summarize(files) {
  const dirs = new Set();
  let byExt = {};
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    const ext = (path.extname(f.path).slice(1) || 'tanpa-ekstensi').toLowerCase();
    byExt[ext] = (byExt[ext] || 0) + 1;
  }
  const top = Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return {
    totalFiles: files.length,
    totalDirs: dirs.size,
    totalSize: files.reduce((a, f) => a + f.size, 0),
    largest: [...files].sort((a, b) => b.size - a.size).slice(0, 5).map((f) => ({ path: f.path, size: f.size })),
    topExtensions: top.map(([ext, n]) => ({ ext, count: n })),
  };
}

const noDiskOnServerless = (req, res, next) => {
  if (!SERVERLESS) return next();
  res.status(501).json({
    error: 'Endpoint ini tidak tersedia di mode serverless (Vercel): tidak ada disk persisten antar-request.',
    hint: 'Gunakan POST /api/push-upload — upload ZIP/folder sekaligus push dalam satu request.',
  });
};

app.post('/api/files/zip', requireAuth, noDiskOnServerless, zipUpload.single('zip'), asyncH(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File ZIP tidak diterima.' });
  const stripRoot = String(req.body?.stripRoot || '1') !== '0';
  const { dir, work } = await ensureSessionUpload(req);

  try {
    const result = await extractZip(req.file.path, work, {
      stripRoot,
      maxFiles: FILES_LIMIT,
      maxEntrySize: MAX_API_FILE_BYTES,
      codepage: req.body?.codepage || null,
      onProgress: (done, total) => { req.session.extractProgress = { done, total }; },
    });
    if (result.files.length === 0) return res.status(400).json({ error: 'ZIP tidak berisi file yang bisa di-push (mungkin hanya folder kosong atau semuanya terfilter).' });
    const info = {
      kind: 'zip', originalName: req.file.originalname, strippedRoot: result.root,
      skipped: result.skipped, ...summarize(result.files),
    };
    info.files = result.files.map((f) => ({ path: f.path, size: f.size }));
    req.session.uploadInfo = info;
    res.json({ ok: true, uploadId: req.session.uploadId, ...info });
  } catch (err) {
    if (/encrypted|password/i.test(err.message || '')) err.message = 'ZIP ini diproteksi password — GitHub API tidak bisa menerima file terenkripsi. Ekstrak dulu, lalu upload sebagai folder.';
    throw err;
  } finally {
    fsp.rm(req.file.path, { force: true }).catch(() => {});
  }
}));

app.post('/api/files/folder', requireAuth, noDiskOnServerless, folderUpload.array('files', FILES_LIMIT), asyncH(async (req, res) => {
  const uploaded = req.files || [];
  if (uploaded.length === 0) return res.status(400).json({ error: 'Tidak ada file folder yang diterima.' });

  // relPaths (opsional) dikirim browser sebagai cadangan bila originalname kehilangan path
  let relPaths = null;
  try { relPaths = req.body && req.body.relPaths ? JSON.parse(req.body.relPaths) : null; } catch (_) { relPaths = null; }
  if (!Array.isArray(relPaths) || relPaths.length !== uploaded.length) relPaths = null;

  const { work } = await ensureSessionUpload(req);
  const result = await collectFolder(uploaded, work, {
    stripRoot: true,
    maxFiles: FILES_LIMIT,
    relPaths,
    onProgress: (done, total) => { req.session.extractProgress = { done, total }; },
  });
  for (const f of uploaded) fsp.rm(f.path, { force: true }).catch(() => {});

  if (result.files.length === 0) return res.status(400).json({ error: 'Semua file terfilter (node_modules, .git, dsb). Coba matikan filter atau pilih folder lain.' });
  const info = { kind: 'folder', strippedRoot: result.root, skipped: result.skipped, ...summarize(result.files) };
  info.files = result.files.map((f) => ({ path: f.path, size: f.size }));
  req.session.uploadInfo = info;
  res.json({ ok: true, uploadId: req.session.uploadId, ...info });
}));

app.get('/api/files', requireAuth, noDiskOnServerless, (req, res) => {
  const info = req.session.uploadInfo;
  if (!info) return res.json({ has: false });
  res.json({ has: true, ...info });
});

app.get('/api/files/progress', requireAuth, noDiskOnServerless, (req, res) => {
  res.json(req.session.extractProgress || { done: 0, total: 0 });
});

app.delete('/api/files', requireAuth, noDiskOnServerless, asyncH(async (req, res) => {
  if (req.session.uploadId) await fsp.rm(uploadDir(req.session.uploadId), { recursive: true, force: true });
  delete req.session.uploadId; delete req.session.uploadInfo;
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* ROUTE: UPLOAD + PUSH SEKALI JALAN (wajib di serverless / Vercel)    */
/* ------------------------------------------------------------------ */
/**
 * Kenapa endpoint ini ada?
 *  - Di Vercel, /tmp hanya hidup selama 1 request  -> file hasil ekstrak
 *    tidak akan ada lagi saat request "push" berikutnya.
 *  - Body request dibatasi 4,5 MB                  -> ZIP/folder kecil saja.
 * Jadi: upload + ekstrak (di memori) + push dilakukan dalam SATU request.
 */
app.post('/api/push-upload', requireAuth, rateLimit('pushup', 20, 60_000), memUpload.any(), asyncH(async (req, res) => {
  const all = [...(req.files || [])];
  const zipFile = all.find((f) => f.fieldname === 'zip');
  const folderFiles = all.filter((f) => f.fieldname === 'files');
  const b = req.body || {};

  let files = [];
  let strippedRoot = null;
  let skipped = 0;
  let kind = 'none';

  const commonOpts = {
    stripRoot: String(b.stripRoot || '1') !== '0',
    maxFiles: FILES_LIMIT,
    maxEntrySize: MAX_API_FILE_BYTES,
    codepage: b.codepage || null,
    onProgress: (done, total) => { req.session.pushProgress = { stage: 'extract', done, total, at: Date.now() }; },
  };

  try {
    if (zipFile && zipFile.buffer && zipFile.buffer.length) {
      kind = 'zip';
      const r = await extractZipBuffer(zipFile.buffer, commonOpts);
      files = r.files; strippedRoot = r.root; skipped = r.skipped;
    } else if (folderFiles.length) {
      kind = 'folder';
      let relPaths = null;
      try { relPaths = b.relPaths ? JSON.parse(b.relPaths) : null; } catch (_) { relPaths = null; }
      if (!Array.isArray(relPaths) || relPaths.length !== folderFiles.length) relPaths = null;
      const r = collectFolderMemory(folderFiles, { ...commonOpts, relPaths });
      files = r.files; strippedRoot = r.root; skipped = r.skipped;
    } else {
      return res.status(400).json({ error: 'Tidak ada file yang diterima. Kirim field "zip" (1 file) atau "files" (banyak file).' });
    }

    if (!files.length) {
      return res.status(400).json({ error: 'Tidak ada file yang bisa di-push (kosong atau semuanya terfilter node_modules/.git/dsb).' });
    }
    const bytes = files.reduce((a, f) => a + f.size, 0);

    /* ---- target ---- */
    const fullName = String(b.repo || '').trim();
    const branch = String(b.branch || '').trim();
    const destPath = String(b.destPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const message = String(b.message || '').trim() || `Upload ${new Date().toISOString().slice(0, 10)} via github-zip-pusher`;
    const createBranch = !!b.createBranch || b.createBranch === 'true';
    const baseBranch = String(b.baseBranch || '').trim() || null;
    const overwrite = b.overwrite !== false && b.overwrite !== 'false';
    const deleteExisting = !!b.deleteExisting && b.deleteExisting !== 'false';
    const dryRun = !!b.dryRun && b.dryRun !== 'false';
    const useMock = !!b.useMock && b.useMock !== 'false';

    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) return res.status(400).json({ error: 'Format repo harus "owner/nama-repo".' });
    if (!branch || /[~^:?*\[\]@{}\\]/.test(branch) || branch.includes('..') || branch.endsWith('.lock')) {
      return res.status(400).json({ error: 'Nama branch tidak valid.' });
    }
    if (destPath.split('/').some((seg) => seg === '..' || seg === '.')) {
      return res.status(400).json({ error: 'Path tujuan tidak valid.' });
    }
    const [owner, repo] = fullName.split('/');
    req.session.pushProgress = { stage: 'idle' };

    /* ---- dry-run ---- */
    if (dryRun) {
      return res.json({
        ok: true, dryRun: true, reason: 'dryRun diminta', kind, strippedRoot, skipped,
        plan: {
          repo: fullName, branch, destPath: destPath || '(root)', message,
          createBranch, baseBranch, overwrite, deleteExisting, files: files.length, bytes,
          apiCalls: [
            `GET  /repos/${fullName}/branches/${branch}`,
            `GET  /repos/${fullName}/git/commits/{parentSha}`,
            `POST /repos/${fullName}/git/blobs      x${files.length}`,
            `POST /repos/${fullName}/git/trees      (base_tree = tree branch tujuan)`,
            `POST /repos/${fullName}/git/commits    (1 commit untuk semua file)`,
            `PATCH/POST /repos/${fullName}/git/refs/heads/${branch}`,
          ],
        },
        preview: files.slice(0, 200).map((f) => ({ path: (destPath ? destPath + '/' : '') + f.path, size: f.size })),
      });
    }

    /* ---- token / mock ---- */
    let { gh } = getGitHub(req);
    const mockUsed = useMock && MOCK_ENABLED && !gh;
    if (mockUsed) gh = getMockGitHub(req);
    if (!gh) {
      return res.json({
        ok: true, dryRun: true, reason: isDemoSession(req) ? 'Mode demo (kredensial GitHub belum diisi)' : 'Token GitHub belum dihubungkan',
        kind, strippedRoot, skipped,
        plan: { repo: fullName, branch, destPath: destPath || '(root)', message, files: files.length, bytes },
        preview: files.slice(0, 200).map((f) => ({ path: (destPath ? destPath + '/' : '') + f.path, size: f.size })),
      });
    }

    /* ---- push ---- */
    const me = req.session.user || {};
    const result = await gh.pushFiles({
      owner, repo, branch, destPath, message, files,
      createBranch, baseBranch, overwrite, deleteExisting,
      author: me.provider === 'github' ? { name: me.name || me.login, email: me.email, login: me.login } : undefined,
      onProgress: (stage, data) => { req.session.pushProgress = { stage, ...data, at: Date.now() }; },
    });

    if (mockUsed) { result.mock = true; result.commitUrl = null; result.treeUrl = null; }
    res.json({
      ok: true, dryRun: false, mock: !!mockUsed, kind, strippedRoot, skipped,
      uploadedBytes: bytes, ...result,
    });
  } finally {
    // bebaskan memori sesegera mungkin (penting di serverless)
    for (const f of all) if (f.buffer) f.buffer = null;
    files.length = 0;
  }
}));

/* ------------------------------------------------------------------ */
/* ROUTE: push ke repository                                           */
/* ------------------------------------------------------------------ */
app.post('/api/push', requireAuth, noDiskOnServerless, rateLimit('push', 20, 60_000), asyncH(async (req, res) => {
  const b = req.body || {};
  const fullName = String(b.repo || '').trim();
  const branch = String(b.branch || '').trim();
  const destPath = String(b.destPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const message = String(b.message || '').trim() || `Upload ${new Date().toISOString().slice(0, 10)} via github-zip-pusher`;
  const createBranch = !!b.createBranch;
  const baseBranch = String(b.baseBranch || '').trim() || null;
  const overwrite = b.overwrite !== false;
  const deleteExisting = !!b.deleteExisting;
  const dryRun = !!b.dryRun;

  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) return res.status(400).json({ error: 'Format repo harus "owner/nama-repo".' });
  if (!branch || /[~^:?*\[\]@{}\\]/.test(branch) || branch.includes('..') || branch.endsWith('.lock')) {
    return res.status(400).json({ error: 'Nama branch tidak valid.' });
  }
  if (destPath.split('/').some((seg) => seg === '..' || seg === '.')) {
    return res.status(400).json({ error: 'Path tujuan tidak valid.' });
  }

  const [owner, repo] = fullName.split('/');
  req.session.pushProgress = { stage: 'idle' };
  const info = req.session.uploadInfo;
  if (!info || !req.session.uploadId) return res.status(400).json({ error: 'Belum ada file yang di-upload. Upload ZIP atau folder dulu.' });

  const work = path.join(uploadDir(req.session.uploadId), 'files');
  const files = (info.files || [])
    .map((f) => ({ path: f.path, absPath: path.join(work, f.path), size: f.size, mode: /\.(sh|bash|py|pl|rb)$/i.test(f.path) ? 0o755 : 0o644 }))
    .filter((f) => {
      const abs = path.resolve(f.absPath);
      return abs.startsWith(path.resolve(work) + path.sep) && fs.existsSync(abs);
    });
  if (!files.length) return res.status(400).json({ error: 'File hasil ekstrak sudah dibersihkan. Silakan upload ulang.' });

  /* ---- Mode demo / dry run: hanya tampilkan rencana commit ---- */
  let { gh } = getGitHub(req);
  const useMock = !!b.useMock && MOCK_ENABLED && !gh; // hanya bila belum ada token asli
  if (useMock) gh = getMockGitHub(req);              // satu instance per sesi -> branch/repo bertahan

  if ((isDemoSession(req) && !useMock) || !gh || dryRun) {
    return res.json({
      ok: true,
      dryRun: true,
      reason: isDemoSession(req) ? 'Mode demo (GITHUB_CLIENT_ID/SECRET belum diisi)' : !gh ? 'Token GitHub belum dihubungkan' : 'dryRun diminta',
      plan: {
        repo: fullName, branch, destPath: destPath || '(root)', message,
        createBranch, baseBranch, overwrite, deleteExisting,
        files: files.length, bytes: files.reduce((a, f) => a + f.size, 0),
        apiCalls: [
          `GET  /repos/${fullName}/branches/${branch}`,
          `GET  /repos/${fullName}/git/commits/{parentSha}`,
          `POST /repos/${fullName}/git/blobs      x${files.length}`,
          `POST /repos/${fullName}/git/trees      (base_tree = tree branch tujuan)`,
          `POST /repos/${fullName}/git/commits    (1 commit untuk semua file)`,
          `PATCH/POST /repos/${fullName}/git/refs/heads/${branch}`,
        ],
      },
      preview: files.slice(0, 200).map((f) => ({ path: (destPath ? destPath + '/' : '') + f.path, size: f.size })),
    });
  }

  /* ---- Push sungguhan ---- */
  const me = req.session.user || {};

  // Pre-flight: pastikan repo ada & token punya izin push (hemat kuota blob bila salah)
  const info0 = await gh.repoPermission(owner, repo);
  if (info0.permission === 'pull') {
    return res.status(403).json({ error: `Token Anda hanya punya akses baca ke ${fullName}.`, hint: 'Gunakan akun/token dengan izin push, atau pilih repo lain.' });
  }

  const result = await gh.pushFiles({
    owner, repo, branch, destPath, message, files,
    createBranch, baseBranch, overwrite, deleteExisting,
    author: me.provider === 'github' ? { name: me.name || me.login, email: me.email, login: me.login } : undefined,
    onProgress: (stage, data) => {
      req.session.pushProgress = { stage, ...data, at: Date.now() };
    },
  });

  if (useMock) {
    // commit hanya ada di memori server -> tidak ada URL github.com yang valid
    result.mock = true;
    result.commitUrl = null;
    result.treeUrl = null;
  }
  res.json({ ok: true, dryRun: false, mock: !!useMock, ...result });
}));

app.get('/api/push/progress', requireAuth, (req, res) => {
  res.json(req.session.pushProgress || { stage: 'idle' });
});

/* ------------------------------------------------------------------ */
/* Housekeeping & error handler                                        */
/* ------------------------------------------------------------------ */
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000; // 1 jam
  fsp.readdir(TMP_DIR).then(async (names) => {
    for (const n of names) {
      const p = path.join(TMP_DIR, n);
      try {
        const st = await fsp.stat(p);
        if (st.isDirectory() && st.mtimeMs < cutoff) await fsp.rm(p, { recursive: true, force: true });
      } catch (_) {}
    }
  }).catch(() => {});
}, 15 * 60 * 1000).unref();

app.use((req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const map = {
      LIMIT_FILE_SIZE: `Ukuran file melebihi batas ${UPLOAD_MB} MB.${SERVERLESS ? ' (Batas Vercel 4,5 MB per request — pakai CLI untuk file besar.)' : ''}`,
      LIMIT_FILE_COUNT: `Jumlah file melebihi batas ${FILES_LIMIT}.`,
      LIMIT_UNEXPECTED_FILE: 'Field upload tidak dikenali.',
    };
    return res.status(413).json({ error: map[err.code] || err.message });
  }
  if (res.headersSent) return next(err);
  apiError(res, err);
});

if (!IS_VERCEL) app.listen(PORT, HOST, () => {
  console.log('='.repeat(64));
  console.log(`  GitHub ZIP/Folder Pusher  ->  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  Login GitHub OAuth : ${DEMO_MODE ? 'NONAKTIF (mode demo — isi GITHUB_CLIENT_ID & SECRET)' : 'aktif'}`);
  console.log(`  Login Google       : ${GOOGLE_CLIENT_ID ? 'aktif' : 'nonaktif (GOOGLE_CLIENT_ID kosong)'}`);
  console.log(`  Batas upload       : ${UPLOAD_MB} MB / ${FILES_LIMIT} file`);
  console.log(`  Mode               : ${SERVERLESS ? 'SERVERLESS (memori, upload+push sekali jalan)' : 'SERVER (disk ' + TMP_DIR + ')'}`);
  console.log('='.repeat(64));
});

/* Dipakai oleh api/index.js saat berjalan sebagai fungsi Vercel. */
module.exports = app;
