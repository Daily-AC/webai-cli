import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCookieHeader,
  parseCookieInput,
  toCookieMap,
  upsertCookieValue,
} from '../src/auth/cookies.js';
import { AuthError, WebaiError } from '../src/errors.js';

test('parseCookieInput accepts a DevTools Cookie header and preserves equals signs', () => {
  const cookies = parseCookieInput('Cookie: sessionKey=abc==; theme=dark', { provider: 'claude' });
  assert.deepEqual(
    cookies.map(({ name, value }) => ({ name, value })),
    [
      { name: 'sessionKey', value: 'abc==' },
      { name: 'theme', value: 'dark' },
    ]
  );
  assert.equal(cookies[0].domain, '.claude.ai');
  assert.equal(cookies[0].path, '/');
  assert.equal(cookies[0].secure, true);
  assert.equal(cookies[0].hostOnly, false);
});

test('parseCookieInput rejects CR/LF injection in a Cookie header', () => {
  assert.throws(
    () => parseCookieInput('Cookie: session=abc\r\nX-Injected: yes', { provider: 'claude' }),
    WebaiError
  );
});

test('parseCookieInput accepts browser-export JSON and preserves structured fields', () => {
  const cookies = parseCookieInput(
    JSON.stringify({
      cookies: [
        {
          name: 'sessionKey',
          value: 'value',
          domain: '.claude.ai',
          path: '/api',
          expirationDate: 2_000_000_000.75,
          secure: true,
          httpOnly: true,
          sameSite: 'no_restriction',
          hostOnly: false,
        },
      ],
    }),
    { provider: 'claude' }
  );

  assert.deepEqual(cookies[0], {
    name: 'sessionKey',
    value: 'value',
    domain: '.claude.ai',
    path: '/api',
    expires: 2_000_000_000,
    secure: true,
    httpOnly: true,
    sameSite: 'none',
    hostOnly: false,
  });
});

test('parseCookieInput accepts a credential bundle with a raw Cookie header', () => {
  const cookies = parseCookieInput(
    JSON.stringify({ cookies: 'ds_session_id=session-secret; smidV2=smid-secret', token: 'bearer-secret' }),
    { provider: 'deepseek' }
  );

  assert.deepEqual(
    cookies.map(({ name, value, domain }) => ({ name, value, domain })),
    [
      { name: 'ds_session_id', value: 'session-secret', domain: '.deepseek.com' },
      { name: 'smidV2', value: 'smid-secret', domain: '.deepseek.com' },
    ]
  );
});

test('browser-export JSON treats expires -1 as a session cookie', () => {
  const [cookie] = parseCookieInput(
    JSON.stringify([{ name: 'sessionKey', value: 'value', expires: -1 }]),
    { provider: 'claude' }
  );
  assert.equal(cookie.expires, null);
});

test('parseCookieInput accepts a Netscape cookie file including HttpOnly cookies', () => {
  const input = [
    '# Netscape HTTP Cookie File',
    '#HttpOnly_.google.com\tTRUE\t/\tTRUE\t4000000000\t__Secure-1PSID\tpsid-value',
    '.google.com\tTRUE\t/app\tFALSE\t0\tother\tplain',
  ].join('\n');
  const cookies = parseCookieInput(input, { provider: 'gemini' });

  assert.equal(cookies.length, 2);
  assert.deepEqual(cookies[0], {
    name: '__Secure-1PSID',
    value: 'psid-value',
    domain: '.google.com',
    path: '/',
    expires: 4_000_000_000,
    secure: true,
    httpOnly: true,
    sameSite: null,
    hostOnly: false,
  });
  assert.equal(cookies[1].expires, null);
  assert.equal(cookies[1].secure, false);
});

test('parseCookieInput validates Gemini required cookies', () => {
  assert.throws(
    () => parseCookieInput('other=value', { provider: 'gemini' }),
    (error) => error instanceof AuthError && error.message.includes('__Secure-1PSID')
  );
  assert.throws(
    () => parseCookieInput('__Secure-1PSID=', { provider: 'gemini' }),
    (error) => error instanceof AuthError && error.message.includes('__Secure-1PSID')
  );
});

