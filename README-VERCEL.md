# Deploy ke Vercel — GitHub ZIP / Folder Pusher

Panduan lengkap men-deploy aplikasi ini ke Vercel, **beserta batas nyata platformnya** dan cara menyiasatinya.

---

## 0. Baca ini dulu: batas Vercel yang tidak bisa diubah

| Batas | Nilai | Dampak ke aplikasi ini |
|---|---|---|
| **Ukuran body request** | **4,5 MB** (semua plan, termasuk Pro) | ZIP/folder yang diupload **maks ±4,3 MB**. Melebihi itu → `413 FUNCTION_PAYLOAD_TOO_LARGE` dari Vercel, fungsi tidak pernah terpanggil. |
| **Disk `/tmp`** | 512 MB, **tidak persisten** antar-request | Tidak bisa "upload dulu → push nanti". Aplikasi otomatis pindah ke **mode sekali jalan**: upload + ekstrak + push dalam **satu** request, semua di RAM. |
| **Memori fungsi** | 1 GB (Hobby) / s.d. 4 GB (Pro) | Isi file ditampung di RAM → jumlah file dibatasi `MAX_FILES=300`. |
| **Durasi fungsi** | 60 s (Hobby default) / maks 300 s | Push ribuan file bisa kena timeout. `maxDuration: 300` sudah diset di `vercel.json`. |
| **State antar-request** | Tidak ada | Sesi disimpan di **cookie bertanda tangan HMAC** (`lib/cookiesession.js`), bukan `express-session`. |

### Kalau file Anda lebih besar dari 4,5 MB (pilihan jujur)

1. **Pakai CLI dari komputer Anda** — paling praktis, tanpa batas ukuran:
   ```bash
   export GITHUB_TOKEN=ghp_xxx
   node cli/push.js ./proyek-200mb --repo saya/web --branch main
   ```
   (CLI bicara langsung ke GitHub, tidak lewat Vercel → batas 4,5 MB tidak berlaku.)
2. **Deploy ke platform yang punya disk & proses panjang**: VPS + nginx, Railway, Render, Fly.io, Google Cloud Run. Repo ini sudah mendukung mode itu (`npm start`, lihat README bagian *Deploy*).
3. **Upload langsung ke Vercel Blob / S3 dari browser**, lalu fungsi Vercel hanya meneruskan ke GitHub. Ini perubahan arsitektur (belum termasuk dalam paket ini) — bisa saya buatkan kalau dibutuhkan.

> Untuk ZIP berisi source code tanpa `node_modules` (sudah otomatis difilter), 4,3 MB biasanya cukup untuk ratusan hingga ribuan file.

---

## 1. Cara A — Deploy lewat GitHub (disarankan)

```bash
# 1. siapkan folder proyek (hasil unzip)
cd github-zip-pusher

# 2. (opsional) uji dulu di lokal
npm install
npm test            # 89 pengujian
npm start           # buka http://localhost:3000

# 3. naikkan ke repo GitHub Anda
git init && git add . && git commit -m "github-zip-pusher"
git branch -M main
git remote add origin https://github.com/USERNAME/NAMA-REPO.git
git push -u origin main
```

