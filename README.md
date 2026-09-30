# GitHub ZIP / Folder Pusher

Aplikasi web (Node.js + Express) untuk **login GitHub/Google**, lalu **upload folder atau file ZIP** yang otomatis **diekstrak di server** dan **di-push ke repository GitHub** — semuanya lewat **GitHub REST API**, jadi **tidak perlu `git` terpasang** di server (cocok untuk shared hosting / VPS minim tooling).

```
[Browser]  upload ZIP / folder
     │
     ▼
[Express]  simpan sementara → ekstrak (yauzl) → filter node_modules/.git/dll
     │
     ▼
[GitHub REST API]
     POST /git/blobs   (isi tiap file, base64, paralel)
     POST /git/trees   (base_tree = tree branch tujuan → file lama tetap ada)
     POST /git/commits (1 commit untuk seluruh folder)
     PATCH/POST /git/refs/heads/<branch>
     │
     ▼
  Commit muncul di repo Anda + link commit & folder
```

---

## Fitur

| Fitur | Keterangan |
|---|---|
| Login GitHub (OAuth App) | Sekali login langsung dapat token dengan scope `repo` |
| Login Google (Identity Services) | ID token diverifikasi di server (RS256, tanpa library JWT) + hubungkan PAT GitHub |
| Login Personal Access Token | Tanpa OAuth App sama sekali — cocok untuk tool internal |
| Upload **ZIP** | Diekstrak di server, aman dari *zip-slip*, dukung nama file non-UTF8 (cp850/cp1252/shift_jis) |
| Upload **folder** | Drag & drop folder atau `<input webkitdirectory>`, struktur folder dipertahankan |
| Buang folder pembungkus | ZIP GitHub (`repo-main/…`) otomatis di-*strip* |
| Filter bawaan | `node_modules`, `.git`, `dist`, `build`, `__pycache__`, `.DS_Store`, dll. dilewati |
| Pilih repo & branch | Daftar repo milik user (termasuk yang bisa di-push), daftar branch, tandai branch *protected* |
| Buat branch baru | `createBranch` + pilih branch basis |
| Folder tujuan | Push ke root atau subfolder, mis. `public/assets` |
| Timpa / jangan timpa | `overwrite=false` → error 409 + daftar file konflik |
| Ganti isi folder | `deleteExisting` → file lama di folder tujuan yang tidak ada di upload ikut dihapus |
| **🗑 Wipe branch (zona berbahaya)** | Hapus SEMUA file di branch terpilih lewat satu commit tree kosong (`POST /api/wipe`) + konfirmasi ganda di UI (ketik nama branch). Riwayat utuh; pemulihan = revert commit. Butuh token asli, rate-limit 5x/menit |
| Dry-run | Lihat rencana commit + urutan panggilan API tanpa menyentuh repo |
| Progress real-time | Bar progres upload, ekstraksi, dan unggah blob (polling `/api/push/progress`) |
| Mode demo + GitHub tiruan | Tanpa kredensial apa pun tetap bisa mencoba **alur push penuh** (in-memory) |
| CLI | `node cli/push.js` untuk push dari terminal / script / CI |
| Uji otomatis | 145 pengujian end-to-end (mock GitHub API + mode serverless) |
| **Siap Vercel** | Mode serverless: sesi cookie HMAC, semua di memori, upload+push 1 request — lihat `README-VERCEL.md` |

---

## Struktur proyek

```
github-zip-pusher/
├── server.js              # Express: auth, upload, push (+ deteksi mode serverless)
├── api/
│   └── index.js           # titik masuk fungsi Vercel (module.exports = app)
├── vercel.json            # maxDuration 300, memory 1024, includeFiles, rewrites
├── .vercelignore          # node_modules/data/test tidak ikut terupload
├── .env.vercel.example    # template environment variable Vercel
├── lib/
│   ├── extractor.js       # ekstrak ZIP (yauzl) ke DISK atau ke MEMORI
│   ├── github.js          # klien GitHub REST API + push via Git Data API (+ mock)
│   ├── google.js          # verifikasi Google ID token (JWT RS256)
│   ├── cookiesession.js   # sesi cookie HMAC (pengganti express-session di serverless)
│   ├── filesource.js      # baca isi file dari disk atau buffer
│   ├── codepage.js        # decoder nama file ZIP lawas (cp850/cp1252/shift_jis)
│   └── codepage-data.js   # tabel codepage (dibangun otomatis)
├── public/
│   ├── index.html         # UI (tanpa framework, tanpa CDN — bisa offline)
│   └── app.js             # logika frontend
├── cli/
│   └── push.js            # CLI: push folder/ZIP dari terminal
├── test/
│   ├── mock-github.js     # tiruan GitHub REST API
│   └── run-test.js        # uji end-to-end (89 kasus, termasuk mode Vercel)
├── data/tmp/              # folder kerja sementara (dibersihkan otomatis tiap 1 jam)
├── .env.example
└── package.json
```

