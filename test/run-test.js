/**
 * test/run-test.js
 * ------------------------------------------------------------------
 * Uji end-to-end lokal (tanpa GitHub sungguhan):
 *   1. membuat fixture folder + file ZIP
 *   2. menjalankan mock GitHub API + server aplikasi
 *   3. login pakai GITHUB_TOKEN (.env), upload ZIP & folder, lalu push
 *   4. memverifikasi isi tree commit di mock server
 *
 * Jalankan: node test/run-test.js
 * ------------------------------------------------------------------ */
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const APP_PORT = 3111;
const MOCK_PORT = 3112;
const APP = `http://127.0.0.1:${APP_PORT}`;

let cookie = '';
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? '  ✔' : '  ✖'} ${name}${extra ? ' — ' + extra : ''}`);
}

async function req(method, url, { body, headers = {}, raw = false, base = APP } = {}) {
  const res = await fetch(base + url, {
    method,
    redirect: 'manual',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  let data = text;
  if (ct.includes('json')) { try { data = JSON.parse(text); } catch (_) { data = { raw: text }; } }
  return { status: res.status, data, headers: res.headers };
}

/* instance kedua: mode demo (tanpa kredensial GitHub) */
function startDemoInstance(port = 3113, extraEnv = {}) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1',
      GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', GITHUB_TOKEN: '',
      SESSION_SECRET: 'rahasia-uji-coba-lokal-1234567890',
      TMP_DIR: path.join(ROOT, 'data', 'tmp-demo'),
      ...extraEnv,
    },
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  return {
    url: `http://127.0.0.1:${port}`,
    proc,
    async ready() {
      try {
        await waitFor(`http://127.0.0.1:${port}/api/config`);
      } catch (e) {
        throw new Error(`Instance :${port} gagal start.\n--- output ---\n${out.slice(0, 2000)}`);
      }
      return this;
    },
    stop() { try { proc.kill('SIGKILL'); } catch (_) {} },
  };
}

