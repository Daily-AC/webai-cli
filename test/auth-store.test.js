import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getCredsPath,
  importFromCookieInput,
  prepareCredentialInput,
  readCreds,
  saveProviderCredential,
  setProvider,
  writeCreds,
} from '../src/auth/store.js';
import { AuthError, WebaiError } from '../src/errors.js';

function withConfigDir(run) {
  const previous = process.env.WEBAI_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'webai-auth-store-'));
  process.env.WEBAI_CONFIG_DIR = dir;
  try {
    return run(dir);
  } finally {
    if (previous === undefined) delete process.env.WEBAI_CONFIG_DIR;
    else process.env.WEBAI_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withConfigDirAsync(run) {
  const previous = process.env.WEBAI_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'webai-auth-store-'));
  process.env.WEBAI_CONFIG_DIR = dir;
  try {
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.WEBAI_CONFIG_DIR;
    else process.env.WEBAI_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('writeCreds uses an atomic replacement with private directory and file permissions', () => {
  withConfigDir((dir) => {
    writeCreds({ claude: { cookies: { session: 'value' } } });
    const firstInode = statSync(getCredsPath()).ino;
    writeCreds({ claude: { cookies: { session: 'replacement' } } });

    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(getCredsPath()).mode & 0o777, 0o600);
    assert.notEqual(statSync(getCredsPath()).ino, firstInode);
    assert.deepEqual(readCreds(), { claude: { cookies: { session: 'replacement' } } });
    assert.deepEqual(readdirSync(dir), ['creds.json']);
  });
});

test('a corrupt credential store throws and is not overwritten by setProvider', () => {
  withConfigDir((dir) => {
    const path = join(dir, 'creds.json');
    writeFileSync(path, '{not valid JSON', { mode: 0o600 });

    assert.throws(() => readCreds(), WebaiError);
    assert.throws(() => setProvider('claude', { cookies: { session: 'new' } }), WebaiError);
    assert.equal(readFileSync(path, 'utf8'), '{not valid JSON');
  });
});

test('writeCreds repairs permissions on an existing config directory', () => {
  withConfigDir((dir) => {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    writeCreds({});
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });
});

test('importFromCookieInput persists a structured jar and a legacy flat map', () => {
  withConfigDir(() => {
    const result = importFromCookieInput({
      provider: 'gemini',
      input: 'Cookie: __Secure-1PSID=psid; __Secure-1PSIDTS=timestamp',
      source: 'stdin',
    });
    const stored = readCreds().gemini;

    assert.equal(result.count, 2);
    assert.deepEqual(stored.cookies, {
      '__Secure-1PSID': 'psid',
      '__Secure-1PSIDTS': 'timestamp',
    });
    assert.equal(stored.cookieJar.length, 2);
    assert.deepEqual(Object.keys(stored.cookieJar[0]), [
      'name', 'value', 'domain', 'path', 'expires', 'secure', 'httpOnly', 'sameSite', 'hostOnly',
    ]);
    assert.equal(stored.importedFrom, 'stdin');
  });
});