---

## 1. Instalasi

Butuh **Node.js ≥ 18.17** (disarankan 20+).

```bash
cd github-zip-pusher
npm install
cp .env.example .env       # lalu isi (lihat bagian 2)
npm start                  # http://localhost:3000
```

> Tanpa mengisi apa pun di `.env`, aplikasi tetap jalan sebagai **mode demo** — Anda bisa mencoba upload ZIP/folder dan push ke **GitHub tiruan** di memori server.

---

## 2. Konfigurasi `.env`

```ini
PORT=3000
HOST=0.0.0.0
PUBLIC_URL=                      # kosongkan saat dev; isi domain saat deploy
SESSION_SECRET=string-acak-panjang

# --- Login GitHub (OAuth App) ---
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_SCOPE=repo                # 'public_repo' bila hanya repo publik
GITHUB_API_URL=https://api.github.com   # GHE: https://github.kantor.com/api/v3
GITHUB_CONCURRENCY=5

# --- Login Google (opsional) ---
GOOGLE_CLIENT_ID=

# --- Mode demo ---
ALLOW_MOCK_PUSH=1                # 1 = izinkan "push ke GitHub tiruan"
GITHUB_TOKEN=                    # token tetap (opsional, untuk server pribadi)

# --- Batasan ---
MAX_UPLOAD_MB=512
MAX_FILES=20000
TMP_DIR=./data/tmp
```

### 2a. Membuat OAuth App GitHub (agar tombol "Lanjut dengan GitHub" aktif)

1. Buka <https://github.com/settings/developers> → **OAuth Apps** → **New OAuth App**
2. Isi:
   - **Application name**: bebas, mis. `ZIP Pusher`
   - **Homepage URL**: `http://localhost:3000`
   - **Authorization callback URL**: `http://localhost:3000/auth/github/callback` ← **harus persis**
3. **Generate a new client secret**, lalu salin `Client ID` & `Client Secret` ke `.env`
4. `npm start` ulang

Saat deploy, ubah kedua URL ke domain Anda (mis. `https://pusher.domainku.com/auth/github/callback`), atau set `PUBLIC_URL=https://pusher.domainku.com` agar callback dibuat otomatis dari domain tersebut.

> **Penting soal izin:** OAuth App dengan scope `repo` memberi token yang bisa push ke repo privat. Tanpa scope itu, push ke repo privat akan ditolak (403/404).
> Alternatif paling aman: **GitHub App** dengan izin *Contents: Read & write* (lihat *Catatan* di bawah).

### 2b. Login Google (opsional)

1. <https://console.cloud.google.com/apis/credentials> → **Create Credentials** → **OAuth client ID** → **Web application**
2. **Authorized JavaScript origins**: `http://localhost:3000`
3. Salin **Client ID** ke `GOOGLE_CLIENT_ID` di `.env`

⚠️ **Login Google tidak memberi akses ke GitHub.** Setelah login Google, user harus menghubungkan **Personal Access Token** GitHub (scope `repo`) lewat menu di aplikasi. Ini batasan desain yang wajar: Google tidak punya token GitHub Anda.

### 2c. Personal Access Token (paling praktis, tanpa OAuth App)

- Classic PAT: <https://github.com/settings/tokens/new?scopes=repo> → `ghp_…`
- Fine-grained: <https://github.com/settings/personal-access-tokens/new> → pilih repo + izin **Contents: Read and write** → `github_pat_…`

