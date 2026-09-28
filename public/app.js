/* ==================================================================
 * app.js — frontend GitHub ZIP/Folder Pusher
 * ================================================================== */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  config: { maxUploadMB: 512, maxFiles: 20000, githubEnabled: false, googleEnabled: false, demoMode: true },
  me: null,
  repos: [],
  selectedRepo: null,
  branches: [],
  branch: '',
  useNewBranch: false,
  upload: null,
  polling: null,
};

/* ---------------- util ---------------- */
const fmtSize = (b) => {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = () => new Date().toLocaleTimeString('id-ID', { hour12: false });

function note(type, html, where = '#notices') {
  const icons = {
    info: '<svg viewBox="0 0 16 16"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm6.5-.25A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>',
    ok: '<svg viewBox="0 0 16 16"><path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16Zm3.78-9.72a.75.75 0 0 0-1.06-1.06L6.75 9.19 5.28 7.72a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l4.5-4.5Z"/></svg>',
    warn: '<svg viewBox="0 0 16 16"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>',
    err: '<svg viewBox="0 0 16 16"><path d="M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.751.751 0 0 0 1.06 1.06L8 9.06l1.97 1.97a.751.751 0 0 0 1.06-1.06L9.06 8l1.97-1.97a.751.751 0 0 0-1.06-1.06L8 6.94Z"/></svg>',
  };
  const el = document.createElement('div');
  el.className = `note ${type}`;
  el.innerHTML = (icons[type] || '') + '<div>' + html + '</div>';
  $(where).appendChild(el);
  return el;
}

function log(msg, cls = '') {
  const pre = $('#log');
  pre.innerHTML += `<span class="dim">[${time()}]</span> <span class="${cls}">${msg}</span>\n`;
  pre.scrollTop = pre.scrollHeight;
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? (opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body)) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const e = new Error((data && data.error) || `HTTP ${res.status}`);
    e.status = res.status; e.hint = data && data.hint; e.data = data;
    throw e;
  }
  return data;
}

/* upload dengan progress (XHR) */
function uploadXhr(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let d = null; try { d = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(d);
      else reject(Object.assign(new Error((d && d.error) || `HTTP ${xhr.status}`), { status: xhr.status, hint: d && d.hint }));
    };
    xhr.onerror = () => reject(new Error('Koneksi terputus saat upload.'));
    xhr.send(formData);
  });
}

/* ==================================================================
 * INIT
 * ================================================================== */
async function init() {
  try { state.config = await api('/api/config'); } catch (e) {
    console.warn(e);
    note('err', 'Tidak bisa menghubungi server (<code>/api/config</code>). Bila ini deploy Vercel, buka <code>/api/health</code> untuk melihat penyebabnya.');
  }
  $('#maxMb').textContent = state.config.maxUploadMB || 512;

  // peringatan dari server (mis. SESSION_SECRET belum diisi di Vercel)
  (state.config.warnings || []).forEach((w) => note('warn', w, '#notices'));
  handleNotice();
  try { state.me = await api('/api/me'); } catch (e) { state.me = { loggedIn: false }; }

  if (state.me.loggedIn) { await showApp(); } else { showLogin(); }
}

function handleNotice() {
  const q = new URLSearchParams(location.search);
  const n = q.get('notice');
  if (!n) return;
  const map = {
    'logged-in': ['ok', 'Berhasil login dengan GitHub. Token siap dipakai untuk push.'],
    'demo-login': ['warn', 'Masuk sebagai <b>akun demo</b> karena <code>GITHUB_CLIENT_ID</code>/<code>GITHUB_CLIENT_SECRET</code> belum diisi. Semua proses push berjalan sebagai <b>dry-run</b> (tidak benar-benar commit).'],
    'state-mismatch': ['err', 'Login dibatalkan: parameter <code>state</code> tidak cocok. Coba login ulang.'],
    'oauth-error': ['err', 'OAuth GitHub gagal: ' + esc(q.get('msg') || 'tidak diketahui')],
    'logged-out': ['info', 'Anda sudah logout.'],
    'popup-completed': ['ok', 'Login selesai di tab lain — halaman ini sudah dimuat ulang.'],
  };
  const [type, html] = map[n] || ['info', esc(n)];
  note(type, html);
  history.replaceState(null, '', location.pathname);
}

/* ==================================================================
 * LOGIN VIEW
 * ================================================================== */
function showLogin() {
  $('#loginView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
  $('#whoBox').classList.add('hidden');

  const inIframe = (() => { try { return window.self !== window.top; } catch (_) { return true; } })();
  const ghBtn = $('#btnGithub');

  if (!state.config.githubEnabled) {
    ghBtn.textContent = '🔍 Masuk mode demo (OAuth belum dikonfigurasi)';
    ghBtn.removeAttribute('href');
    ghBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const w = inIframe ? window.open('/auth/github', '_blank') : null;
      if (!w) location.href = '/auth/github'; // popup diblokir (iframe sandbox) -> navigasi langsung
    });
  } else if (inIframe) {
    ghBtn.setAttribute('target', '_blank');
    ghBtn.setAttribute('rel', 'noopener');
    note('info', 'Halaman ini tampil di dalam iframe pratinjau. Login GitHub akan terbuka di <b>tab baru</b> — setelah selesai, halaman ini otomatis memuat ulang.', '#notices');
    startLoginPolling();
  }

  // Google Identity Services
  if (state.config.googleEnabled && state.config.googleClientId) {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = () => {
      try {
        window.google.accounts.id.initialize({
          client_id: state.config.googleClientId,
          callback: onGoogleCredential,
          auto_select: false,
          cancel_on_tap_outside: true,
        });
        window.google.accounts.id.renderButton($('#googleBtn'), {
          theme: 'filled_black', size: 'large', width: 380, text: 'continue_with', shape: 'pill', locale: 'id',
        });
      } catch (e) { console.warn('GSI gagal dimuat', e); }
    };
    s.onerror = () => note('warn', 'Skrip Google Sign-In gagal dimuat (mungkin diblokir jaringan/iframe). Gunakan login GitHub atau PAT.', '#notices');
    document.head.appendChild(s);
  } else {
    $('#googleBtn').innerHTML = '<p class="hint" style="text-align:center">Login Google nonaktif — isi <code>GOOGLE_CLIENT_ID</code> di file <code>.env</code>.</p>';
  }

  $('#btnPatLogin').onclick = () => $('#patBox').classList.toggle('hidden');
  $('#patSave').onclick = async () => {
    const token = $('#patInput').value.trim();
    if (!token) return alert('Isi token terlebih dahulu.');
    $('#patSave').disabled = true;
    try {
      const r = await api('/auth/token', { method: 'POST', body: { token } });
      note('ok', `Token terhubung sebagai <b>${esc(r.profile.login)}</b>.${r.warning ? ' ⚠ ' + esc(r.warning) : ''}`);
      setTimeout(() => location.href = '/?notice=logged-in', 800);
    } catch (e) {
      note('err', esc(e.message) + (e.hint ? ' — ' + esc(e.hint) : ''));
      $('#patSave').disabled = false;
    }
  };

  $('#setupHelp').innerHTML = `
    <b style="color:var(--fg)">Cara mengaktifkan login GitHub (sekali saja):</b><br/>
    1. Buka <a href="https://github.com/settings/developers" target="_blank" rel="noopener">github.com/settings/developers</a> → <i>OAuth Apps</i> → <i>New OAuth App</i>.<br/>
    2. <b>Homepage URL</b>: <code>${esc(location.origin)}</code><br/>
    3. <b>Authorization callback URL</b>: <code>${esc(location.origin)}/auth/github/callback</code><br/>
    4. Salin <i>Client ID</i> &amp; <i>Client Secret</i> ke file <code>.env</code>, lalu jalankan ulang <code>npm start</code>.<br/>
    <span style="color:var(--fg3)">Tanpa langkah ini aplikasi tetap jalan dalam mode demo (push = dry-run).</span>`;
}

async function onGoogleCredential(resp) {
  try {
    const r = await api('/auth/google', { method: 'POST', body: { credential: resp.credential } });
    note('ok', `Login Google berhasil sebagai <b>${esc(r.profile.email)}</b>. ${esc(r.warning || '')}`);
    setTimeout(() => location.reload(), 1000);
  } catch (e) {
    note('err', 'Login Google gagal: ' + esc(e.message));
  }
}

function startLoginPolling() {
  let tries = 0;
  const t = setInterval(async () => {
    tries++;
    if (tries > 240) return clearInterval(t);
    try {
      const m = await api('/api/me');
      if (m.loggedIn) { clearInterval(t); location.reload(); }
    } catch (_) {}
  }, 2000);
}


