/**
 * lib/codepage.js
 * ------------------------------------------------------------------
 * Decoder nama file untuk arsip ZIP lawas.
 *
 * Kenapa tidak cukup `TextDecoder`?
 *   Sebagian build Node (small-icu) memetakan windows-1252 / ISO-8859-x
 *   secara tidak lengkap (byte 0x80–0x9F dilewatkan apa adanya). Karena itu
 *   codepage 1-byte ditangani dengan tabel internal, sementara codepage
 *   multi-byte (shift_jis, gbk, big5, euc-kr…) diserahkan ke ICU.
 * ------------------------------------------------------------------
 */
const DATA = require('./codepage-data');

const cache = new Map();

function normalize(label) {
  if (!label) return null;
  const key = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return DATA.alias[key] || DATA.alias[key.replace(/-/g, '')] || key;
}

/** Decode buffer menjadi string memakai codepage tertentu. */
function decodeBuffer(buf, label) {
  const name = normalize(label);
  if (!name) return buf.toString('utf8');

  // 1) tabel internal (codepage 1-byte) — hasil pasti benar
  const b64 = DATA.tables[name];
  if (b64) {
    let table = cache.get(name);
    if (!table) {
      table = Buffer.from(b64, 'base64').toString('utf16le');
      cache.set(name, table);
    }
    let out = '';
    for (const byte of buf) {
      out += byte < 0x80 ? String.fromCharCode(byte) : (table[byte - 0x80] || '\uFFFD');
    }
    return out;
  }

  // 2) ICU (shift_jis, gbk, big5, euc-kr, koi8-u, …)
  try {
    return new TextDecoder(name).decode(buf);
  } catch (_) {
    try { return new TextDecoder(label).decode(buf); } catch (__) { return buf.toString('utf8'); }
  }
}

/** Apakah buffer ini UTF-8 yang valid? */
function isValidUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Tebak encoding nama file ZIP:
 *   flag UTF-8 hidup  -> UTF-8
 *   bytes valid UTF-8 -> UTF-8
 *   selain itu        -> codepage pilihan user, default cp850 (DOS Latin-1)
 */
function decodeZipName(buf, { utf8Flag = false, codepage = null } = {}) {
  if (!buf || !buf.length) return '';
  if (utf8Flag) return buf.toString('utf8');
  if (isValidUtf8(buf)) return buf.toString('utf8');
  return decodeBuffer(buf, codepage || 'cp850');
}

module.exports = { decodeBuffer, decodeZipName, isValidUtf8, normalize, supported: Object.keys(DATA.tables) };
