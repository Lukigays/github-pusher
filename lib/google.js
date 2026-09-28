/**
 * lib/google.js
 * ------------------------------------------------------------------
 * Verifikasi Google ID Token (JWT RS256) dari Google Identity Services
 * ("Sign in with Google") tanpa library tambahan — pakai crypto Node.
 *
 * Catatan penting:
 *   Login Google TIDAK memberi akses ke GitHub. User yang login lewat
 *   Google tetap harus menghubungkan Personal Access Token (PAT) GitHub
 *   agar bisa push. Login GitHub OAuth-lah yang memberi token push otomatis.
 * ------------------------------------------------------------------
 */
const crypto = require('crypto');

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const VALID_ISS = ['https://accounts.google.com', 'accounts.google.com'];

let certsCache = { keys: null, exp: 0 };

function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function getCerts(force = false) {
  const now = Date.now();
  if (!force && certsCache.keys && certsCache.exp > now + 60_000) return certsCache.keys;
  const res = await fetch(CERTS_URL, { headers: { 'Cache-Control': 'no-store' } });
  if (!res.ok) throw new Error(`Gagal mengambil Google certs (HTTP ${res.status})`);
  const jwks = await res.json();
  const keys = new Map();
  for (const k of jwks.keys || []) {
    if (k.kty !== 'RSA' || !k.n || !k.e) continue;
    keys.set(k.kid, crypto.createPublicKey({
      key: { kty: 'RSA', n: k.n, e: k.e },
      format: 'jwk',
    }));
  }
  const maxAge = Number(res.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] || 3600);
  certsCache = { keys, exp: now + maxAge * 1000 };
  return keys;
}

/**
 * @param {string} idToken - credential dari Google
 * @param {string[]} expectedAudience - daftar Google Client ID yang valid
 * @param {string} [expectedNonce]
 */
async function verifyIdToken(idToken, expectedAudience, expectedNonce) {
  if (!idToken || idToken.split('.').length !== 3) throw new Error('ID token Google tidak valid.');
  const [h, p, s] = idToken.split('.');
  const header = JSON.parse(b64urlDecode(h).toString('utf8'));
  const payload = JSON.parse(b64urlDecode(p).toString('utf8'));

  if (header.alg !== 'RS256') throw new Error(`Algoritma tak didukung: ${header.alg}`);

  let keys = await getCerts();
  let pub = keys.get(header.kid);
  if (!pub) {
    keys = await getCerts(true); // refresh sekali bila kid tidak dikenal
    pub = keys.get(header.kid);
  }
  if (!pub) throw new Error('Kunci publik Google tidak ditemukan (kid tidak dikenal).');

  const ok = crypto.createVerify('RSA-SHA256')
    .update(`${h}.${p}`)
    .verify(pub, b64urlDecode(s));
  if (!ok) throw new Error('Tanda tangan ID token Google tidak valid.');

  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(expectedAudience) ? expectedAudience : [expectedAudience];
  if (!auds.filter(Boolean).includes(payload.aud)) throw new Error('Audience ID token tidak cocok dengan GOOGLE_CLIENT_ID.');
  if (!VALID_ISS.includes(payload.iss)) throw new Error(`Issuer tidak valid: ${payload.iss}`);
  if (payload.exp && payload.exp < now - 30) throw new Error('ID token Google sudah kedaluwarsa.');
  if (payload.iat && payload.iat > now + 300) throw new Error('ID token Google berasal dari masa depan (jam server tidak sinkron?).');
  if (expectedNonce && payload.nonce !== expectedNonce) throw new Error('Nonce tidak cocok.');

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: !!payload.email_verified,
    name: payload.name,
    picture: payload.picture,
    locale: payload.locale,
    hd: payload.hd,
  };
}

module.exports = { verifyIdToken };