/* ==================================================================
 * MODE SEKALI JALAN (Vercel / serverless)
 * Tidak ada disk persisten -> file tidak disimpan di server.
 * Pratinjau isi ZIP dibaca langsung di browser (parse End of Central
 * Directory), lalu upload + push dikirim dalam SATU request.
 * ================================================================== */
async function scanZipLocal(file) {
  const view = new DataView(await file.arrayBuffer());
  const len = view.byteLength;
  if (len < 22) throw new Error('File terlalu kecil untuk menjadi ZIP.');

  // cari signature End of Central Directory (0x06054b50) dari belakang
  const maxBack = Math.min(len - 22, 66000);
  let eocd = -1;
  for (let i = len - 22; i >= len - 22 - maxBack; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Bukan arsip ZIP yang valid (EOCD tidak ditemukan).');

  let count = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);

  // ZIP64: bila penanda 0xFFFF/0xFFFFFFFF, baca EOCD-64
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && view.getUint32(loc, true) === 0x07064b50) {
      const eocd64 = Number(view.getBigUint64(loc + 8, true));
      if (eocd64 >= 0 && view.getUint32(eocd64, true) === 0x06064b50) {
        count = Number(view.getBigUint64(eocd64 + 32, true));
        cdOffset = Number(view.getBigUint64(eocd64 + 48, true));
      }
    }
  }

  const decUtf8 = new TextDecoder('utf-8');
  const decCp437 = new TextDecoder('ibm437'); // tersedia di semua browser
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > len || view.getUint32(p, true) !== 0x02014b50) break;
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const extAttr = view.getUint32(p + 38, true);
    const nameBytes = new Uint8Array(view.buffer, view.byteOffset + p + 46, nameLen);

    // Info-ZIP Unicode Path Extra Field (0x75) bila ada
    let name = null;
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = view.getUint16(e, true);
      const sz = view.getUint16(e + 2, true);
      if (id === 0x75 && sz > 5) {
        try { name = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(view.buffer, view.byteOffset + e + 4 + 5, sz - 5)); } catch (_) {}
      }
      e += 4 + sz;
    }
    if (!name) name = (flags & 0x800) ? decUtf8.decode(nameBytes) : decCp437.decode(nameBytes);

    const isDir = name.endsWith('/') || (((extAttr >>> 16) & 0o170000) === 0o040000);
    entries.push({
      path: name.replace(/\\/g, '/').replace(/^\/+/, ''),
      size: usize,
      dir: isDir,
      encrypted: (flags & 0x1) !== 0,
      stored: method === 0,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* daftar folder pembungkus + filter bawaan (samakan dengan server) */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.idea', '.vscode', '.next', '.nuxt', '.cache',
  '.parcel-cache', '.turbo', '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'dist', 'build', 'out', 'target', 'coverage', '.gradle', '.terraform', 'vendor', '.angular', '.svelte-kit',
  '.output', 'bin', 'obj']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.env.local']);

function filteredPaths(paths) {
  return paths.filter((p) => {
    const parts = p.split('/');
    for (let i = 0; i < parts.length - 1; i++) if (SKIP_DIRS.has(parts[i])) return false;
    return !SKIP_FILES.has(parts[parts.length - 1]);
  });
}

function commonRoot(paths) {
  if (!paths.length) return null;
  const i = paths[0].indexOf('/');
  if (i === -1) return null;
  const root = paths[0].slice(0, i);
  return paths.every((p) => p.startsWith(root + '/')) ? root : null;
}

/** Pratinjau ZIP sepenuhnya di browser (tanpa upload). */
async function previewZipLocal(file) {
  if (file.size > state.config.maxUploadMB * 1048576) {
    return note('err', `ZIP ${(fmtSize(file.size))} melebihi batas <b>${state.config.maxUploadMB} MB</b> di Vercel (limit 4,5 MB per request). Gunakan CLI atau server sendiri untuk file besar.`);
  }
  showUploadProgress(true);
  $('#upText').textContent = 'Membaca daftar isi ZIP di browser…';
  $('#upBar').style.width = '40%';
  try {
    const entries = await scanZipLocal(file);
    const strip = $('#stripRoot').checked;
    let list = entries.filter((e) => !e.dir);
    const enc = list.filter((e) => e.encrypted);
    if (enc.length) note('warn', `${enc.length} file di ZIP terenkripsi password — tidak bisa di-push ke GitHub.`, '#demoBanner');
    let paths = list.map((e) => e.path);
    const kept = filteredPaths(paths);
    const root = strip ? commonRoot(kept) : null;
    const files = list
      .filter((e) => kept.includes(e.path))
      .map((e) => ({ path: root ? e.path.slice(root.length + 1) : e.path, size: e.size }));

    state.localZip = { file, entries };
    state.upload = {
      kind: 'zip', local: true, originalName: file.name, strippedRoot: root,
      skipped: paths.length - kept.length,
      totalFiles: files.length,
      totalDirs: new Set(files.flatMap((f) => f.path.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/')))).size,
      totalSize: files.reduce((a, f) => a + f.size, 0) + file.size * 0, // ukuran terkompresi dihitung terpisah
      zipSize: file.size,
      largest: [...files].sort((a, b) => b.size - a.size).slice(0, 5),
      topExtensions: (() => {
        const m = {};
        files.forEach((f) => { const e = (f.path.split('.').pop() || 'tanpa-ekstensi').toLowerCase(); m[e] = (m[e] || 0) + 1; });
        return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([ext, count]) => ({ ext, count }));
      })(),
      files,
    };
    renderUpload();
    log(`ZIP <b>${esc(file.name)}</b> dibaca di browser: ${files.length} file, ${fmtSize(state.upload.totalSize)} (arsip ${fmtSize(file.size)})`, 'ok');
    if (files.length === 0) note('err', 'Tidak ada file yang bisa di-push dari ZIP ini.', '#demoBanner');
    const big = files.filter((f) => f.size > 100 * 1048576);
    if (big.length) note('warn', `File melebihi batas 100 MB API GitHub: ${big.map((f) => esc(f.path)).join(', ')}`, '#demoBanner');
  } catch (e) {
    note('err', 'Gagal membaca ZIP: ' + esc(e.message), '#demoBanner');
  } finally {
    showUploadProgress(false);
  }
}

/** Pratinjau folder di browser (tanpa upload). */
function previewFolderLocal(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const zip = files.find((f) => /\.zip$/i.test(f.name));
  if (zip && files.length === 1) return previewZipLocal(zip);

  const rel = files.map((f) => f.webkitRelativePath || f.relativePath || f.name);
  const kept = filteredPaths(rel);
  const root = commonRoot(kept);
  const list = files
    .map((f, i) => ({ f, rel: rel[i] }))
    .filter((x) => kept.includes(x.rel))
    .map((x) => ({ file: x.f, path: root ? x.rel.slice(root.length + 1) : x.rel, size: x.f.size }));

  state.localFolder = list;
  state.upload = {
    kind: 'folder', local: true, strippedRoot: root, skipped: rel.length - kept.length,
    totalFiles: list.length,
    totalSize: list.reduce((a, f) => a + f.size, 0),
    largest: [...list].sort((a, b) => b.size - a.size).slice(0, 5).map((f) => ({ path: f.path, size: f.size })),
    topExtensions: (() => {
      const m = {};
      list.forEach((f) => { const e = (f.path.split('.').pop() || 'tanpa-ekstensi').toLowerCase(); m[e] = (m[e] || 0) + 1; });
      return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([ext, count]) => ({ ext, count }));
    })(),
    files: list.map((f) => ({ path: f.path, size: f.size })),
  };
  renderUpload();
  log(`Folder dibaca di browser: ${list.length} file, ${fmtSize(state.upload.totalSize)}`, 'ok');
  updatePushReady();
}

/** Upload + push dalam satu request (multipart). */
async function doOneShotPush(payload) {
  const fd = new FormData();
  if (state.localZip) {
    fd.append('zip', state.localZip.file, state.localZip.file.name);
  } else if (state.localFolder && state.localFolder.length) {
    const relPaths = [];
    for (const it of state.localFolder) {
      const rel = it.file.webkitRelativePath || it.file.relativePath || it.path;
      fd.append('files', it.file, rel);
      relPaths.push(rel);
    }
    fd.append('relPaths', JSON.stringify(relPaths));
  } else {
    alert('Pilih ZIP atau folder terlebih dahulu.');
    return;
  }
  fd.append('stripRoot', $('#stripRoot').checked ? '1' : '0');
  if ($('#codepage') && $('#codepage').value) fd.append('codepage', $('#codepage').value);
  for (const [k, v] of Object.entries(payload)) {
    if (v === null || v === undefined || v === '') continue;
    fd.append(k, typeof v === 'boolean' ? String(v) : String(v));
  }

  if (state.config.oneshot) return doOneShotPush(payload);

  $('#resultCard').classList.remove('hidden');
  $('#log').innerHTML = ''; $('#resultNote').innerHTML = ''; $('#resultLinks').innerHTML = '';
  $('#resultTag').textContent = 'memproses…';
  $('#pushProgress').classList.remove('hidden');
  $('#pushBar').style.width = '5%';
  $('#pushStage').textContent = 'Mengupload ke fungsi Vercel…';
  $('#btnPush').disabled = true;
  log(`Mode sekali jalan: upload ${state.localZip ? 'ZIP' : 'folder'} + push dalam 1 request.`);
  startProgressPolling();

  try {
    const r = await uploadXhr('/api/push-upload', fd, (p) => {
      $('#pushBar').style.width = (5 + p * 40).toFixed(1) + '%';
      if (p >= 1) $('#pushStage').textContent = 'Mengekstrak & push di server…';
    });
    stopProgressPolling();
    $('#pushBar').style.width = '100%';
    renderPushResult(r);
  } catch (e) {
    stopProgressPolling();
    $('#resultTag').textContent = 'gagal';
    $('#pushStage').textContent = 'Gagal';
    note('err', `<b>Push gagal:</b> ${esc(e.message)}${e.hint ? '<br/>' + esc(e.hint) : ''}`, '#resultNote');
    log('✖ ' + esc(e.message), 'err');
  } finally {
    $('#btnPush').disabled = false;
    updatePushReady();
  }
}

/* ==================================================================
 * APP VIEW
 * ================================================================== */
async function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  renderWho();

  if (state.config.mockEnabled && $('#optMockRow')) $('#optMockRow').classList.remove('hidden');
  if (state.config.oneshot) {
    note('info', `<b>Mode serverless (Vercel).</b> Upload &amp; push digabung jadi satu request karena <code>/tmp</code> tidak persisten.
      Batas Vercel: <b>4,5 MB</b> per request (tidak bisa dinaikkan) — untuk proyek lebih besar pakai <code>cli/push.js</code> dari komputer Anda atau deploy ke VPS/Railway/Render.`, '#demoBanner');
    const t = $('#fileTag'); if (t) t.textContent = 'pratinjau lokal';
  }
  if (state.config.demoMode || state.me.provider === 'demo') {
    $('#demoBanner').innerHTML = '';
    note('warn', `<b>Mode demo aktif.</b> Push hanya menghasilkan <i>dry-run</i> (rencana commit), tidak benar-benar menulis ke GitHub.
      Isi <code>GITHUB_CLIENT_ID</code> + <code>GITHUB_CLIENT_SECRET</code> di <code>.env</code> untuk mengaktifkan push sungguhan.`, '#demoBanner');
  }
  if (state.me.provider === 'google' && !state.me.github.connected) {
    note('warn', `Anda login lewat <b>Google</b>. Google tidak memberi akses ke GitHub —
      <a href="#" id="linkPatNow">hubungkan Personal Access Token</a> (scope <code>repo</code>) agar bisa push.`, '#demoBanner');
    const a = document.getElementById('linkPatNow');
    if (a) a.onclick = (e) => { e.preventDefault(); openPatDialog(); };
  }

  await Promise.all([loadRepos(), loadExistingUpload()]);
  bindApp();
}

