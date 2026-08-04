import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey, decryptChromeCookie, buildCookieHeader } from '../src/auth/store.js';

// Fixed vector computed independently with the documented v10 scheme:
//   key = PBKDF2-HMAC-SHA1("testpassword123", "saltysalt", 1003, 16)
//   AES-128-CBC, IV = 16 x 0x20, plaintext = "hello-cookie-value-123"
const PASSWORD = 'testpassword123';
const KEY_HEX = '12f28b14d5df4e0e6e2b07b80e20a4b7';
const CIPHER_HEX = '763130d99699810a6a85a6baaaf2ecb7522beb3b8aabe7ccfa1840da14149ebac4b8d0';
const EXPECTED = 'hello-cookie-value-123';

test('deriveKey matches the known PBKDF2 vector', () => {
  assert.equal(deriveKey(PASSWORD).toString('hex'), KEY_HEX);
});

test('decryptChromeCookie decrypts a known v10 ciphertext', () => {
  const key = Buffer.from(KEY_HEX, 'hex');
  const value = decryptChromeCookie(Buffer.from(CIPHER_HEX, 'hex'), key);
  assert.equal(value, EXPECTED);
});

test('decryptChromeCookie returns null for unsupported prefixes', () => {
  const key = Buffer.from(KEY_HEX, 'hex');
  assert.equal(decryptChromeCookie(Buffer.from('v20abcdef', 'utf8'), key), null);
  assert.equal(decryptChromeCookie(Buffer.alloc(2), key), null);
});

test('buildCookieHeader joins pairs and honors the `only` filter', () => {
  const jar = { a: '1', __Secure_1PSID: 'x', b: '2' };
  assert.equal(buildCookieHeader(jar), 'a=1; __Secure_1PSID=x; b=2');
  assert.equal(buildCookieHeader(jar, { only: ['a', 'b'] }), 'a=1; b=2');
});