4. Buka **[vercel.com/new](https://vercel.com/new)** → **Import** repo tersebut.
5. Vercel otomatis mendeteksi preset **Other** + `vercel.json` (tidak perlu mengatur build command).
6. **Sebelum klik Deploy**, buka **Environment Variables** dan isi (lihat bagian 3).
7. **Deploy**.

## 1b. Cara B — Deploy lewat CLI Vercel

```bash
npm i -g vercel
cd github-zip-pusher
vercel login
vercel                    # deploy preview
vercel env add SESSION_SECRET
vercel env add GITHUB_CLIENT_ID
vercel env add GITHUB_CLIENT_SECRET
vercel env add PUBLIC_URL
vercel --prod             # deploy produksi
```

---

## 2. Isi paket yang membuatnya "Vercel-ready"

```
api/index.js          # titik masuk fungsi: module.exports = require('../server')
vercel.json           # maxDuration 300, memory 1024, includeFiles {public,lib}/**,
                      # rewrite semua path (selain /api/*) ke api/index.js
.vercelignore         # node_modules, data, test/fixtures, .env tidak ikut terupload
.env.vercel.example   # template environment variable Vercel
lib/cookiesession.js  # sesi berbasis cookie HMAC (pengganti express-session)
lib/filesource.js     # baca isi file dari disk ATAU dari memori (Buffer)
server.js             # deteksi VERCEL/SERVERLESS -> memori + mode sekali jalan
public/app.js         # UI menyesuaikan: pratinjau ZIP di browser + push 1 request
```

Yang berubah otomatis saat `VERCEL` terdeteksi:

| Aspek | Mode server (VPS) | Mode Vercel |
|---|---|---|
| Sesi | `express-session` (memori proses) | Cookie HMAC bertanda tangan |
| Penyimpanan file | `data/tmp/<sesi>/files` di disk | Buffer di RAM, per-request |
| Alur | upload → pratinjau → push (2 request) | **upload + push (1 request)** |
| Endpoint upload | `POST /api/files/zip`, `POST /api/push` | `POST /api/push-upload` (yang lain balas `501` + petunjuk) |
| Batas | 512 MB / 20.000 file | **4,3 MB / 300 file** (dikunci) |
| `app.listen()` | dipanggil | **tidak** dipanggil (Vercel yang memanggil handler) |

Pratinjau isi ZIP di mode Vercel dibuat **di browser** (parser *End of Central Directory* di `public/app.js`) supaya user tetap melihat daftar file sebelum push, padahal server tidak menyimpan apa pun.

---

## 3. Environment Variables (Dashboard → Settings → Environment Variables)

| Nama | Wajib | Contoh / keterangan |
|---|---|---|
| `SESSION_SECRET` | **YA** | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`<br/>Harus **sama** di Production/Preview/Development. Kalau berubah-ubah, login tidak akan "menempel". |
| `GITHUB_CLIENT_ID` | **YA** untuk login GitHub | Dari OAuth App (bagian 4) |
| `GITHUB_CLIENT_SECRET` | **YA** untuk login GitHub | Dari OAuth App |
| `PUBLIC_URL` | disarankan | `https://nama-proyek.vercel.app` |
| `GITHUB_SCOPE` | opsional | `repo` (default). `public_repo` bila hanya repo publik. |
| `GOOGLE_CLIENT_ID` | opsional | Untuk tombol login Google |
| `ALLOW_MOCK_PUSH` | opsional | `1` = izinkan "push ke GitHub tiruan" untuk demo. Set `0` di produksi bila tak diinginkan. |
| `GITHUB_CONCURRENCY` | opsional | `5` (default). Naikkan untuk mempercepat push banyak file. |
| `MAX_UPLOAD_MB` / `MAX_FILES` | jangan diubah | Dikunci 4,3 MB / 300 file di Vercel. |

Alternatif tanpa OAuth App: isi `GITHUB_TOKEN=ghp_...` (token dipakai semua sesi — **hanya** cocok untuk tool pribadi/internal, jangan untuk aplikasi publik).

---

## 4. Callback URL OAuth GitHub untuk Vercel

Di <https://github.com/settings/developers> → OAuth App Anda:

- **Homepage URL**: `https://nama-proyek.vercel.app`
- **Authorization callback URL**: `https://nama-proyek.vercel.app/auth/github/callback`

⚠️ **URL preview deploy** (`https://nama-proyek-git-branch-xxx.vercel.app`) **tidak akan bisa** dipakai login GitHub, karena OAuth App hanya menerima callback yang terdaftar persis. Solusi:

- Pakai **Production domain** untuk menguji login, atau
- Tambahkan **Custom Domain**, atau
- Buat **OAuth App kedua** khusus preview dengan callback URL preview-nya.

Aplikasi menyusun callback dari `PUBLIC_URL` (bila diisi) atau dari header `Host` request. Di Vercel, `x-forwarded-proto` sudah dihormati (`app.set('trust proxy', 1)`), jadi `https://` terbentuk otomatis.

---

## 5. Uji lokal ala Vercel

```bash
# cara 1: paksa mode serverless di lokal
SERVERLESS=1 SESSION_SECRET=coba-lokal-123 npm start
# -> banner: Mode: SERVERLESS (memori, upload+push sekali jalan)

# cara 2: pakai Vercel CLI (paling mirip produksi)
npm i -g vercel
vercel env pull .env.vercel.local
vercel dev
```

Verifikasi cepat:

```bash
curl -s localhost:3000/api/config
# {"serverless":true,"oneshot":true,"maxUploadMB":4.3,"maxFiles":300,...}

curl -s -X POST localhost:3000/api/files/zip
# {"error":"Endpoint ini tidak tersedia di mode serverless ...","hint":"Gunakan POST /api/push-upload ..."}
```

---

## 6. Pemecahan masalah di Vercel

| Gejala | Sebab & solusi |
|---|---|
| `413 FUNCTION_PAYLOAD_TOO_LARGE` | ZIP/folder > 4,5 MB. Batas infrastruktur Vercel — pakai CLI atau platform lain (bagian 0). |
| Login berhasil lalu balik ke halaman login | `SESSION_SECRET` tidak di-set (rahasia acak per-instance) **atau** berbeda antar environment. Set satu nilai tetap. |
| `redirect_uri_mismatch` | Callback URL di OAuth App ≠ `https://domain-anda/auth/github/callback`. Anda mungkin sedang membuka URL preview. |
| Halaman putih / `Cannot GET /` | `rewrites` di `vercel.json` belum diterapkan — pastikan file `vercel.json` ada di root repo dan `api/index.js` ada. |
| `MODULE_NOT_FOUND: public/...` | Asset statis tidak ikut ter-bundle. `includeFiles: "{public,lib}/**"` sudah diset; pastikan folder `public/` ter-commit ke git (bukan di `.gitignore`). |
| `FUNCTION_INVOCATION_TIMEOUT` | Terlalu banyak file / GitHub lambat. Turunkan jumlah file per push, naikkan `GITHUB_CONCURRENCY`, atau set `maxDuration` lebih besar (butuh plan Pro untuk >60 s di beberapa region). |
| `501` pada `/api/files/*` atau `/api/push` | Memang disengaja di serverless (butuh disk). UI otomatis memakai `/api/push-upload`. |
| Push sukses tapi branch "hilang" di demo | Anda memakai **GitHub tiruan** (`ALLOW_MOCK_PUSH=1`) yang datanya di RAM per-instance. Isi kredensial GitHub asli untuk push nyata. |
| Rate limit GitHub (403) | 1 file = 1 request blob. Kurangi file per push atau tunggu reset (limit 5.000/jam). |

---

## 7. Kalau butuh lebih dari 4,5 MB — perbandingan platform

| Platform | Body/upload | Disk | Cocok untuk |
|---|---|---|---|
| **Vercel** | 4,5 MB (tetap) | `/tmp` sementara | ZIP kecil, demo, tool internal ringan |
| **Railway / Render** | praktis tak dibatasi (tergantung plan) | persisten selama proses hidup | mode server penuh (`npm start`), semua fitur jalan |
| **Fly.io** | fleksibel | volume persisten | produksi serius multi-region |
| **VPS + nginx** | `client_max_body_size` bebas | persisten | kontrol penuh, lihat README bagian *Deploy* |
| **CLI di komputer Anda** | tak terbatas | disk lokal | cara tercepat untuk proyek besar |

Semua platform selain Vercel cukup menjalankan `npm start` — tidak perlu perubahan kode.

---

## 8. Checklist sebelum produksi

- [ ] `SESSION_SECRET` acak & sama di semua environment
- [ ] `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` terisi, callback URL production terdaftar
- [ ] `PUBLIC_URL` = domain production
- [ ] `ALLOW_MOCK_PUSH=0` (bila tidak ingin ada mode simulasi)
- [ ] Uji login GitHub → daftar repo muncul → push ZIP kecil ke repo uji → commit terlihat di GitHub
- [ ] Uji branch baru + folder tujuan (`destPath`)
- [ ] Cek **Runtime Logs** Vercel setelah push pertama (pastikan tidak ada error memori/timeout)
- [ ] Pertimbangkan GitHub App (izin *Contents: Read & write* per-repo) alih-alih OAuth App scope `repo` untuk keamanan lebih baik