function renderWho() {
  const u = state.me.profile || {};
  const via = { oauth: 'GitHub OAuth', pat: 'Personal Access Token', env: 'token dari .env', demo: null }[state.me.github?.via] || (state.me.provider === 'google' ? 'Google' : 'demo');
  $('#whoBox').classList.remove('hidden');
  $('#whoBox').innerHTML = `
    <div class="who">
      ${u.avatar ? `<img src="${esc(u.avatar)}" alt="" referrerpolicy="no-referrer" />` : ''}
      <div>
        <div class="nm">${esc(u.name || u.login || 'user')}</div>
        <div class="via">${esc(u.login || '')} · ${esc(via)}</div>
      </div>
    </div>
    <button class="ghost" id="btnLogout" style="margin-left:8px">Logout</button>`;
  $('#btnLogout').onclick = async () => {
    await api('/api/logout', { method: 'POST' });
    location.href = '/?notice=logged-out';
  };
}

function openPatDialog() {
  const token = prompt('Tempel GitHub Personal Access Token (scope repo):');
  if (!token) return;
  api('/api/link-token', { method: 'POST', body: { token: token.trim() } })
    .then((r) => { note('ok', `Token terhubung sebagai <b>${esc(r.githubLogin)}</b>.`); setTimeout(() => location.reload(), 900); })
    .catch((e) => note('err', esc(e.message)));
}

/* ---------------- repos ---------------- */
async function loadRepos() {
  try {
    const r = await api('/api/repos?includeOrgs=0');
    state.repos = r.repos || [];
    renderRepos('');
    if (r.notice) $('#repoMeta').textContent = r.notice;
  } catch (e) {
    $('#repoSelect').innerHTML = '';
    note('err', 'Gagal memuat daftar repo: ' + esc(e.message) + (e.hint ? ' — ' + esc(e.hint) : ''), '#demoBanner');
  }
}

function renderRepos(filter) {
  const sel = $('#repoSelect');
  const f = filter.trim().toLowerCase();
  const list = state.repos.filter((r) => !f || r.full_name.toLowerCase().includes(f));
  sel.innerHTML = list.map((r) =>
    `<option value="${esc(r.full_name)}" data-default="${esc(r.default_branch || 'main')}" data-priv="${r.private ? 1 : 0}" data-perm="${esc(r.permission || '')}">
      ${esc(r.full_name)}${r.private ? '  🔒' : ''}
    </option>`).join('') || '<option disabled>— tidak ada repo yang cocok —</option>';
  $('#repoTag').textContent = `${list.length} repo`;
  if (!state.selectedRepo && list.length) sel.value = list[0].value;
  updatePushReady();
}

async function onRepoChange() {
  const sel = $('#repoSelect');
  const full = sel.value;
  if (!full || !full.includes('/')) return;
  const opt = sel.options[sel.selectedIndex];
  state.selectedRepo = {
    full_name: full,
    default_branch: opt?.dataset.default || 'main',
    private: opt?.dataset.priv === '1',
    permission: opt?.dataset.perm || '',
  };
  $('#repoMeta').innerHTML = `branch utama: <b>${esc(state.selectedRepo.default_branch)}</b> ·
    ${state.selectedRepo.private ? '<span class="pill priv">privat</span>' : '<span class="pill">publik</span>'}
    <span class="pill">izin: ${esc(state.selectedRepo.permission || '?')}</span>`;
  $('#branchSelect').innerHTML = '<option disabled>memuat branch…</option>';
  state.branches = [];
  try {
    const r = await api(`/api/branches/${encodeURIComponent(state.selectedRepo.owner || full.split('/')[0])}/${encodeURIComponent(full.split('/')[1])}`);
    state.branches = r.branches || [];
    $('#branchSelect').innerHTML = state.branches.map((b) =>
      `<option value="${esc(b.name)}"${b.protected ? ' data-prot="1"' : ''}>${esc(b.name)}${b.protected ? '  🛡 (protected)' : ''}</option>`).join('')
      || `<option value="${esc(r.default_branch || 'main')}">${esc(r.default_branch || 'main')} (baru)</option>`;
    state.branch = $('#branchSelect').value;
    const prot = $('#branchSelect').selectedOptions[0]?.dataset.prot === '1';
    $('#branchMeta').innerHTML = prot
      ? '⚠ Branch ini <b>protected</b> — push langsung bisa ditolak (422). Pertimbangkan branch baru.'
      : `${state.branches.length} branch tersedia.`;
  } catch (e) {
    $('#branchSelect').innerHTML = `<option value="${esc(state.selectedRepo.default_branch)}">${esc(state.selectedRepo.default_branch)}</option>`;
    state.branch = state.selectedRepo.default_branch;
    $('#branchMeta').textContent = 'Gagal memuat branch: ' + e.message;
  }
  state.useNewBranch = false;
  updatePushReady();
}

/* ---------------- upload ---------------- */
function setTab(kind) {
  $('#tabZip').classList.toggle('on', kind === 'zip');
  $('#tabFolder').classList.toggle('on', kind === 'folder');
  $('#paneZip').classList.toggle('hidden', kind !== 'zip');
  $('#paneFolder').classList.toggle('hidden', kind !== 'folder');
}

function showUploadProgress(on) {
  $('#uploadProgress').classList.toggle('hidden', !on);
  if (!on) $('#upBar').style.width = '0%';
}