Tempel di aplikasi (tombol *Masuk dengan Personal Access Token*), atau lewat CLI:

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxx
```

Token disimpan **hanya di sesi server (memori)** dan hilang saat logout/restart. Untuk produksi, gunakan session store terenkripsi (Redis + `connect-redis`) dan jangan pernah menulis token ke log.

---

## 3. Cara pakai (web)

1. **Login** — GitHub (disarankan) / Google+PAT / PAT.
2. **Langkah 1 – Pilih file**
   - Tab **📦 File ZIP**: tarik-lepas atau klik untuk memilih `.zip`.
   - Tab **📁 Folder**: tarik-lepas folder, atau klik untuk memilih folder dari komputer.
   - Setelah selesai, muncul ringkasan: jumlah file, folder, total ukuran, tipe file terbanyak, dan pratinjau pohon file.
3. **Langkah 2 – Tujuan push**
   - **Repository**: cari/ketik untuk memfilter, klik salah satu.
   - **Branch tujuan**: pilih branch yang ada, atau isi **branch baru** lalu klik *Pakai*.
   - **Folder tujuan**: kosongkan untuk root, atau isi mis. `public/assets`.
   - **Pesan commit**.
   - *Opsi lanjutan*: timpa file, hapus file lama di folder tujuan, dry-run, branch basis, push ke GitHub tiruan.
4. Klik **Lihat rencana commit** untuk dry-run, atau **Push ke GitHub**.
5. **Langkah 3 – Hasil**: progress bar, log, lalu tombol **Lihat commit** & **Lihat folder di repo**.

---

## 4. Cara pakai (CLI)

```bash
# push folder ke branch gh-pages, folder tujuan "assets"
node cli/push.js ./dist --repo saya/web --branch gh-pages --dest assets

# push file ZIP + buang folder pembungkus + buat branch baru dari main
node cli/push.js ./proyek.zip --repo saya/web --branch upload/asset \
     --create-branch --base main --message "Upload aset baru"

# lihat rencana saja (tidak push)
node cli/push.js ./src --repo saya/web --branch main --dry-run

# GitHub Enterprise Server
node cli/push.js ./build --repo saya/web --branch main \
     --api-url https://github.kantor.com/api/v3

# ganti seluruh isi folder tujuan (hapus file lama yang tak terupload)
node cli/push.js ./public --repo saya/web --branch main --dest public --delete-existing
```

Opsi lengkap: `node cli/push.js --help`. Token diambil dari `--token`, `GITHUB_TOKEN`, atau `.env`.

---

## 5. Endpoint API

| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/config` | Konfigurasi publik (login apa saja yang aktif, batas upload) |
| GET | `/api/me` | Status login + sumber token |
| GET | `/auth/github` | Mulai OAuth GitHub |
| GET | `/auth/github/callback` | Callback OAuth (tukar `code` → token) |
| POST | `/auth/google` | Login Google (body: `{ credential }`) |
| POST | `/auth/token` | Login pakai PAT (body: `{ token }`) |
| POST | `/api/link-token` | Hubungkan PAT ke sesi yang sedang login |
| POST | `/api/logout` | Logout + hapus file sementara |
| GET | `/api/repos` | Daftar repo (query `includeOrgs=1` untuk repo organisasi) |
| GET | `/api/branches/:owner/:repo` | Daftar branch + branch default + izin |
| GET | `/api/tree/:owner/:repo?path=` | Isi folder di repo |
| POST | `/api/repos` | Buat repo baru |
| POST | `/api/files/zip` | Upload ZIP (multipart, field `zip`) → ekstrak |
| POST | `/api/files/folder` | Upload folder (multipart, field `files[]`) |
| GET | `/api/files` | Daftar file hasil ekstraksi sesi ini |
| GET | `/api/files/progress` | Progres ekstraksi |
| DELETE | `/api/files` | Hapus file sementara |
| POST | `/api/push` | Push ke repo (`dryRun`, `useMock` didukung) |
| GET | `/api/push/progress` | Progres push (tahap & jumlah blob) |

Contoh `POST /api/push`:

```json
{
  "repo": "saya/web",
  "branch": "gh-pages",
  "destPath": "assets",
  "message": "Upload aset dari ZIP",
  "createBranch": false,
  "baseBranch": "main",
  "overwrite": true,
  "deleteExisting": false,
  "dryRun": false
}
```

Respons sukses:

```json
{
  "ok": true,
  "sha": "9bf1162cfb3186025d9892ab4a4338774268307f",
  "shortSha": "9bf1162",
  "branch": "gh-pages",
  "branchCreated": true,
  "commitUrl": "https://github.com/saya/web/commit/9bf1162...",
  "treeUrl": "https://github.com/saya/web/tree/gh-pages/assets",
  "files": [{ "path": "assets/index.html", "size": 1234, "sha": "..." }],
  "overwritten": [],
  "removed": []
}
```

---

## 6. Menjalankan uji

```bash
npm test        # 89 kasus end-to-end terhadap mock GitHub API
npm run mock    # jalankan tiruan GitHub API di :8080 (untuk eksperimen manual)
```

Yang diuji: login PAT, daftar repo/branch, ekstrak ZIP (strip root + filter `node_modules`), dry-run, push ke root, push ke subfolder + branch baru, proteksi konflik (409), upload folder, **zip-slip**, decoder codepage (cp850/cp1252/shift_jis), validasi `destPath`/nama branch/nama repo, `relPaths` fallback, logout, mode demo + push ke GitHub tiruan, serta **mode serverless/Vercel** (sesi cookie antar-request, endpoint disk → 501, `POST /api/push-upload` untuk ZIP & folder).

---

## 6b. Deploy ke Vercel

Aplikasi ini **sudah siap Vercel**: `api/index.js` + `vercel.json` + mode serverless otomatis.
Panduan lengkap (beserta batas platform & pemecahan masalah) ada di **`README-VERCEL.md`**.

```bash
# 1. push folder ini ke repo GitHub Anda
git init && git add . && git commit -m "github-zip-pusher" && git branch -M main
git remote add origin https://github.com/USERNAME/NAMA-REPO.git && git push -u origin main
# 2. vercel.com/new -> import repo -> isi Environment Variables -> Deploy
```

Environment variable minimum: `SESSION_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `PUBLIC_URL`.
Callback OAuth GitHub: `https://nama-proyek.vercel.app/auth/github/callback`.

**Batas Vercel yang tidak bisa diubah:** body request **4,5 MB** dan `/tmp` tidak persisten. Karena itu di Vercel aplikasi otomatis:

- menyimpan sesi di **cookie bertanda tangan HMAC** (bukan memori proses),
- mengekstrak ZIP **sepenuhnya di RAM**,
- menggabungkan upload + push jadi **satu request**: `POST /api/push-upload`
  (endpoint berbasis disk seperti `/api/files/zip` membalas `501` beserta petunjuknya),
- menampilkan pratinjau isi ZIP **dari browser** (parser EOCD di `app.js`) karena server tidak menyimpan apa pun.

Proyek lebih besar dari 4,5 MB → pakai **`cli/push.js`** dari komputer Anda (tanpa batas ukuran),
atau deploy ke VPS/Railway/Render dengan `npm start` (semua fitur mode disk aktif).

Uji lokal ala Vercel:

```bash
SERVERLESS=1 SESSION_SECRET=coba-lokal npm start
curl -s localhost:3000/api/config   # {"serverless":true,"oneshot":true,"maxUploadMB":4.3,...}
```

---

## 7. Deploy (VPS / Docker)

### Nginx reverse proxy + HTTPS (disarankan)

```nginx
server {
  server_name pusher.domainku.com;
  client_max_body_size 512m;          # samakan dengan MAX_UPLOAD_MB

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;   # dibutuhkan cookie secure
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 600s;                       # push repo besar
    proxy_request_buffering off;                   # upload besar lebih lancar
  }
}
```

Lalu di `.env`: `PUBLIC_URL=https://pusher.domainku.com` dan daftarkan callback `https://pusher.domainku.com/auth/github/callback` di OAuth App GitHub.

### systemd

```ini
[Unit]
Description=GitHub ZIP Pusher
After=network.target

[Service]
WorkingDirectory=/var/www/github-zip-pusher
ExecStart=/usr/bin/node server.js
Restart=always
Environment=NODE_ENV=production
User=www-data

[Install]
WantedBy=multi-user.target
```