test('Gemini required-cookie validation rejects unusable domain, path, and expiry', () => {
  const base = {
    name: '__Secure-1PSID',
    value: 'value',
    domain: '.google.com',
    path: '/',
    secure: true,
    expires: 4_000_000_000,
  };
  for (const cookie of [
    { ...base, domain: '.evil.example' },
    { ...base, path: '/not-gemini' },
    { ...base, expires: 1 },
  ]) {
    assert.throws(
      () => parseCookieInput(JSON.stringify([cookie]), { provider: 'gemini' }),
      (error) => error instanceof AuthError && error.message.includes('__Secure-1PSID')
    );
  }
});

test('buildCookieHeader filters structured cookies by URL, expiry, and secure flag', () => {
  const cookies = [
    {
      name: 'domainPath', value: '1', domain: '.example.com', path: '/api', expires: null,
      secure: true, httpOnly: false, sameSite: null, hostOnly: false,
    },
    {
      name: 'parentHostOnly', value: '2', domain: 'example.com', path: '/', expires: null,
      secure: false, httpOnly: false, sameSite: null, hostOnly: true,
    },
    {
      name: 'subHostOnly', value: '3', domain: 'sub.example.com', path: '/', expires: null,
      secure: true, httpOnly: false, sameSite: null, hostOnly: true,
    },
    {
      name: 'plain', value: '4', domain: '.example.com', path: '/', expires: null,
      secure: false, httpOnly: false, sameSite: null, hostOnly: false,
    },
    {
      name: 'expired', value: '5', domain: '.example.com', path: '/', expires: 100,
      secure: false, httpOnly: false, sameSite: null, hostOnly: false,
    },
    {
      name: 'wrongDomain', value: '6', domain: '.other.test', path: '/', expires: null,
      secure: false, httpOnly: false, sameSite: null, hostOnly: false,
    },
  ];

  assert.equal(
    buildCookieHeader(cookies, { url: 'https://sub.example.com/api/item', now: 1_000_000 }),
    'domainPath=1; subHostOnly=3; plain=4'
  );
  assert.equal(
    buildCookieHeader(cookies, { url: 'http://sub.example.com/api/item', now: 1_000_000 }),
    'plain=4'
  );
  assert.equal(
    buildCookieHeader(cookies, {
      url: 'https://sub.example.com/apix',
      now: 1_000_000,
      only: ['domainPath', 'plain'],
    }),
    'plain=4'
  );
});

test('buildCookieHeader remains compatible with a legacy flat cookie map', () => {
  assert.equal(buildCookieHeader({ a: '1', b: '2' }, { only: ['b'] }), 'b=2');
  assert.equal(buildCookieHeader({ cookies: 'ordinary-cookie', a: '1' }), 'cookies=ordinary-cookie; a=1');
});

test('upsertCookieValue keeps the structured jar and legacy map in sync', () => {
  const original = [
    {
      name: '__Secure-1PSIDTS', value: 'old', domain: '.google.com', path: '/', expires: null,
      secure: true, httpOnly: true, sameSite: null, hostOnly: false,
    },
    {
      name: '__Secure-1PSID', value: 'stable', domain: '.google.com', path: '/', expires: null,
      secure: true, httpOnly: true, sameSite: null, hostOnly: false,
    },
  ];
  const updated = upsertCookieValue(original, '__Secure-1PSIDTS', 'new');

  assert.equal(updated[0].value, 'new');
  assert.equal(original[0].value, 'old');
  assert.equal(toCookieMap(updated)['__Secure-1PSIDTS'], 'new');
});

test('upsertCookieValue can clear stale attributes on a rotated cookie', () => {
  const original = [
    {
      name: '__Secure-1PSIDTS', value: 'old', domain: '.google.com', path: '/', expires: 1,
      secure: true, httpOnly: true, sameSite: null, hostOnly: false,
    },
  ];
  const updated = upsertCookieValue(original, '__Secure-1PSIDTS', 'new', { expires: null });
  assert.equal(updated[0].expires, null);
  assert.equal(
    buildCookieHeader(updated, { url: 'https://accounts.google.com/RotateCookies' }),
    '__Secure-1PSIDTS=new'
  );
});