async function handleZipFile(file) {
  if (!file) return;
  if (state.config.oneshot) return previewZipLocal(file);
  if (!/\.zip$/i.test(file.name)) return note('err', 'File harus berformat <code>.zip</code>. Untuk folder biasa, gunakan tab <b>📁 Folder</b>.');
  if (file.size > state.config.maxUploadMB * 1048576) return note('err', `File ${(fmtSize(file.size))} melebihi batas ${state.config.maxUploadMB} MB.`);
  const fd = new FormData();
  fd.append('zip', file);
  fd.append('stripRoot', $('#stripRoot').checked ? '1' : '0');
  if ($('#codepage') && $('#codepage').value) fd.append('codepage', $('#codepage').value);
  showUploadProgress(true);
  $('#upText').textContent = `Mengupload ${file.name} (${fmtSize(file.size)})…`;
  const stopPoll = startExtractPolling();
  try {
    const r = await uploadXhr('/api/files/zip', fd, (p) => {
      $('#upBar').style.width = (p * 100).toFixed(1) + '%';
      if (p >= 1) $('#upText').textContent = 'Mengekstrak ZIP di server…';
    });
    state.upload = r;
    renderUpload();
    log(`ZIP <b>${esc(file.name)}</b> diekstrak: ${r.totalFiles} file, ${fmtSize(r.totalSize)}${r.skipped ? ` · ${r.skipped} entri dilewati` : ''}`, 'ok');
  } catch (e) {
    note('err', 'Upload ZIP gagal: ' + esc(e.message) + (e.hint ? ' — ' + esc(e.hint) : ''));
  } finally {
    stopPoll();
    showUploadProgress(false);
  }
}

async function handleFolderFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (state.config.oneshot) return previewFolderLocal(files);
  const zips = files.filter((f) => /\.zip$/i.test(f.name));
  if (zips.length === 1 && files.length === 1) return handleZipFile(zips[0]);
  if (files.length > state.config.maxFiles) return note('err', `Jumlah file (${files.length}) melebihi batas ${state.config.maxFiles}.`);
  const fd = new FormData();
  let total = 0;
  const relPaths = [];
  for (const f of files) {
    const rel = f.webkitRelativePath || f.relativePath || f.name;
    fd.append('files', f, rel);
    relPaths.push(rel);
    total += f.size;
  }
  // cadangan bila originalname kehilangan struktur folder (browser lama)
  if (relPaths.every((p) => p && p.length)) fd.append('relPaths', JSON.stringify(relPaths));

  showUploadProgress(true);
  $('#upText').textContent = `Mengupload ${files.length} file (${fmtSize(total)})…`;
  const stopPoll = startExtractPolling();
  try {
    const r = await uploadXhr('/api/files/folder', fd, (p) => { $('#upBar').style.width = (p * 100).toFixed(1) + '%'; });
    state.upload = r;
    renderUpload();
    log(`Folder diupload: ${r.totalFiles} file, ${fmtSize(r.totalSize)}${r.skipped ? ` · ${r.skipped} dilewati (node_modules/.git/dsb)` : ''}`, 'ok');
  } catch (e) {
    note('err', 'Upload folder gagal: ' + esc(e.message) + (e.hint ? ' — ' + esc(e.hint) : ''));
  } finally {
    stopPoll();
    showUploadProgress(false);
  }
}

/* tampilkan progres ekstraksi sisi server saat upload sudah 100% */
function startExtractPolling() {
  if (state.config.oneshot) return () => {}; // serverless: ekstraksi terjadi saat push
  const t = setInterval(async () => {
    try {
      const p = await api('/api/files/progress');
      if (p && p.total) {
        $('#upText').textContent = `Memproses file di server… ${p.done}/${p.total}`;
        $('#upBar').style.width = '100%';
      }
    } catch (_) {}
  }, 700);
  return () => clearInterval(t);
}

function renderUpload() {
  const u = state.upload;
  if (!u || !u.files) { $('#fileSummary').classList.add('hidden'); $('#fileTag').textContent = 'belum ada file'; return; }
  $('#fileSummary').classList.remove('hidden');
  $('#fileTag').textContent = `${u.totalFiles} file siap di-push`;
  $('#statsBox').innerHTML = `
    <div><b>${u.totalFiles}</b>file</div>
    <div><b>${u.totalDirs || 0}</b>folder</div>
    <div><b>${fmtSize(u.totalSize)}</b>total ukuran</div>
    <div><b>${(u.topExtensions || []).slice(0, 4).map((e) => `.${esc(e.ext)} (${e.count})`).join(', ') || '-'}</b>tipe terbanyak</div>`;
  $('#rootInfo').textContent = u.strippedRoot ? `folder pembungkus "${u.strippedRoot}" dibuang` : '';

  // susun tampilan tree sederhana (folder + file, maks 400 baris)
  const dirs = new Set();
  const rows = [];
  for (const f of u.files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    rows.push({ path: f.path, size: f.size, dir: false });
  }
  for (const d of dirs) rows.push({ path: d + '/', size: null, dir: true });
  rows.sort((a, b) => a.path.localeCompare(b.path));
  const shown = rows.slice(0, 400);
  $('#fileTree').innerHTML = shown.map((r) =>
    `<li class="${r.dir ? 'dir' : ''}"><span>${r.dir ? '📁' : '📄'} ${esc(r.path)}</span>${r.size != null ? `<span class="sz">${fmtSize(r.size)}</span>` : ''}</li>`).join('')
    + (rows.length > shown.length ? `<li class="dir">… +${rows.length - shown.length} baris lagi</li>` : '');

  const big = (u.largest || []).filter((f) => f.size > 90 * 1048576);
  if (big.length) note('warn', `Ada file mendekati/melebihi batas 100 MB API GitHub: ${big.map((b) => esc(b.path) + ' (' + fmtSize(b.size) + ')').join(', ')}`, '#demoBanner');
  updatePushReady();
}

async function loadExistingUpload() {
  if (state.config.oneshot) return; // tidak ada penyimpanan antar-request
  try {
    const r = await api('/api/files');
    if (r.has) { state.upload = r; renderUpload(); log('File dari sesi sebelumnya masih tersedia di server.', 'dim'); }
  } catch (_) {}
}

/* ---------------- push ---------------- */
function currentBranch() {
  return state.useNewBranch ? ($('#newBranch').value.trim() || state.branch) : ($('#branchSelect').value || state.branch);
}

function updatePushReady() {
  const okFiles = !!(state.upload && state.upload.files && state.upload.files.length);
  const okRepo = !!$('#repoSelect').value;
  const okBranch = !!currentBranch();
  $('#btnPush').disabled = !(okFiles && okRepo && okBranch);
  $('#btnPreview').disabled = !okFiles;
}

function buildPayload(extra = {}) {
  return {
    repo: $('#repoSelect').value,
    branch: currentBranch(),
    destPath: $('#destPath').value.trim(),
    message: $('#commitMsg').value.trim(),
    createBranch: state.useNewBranch,
    baseBranch: $('#optBaseBranch').value.trim(),
    overwrite: $('#optOverwrite').checked,
    deleteExisting: $('#optDelete').checked,
    dryRun: $('#optDry').checked,
    useMock: $('#optMock') ? $('#optMock').checked : false,
    ...extra,
  };
}

