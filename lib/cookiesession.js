/**
 * lib/cookiesession.js
 * ------------------------------------------------------------------
 * "Sesi" berbasis cookie bertanda tangan (HMAC-SHA256) untuk lingkungan
 * SERVERLESS (Vercel) yang tidak punya penyimpanan antar-request.
 *
 * Menyediakan antarmuka mirip express-session (req.session + save/destroy)
 * sehingga seluruh route di server.js tetap jalan tanpa diubah.
 *
 * Batasan:
 *   - Total cookie browser ± 4 KB -> hanya menyimpan identitas + token,
 *     TIDAK menyimpan daftar file. Karena itu di Vercel alur push memakai
 *     mode sekali-jalan (upload ZIP + push dalam 1 request).
 *   - SESSION_SECRET WAJIB sama di semua instance (set di dashboard Vercel).
 * ------------------------------------------------------------------
 */
const crypto = require('crypto');

const COOKIE_NAME = 'gzp.sess';
const MAX_AGE_MS = 1000 * 60 * 60 * 8; // 8 jam

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (str) => Buffer.from(str, 'base64url');

function makeKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function sign(payloadB64, key) {
  return crypto.createHmac('sha256', key).update(payloadB64).digest('base64url');
}

/**
 * @param {object} opts { secret, cookieName, maxAge }
 */
function cookieSession(opts = {}) {
  const key = makeKey(opts.secret || 'insecure-default-secret-change-me');
  const name = opts.cookieName || COOKIE_NAME;
  const maxAge = opts.maxAge || MAX_AGE_MS;

  return function cookieSessionMiddleware(req, res, next) {
    let data = {};
    const raw = req.cookies && req.cookies[name];
    if (raw && typeof raw === 'string' && raw.includes('.')) {
      const [payload, sig] = raw.split('.');
      const expected = sign(payload, key);
      const a = Buffer.from(sig || '');
      const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        try {
          const parsed = JSON.parse(unb64u(payload).toString('utf8'));
          if (parsed && (!parsed.exp || parsed.exp > Date.now())) data = parsed.d || {};
        } catch (_) { /* cookie rusak -> mulai dari kosong */ }
      }
    }

    // objek sesi sementara (per-request)
    data = { ...data };
    req.session = data;
    req.sessionID = data.__id || (data.__id = crypto.randomBytes(8).toString('hex'));

    const snapshot = JSON.stringify(data);
    let saved = false;

    /** Tulis cookie sesi. Aman dipanggil berulang; gagal diam-diam bila header sudah terkirim. */
    req.sessionSave = () => {
      if (saved || res.headersSent || res.writableEnded) return;
      let payload = b64u(JSON.stringify({ d: data, exp: Date.now() + maxAge }));
      let value = `${payload}.${sign(payload, key)}`;
      // 1 cookie dibatasi ±4 KB -> buang payload besar (daftar file) bila perlu
      if (Buffer.byteLength(value) > 3800 && data.uploadInfo) {
        const slim = { ...data };
        delete slim.uploadInfo;
        payload = b64u(JSON.stringify({ d: slim, exp: Date.now() + maxAge }));
        value = `${payload}.${sign(payload, key)}`;
      }
      if (Buffer.byteLength(value) > 3800) return; // masih kebesaran -> jangan ditulis
      res.cookie(name, value, cookieOpts(req, maxAge));
      saved = true;
    };

    req.sessionDestroy = (cb) => {
      if (!res.headersSent) res.clearCookie(name, cookieOpts(req, maxAge));
      req.session = {};
      saved = true;
      if (typeof cb === 'function') cb();
    };

    /* Simpan OTOMATIS tepat sebelum header dikirim.
       Hook writeHead (bukan event 'finish') karena setelah body terkirim
       cookie sudah tidak bisa disetel lagi (ERR_HTTP_HEADERS_SENT). */
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = function patchedWriteHead(...args) {
      try {
        if (JSON.stringify(data) !== snapshot) req.sessionSave();
      } catch (_) { /* jangan gagalkan response hanya karena sesi */ }
      return origWriteHead(...args);
    };

    next();
  };

  function cookieOpts(req, ms) {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      maxAge: ms,
      path: '/',
    };
  }
}

module.exports = { cookieSession, COOKIE_NAME };