### Docker (opsional)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=3000 HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "server.js"]
```

```bash
docker build -t zip-pusher . && docker run -d -p 3000:3000 --env-file .env zip-pusher
```

### Checklist produksi

- [ ] `SESSION_SECRET` acak panjang, `NODE_ENV=production`
- [ ] Gunakan session store persisten (Redis) bila lebih dari 1 proses/instance
- [ ] HTTPS wajib (OAuth + cookie `secure`)
- [ ] `ALLOW_MOCK_PUSH=0` bila tidak ingin ada mode simulasi
- [ ] Batasi `MAX_UPLOAD_MB`, `MAX_FILES`, dan disk `TMP_DIR`
- [ ] Pasang rate limit lebih ketat di depan (mis. nginx `limit_req`)
- [ ] Jangan simpan token di log; pertimbangkan mengenkripsi token di sesi

---

## 8. Batasan & catatan penting

- **Maks 100 MB per file** — batas blob Git Data API GitHub. File lebih besar ditolak dengan pesan jelas; gunakan Git LFS lewat `git` CLI untuk kasus itu.
- **Rate limit** — setiap file = 1 permintaan `POST /git/blobs`. 1.000 file ≈ 1.000 permintaan (limit 5.000/jam untuk token terautentikasi). Naikkan/turunkan `GITHUB_CONCURRENCY` sesuai kebutuhan.
- **Branch protected** — push langsung bisa ditolak (422). Solusi: push ke branch baru lalu buat Pull Request, atau longgarkan aturan proteksi.
- **Commit tunggal** — seluruh upload jadi 1 commit; riwayat commit asli dari ZIP tidak ikut terbawa (ZIP tidak menyimpan riwayat git).
- **Repo kosong** — bila repo belum punya commit sama sekali, buat dulu branch basis (mis. centang *Inisialisasi dengan README* saat membuat repo baru).
- **Mode demo** — tanpa `GITHUB_CLIENT_ID/SECRET`, login menjadi akun demo dan push hanya *dry-run* atau ke GitHub tiruan di memori (data hilang saat server berhenti).
- **Keamanan** — path entri ZIP selalu dinormalisasi; entri berisi `..`, symlink, dan path absolut dibuang. Nama file di disk dibuat acak, jadi `originalname` tidak pernah dipakai sebagai path.
- **GitHub App (alternatif lebih aman)** — untuk produksi multi-user, ganti OAuth App dengan GitHub App: izin *Contents: Read & write* per-repo, token instalasi berumur 1 jam, dan tidak ada scope `repo` yang terlalu luas. Alur API-nya sama persis dengan kode di `lib/github.js` (cukup ganti sumber token).

---

## 9. Pemecahan masalah

| Gejala | Sebab & solusi |
|---|---|
| `redirect_uri_mismatch` saat login GitHub | Callback URL di OAuth App ≠ `PUBLIC_URL/auth/github/callback`. Samakan persis (skema, host, port, tanpa slash akhir). |
| Setelah login GitHub, kembali ke halaman login | Cookie diblokir (iframe/SameSite). Buka aplikasi di tab tersendiri, atau pastikan HTTPS + `trust proxy` benar. |
| `404 Not Found` saat push | Token tidak punya akses ke repo itu (scope `repo` kurang) atau nama repo/branch salah. |
| `403 resource not protected by scope` | Scope token kurang; buat PAT baru dengan `repo`. |
| `422 Update is not a fast forward` / branch protected | Branch dilindungi. Push ke branch baru (`--create-branch`) lalu buka PR. |
| `403 rate limit exceeded` | Tunggu reset (cek header `X-RateLimit-Reset`) atau kurangi jumlah file per push. |
| ZIP terproteksi password | Tidak didukung GitHub API. Ekstrak dulu di komputer, lalu upload sebagai folder. |
| Nama file ZIP berantakan (mis. `Kopi²`) | ZIP dibuat dengan codepage non-UTF8. Kirim `codepage` saat upload (`windows-1252`, `shift_jis`, `cp1251`). |
| Upload folder hanya mengirim nama file (tanpa path) | Browser lama; aplikasi otomatis memakai field `relPaths` sebagai cadangan. |
| `LIMIT_FILE_SIZE` | Naikkan `MAX_UPLOAD_MB` di `.env` **dan** `client_max_body_size` di nginx. |

---

## Lisensi

MIT — bebas dipakai dan dimodifikasi.