async function doPreview() {
  if (state.config.oneshot) {
    const fd = new FormData();
    if (state.localZip) fd.append('zip', state.localZip.file, state.localZip.file.name);
    else if (state.localFolder) {
      const relPaths = [];
      for (const it of state.localFolder) {
        const rel = it.file.webkitRelativePath || it.file.relativePath || it.path;
        fd.append('files', it.file, rel); relPaths.push(rel);
      }
      fd.append('relPaths', JSON.stringify(relPaths));
    } else return alert('Pilih ZIP atau folder terlebih dahulu.');
    fd.append('stripRoot', $('#stripRoot').checked ? '1' : '0');
    Object.entries(buildPayload({ dryRun: true })).forEach(([k, v]) => {
      if (v !== null && v !== undefined && v !== '') fd.append(k, String(v));
    });
    $('#resultCard').classList.remove('hidden');
    $('#log').innerHTML = ''; $('#resultNote').innerHTML = ''; $('#resultLinks').innerHTML = '';
    try {
      const r = await uploadXhr('/api/push-upload', fd, () => {});
      $('#pushProgress').classList.add('hidden');
      renderPushResult(r);
    } catch (e) {
      $('#resultTag').textContent = 'gagal';
      note('err', esc(e.message), '#resultNote');
    }
    return;
  }
  $('#resultCard').classList.remove('hidden');
  $('#log').innerHTML = '';
  $('#resultNote').innerHTML = '';
  $('#resultLinks').innerHTML = '';
  try {
    const r = await api('/api/push', { method: 'POST', body: buildPayload({ dryRun: true }) });
    $('#resultTag').textContent = 'rencana commit';
    note('info', `<b>Dry-run.</b> Tidak ada yang dikirim ke GitHub.<br/>
      Repo <b>${esc(r.plan.repo)}</b> · branch <b>${esc(r.plan.branch)}</b>${r.plan.createBranch ? ' (baru)' : ''} · folder <b>${esc(r.plan.destPath)}</b><br/>
      ${r.plan.files} file · ${fmtSize(r.plan.bytes)} · pesan: "${esc(r.plan.message)}"<br/>
      <span style="color:var(--fg3)">Urutan API: ${r.plan.apiCalls.map(esc).join(' → ')}</span>`, '#resultNote');
    r.preview.slice(0, 60).forEach((f) => log(`📄 ${esc(f.path)}  <span class="dim">${fmtSize(f.size)}</span>`));
    if (r.preview.length > 60) log(`… +${r.preview.length - 60} file lainnya`, 'dim');
  } catch (e) {
    $('#resultTag').textContent = 'gagal';
    note('err', esc(e.message) + (e.hint ? ' — ' + esc(e.hint) : ''), '#resultNote');
  }
}

async function doPush() {
  const payload = buildPayload();
  if (!payload.repo) return alert('Pilih repository dulu.');
  if (!payload.branch) return alert('Tentukan branch tujuan.');

  // validasi branch: sudah ada atau memang mau dibuat baru
  if (!payload.createBranch && state.branches.length && !state.branches.some((b) => b.name === payload.branch)) {
    const yes = confirm(`Branch "${payload.branch}" belum ada di repo ini.\n\nBuat branch baru dari "${state.selectedRepo?.default_branch || 'main'}"?`);
    if (!yes) return;
    payload.createBranch = true;
  }
  if (payload.createBranch && state.branches.some((b) => b.name === payload.branch)) {
    payload.createBranch = false; // branch-nya ternyata sudah ada
  }
  if (payload.deleteExisting && payload.destPath &&
      !confirm(`File lama di folder "${payload.destPath}" yang tidak ada di upload akan DIHAPUS dari branch ${payload.branch}. Lanjutkan?`)) return;

  if (state.config.oneshot) return doOneShotPush(payload);

  $('#resultCard').classList.remove('hidden');
  $('#log').innerHTML = ''; $('#resultNote').innerHTML = ''; $('#resultLinks').innerHTML = '';
  $('#resultTag').textContent = 'memproses…';
  $('#pushProgress').classList.remove('hidden');
  $('#pushBar').style.width = '5%';
  $('#pushStage').textContent = 'Menghubungi GitHub…';
  $('#btnPush').disabled = true;

  log(`Mulai push ${state.upload.totalFiles} file ke <b>${esc(payload.repo)}</b> → <b>${esc(payload.branch)}</b>${payload.destPath ? '/' + esc(payload.destPath) : ''}`);
  startProgressPolling();

  try {
    const r = await api('/api/push', { method: 'POST', body: payload });
    stopProgressPolling();
    $('#pushBar').style.width = '100%';

    renderPushResult(r);
  } catch (e) {
    stopProgressPolling();
    $('#resultTag').textContent = 'gagal';
    $('#pushStage').textContent = 'Gagal';
    note('err', `<b>Push gagal:</b> ${esc(e.message)}${e.hint ? '<br/>' + esc(e.hint) : ''}`, '#resultNote');
    log('✖ ' + esc(e.message), 'err');
  } finally {
    $('#btnPush').disabled = false;
    updatePushReady();
  }
}

/* ==================================================================
 * APP VIEW
 * ================================================================== */
async function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  renderWho();

  if (state.config.mockEnabled && $('#optMockRow')) $('#optMockRow').classList.remove('hidden');
  if (state.config.oneshot) {
    note('info', `<b>Mode serverless (Vercel).</b> Upload &amp; push digabung jadi satu request karena <code>/tmp</code> tidak persisten.
      Batas Vercel: <b>4,5 MB</b> per request (tidak bisa dinaikkan) — untuk proyek lebih besar pakai <code>cli/push.js</code> dari komputer Anda atau deploy ke VPS/Railway/Render.`, '#demoBanner');
    const t = $('#fileTag'); if (t) t.textContent = 'pratinjau lokal';
  }
  if (state.config.demoMode || state.me.provider === 'demo') {
    $('#demoBanner').innerHTML = '';
    note('warn', `<b>Mode demo aktif.</b> Push hanya menghasilkan <i>dry-run</i> (rencana commit), tidak benar-benar menulis ke GitHub.
      Isi <code>GITHUB_CLIENT_ID</code> + <code>GITHUB_CLIENT_SECRET</code> di <code>.env</code> untuk mengaktifkan push sungguhan.`, '#demoBanner');
  }
  if (state.me.provider === 'google' && !state.me.github.connected) {
    note('warn', `Anda login lewat <b>Google</b>. Google tidak memberi akses ke GitHub —
      <a href="#" id="linkPatNow">hubungkan Personal Access Token</a> (scope <code>repo</code>) agar bisa push.`, '#demoBanner');
    const a = document.getElementById('linkPatNow');
    if (a) a.onclick = (e) => { e.preventDefault(); openPatDialog(); };
  }

  await Promise.all([loadRepos(), loadExistingUpload()]);
  bindApp();
}

function renderWho() {
  const u = state.me.profile || {};
  const via = { oauth: 'GitHub OAuth', pat: 'Personal Access Token', env: 'token dari .env', demo: null }[state.me.github?.via] || (state.me.provider === 'google' ? 'Google' : 'demo');
  $('#whoBox').classList.remove('hidden');
  $('#whoBox').innerHTML = `
    <div class="who">
      ${u.avatar ? `<img src="${esc(u.avatar)}" alt="" referrerpolicy="no-referrer" />` : ''}
      <div>
        <div class="nm">${esc(u.name || u.login || 'user')}</div>
        <div class="via">${esc(u.login || '')} · ${esc(via)}</div>
      </div>
    </div>
    <button class="ghost" id="btnLogout" style="margin-left:8px">Logout</button>`;
  $('#btnLogout').onclick = async () => {
    await api('/api/logout', { method: 'POST' });
    location.href = '/?notice=logged-out';
  };
}

function openPatDialog() {
  const token = prompt('Tempel GitHub Personal Access Token (scope repo):');
  if (!token) return;
  api('/api/link-token', { method: 'POST', body: { token: token.trim() } })
    .then((r) => { note('ok', `Token terhubung sebagai <b>${esc(r.githubLogin)}</b>.`); setTimeout(() => location.reload(), 900); })
    .catch((e) => note('err', esc(e.message)));
}

/* ---------------- repos ---------------- */
async function loadRepos() {
  try {
    const r = await api('/api/repos?includeOrgs=0');
    state.repos = r.repos || [];
    renderRepos('');
    if (r.notice) $('#repoMeta').textContent = r.notice;
  } catch (e) {
    $('#repoSelect').innerHTML = '';
    note('err', 'Gagal memuat daftar repo: ' + esc(e.message) + (e.hint ? ' — ' + esc(e.hint) : ''), '#demoBanner');
  }
}

function renderRepos(filter) {
  const sel = $('#repoSelect');
  const f = filter.trim().toLowerCase();
  const list = state.repos.filter((r) => !f || r.full_name.toLowerCase().includes(f));
  sel.innerHTML = list.map((r) =>
    `<option value="${esc(r.full_name)}" data-default="${esc(r.default_branch || 'main')}" data-priv="${r.private ? 1 : 0}" data-perm="${esc(r.permission || '')}">
      ${esc(r.full_name)}${r.private ? '  🔒' : ''}
    </option>`).join('') || '<option disabled>— tidak ada repo yang cocok —</option>';
  $('#repoTag').textContent = `${list.length} repo`;
  if (!state.selectedRepo && list.length) sel.value = list[0].value;
  updatePushReady();
}