test('credential preparation does not persist until an explicit save', () => {
  withConfigDir(() => {
    const prepared = prepareCredentialInput({
      provider: 'gemini',
      input: '__Secure-1PSID=staged-secret',
    });

    assert.deepEqual(readCreds(), {});
    assert.equal(prepared.credential.cookies['__Secure-1PSID'], 'staged-secret');
    saveProviderCredential('gemini', prepared.credential, {
      source: 'interactive',
      verified: true,
    });

    const stored = readCreds().gemini;
    assert.equal(stored.cookies['__Secure-1PSID'], 'staged-secret');
    assert.equal(stored.importedFrom, 'interactive');
    assert.match(stored.importedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(stored.verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('credential import discards cookies that cannot reach the provider domain', () => {
  withConfigDir(() => {
    importFromCookieInput({
      provider: 'gemini',
      input: JSON.stringify({
        cookies: [
          { name: '__Secure-1PSID', value: 'google-secret', domain: '.google.com', path: '/' },
          { name: 'foreign_session', value: 'foreign-secret', domain: '.example.com', path: '/' },
        ],
      }),
    });

    const stored = readCreds().gemini;
    assert.deepEqual(Object.keys(stored.cookies), ['__Secure-1PSID']);
    assert.equal(stored.cookieJar.length, 1);
  });
});

test('credential bundle import persists DeepSeek bearer metadata without returning it', () => {
  withConfigDir(() => {
    const result = importFromCookieInput({
      provider: 'deepseek',
      input: JSON.stringify({
        cookies: { ds_session_id: 'session-secret', smidV2: 'smid-secret' },
        token: 'bearer-secret',
        hifDliq: 'dliq-value',
        hifLeim: 'leim-value',
      }),
    });
    const stored = readCreds().deepseek;

    assert.equal(stored.token, 'bearer-secret');
    assert.equal(stored.hifDliq, 'dliq-value');
    assert.equal(stored.hifLeim, 'leim-value');
    assert.equal(stored.cookies.ds_session_id, 'session-secret');
    assert.equal(result.hasToken, true);
    assert.equal(JSON.stringify(result).includes('bearer-secret'), false);
  });
});

test('credential bundle import accepts DeepSeek cookies as a raw header string', () => {
  withConfigDir(() => {
    const result = importFromCookieInput({
      provider: 'deepseek',
      input: JSON.stringify({
        cookies: 'ds_session_id=session-secret; smidV2=smid-secret',
        token: 'bearer-secret',
      }),
    });

    assert.equal(result.hasToken, true);
    assert.equal(readCreds().deepseek.cookies.ds_session_id, 'session-secret');
  });
});

test('DeepSeek import requires a bearer token in the credential bundle', () => {
  withConfigDir(() => {
    assert.throws(
      () => importFromCookieInput({ provider: 'deepseek', input: 'ds_session_id=session-secret' }),
      (error) => error instanceof AuthError && /token/.test(error.message)
    );
  });
});

test('credential import rejects cookies that are unusable for the provider target', () => {
  withConfigDir(() => {
    assert.throws(
      () => importFromCookieInput({
        provider: 'deepseek',
        input: JSON.stringify({
          cookies: [{ name: 'foreign', value: 'secret', domain: '.example.com', path: '/' }],
          token: 'bearer-secret',
        }),
      }),
      (error) => error instanceof AuthError && /no non-expired cookie/.test(error.message)
    );
  });
});

test('credential re-import atomically replaces stale provider metadata', () => {
  withConfigDir(() => {
    importFromCookieInput({
      provider: 'deepseek',
      input: JSON.stringify({
        cookies: { ds_session_id: 'old-cookie' },
        token: 'old-token',
        hifDliq: 'stale-dliq',
        hifLeim: 'stale-leim',
      }),
    });
    importFromCookieInput({
      provider: 'deepseek',
      input: JSON.stringify({
        cookies: { ds_session_id: 'new-cookie' },
        token: 'new-token',
      }),
    });

    assert.deepEqual(
      Object.keys(readCreds().deepseek).sort(),
      ['cookieJar', 'cookies', 'importedAt', 'importedFrom', 'token'].sort()
    );
    assert.equal(readCreds().deepseek.cookies.ds_session_id, 'new-cookie');
  });
});

test('credential bundle import persists validated Doubao device metadata', () => {
  withConfigDir(() => {
    importFromCookieInput({
      provider: 'doubao',
      input: JSON.stringify({
        cookies: { sessionid: 'session-secret', sessionid_ss: 'session-secret' },
        device: {
          deviceId: '7123456789012345678',
          webId: '7123456789012345678',
          teaUuid: '7123456789012345678',
          webTabId: 'tab-id',
        },
      }),
    });

    assert.deepEqual(readCreds().doubao.device, {
      deviceId: '7123456789012345678',
      webId: '7123456789012345678',
      teaUuid: '7123456789012345678',
      webTabId: 'tab-id',
    });
  });
});

test('Claude import requires sessionKey and persists optional direct-provider metadata', () => {
  withConfigDir(() => {
    assert.throws(
      () => importFromCookieInput({ provider: 'claude', input: 'other=value' }),
      (error) => error instanceof AuthError && /sessionKey/.test(error.message)
    );

    const result = importFromCookieInput({
      provider: 'claude',
      input: JSON.stringify({
        cookies: { sessionKey: 'session-secret' },
        organizationId: 'org-id',
        userAgent: 'Browser UA',
      }),
    });
    const stored = readCreds().claude;

    assert.equal(result.hasRequire, true);
    assert.equal(stored.organizationId, 'org-id');
    assert.equal(stored.userAgent, 'Browser UA');
    assert.equal(JSON.stringify(result).includes('session-secret'), false);
  });
});

test('ChatGPT import validates chunked session cookies and persists transport metadata', () => {
  withConfigDir(() => {
    assert.throws(
      () => importFromCookieInput({ provider: 'chatgpt', input: 'other=value' }),
      (error) => error instanceof AuthError && /session-token/.test(error.message)
    );
    assert.throws(
      () => importFromCookieInput({
        provider: 'chatgpt',
        input: '__Secure-next-auth.session-token.1=orphan',
      }),
      (error) => error instanceof AuthError && /incomplete/.test(error.message)
    );

    importFromCookieInput({
      provider: 'chatgpt',
      input: JSON.stringify({
        cookies: {
          '__Secure-next-auth.session-token.0': 'part-zero',
          '__Secure-next-auth.session-token.1': 'part-one',
        },
        userAgent: 'Browser UA',
        tlsProfile: 'firefox',
      }),
    });
    const stored = readCreds().chatgpt;

    assert.equal(stored.userAgent, 'Browser UA');
    assert.equal(stored.tlsProfile, 'firefox');
    assert.equal(stored.cookies['__Secure-next-auth.session-token.0'], 'part-zero');
  });
});

test('ChatGPT import rejects a session token whose path cannot reach session exchange', () => {
  withConfigDir(() => {
    assert.throws(
      () => importFromCookieInput({
        provider: 'chatgpt',
        input: JSON.stringify({
          cookies: [
            {
              name: '__Secure-next-auth.session-token',
              value: 'path-bound-token',
              domain: '.chatgpt.com',
              path: '/backend-only',
            },
            { name: 'cf_clearance', value: 'root-cookie', domain: '.chatgpt.com', path: '/' },
          ],
        }),
      }),
      (error) => error instanceof AuthError && /session-token/.test(error.message)
    );
  });
});

test('rotate1PSIDTS is single-flight and updates both credential representations', async () => {
  const { rotate1PSIDTS } = await import('../src/auth/store.js');
  await withConfigDirAsync(async () => {
    importFromCookieInput({
      provider: 'gemini',
      input: JSON.stringify([
        { name: '__Secure-1PSID', value: 'stable', domain: '.google.com', path: '/', secure: true },
        {
          name: '__Secure-1PSIDTS', value: 'stale', domain: '.google.com', path: '/', secure: true,
          expires: 1,
        },
      ]),
    });

    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response('', {
        status: 200,
        headers: { 'Set-Cookie': '__Secure-1PSIDTS=fresh; Domain=.google.com; Path=/; Secure; HttpOnly' },
      });
    };
    try {
      assert.deepEqual(await Promise.all([rotate1PSIDTS(), rotate1PSIDTS()]), ['fresh', 'fresh']);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(calls, 1);
    const stored = readCreds().gemini;
    assert.equal(stored.cookies['__Secure-1PSIDTS'], 'fresh');
    const rotated = stored.cookieJar.find((cookie) => cookie.name === '__Secure-1PSIDTS');
    assert.equal(rotated.value, 'fresh');
    assert.equal(rotated.expires, null);
  });
});