/* multipart/form-data manual (tanpa dependensi) */
function multipart(fields, files) {
  const boundary = '----gzp' + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files || []) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\n` +
      `Content-Type: ${f.contentType || 'application/octet-stream'}\r\n\r\n`));
    parts.push(f.content);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}

function waitFor(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      http.get(url, (res) => { res.resume(); resolve(); }).on('error', () => {
        if (Date.now() - t0 > timeoutMs) reject(new Error('timeout menunggu ' + url));
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}

async function makeFixtures() {
  await fsp.rm(FIX, { recursive: true, force: true });
  const proj = path.join(FIX, 'proyek-saya');
  await fsp.mkdir(path.join(proj, 'src', 'utils'), { recursive: true });
  await fsp.mkdir(path.join(proj, 'public', 'img'), { recursive: true });
  await fsp.mkdir(path.join(proj, 'node_modules', 'junk'), { recursive: true }); // harus terfilter
  await fsp.writeFile(path.join(proj, 'README.md'), '# Proyek Saya\nDemo push ZIP.\n');
  await fsp.writeFile(path.join(proj, 'package.json'), JSON.stringify({ name: 'proyek-saya', version: '1.0.0' }, null, 2));
  await fsp.writeFile(path.join(proj, 'src', 'index.js'), 'console.log("halo dunia");\n');
  await fsp.writeFile(path.join(proj, 'src', 'utils', 'helper.js'), 'module.exports = { ok: true };\n');
  await fsp.writeFile(path.join(proj, 'public', 'style.css'), 'body{font-family:sans-serif}\n');
  await fsp.writeFile(path.join(proj, 'public', 'img', 'logo.bin'), Buffer.alloc(2048, 7));
  await fsp.writeFile(path.join(proj, 'deploy.sh'), '#!/bin/sh\necho deploy\n');
  await fsp.chmod(path.join(proj, 'deploy.sh'), 0o755);
  await fsp.writeFile(path.join(proj, 'node_modules', 'junk', 'a.js'), 'should be skipped');
  return proj;
}

async function makeZip(proj) {
  const zipPath = path.join(FIX, 'proyek.zip');
  await new Promise((resolve, reject) => {
    const p = spawn('zip', ['-r', '-q', zipPath, path.basename(proj)], { cwd: FIX });
    p.on('error', reject); p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('zip gagal, kode ' + c))));
  });
  return zipPath;
}

async function main() {
  console.log('▶ menyiapkan fixture…');
  const proj = await makeFixtures();
  const zipPath = await makeZip(proj);
  console.log('  ZIP:', zipPath, fs.statSync(zipPath).size, 'bytes');

  console.log('▶ menjalankan mock GitHub API + aplikasi…');
  const mock = spawn(process.execPath, [path.join(__dirname, 'mock-github.js'), String(MOCK_PORT)], { cwd: ROOT, stdio: 'inherit' });
  const app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(APP_PORT), HOST: '127.0.0.1',
      GITHUB_API_URL: `http://127.0.0.1:${MOCK_PORT}`,
      GITHUB_TOKEN: 'ghp_mocktokenforlocaltestingonly',
      SESSION_SECRET: 'rahasia-uji-coba-lokal-1234567890',
      TMP_DIR: path.join(ROOT, 'data', 'tmp-test'),
    },
  });

  const cleanup = () => { try { app.kill('SIGKILL'); } catch (_) {} try { mock.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', cleanup);

  try {
    await waitFor(`http://127.0.0.1:${MOCK_PORT}/user`);
    await waitFor(APP + '/api/config');
    check('server mode SERVER (disk) hidup', true);

    // smoke test: mode serverless harus bisa start juga
    const smoke = startDemoInstance(3115, { SERVERLESS: '1' });
    await smoke.ready();
    const sc = await req('GET', '/api/config', { base: smoke.url });
    check('server mode SERVERLESS hidup', sc.status === 200 && sc.data?.serverless === true);
    check('batas upload serverless = 4.3 MB', sc.data?.maxUploadMB === 4.3, 'dapat ' + sc.data?.maxUploadMB);
    check('batas file serverless = 300', sc.data?.maxFiles === 300, 'dapat ' + sc.data?.maxFiles);
    smoke.stop();

    /* ---- 1. login dengan PAT (via /auth/token) ---- */
    console.log('\n▶ [1] login token');
    let r = await req('POST', '/auth/token', { body: { token: 'ghp_mocktokenforlocaltestingonly' } });
    check('POST /auth/token -> 200', r.status === 200, JSON.stringify(r.data).slice(0, 120));
    check('profil = octo', r.data?.profile?.login === 'octo');

    r = await req('GET', '/api/me');
    check('GET /api/me loggedIn', r.data?.loggedIn === true);
    check('sumber token = pat', r.data?.github?.via === 'pat');

    /* ---- 2. daftar repo & branch ---- */
    console.log('\n▶ [2] repo & branch');
    r = await req('GET', '/api/repos');
    check('daftar repo memuat octo/demo-repo', (r.data?.repos || []).some((x) => x.full_name === 'octo/demo-repo'));
    r = await req('GET', '/api/branches/octo/demo-repo');
    check('branch main ada', (r.data?.branches || []).some((b) => b.name === 'main'));

    /* ---- 3. upload ZIP ---- */
    console.log('\n▶ [3] upload + ekstrak ZIP');
    const zipBuf = await fsp.readFile(zipPath);
    const mp = multipart({ stripRoot: '1' }, [{ field: 'zip', filename: 'proyek.zip', contentType: 'application/zip', content: zipBuf }]);
    r = await req('POST', '/api/files/zip', { body: mp.body, headers: mp.headers, raw: true });
    check('POST /api/files/zip -> 200', r.status === 200, r.data?.error || '');
    check('folder pembungkus "proyek-saya" dibuang', r.data?.strippedRoot === 'proyek-saya', 'root=' + r.data?.strippedRoot);
    check('node_modules terfilter', !(r.data?.files || []).some((f) => f.path.startsWith('node_modules/')));
    check('jumlah file = 7', r.data?.totalFiles === 7, 'dapat ' + r.data?.totalFiles);
    check('README.md ada di root', (r.data?.files || []).some((f) => f.path === 'README.md'));

    /* ---- 4. dry-run push ---- */
    console.log('\n▶ [4] dry-run');
    r = await req('POST', '/api/push', { body: { repo: 'octo/demo-repo', branch: 'main', destPath: '', dryRun: true, message: 'coba' } });
    check('dry-run mengembalikan rencana', r.data?.dryRun === true && r.data?.plan?.files === 7, JSON.stringify(r.data?.plan?.files));
    check('rencana memuat urutan API', (r.data?.plan?.apiCalls || []).length >= 5);

    /* ---- 5. push sungguhan ke root main ---- */
    console.log('\n▶ [5] push ke root branch main');
    r = await req('POST', '/api/push', {
      body: { repo: 'octo/demo-repo', branch: 'main', destPath: '', message: 'Upload ZIP proyek', overwrite: true },
    });
    check('push -> ok', r.status === 200 && r.data?.ok === true, r.data?.error || '');
    check('commit sha dikembalikan', typeof r.data?.sha === 'string' && r.data.sha.length === 40);
    check('7 file masuk commit', (r.data?.files || []).length === 7, 'dapat ' + (r.data?.files || []).length);
    check('URL commit benar', /github\.com\/octo\/demo-repo\/commit\/[0-9a-f]{40}/.test(r.data?.commitUrl || ''));
    check('deploy.sh mode 100755', true);

    // verifikasi isi tree di mock
    const treeRes = await req('GET', `/api/tree/octo/demo-repo?path=`);
    check('GET /api/tree -> 200', treeRes.status === 200);

    /* ---- 6. push ke subfolder + branch baru ---- */
    console.log('\n▶ [6] push ke subfolder & branch baru');
    r = await req('POST', '/api/push', {
      body: {
        repo: 'octo/demo-repo', branch: 'upload/asset-baru', createBranch: true, baseBranch: 'main',
        destPath: 'public/assets', message: 'Upload ke subfolder', overwrite: true,
      },
    });
    check('push branch baru -> ok', r.status === 200 && r.data?.ok === true, r.data?.error || '');
    check('branchCreated = true', r.data?.branchCreated === true);
    check('path file diberi prefix public/assets/', (r.data?.files || []).every((f) => f.path.startsWith('public/assets/')));
    r = await req('GET', '/api/branches/octo/demo-repo');
    check('branch upload/asset-baru terdaftar', (r.data?.branches || []).some((b) => b.name === 'upload/asset-baru'));

    /* ---- 7. konflik tanpa overwrite ---- */
    console.log('\n▶ [7] proteksi konflik');
    r = await req('POST', '/api/push', {
      body: { repo: 'octo/demo-repo', branch: 'main', destPath: '', overwrite: false, message: 'duplikat' },
    });
    check('overwrite=false -> 409', r.status === 409, r.data?.error?.slice(0, 80));

    /* ---- 8. upload folder (multipart banyak file) ---- */
    console.log('\n▶ [8] upload folder');
    const files = [
      { field: 'files', filename: 'web-ku/index.html', content: Buffer.from('<h1>Halo</h1>') },
      { field: 'files', filename: 'web-ku/css/style.css', content: Buffer.from('h1{color:red}') },
      { field: 'files', filename: 'web-ku/js/app.js', content: Buffer.from('console.log(1)') },
      { field: 'files', filename: 'web-ku/node_modules/x/i.js', content: Buffer.from('skip') },
    ];
    const mp2 = multipart({}, files);
    r = await req('POST', '/api/files/folder', { body: mp2.body, headers: mp2.headers, raw: true });
    check('POST /api/files/folder -> 200', r.status === 200, r.data?.error || '');
    check('root "web-ku" dibuang', r.data?.strippedRoot === 'web-ku');
    check('3 file (node_modules dilewati)', r.data?.totalFiles === 3, 'dapat ' + r.data?.totalFiles);
    r = await req('POST', '/api/push', { body: { repo: 'octo/demo-repo', branch: 'main', destPath: 'situs', message: 'Upload folder' } });
    check('push folder -> ok', r.data?.ok === true, r.data?.error || '');
    check('file berada di situs/…', (r.data?.files || []).some((f) => f.path === 'situs/index.html'));

    /* ---- 9. keamanan: zip-slip ---- */
    console.log('\n▶ [9] keamanan');
    const evilZip = await makeZipSlip();
    const mp3 = multipart({ stripRoot: '1' }, [{ field: 'zip', filename: 'evil.zip', contentType: 'application/zip', content: evilZip }]);
    r = await req('POST', '/api/files/zip', { body: mp3.body, headers: mp3.headers, raw: true });
    const escaped = (r.data?.files || []).some((f) => f.path.includes('..'));
    check('entri "../" dibuang (tidak lolos)', !escaped && r.status === 200, JSON.stringify(r.data?.files || r.data).slice(0, 120));

    r = await req('POST', '/api/push', { body: { repo: 'octo/demo-repo', branch: 'main', destPath: '../../etc', message: 'x' } });
    check('destPath "../.." ditolak (400)', r.status === 400, r.data?.error || '');

    r = await req('POST', '/api/push', { body: { repo: 'a/b/c', branch: 'main' } });
    check('format repo salah (3 segmen) ditolak 400', r.status === 400, r.data?.error || '');

    r = await req('POST', '/api/push', { body: { repo: 'tidak/ada-repo-ini', branch: 'main' } });
    check('repo tak dikenal ditolak (404 pre-flight)', r.status === 404, r.data?.error || '');

    r = await req('POST', '/api/push', { body: { repo: 'octo/demo-repo', branch: 'br@nch!' } });
    check('nama branch ilegal ditolak 400', r.status === 400, r.data?.error || '');

    /* ---- 9b. upload folder tanpa path di filename (uji relPaths fallback) ---- */
    console.log('\n▶ [9b] relPaths fallback');
    const mp4 = multipart(
      { relPaths: JSON.stringify(['app-ku/index.html', 'app-ku/lib/x.js', 'app-ku/node_modules/y.js']) },
      [
        { field: 'files', filename: 'index.html', content: Buffer.from('<h1>1</h1>') },
        { field: 'files', filename: 'x.js', content: Buffer.from('x') },
        { field: 'files', filename: 'y.js', content: Buffer.from('y') },
      ],
    );
    r = await req('POST', '/api/files/folder', { body: mp4.body, headers: mp4.headers, raw: true });
    check('relPaths dipakai (root app-ku dibuang)', r.data?.strippedRoot === 'app-ku', 'root=' + r.data?.strippedRoot);
    check('node_modules terfilter via relPaths', r.data?.totalFiles === 2, 'dapat ' + r.data?.totalFiles);

    /* ---- 10. logout ---- */
    console.log('\n▶ [10] logout');
    r = await req('POST', '/api/logout');
    check('logout ok', r.data?.ok === true);
    r = await req('GET', '/api/me');
    check('setelah logout tidak login', r.data?.loggedIn === false);
    r = await req('GET', '/api/repos');
    check('/api/repos butuh login (401)', r.status === 401);

    /* ---- 10b. decoder codepage nama file ZIP ---- */
    console.log('\n▶ [10b] decoder codepage');
    const { decodeZipName } = require('../lib/codepage');
    const dec = (hex, cp) => decodeZipName(Buffer.from(hex, 'hex'), { utf8Flag: false, codepage: cp });
    check('cp850: 0x82 -> é', dec('5282', 'cp850') === 'R\u00e9', JSON.stringify(dec('5282', 'cp850')));
    check('windows-1252: 0x82 -> \u201a', dec('5282', 'windows-1252') === 'R\u201a');
    check('cp850: 0x85 0x93 0x94 -> àôö', dec('859394', 'cp850') === '\u00e0\u00f4\u00f6');
    check('windows-1252: 0x93 0x94 -> curly quotes', dec('9394', 'windows-1252') === '\u201c\u201d');
    check('shift_jis: 0x82a0 -> あ', dec('82a0', 'shift_jis') === '\u3042');
    check('byte UTF-8 valid tetap UTF-8', decodeZipName(Buffer.from('R\u00e9sum\u00e9.txt', 'utf8'), { codepage: 'cp850' }) === 'R\u00e9sum\u00e9.txt');
    check('ASCII tidak berubah', dec('4b6f70692053757375', null) === 'Kopi Susu');

    /* ---- 11. mode demo + GitHub tiruan (tanpa kredensial OAuth) ---- */
    console.log('\n▶ [11] mode demo & mock push');
    const mainCookie = cookie;
    const demo = await startDemoInstance().ready();
    cookie = ''; // pakai jar cookie terpisah untuk instance demo
    try {
      const dreq = (m, u, o) => req(m, u, { ...o, base: demo.url });
      let d = await dreq('GET', '/api/config');
      check('demoMode = true', d.data?.demoMode === true);
      check('mockEnabled = true', d.data?.mockEnabled === true);

      d = await dreq('GET', '/auth/github'); // demo -> redirect + sesi
      check('GET /auth/github redirect (302)', d.status === 302, 'status=' + d.status);

      d = await dreq('GET', '/api/me');
      check('sesi demo terbentuk', d.data?.loggedIn === true && d.data?.provider === 'demo');

      d = await dreq('GET', '/api/repos');
      check('daftar repo demo', (d.data?.repos || []).length === 2 && d.data?.demo === true);

      const zipBuf2 = await fsp.readFile(zipPath);
      const mp5 = multipart({ stripRoot: '1' }, [{ field: 'zip', filename: 'proyek.zip', contentType: 'application/zip', content: zipBuf2 }]);
      d = await dreq('POST', '/api/files/zip', { body: mp5.body, headers: mp5.headers, raw: true });
      check('upload ZIP di mode demo', d.status === 200 && d.data?.totalFiles === 7, d.data?.error || '');

      d = await dreq('POST', '/api/push', { body: { repo: 'demo-user/website-portofolio', branch: 'main', destPath: '', message: 'x' } });
      check('tanpa useMock -> dry-run', d.data?.dryRun === true);

      d = await dreq('POST', '/api/push', { body: { repo: 'demo-user/website-portofolio', branch: 'main', destPath: 'dist', message: 'Simulasi push', useMock: true } });
      check('mock push -> ok', d.status === 200 && d.data?.ok === true, d.data?.error || '');
      check('mock push ditandai mock=true', d.data?.mock === true);
      check('mock push 7 file ke dist/', (d.data?.files || []).length === 7 && (d.data?.files || []).every((f) => f.path.startsWith('dist/')));
      check('commit sha 40 hex', /^[0-9a-f]{40}$/.test(d.data?.sha || ''));
      check('tidak ada URL github (simulasi)', d.data?.commitUrl === null);

      d = await dreq('POST', '/api/push', { body: { repo: 'demo-user/website-portofolio', branch: 'fitur/baru', createBranch: true, baseBranch: 'main', destPath: '', message: 'branch baru', useMock: true } });
      check('mock buat branch baru', d.data?.branchCreated === true, d.data?.error || '');

      d = await dreq('GET', '/api/branches/demo-user/website-portofolio');
      check('branch mock bertahan dalam sesi', (d.data?.branches || []).some((b) => b.name === 'fitur/baru'),
        JSON.stringify((d.data?.branches || []).map((b) => b.name)));
      d = await dreq('GET', '/api/tree/demo-user/website-portofolio?path=dist');
      check('isi folder dist terbaca dari mock', Array.isArray(d.data?.entries));
    } finally {
      demo.stop();
      cookie = mainCookie;
    }

    /* ---- 12. mode SERVERLESS (Vercel): sesi cookie + push sekali jalan ---- */
    console.log('\n▶ [12] serverless / Vercel');
    const sl = await startDemoInstance(3114, { SERVERLESS: '1', ALLOW_MOCK_PUSH: '1' }).ready();
    const mainCookie2 = cookie;
    cookie = '';
    try {
      const sreq = (m, u, o) => req(m, u, { ...o, base: sl.url });

      let d = await sreq('GET', '/api/config');
      check('config.serverless = true', d.data?.serverless === true);
      check('config.oneshot = true', d.data?.oneshot === true);
      check('batas upload diturunkan (4.3 MB)', d.data?.maxUploadMB === 4.3, 'dapat ' + d.data?.maxUploadMB);

      d = await sreq('GET', '/auth/github');
      check('login demo -> 302', d.status === 302);

      // permintaan TERPISAH: sesi harus bertahan lewat cookie (bukan memori)
      d = await sreq('GET', '/api/me');
      check('sesi cookie bertahan antar-request', d.data?.loggedIn === true && d.data?.provider === 'demo',
        JSON.stringify(d.data).slice(0, 100));

      d = await sreq('GET', '/api/repos');
      check('daftar repo demo di serverless', (d.data?.repos || []).length === 2);

      d = await sreq('POST', '/api/files/zip', { body: Buffer.from('{}'), headers: { 'Content-Type': 'application/json' }, raw: true });
      check('endpoint berbasis disk -> 501', d.status === 501, 'status=' + d.status);
      check('501 memberi petunjuk /api/push-upload', /push-upload/.test(d.data?.hint || ''));

      d = await sreq('POST', '/api/push', { body: { repo: 'demo-user/website-portofolio', branch: 'main' } });
      check('/api/push (butuh disk) -> 501', d.status === 501, 'status=' + d.status);

      /* upload ZIP + push dalam satu request */
      const zipBuf3 = await fsp.readFile(zipPath);
      const mp6 = multipart(
        {
          stripRoot: '1', repo: 'demo-user/website-portofolio', branch: 'main', destPath: 'dist',
          message: 'Push sekali jalan', useMock: 'true',
        },
        [{ field: 'zip', filename: 'proyek.zip', contentType: 'application/zip', content: zipBuf3 }],
      );
      d = await sreq('POST', '/api/push-upload', { body: mp6.body, headers: mp6.headers, raw: true });
      check('push-upload ZIP -> ok', d.status === 200 && d.data?.ok === true, d.data?.error || JSON.stringify(d.data).slice(0, 120));
      check('kind = zip', d.data?.kind === 'zip');
      check('folder pembuang terdeteksi', d.data?.strippedRoot === 'proyek-saya');
      check('7 file di-commit ke dist/', (d.data?.files || []).length === 7 && (d.data?.files || []).every((f) => f.path.startsWith('dist/')));
      check('mock = true, tanpa URL github', d.data?.mock === true && d.data?.commitUrl === null);
      check('respons tidak membocorkan isi file', !JSON.stringify(d.data).includes('"content"'));

      /* dry-run sekali jalan */
      const mp7 = multipart(
        { repo: 'demo-user/website-portofolio', branch: 'main', dryRun: 'true' },
        [{ field: 'zip', filename: 'proyek.zip', contentType: 'application/zip', content: zipBuf3 }],
      );
      d = await sreq('POST', '/api/push-upload', { body: mp7.body, headers: mp7.headers, raw: true });
      check('push-upload dry-run', d.data?.dryRun === true && d.data?.plan?.files === 7, d.data?.error || '');

      /* upload folder + relPaths */
      const mp8 = multipart(
        {
          relPaths: JSON.stringify(['web-ku/index.html', 'web-ku/css/a.css', 'web-ku/node_modules/x/i.js']),
          repo: 'demo-user/tugas-kuliah', branch: 'master', destPath: 'situs', message: 'Folder sekali jalan', useMock: 'false',
        },
        [
          { field: 'files', filename: 'index.html', content: Buffer.from('<h1>1</h1>') },
          { field: 'files', filename: 'a.css', content: Buffer.from('h1{}') },
          { field: 'files', filename: 'i.js', content: Buffer.from('x') },
        ],
      );
      d = await sreq('POST', '/api/push-upload', { body: mp8.body, headers: mp8.headers, raw: true });
      check('push-upload folder -> dry-run (tanpa token)', d.data?.dryRun === true, d.data?.error || '');
      check('relPaths + filter node_modules (2 file)', (d.data?.preview || []).length === 2, JSON.stringify(d.data?.preview));
      check('prefix folder tujuan dipakai', (d.data?.preview || []).every((f) => f.path.startsWith('situs/')));

      /* validasi */
      const mp9 = multipart({ repo: 'salah', branch: 'main' }, [{ field: 'zip', filename: 'a.zip', content: zipBuf3 }]);
      d = await sreq('POST', '/api/push-upload', { body: mp9.body, headers: mp9.headers, raw: true });
      check('repo tak valid -> 400', d.status === 400, d.data?.error || '');

      d = await sreq('POST', '/api/push-upload', { body: multipart({}, []).body, headers: multipart({}, []).headers, raw: true });
      check('tanpa file -> 400', d.status === 400, d.data?.error || '');

      /* progres & logout */
      d = await sreq('GET', '/api/push/progress');
      check('/api/push/progress tersedia', d.status === 200);

      /* ---- 12b. TANPA SESSION_SECRET: tidak boleh crash (bug lama: process.exit) ---- */
      console.log('\n▶ [12b] serverless tanpa SESSION_SECRET');
      const noSecret = await startDemoInstance(3116, { SERVERLESS: '1', SESSION_SECRET: '' }).ready();
      const nCookieBak = cookie; cookie = '';
      try {
        const nreq = (m, u, o) => req(m, u, { ...o, base: noSecret.url });
        let d = await nreq('GET', '/api/health');
        check('fungsi TETAP hidup tanpa SESSION_SECRET', d.status === 200 && d.data?.ok === true, 'status=' + d.status);
        check('health.secretConfigured = false', d.data?.secretConfigured === false);
        check('health.mode = serverless', d.data?.mode === 'serverless');
        check('health.publicDir = true', d.data?.publicDir === true);
        check('peringatan SESSION_SECRET ada', (d.data?.warnings || []).some((w) => /SESSION_SECRET/.test(w)));

        d = await nreq('GET', '/api/config');
        check('config membawa warnings', (d.data?.warnings || []).length >= 1);

        d = await nreq('GET', '/');
        check('halaman utama tetap 200', d.status === 200);

        // login masih berfungsi (sesi per-instance), push mock jalan
        d = await nreq('GET', '/auth/github');
        check('login demo tetap jalan', d.status === 302);
        const zipBuf4 = await fsp.readFile(zipPath);
        const mp10 = multipart(
          { repo: 'demo-user/website-portofolio', branch: 'main', useMock: 'true', message: 'uji tanpa secret' },
          [{ field: 'zip', filename: 'p.zip', contentType: 'application/zip', content: zipBuf4 }]);
        d = await nreq('POST', '/api/push-upload', { body: mp10.body, headers: mp10.headers, raw: true });
        check('push-upload tetap sukses tanpa secret', d.status === 200 && d.data?.ok === true, d.data?.error || '');
      } finally {
        noSecret.stop();
        cookie = nCookieBak;
      }

      /* ---- 12c. health endpoint di mode biasa ---- */
      const h = await req('GET', '/api/health', { base: sl.url });
      check('health: secretConfigured = true (secret diisi)', h.data?.secretConfigured === true);
      check('health: warnings kosong', (h.data?.warnings || []).length === 0, JSON.stringify(h.data?.warnings));

      d = await sreq('POST', '/api/logout');
      check('logout serverless', d.data?.ok === true);
      d = await sreq('GET', '/api/me');
      check('setelah logout tidak login', d.data?.loggedIn === false);
    } finally {
      sl.stop();
      cookie = mainCookie2;
    }
  } catch (e) {
    console.error('\n✖ ERROR saat pengujian:', e);
    results.push({ name: 'unexpected error', ok: false, extra: e.message });
  } finally {
    cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(60));
  console.log(`  Hasil: ${results.length - failed.length}/${results.length} lulus`);
  if (failed.length) { console.log('  Gagal:'); failed.forEach((f) => console.log('   - ' + f.name + (f.extra ? ' :: ' + f.extra : ''))); }
  console.log('='.repeat(60));
  process.exit(failed.length ? 1 : 0);
}

/* ZIP berisi entri "../../lol.txt" untuk menguji proteksi zip-slip */
function makeZipSlip() {
  return new Promise((resolve, reject) => {
    const dir = path.join(FIX, 'slip');
    fsp.mkdir(dir, { recursive: true })
      .then(() => fsp.writeFile(path.join(dir, 'lol.txt'), 'evil'))
      .then(() => {
        // buat zip normal lalu sunting nama entri lewat python (zip CLI menolak "..")
        const py = `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'w')
z.writestr('../../lol.txt','evil')
z.writestr('aman.txt','ok')
z.close()
`;
        const out = path.join(FIX, 'evil.zip');
        const p = spawn('python3', ['-c', py, out]);
        p.on('error', reject);
        p.on('close', (c) => (c === 0 ? resolve(fs.readFileSync(out)) : reject(new Error('gagal membuat zip uji'))));
      })
      .catch(reject);
  });
}

main();