async function onRepoChange() {
  const sel = $('#repoSelect');
  const full = sel.value;
  if (!full || !full.includes('/')) return;
  const opt = sel.options[sel.selectedIndex];
  state.selectedRepo = {
    full_name: full,
    default_branch: opt?.dataset.default || 'main',
    private: opt?.dataset.priv === '1',
    permission: opt?.dataset.perm || '',
  };
  $('#repoMeta').innerHTML = `branch utama: <b>${esc(state.selectedRepo.default_branch)}</b> ·
    ${state.selectedRepo.private ? '<span class="pill priv">privat</span>' : '<span class="pill">publik</span>'}
    <span class="pill">izin: ${esc(state.selectedRepo.permission || '?')}</span>`;
  $('#branchSelect').innerHTML = '<option disabled>memuat branch…</option>';
  state.branches = [];
  try {
    const r = await api(`/api/branches/${encodeURIComponent(state.selectedRepo.owner || full.split('/')[0])}/${encodeURIComponent(full.split('/')[1])}`);
    state.branches = r.branches || [];
    $('#branchSelect').innerHTML = state.branches.map((b) =>
      `<option value="${esc(b.name)}"${b.protected ? ' data-prot="1"' : ''}>${esc(b.name)}${b.protected ? '  🛡 (protected)' : ''}</option>`).join('')
      || `<option value="${esc(r.default_branch || 'main')}">${esc(r.default_branch || 'main')} (baru)</option>`;
    state.branch = $('#branchSelect').value;
    const prot = $('#branchSelect').selectedOptions[0]?.dataset.prot === '1';
    $('#branchMeta').innerHTML = prot
      ? '⚠ Branch ini <b>protected</b> — push langsung bisa ditolak (422). Pertimbangkan branch baru.'
      : `${state.branches.length} branch tersedia.`;
  } catch (e) {
    $('#branchSelect').innerHTML = `<option value="${esc(state.selectedRepo.default_branch)}">${esc(state.selectedRepo.default_branch)}</option>`;
    state.branch = state.selectedRepo.default_branch;
    $('#branchMeta').textContent = 'Gagal memuat branch: ' + e.message;
  }
  state.useNewBranch = false;
  updatePushReady();
}

/* ---------------- upload ---------------- */
function setTab(kind) {
  $('#tabZip').classList.toggle('on', kind === 'zip');
  $('#tabFolder').classList.toggle('on', kind === 'folder');
  $('#paneZip').classList.toggle('hidden', kind !== 'zip');
  $('#paneFolder').classList.toggle('hidden', kind !== 'folder');
}

function showUploadProgress(on) {
  $('#uploadProgress').classList.toggle('hidden', !on);
  if (!on) $('#upBar').style.width = '0%';
}

async function handleZipFile(file) {
  if (!file) return;
  if (state.config.oneshot) return previewZipLocal(file);
  if (!/\.zip$/i.test(file.name)) return note('err', 'File harus berformat <code>.zip</code>. Untuk folder biasa, gunakan tab <b>📁 Folder</b>.');
  if (file.size > state.config.maxUploadMB * 1048576) return note('err', `File ${(fmtSize(file.size))} melebihi batas ${state.config.maxUploadMB} MB.`);
  const fd = new FormData();
  fd.append('zip', file);
  fd.append('stripRoot', $('#stripRoot').checked ? '1' : '0');
  if ($('#codepage') && $('#codepage').value) fd.append('codepage', $('#codepage').value);
  showUploadProgress(true);
  $('#upText').textContent = `Mengupload ${file.name} (${fmtSize(file.size)})…`;
  const stopPoll = startExtractPolling();
  try {
    const r = await uploadXhr('/api/files/zip', fd, (p) => {
      $('#upBar').style.width = (p * 100).toFixed(1) + '%';
      if (p >= 1) $('#upText').textContent = 'Mengekstrak ZIP di server…';
    });
    state.upload = r;
    renderUpload();
    log(`ZIP <b>${esc(file.name)}</b> diekstrak: ${r.totalFiles} file, ${fmtSize(r.totalSize)}${r.skipped ? ` · ${r.skipped} entri dilewati` : ''}`, 'ok');
  } catch (e) {
    note('err', 'Upload ZIP gagal: ' + esc(e.message) + (e.hint ? ' — ' + esc(e.hint) : ''));
  } finally {
    stopPoll();
    showUploadProgress(false);
  }
}

async function handleFolderFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (state.config.oneshot) return previewFolderLocal(files);
  const zips = files.filter((f) => /\.zip$/i.test(f.name));
  if (zips.length === 1 && files.length === 1) return handleZipFile(zips[0]);
  if (files.length > state.config.maxFiles) return note('err', `Jumlah file (${files.length}) melebihi batas ${state.config.maxFiles}.`);
  const fd = new FormData();
  let total = 0;
  const relPaths = [];
  for (const f of files) {
    const rel = f.webkitRelativePath || f.relativePath || f.name;
    fd.append('files', f, rel);
    relPaths.push(rel);
    total += f.size;
  }
  // cadangan bila originalname kehilangan struktur folder (browser lama)
  if (relPaths.every((p) => p && p.length)) fd.append('relPaths', JSON.stringify(relPaths));

  showUploadProgress(true);
  $('#upText').textContent = `Mengupload ${files.length} file (${fmtSize(total)})…`;
  const stopPoll = startExtractPolling();
  try {
    const r = await uploadXhr('/api/files/folder', fd, (p) => { $('#upBar').style.width = (p * 100).toFixed(1) + '%'; });
    state.upload = r;
    renderUpload();
    log(`Folder diupload: ${r.totalFiles} file, ${fmtSize(r.totalSize)}${r.skipped ? ` · ${r.skipped} dilewati (node_modules/.git/dsb)` : ''}`, 'ok');
  } catch (e) {
    note('err', 'Upload folder gagal: ' + esc(e.message) + (e.hint ? ' — ' + esc(e.hint) : ''));
  } finally {
    stopPoll();
    showUploadProgress(false);
  }
}

/* tampilkan progres ekstraksi sisi server saat upload sudah 100% */
function startExtractPolling() {
  if (state.config.oneshot) return () => {}; // serverless: ekstraksi terjadi saat push
  const t = setInterval(async () => {
    try {
      const p = await api('/api/files/progress');
      if (p && p.total) {
        $('#upText').textContent = `Memproses file di server… ${p.done}/${p.total}`;
        $('#upBar').style.width = '100%';
      }
    } catch (_) {}
  }, 700);
  return () => clearInterval(t);
}

function renderUpload() {
  const u = state.upload;
  if (!u || !u.files) { $('#fileSummary').classList.add('hidden'); $('#fileTag').textContent = 'belum ada file'; return; }
  $('#fileSummary').classList.remove('hidden');
  $('#fileTag').textContent = `${u.totalFiles} file siap di-push`;
  $('#statsBox').innerHTML = `
    <div><b>${u.totalFiles}</b>file</div>
    <div><b>${u.totalDirs || 0}</b>folder</div>
    <div><b>${fmtSize(u.totalSize)}</b>total ukuran</div>
    <div><b>${(u.topExtensions || []).slice(0, 4).map((e) => `.${esc(e.ext)} (${e.count})`).join(', ') || '-'}</b>tipe terbanyak</div>`;
  $('#rootInfo').textContent = u.strippedRoot ? `folder pembungkus "${u.strippedRoot}" dibuang` : '';

  // susun tampilan tree sederhana (folder + file, maks 400 baris)
  const dirs = new Set();
  const rows = [];
  for (const f of u.files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    rows.push({ path: f.path, size: f.size, dir: false });
  }
  for (const d of dirs) rows.push({ path: d + '/', size: null, dir: true });
  rows.sort((a, b) => a.path.localeCompare(b.path));
  const shown = rows.slice(0, 400);
  $('#fileTree').innerHTML = shown.map((r) =>
    `<li class="${r.dir ? 'dir' : ''}"><span>${r.dir ? '📁' : '📄'} ${esc(r.path)}</span>${r.size != null ? `<span class="sz">${fmtSize(r.size)}</span>` : ''}</li>`).join('')
    + (rows.length > shown.length ? `<li class="dir">… +${rows.length - shown.length} baris lagi</li>` : '');

  const big = (u.largest || []).filter((f) => f.size > 90 * 1048576);
  if (big.length) note('warn', `Ada file mendekati/melebihi batas 100 MB API GitHub: ${big.map((b) => esc(b.path) + ' (' + fmtSize(b.size) + ')').join(', ')}`, '#demoBanner');
  updatePushReady();
}

async function loadExistingUpload() {
  if (state.config.oneshot) return; // tidak ada penyimpanan antar-request
  try {
    const r = await api('/api/files');
    if (r.has) { state.upload = r; renderUpload(); log('File dari sesi sebelumnya masih tersedia di server.', 'dim'); }
  } catch (_) {}
}

/* ---------------- push ---------------- */
function currentBranch() {
  return state.useNewBranch ? ($('#newBranch').value.trim() || state.branch) : ($('#branchSelect').value || state.branch);
}

