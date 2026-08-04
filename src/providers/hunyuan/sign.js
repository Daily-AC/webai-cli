// Hunyuan 3D request signature.
//
// The web app signs a small set of *query* parameters (not the JSON body) for
// POST /api/3d/creations/generations. Its axios interceptor takes the request's
// existing query params, adds `timestamp` (unix seconds) and `nonce` (16 random
// alphanumerics), sorts every entry by key, joins them as `k=v&k=v`, and puts
// HMAC-SHA256 of that string under `sign`.
//
// The HMAC key is not stored as a literal in the bundle. It is derived at
// runtime from a 16-byte array by XOR-ing with a second array, rotating each
// byte left by a per-position amount, permuting the result, and cutting at the
// first NUL. That derivation is pure and constant, so it is reproduced here as
// KEY_SOURCE/KEY_MASK/KEY_ROTATIONS/KEY_PERMUTATION rather than pasting the
// resulting secret: if the bundle rotates the constants, this stays diffable
// against the source it came from.
import crypto from 'node:crypto';

const KEY_SOURCE = [122, 59, 92, 165, 30, 79, 166, 139, 142, 129, 139, 89, 219, 131, 101, 204];
const KEY_MASK = [122, 59, 92, 45, 30, 79, 106, 139, 156, 13, 46, 63, 74, 91, 108, 125];
const KEY_ROTATIONS = [3, 5, 2, 7, 1, 4, 6, 2, 5, 3, 1, 4, 2, 6, 3, 5];
const KEY_PERMUTATION = [14, 11, 13, 9, 15, 10, 12, 8, 6, 3, 5, 1, 7, 2, 4, 0];

const NONCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function deriveSignKey() {
  const xored = KEY_SOURCE.map((byte, i) => byte ^ KEY_MASK[i]);
  const rotated = xored.map((byte, i) => {
    const bits = KEY_ROTATIONS[i];
    return 0xff & ((byte << bits) | (byte >>> (8 - bits)));
  });
  const permuted = KEY_PERMUTATION.map((from) => rotated[from]);
  const end = permuted.indexOf(0);
  return Buffer.from(end === -1 ? permuted : permuted.slice(0, end)).toString('utf8');
}

export function makeNonce(length = 16, randomInt = (max) => crypto.randomInt(max)) {
  let out = '';
  for (let i = 0; i < length; i++) out += NONCE_ALPHABET[randomInt(NONCE_ALPHABET.length)];
  return out;
}

// Canonical string that gets HMAC'd: non-empty entries, stringified, key-sorted.
export function canonicalize(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => [key, String(value)])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

// Returns the full signed query-parameter set (input params + timestamp/nonce/sign).
export function signQuery(params = {}, { timestamp, nonce, key } = {}) {
  const signed = {
    ...params,
    timestamp: timestamp ?? Math.floor(Date.now() / 1000),
    nonce: nonce ?? makeNonce(16),
  };
  signed.sign = crypto
    .createHmac('sha256', key ?? deriveSignKey())
    .update(canonicalize(signed))
    .digest('hex');
  return signed;
}
