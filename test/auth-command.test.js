import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { auth } from '../src/commands/auth.js';
import { getCredsPath, readCreds, writeCreds } from '../src/auth/store.js';
import { AuthError, CloudflareChallengeError, WebaiError } from '../src/errors.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'webai.js');

function outputSink() {
  return {
    value: '',
    write(chunk) {
      this.value += chunk;
      return true;
    },
  };
}

async function withConfigDir(run) {
  const previous = process.env.WEBAI_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'webai-auth-command-'));
  process.env.WEBAI_CONFIG_DIR = dir;
  try {
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.WEBAI_CONFIG_DIR;
    else process.env.WEBAI_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('auth import reads credentials from stdin without printing their values', async () => {
  await withConfigDir(async () => {
    const stdout = outputSink();
    await auth(
      { positional: ['import', 'gemini'], stdin: true, json: true },
      {
        stdin: Readable.from(['Cookie: __Secure-1PSID=never-print-this']),
        stdout,
        stderr: outputSink(),
      }
    );

    assert.equal(readCreds().gemini.cookies['__Secure-1PSID'], 'never-print-this');
    assert.equal(stdout.value.includes('never-print-this'), false);
    assert.deepEqual(JSON.parse(stdout.value), {
      ok: true,
      provider: 'gemini',
      source: 'stdin',
      count: 1,
      require: '__Secure-1PSID',
      hasRequire: true,
      has1PSID: true,
      has1PSIDTS: false,
    });
  });
});

test('the CLI parser passes --stdin through to auth import end to end', async () => {
  await withConfigDir(async (dir) => {
    const result = spawnSync(
      process.execPath,
      [BIN, 'auth', 'import', 'gemini', '--stdin', '--json'],
      {
        input: 'Cookie: __Secure-1PSID=cli-subprocess-secret',
        encoding: 'utf8',
        env: { ...process.env, WEBAI_CONFIG_DIR: dir },
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('cli-subprocess-secret'), false);
    assert.equal(JSON.parse(result.stdout).source, 'stdin');
    assert.equal(readCreds().gemini.cookies['__Secure-1PSID'], 'cli-subprocess-secret');
  });
});

test('malformed credential JSON is never echoed through the CLI error message', async () => {
  await withConfigDir(async (dir) => {
    const marker = 'MALFORMED_CREDENTIAL_SECRET';
    const result = spawnSync(
      process.execPath,
      [BIN, 'auth', 'import', 'claude', '--stdin'],
      {
        input: `{"cookies": ${marker}}`,
        encoding: 'utf8',
        env: { ...process.env, WEBAI_CONFIG_DIR: dir },
      }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid cookie JSON/);
    assert.equal(result.stderr.includes(marker), false);
  });
});

test('auth import reads a named file through --file', async () => {
  await withConfigDir(async () => {
    const stdout = outputSink();
    let requestedPath;
    await auth(
      { positional: ['import', 'claude'], file: '/private/cookies.json', json: true },
      {
        stdout,
        stderr: outputSink(),
        readFile: (path) => {
          requestedPath = path;
          return JSON.stringify({ cookies: { sessionKey: 'file-secret' } });
        },
      }
    );

    assert.equal(requestedPath, '/private/cookies.json');
    assert.equal(readCreds().claude.cookies.sessionKey, 'file-secret');
    assert.equal(stdout.value.includes('file-secret'), false);
    assert.equal(JSON.parse(stdout.value).source, 'file');
  });
});

test('auth import supports auth flags delivered by an older positional parser', async () => {
  await withConfigDir(async () => {
    await auth(
      { positional: ['import', 'gemini', '--stdin'], json: false },
      {
        stdin: Readable.from(['__Secure-1PSID=value']),
        stdout: outputSink(),
        stderr: outputSink(),
      }
    );
    assert.equal(readCreds().gemini.cookies['__Secure-1PSID'], 'value');
  });
});

test('auth import rejects positional credential data', async () => {
  await assert.rejects(
    () =>
      auth(
        { positional: ['import', 'claude', 'session=must-not-be-argv'] },
        { stdout: outputSink(), stderr: outputSink() }
      ),
    (error) => error instanceof WebaiError && error.message.includes('never as a positional argument')
  );
});

test('auth import requires exactly one input source', async () => {
  await assert.rejects(
    () =>
      auth(
        { positional: ['import', 'claude'], stdin: true, file: '/private/cookies.txt' },
        { stdout: outputSink(), stderr: outputSink() }
      ),
    (error) => error instanceof WebaiError && error.message.includes('exactly one')
  );
  await assert.rejects(
    () => auth({ positional: ['import', 'claude'] }, { stdout: outputSink(), stderr: outputSink() }),
    (error) => error instanceof WebaiError && error.message.includes('exactly one')
  );
});

test('auth login collects DeepSeek cookies and token separately, verifies, then saves', async () => {
  await withConfigDir(async () => {
    const cookie = 'ds_session_id=deepseek-cookie-secret';
    const token = 'deepseek-token-secret';
    const pendingSecrets = [cookie, token];
    const prompts = [];
    const stdout = outputSink();
    const stderr = outputSink();
    let verifiedCredential;

    await auth(
      { positional: ['login', 'deepseek'], json: true },
      {
        stdin: { isTTY: true },
        stdout,
        stderr,
        readSecret: async ({ prompt }) => {
          prompts.push(prompt);
          return pendingSecrets.shift();
        },
        verifyCredential: async (provider, credential) => {
          assert.equal(provider, 'deepseek');
          verifiedCredential = credential;
          assert.deepEqual(readCreds(), {});
          return { model: 'deepseek-web', updates: {} };
        },
      }
    );

    assert.deepEqual(prompts, [
      'DeepSeek Cookie header: ',
      'DeepSeek localStorage.userToken: ',
    ]);
    assert.equal(verifiedCredential.cookies.ds_session_id, 'deepseek-cookie-secret');
    assert.equal(verifiedCredential.token, token);
    assert.equal(readCreds().deepseek.token, token);
    assert.equal(readCreds().deepseek.importedFrom, 'interactive');
    assert.ok(readCreds().deepseek.verifiedAt);
    assert.equal(stdout.value.includes(cookie), false);
    assert.equal(stdout.value.includes(token), false);
    assert.equal(stderr.value.includes(cookie), false);
    assert.equal(stderr.value.includes(token), false);
    assert.deepEqual(JSON.parse(stdout.value), {
      ok: true,
      verified: true,
      provider: 'deepseek',
      source: 'interactive',
      model: 'deepseek-web',
      count: 1,
      require: null,
      hasRequire: null,
      has1PSID: false,
      has1PSIDTS: false,
      hasToken: true,
    });
  });
});

test('auth login supports non-interactive stdin and still verifies before saving', async () => {
  await withConfigDir(async () => {
    const stdout = outputSink();
    await auth(
      { positional: ['login', 'gemini'], stdin: true, json: true },
      {
        stdin: Readable.from(['__Secure-1PSID=automation-secret']),
        stdout,
        stderr: outputSink(),
        verifyCredential: async () => ({ model: 'gemini-web', updates: {} }),
      }
    );

    assert.equal(JSON.parse(stdout.value).source, 'stdin');
    assert.equal(readCreds().gemini.cookies['__Secure-1PSID'], 'automation-secret');
    assert.ok(readCreds().gemini.verifiedAt);
  });
});

test('auth login failure redacts secrets and leaves the previous store byte-for-byte unchanged', async () => {
  await withConfigDir(async () => {
    writeCreds({ gemini: { cookies: { '__Secure-1PSID': 'existing-secret' } } });
    const before = readFileSync(getCredsPath(), 'utf8');
    const marker = 'NEW_LOGIN_SECRET_MARKER';
    const stderr = outputSink();

    await assert.rejects(
      () => auth(
        { positional: ['login', 'gemini'] },
        {
          stdin: { isTTY: true },
          stdout: outputSink(),
          stderr,
          readSecret: async () => `__Secure-1PSID=${marker}`,
          verifyCredential: async () => {
            throw new WebaiError(`upstream echoed ${marker}`);
          },
        }
      ),
      (error) => {
        assert.equal(error.message.includes(marker), false);
        assert.equal(error.stack.includes(marker), false);
        assert.match(error.message, /existing credentials were not changed/);
        return true;
      }
    );

    assert.equal(readFileSync(getCredsPath(), 'utf8'), before);
    assert.equal(stderr.value.includes(marker), false);
  });
});

test('auth login never exposes a decoded DeepSeek JSON token from an upstream error', async () => {
  await withConfigDir(async () => {
    const marker = 'DECODED_TOKEN_SECRET_MARKER';
    const values = [
      'ds_session_id=cookie-secret',
      JSON.stringify({ value: marker }),
    ];

    await assert.rejects(
      () => auth(
        { positional: ['login', 'deepseek'] },
        {
          stdin: { isTTY: true },
          stdout: outputSink(),
          stderr: outputSink(),
          readSecret: async () => values.shift(),
          verifyCredential: async () => {
            throw new AuthError(`upstream decoded and echoed ${marker}`);
          },
        }
      ),
      (error) => {
        assert.equal(error instanceof AuthError, true);
        assert.equal(error.message.includes(marker), false);
        assert.equal(error.stack.includes(marker), false);
        assert.match(error.message, /rejected the candidate credentials/);
        return true;
      }
    );
    assert.deepEqual(readCreds(), {});
  });
});

test('auth login reports a Cloudflare block without calling the credential invalid', async () => {
  await withConfigDir(async () => {
    writeCreds({ claude: { cookies: { sessionKey: 'existing-secret' } } });
    const before = readFileSync(getCredsPath(), 'utf8');
    const marker = 'CLOUDFLARE_BODY_SECRET_MARKER';

    await assert.rejects(
      () => auth(
        { positional: ['login', 'claude'] },
        {
          stdin: { isTTY: true },
          stdout: outputSink(),
          stderr: outputSink(),
          readSecret: async () => 'sessionKey=new-secret',
          verifyCredential: async () => {
            throw new CloudflareChallengeError(`upstream echoed ${marker}`, {
              provider: 'claude',
              stage: 'completion',
              status: 403,
            });
          },
        }
      ),
      (error) => {
        assert.equal(error instanceof CloudflareChallengeError, true);
        assert.equal(error.code, 'cloudflare_blocked');
        assert.equal(error.stage, 'completion');
        assert.equal(error.status, 403);
        assert.match(error.message, /Cloudflare challenge during completion \(HTTP 403\)/);
        assert.match(error.message, /does not prove the session credential is invalid/);
        assert.equal(error.message.includes(marker), false);
        assert.equal(error.stack.includes(marker), false);
        return true;
      }
    );

    assert.equal(readFileSync(getCredsPath(), 'utf8'), before);
  });
});

test('auth login does not copy untrusted Cloudflare diagnostic fields', async () => {
  const marker = 'UNTRUSTED_DIAGNOSTIC_SECRET';
  await assert.rejects(
    () => auth(
      { positional: ['login', 'claude'] },
      {
        stdin: { isTTY: true },
        stdout: outputSink(),
        stderr: outputSink(),
        readSecret: async () => 'sessionKey=new-secret',
        verifyCredential: async () => {
          const error = new WebaiError(`upstream echoed ${marker}`);
          error.code = 'cloudflare_blocked';
          error.stage = marker;
          error.status = 999;
          throw error;
        },
      }
    ),
    (error) => {
      assert.equal(error instanceof CloudflareChallengeError, true);
      assert.equal(error.stage, undefined);
      assert.equal(error.status, undefined);
      assert.equal(error.message.includes(marker), false);
      assert.equal(error.stack.includes(marker), false);
      return true;
    }
  );
});

test('auth import uses hidden input when --stdin is attached to a TTY', async () => {
  await withConfigDir(async () => {
    let prompted = false;
    await auth(
      { positional: ['import', 'gemini'], stdin: true },
      {
        stdin: { isTTY: true },
        stdout: outputSink(),
        stderr: outputSink(),
        readSecret: async () => {
          prompted = true;
          return '__Secure-1PSID=tty-secret';
        },
      }
    );

    assert.equal(prompted, true);
    assert.equal(readCreds().gemini.cookies['__Secure-1PSID'], 'tty-secret');
  });
});

test('auth login rejects providers without a direct verifier before reading secrets', async () => {
  let read = false;
  await assert.rejects(
    () => auth(
      { positional: ['login', 'grok'] },
      {
        stdout: outputSink(),
        stderr: outputSink(),
        readSecret: async () => {
          read = true;
          return 'secret';
        },
      }
    ),
    (error) => error instanceof WebaiError && /unknown provider/.test(error.message)
  );
  assert.equal(read, false);
});

test('auth login reports a missing --file path without entering interactive mode', () => {
  const result = spawnSync(
    process.execPath,
    [BIN, 'auth', 'login', 'gemini', '--file'],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--file requires a path/);
  assert.equal(result.stderr.includes('requires a TTY'), false);
});