function updatePushReady() {
  const okFiles = !!(state.upload && state.upload.files && state.upload.files.length);
  const okRepo = !!$('#repoSelect').value;
  const okBranch = !!currentBranch();
  $('#btnPush').disabled = !(okFiles && okRepo && okBranch);
  $('#btnPreview').disabled = !okFiles;
}

function buildPayload(extra = {}) {
  return {
    repo: $('#repoSelect').value,
    branch: currentBranch(),
    destPath: $('#destPath').value.trim(),
    message: $('#commitMsg').value.trim(),
    createBranch: state.useNewBranch,
    baseBranch: $('#optBaseBranch').value.trim(),
    overwrite: $('#optOverwrite').checked,
    deleteExisting: $('#optDelete').checked,
    dryRun: $('#optDry').checked,
    useMock: $('#optMock') ? $('#optMock').checked : false,
    ...extra,
  };
}

async function doPreview() {
  if (state.config.oneshot) {
    const fd = new FormData();
    if (state.localZip) fd.append('zip', state.localZip.file, state.localZip.file.name);
    else if (state.localFolder) {
      const relPaths = [];
      for (const it of state.localFolder) {
        const rel = it.file.webkitRelativePath || it.file.relativePath || it.path;
        fd.append('files', it.file, rel); relPaths.push(rel);
      }
      fd.append('relPaths', JSON.stringify(relPaths));
    } else return alert('Pilih ZIP atau folder terlebih dahulu.');
    fd.append('stripRoot', $('#stripRoot').checked ? '1' : '0');
    Object.entries(buildPayload({ dryRun: true })).forEach(([k, v]) => {
      if (v !== null && v !== undefined && v !== '') fd.append(k, String(v));
    });
    $('#resultCard').classList.remove('hidden');
    $('#log').innerHTML = ''; $('#resultNote').innerHTML = ''; $('#resultLinks').innerHTML = '';
    try {
      const r = await uploadXhr('/api/push-upload', fd, () => {});
      $('#pushProgress').classList.add('hidden');
      renderPushResult(r);
    } catch (e) {
      $('#resultTag').textContent = 'gagal';
      note('err', esc(e.message), '#resultNote');
    }
    return;
  }
  $('#resultCard').classList.remove('hidden');
  $('#log').innerHTML = '';
  $('#resultNote').innerHTML = '';
  $('#resultLinks').innerHTML = '';
  try {
    const r = await api('/api/push', { method: 'POST', body: buildPayload({ dryRun: true }) });
    $('#resultTag').textContent = 'rencana commit';
    note('info', `<b>Dry-run.</b> Tidak ada yang dikirim ke GitHub.<br/>
      Repo <b>${esc(r.plan.repo)}</b> · branch <b>${esc(r.plan.branch)}</b>${r.plan.createBranch ? ' (baru)' : ''} · folder <b>${esc(r.plan.destPath)}</b><br/>
      ${r.plan.files} file · ${fmtSize(r.plan.bytes)} · pesan: "${esc(r.plan.message)}"<br/>
      <span style="color:var(--fg3)">Urutan API: ${r.plan.apiCalls.map(esc).join(' → ')}</span>`, '#resultNote');
    r.preview.slice(0, 60).forEach((f) => log(`📄 ${esc(f.path)}  <span class="dim">${fmtSize(f.size)}</span>`));
    if (r.preview.length > 60) log(`… +${r.preview.length - 60} file lainnya`, 'dim');
  } catch (e) {
    $('#resultTag').textContent = 'gagal';
    note('err', esc(e.message) + (e.hint ? ' — ' + esc(e.hint) : ''), '#resultNote');
  }
}

async function doPush() {
  const payload = buildPayload();
  if (!payload.repo) return alert('Pilih repository dulu.');
  if (!payload.branch) return alert('Tentukan branch tujuan.');

  // validasi branch: sudah ada atau memang mau dibuat baru
  if (!payload.createBranch && state.branches.length && !state.branches.some((b) => b.name === payload.branch)) {
    const yes = confirm(`Branch "${payload.branch}" belum ada di repo ini.\n\nBuat branch baru dari "${state.selectedRepo?.default_branch || 'main'}"?`);
    if (!yes) return;
    payload.createBranch = true;
  }
  if (payload.createBranch && state.branches.some((b) => b.name === payload.branch)) {
    payload.createBranch = false; // branch-nya ternyata sudah ada
  }
  if (payload.deleteExisting && payload.destPath &&
      !confirm(`File lama di folder "${payload.destPath}" yang tidak ada di upload akan DIHAPUS dari branch ${payload.branch}. Lanjutkan?`)) return;

  if (state.config.oneshot) return doOneShotPush(payload);

  $('#resultCard').classList.remove('hidden');
  $('#log').innerHTML = ''; $('#resultNote').innerHTML = ''; $('#resultLinks').innerHTML = '';
  $('#resultTag').textContent = 'memproses…';
  $('#pushProgress').classList.remove('hidden');
  $('#pushBar').style.width = '5%';
  $('#pushStage').textContent = 'Menghubungi GitHub…';
  $('#btnPush').disabled = true;

  log(`Mulai push ${state.upload.totalFiles} file ke <b>${esc(payload.repo)}</b> → <b>${esc(payload.branch)}</b>${payload.destPath ? '/' + esc(payload.destPath) : ''}`);
  startProgressPolling();

  try {
    const r = await api('/api/push', { method: 'POST', body: payload });
    stopProgressPolling();
    $('#pushBar').style.width = '100%';

    if (r.dryRun) {
      $('#resultTag').textContent = 'dry-run selesai';
      note('warn', `<b>Dry-run</b> (${esc(r.reason)}): tidak ada perubahan di GitHub.<br/>
        Rencana: ${r.plan.files} file · ${fmtSize(r.plan.bytes)} → <b>${esc(r.plan.repo)}@${esc(r.plan.branch)}</b>${r.plan.destPath !== '(root)' ? '/' + esc(r.plan.destPath) : ''}`, '#resultNote');
      r.preview.slice(0, 60).forEach((f) => log(`📄 ${esc(f.path)}`));
      log('Selesai (dry-run).', 'warn');
    } else {
      $('#resultTag').textContent = 'sukses ✓';
      $('#pushStage').textContent = 'Selesai';
      note('ok', `<b>${r.mock ? 'Berhasil (simulasi)!' : 'Berhasil!'}</b> Commit <code>${esc(r.shortSha)}</code> masuk ke branch <b>${esc(r.branch)}</b>${r.branchCreated ? ' (branch baru dibuat)' : ''}.<br/>
        ${r.files.length} file di-commit${r.overwritten.length ? ` · ${r.overwritten.length} file ditimpa` : ''}${r.removed.length ? ` · ${r.removed.length} file lama dihapus` : ''}.`, '#resultNote');
      if (r.commitUrl) {
        $('#resultLinks').innerHTML = `
          <a class="btnlink" style="padding:8px 12px" href="${esc(r.commitUrl)}" target="_blank" rel="noopener">🔗 Lihat commit</a>
          <a class="btnlink" style="padding:8px 12px" href="${esc(r.treeUrl)}" target="_blank" rel="noopener">📂 Lihat folder di repo</a>`;
      } else {
        note('info', 'Push dilakukan ke <b>GitHub tiruan</b> di memori server (tidak ada repo nyata yang berubah). Data hilang saat server dimatikan.', '#resultNote');
      }
      log(`Commit ${esc(r.shortSha)}${r.commitUrl ? ' → ' + esc(r.commitUrl) : ' (simulasi di memori server)'}`, 'ok');
      r.files.slice(0, 40).forEach((f) => log(`✓ ${esc(f.path)} <span class="dim">${fmtSize(f.size)}</span>`, 'ok'));
      if (r.files.length > 40) log(`… dan ${r.files.length - 40} file lainnya`, 'dim');
    }
  } catch (e) {
    stopProgressPolling();
    $('#resultTag').textContent = 'gagal';
    $('#pushStage').textContent = 'Gagal';
    note('err', `<b>Push gagal:</b> ${esc(e.message)}${e.hint ? '<br/>' + esc(e.hint) : ''}`, '#resultNote');
    log('✖ ' + esc(e.message), 'err');
  } finally {
    $('#btnPush').disabled = false;
    updatePushReady();
  }
}


/** Tampilkan hasil push (dipakai mode biasa & mode sekali jalan). */
function renderPushResult(r) {
  if (r.dryRun) {
    $('#resultTag').textContent = 'dry-run selesai';
    $('#pushStage').textContent = 'Dry-run selesai';
    const plan = r.plan || {};
    note('warn', `<b>Dry-run</b>${r.reason ? ' (' + esc(r.reason) + ')' : ''}: tidak ada perubahan di GitHub.<br/>
      Rencana: ${plan.files ?? 0} file · ${fmtSize(plan.bytes || 0)} → <b>${esc(plan.repo || '')}@${esc(plan.branch || '')}</b>${plan.destPath && plan.destPath !== '(root)' ? '/' + esc(plan.destPath) : ''}
      ${r.strippedRoot ? '<br/>folder pembungkus "' + esc(r.strippedRoot) + '" dibuang' : ''}${r.skipped ? ' · ' + r.skipped + ' entri dilewati' : ''}
      ${plan.apiCalls ? '<br/><span style="color:var(--fg3)">Urutan API: ' + plan.apiCalls.map(esc).join(' → ') + '</span>' : ''}`, '#resultNote');
    (r.preview || []).slice(0, 60).forEach((f) => log(`📄 ${esc(f.path)}  <span class="dim">${fmtSize(f.size)}</span>`));
    if ((r.preview || []).length > 60) log(`… +${r.preview.length - 60} file lainnya`, 'dim');
    log('Selesai (dry-run).', 'warn');
    return;
  }

  $('#resultTag').textContent = 'sukses ✓';
  $('#pushStage').textContent = 'Selesai';
  note('ok', `<b>${r.mock ? 'Berhasil (simulasi)!' : 'Berhasil!'}</b> Commit <code>${esc(r.shortSha)}</code> masuk ke branch <b>${esc(r.branch)}</b>${r.branchCreated ? ' (branch baru dibuat)' : ''}.<br/>
    ${r.files.length} file di-commit${r.overwritten && r.overwritten.length ? ` · ${r.overwritten.length} file ditimpa` : ''}${r.removed && r.removed.length ? ` · ${r.removed.length} file lama dihapus` : ''}${r.strippedRoot ? ` · folder "${esc(r.strippedRoot)}" dibuang` : ''}.`, '#resultNote');
  if (r.commitUrl) {
    $('#resultLinks').innerHTML = `
      <a class="btnlink" style="padding:8px 12px" href="${esc(r.commitUrl)}" target="_blank" rel="noopener">🔗 Lihat commit</a>
      <a class="btnlink" style="padding:8px 12px" href="${esc(r.treeUrl)}" target="_blank" rel="noopener">📂 Lihat folder di repo</a>`;
  } else {
    note('info', 'Push dilakukan ke <b>GitHub tiruan</b> di memori server (tidak ada repo nyata yang berubah). Data hilang saat instance dimatikan.', '#resultNote');
  }
  log(`Commit ${esc(r.shortSha)}${r.commitUrl ? ' → ' + esc(r.commitUrl) : ' (simulasi di memori server)'}`, 'ok');
  r.files.slice(0, 40).forEach((f) => log(`✓ ${esc(f.path)} <span class="dim">${fmtSize(f.size)}</span>`, 'ok'));
  if (r.files.length > 40) log(`… dan ${r.files.length - 40} file lainnya`, 'dim');
}

function startProgressPolling() {
  stopProgressPolling();
  state.polling = setInterval(async () => {
    try {
      const p = await api('/api/push/progress');
      const map = {
        start: `Menyiapkan commit (${p.total} file)…`,
        blobs: `Mengunggah isi file ke GitHub… ${p.done}/${p.total}`,
        tree: 'Menyusun tree commit…',
        commit: 'Membuat commit…',
        ref: p.createBranch ? 'Membuat branch baru…' : 'Memperbarui referensi branch…',
        done: 'Selesai.',
        warn: p.message || '',
      };
      const txt = map[p.stage] || 'Memproses…';
      $('#pushStage').textContent = txt;
      if (p.stage === 'blobs' && p.total) $('#pushBar').style.width = (5 + (p.done / p.total) * 85).toFixed(1) + '%';
      else if (p.stage === 'tree') $('#pushBar').style.width = '92%';
      else if (p.stage === 'commit') $('#pushBar').style.width = '95%';
      else if (p.stage === 'ref') $('#pushBar').style.width = '98%';
      else if (p.stage === 'done') $('#pushBar').style.width = '100%';
      if (p.stage === 'warn') log('⚠ ' + esc(p.message), 'warn');
    } catch (_) {}
  }, 1200);
}
function stopProgressPolling() { if (state.polling) { clearInterval(state.polling); state.polling = null; } }

/* ---------------- bindings ---------------- */
function bindApp() {
  // tab
  $('#tabZip').onclick = () => setTab('zip');
  $('#tabFolder').onclick = () => setTab('folder');

  // ZIP
  const dz = $('#dropZip');
  dz.onclick = () => $('#zipInput').click();
  $('#zipInput').onchange = (e) => handleZipFile(e.target.files[0]);
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => handleZipFile(e.dataTransfer.files[0]));

  // Folder
  const df = $('#dropFolder');
  df.onclick = () => $('#folderInput').click();
  $('#folderInput').onchange = (e) => handleFolderFiles(e.target.files);
  ['dragenter', 'dragover'].forEach((ev) => df.addEventListener(ev, (e) => { e.preventDefault(); df.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => df.addEventListener(ev, (e) => { e.preventDefault(); df.classList.remove('over'); }));
  df.addEventListener('drop', async (e) => {
    e.preventDefault();
    const items = Array.from(e.dataTransfer.items || []);
    const webkit = items.filter((i) => i.kind === 'file' && typeof i.webkitGetAsEntry === 'function');
    if (!webkit.length) return handleFolderFiles(e.dataTransfer.files);
    const out = [];
    for (const it of webkit) {
      const entry = it.webkitGetAsEntry();
      if (entry) await walkEntry(entry, '', out);
    }
    if (!out.length) return handleFolderFiles(e.dataTransfer.files);
    await handleFolderFiles(out);
  });

  $('#btnClearFiles').onclick = async () => {
    if (!state.config.oneshot) await api('/api/files', { method: 'DELETE' }).catch(() => {});
    state.upload = null; state.localZip = null; state.localFolder = null;
    renderUpload(); updatePushReady();
    $('#zipInput').value = ''; $('#folderInput').value = '';
    log(state.config.oneshot ? 'Pilihan file di browser dibersihkan.' : 'File di server dihapus.', 'dim');
  };

  // repo & branch
  $('#repoSearch').oninput = (e) => renderRepos(e.target.value);
  $('#repoSelect').onchange = onRepoChange;
  $('#branchSelect').onchange = () => { state.useNewBranch = false; $('#newBranch').value = ''; updatePushReady(); };
  $('#btnUseNewBranch').onclick = () => {
    const v = $('#newBranch').value.trim();
    if (!v) return alert('Isi nama branch baru.');
    state.useNewBranch = true;
    $('#branchMeta').innerHTML = `Branch baru <b>${esc(v)}</b> akan dibuat dari <b>${esc($('#optBaseBranch').value.trim() || state.selectedRepo?.default_branch || 'main')}</b>.`;
    updatePushReady();
  };

  $('#btnPush').onclick = doPush;
  $('#btnPreview').onclick = doPreview;

  // modal repo baru
  $('#btnNewRepo').onclick = () => $('#modal').classList.remove('hidden');
  $('#nrCancel').onclick = () => $('#modal').classList.add('hidden');
  $('#nrCreate').onclick = async () => {
    const name = $('#nrName').value.trim();
    if (!name) return alert('Isi nama repo.');
    $('#nrCreate').disabled = true;
    try {
      const r = await api('/api/repos', { method: 'POST', body: {
        name, private: $('#nrPrivate').checked, description: $('#nrDesc').value, autoInit: $('#nrInit').checked,
      } });
      $('#modal').classList.add('hidden');
      note('ok', `Repo <b>${esc(r.repo.full_name)}</b> dibuat.`);
      await loadRepos();
      $('#repoSearch').value = r.repo.full_name;
      renderRepos(r.repo.full_name);
      $('#repoSelect').value = r.repo.full_name;
      await onRepoChange();
    } catch (e) {
      note('err', 'Gagal membuat repo: ' + esc(e.message), '#demoBanner');
    } finally { $('#nrCreate').disabled = false; }
  };

  if (state.selectedRepo == null && $('#repoSelect').value) onRepoChange();
  updatePushReady();
}

/* rekursif mengambil file dari DataTransferItem (drag & drop folder) */
async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res) => entry.file(res, () => res(null)));
    if (file) {
      Object.defineProperty(file, 'webkitRelativePath', { value: prefix + file.name, configurable: true });
      out.push(file);
    }
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch = [];
    do {
      batch = await new Promise((res) => reader.readEntries(res, () => res([])));
      for (const child of batch) await walkEntry(child, prefix + entry.name + '/', out);
    } while (batch.length > 0);
  }
}

/* mulai */
init();
