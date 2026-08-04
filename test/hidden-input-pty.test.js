import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const EXPECT = '/usr/bin/expect';
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'webai.js');

test('real PTY input stays hidden and the CLI exits after Enter', {
  skip: !existsSync(EXPECT),
}, () => {
  const configDir = mkdtempSync(join(tmpdir(), 'webai-auth-pty-'));
  const script = String.raw`
    set timeout 8
    log_user 0
    set config_dir $env(WEBAI_PTY_CONFIG_DIR)
    set node $env(WEBAI_PTY_NODE)
    set bin $env(WEBAI_PTY_BIN)
    spawn env WEBAI_CONFIG_DIR=$config_dir $node $bin auth import gemini --stdin
    set transcript ""
    expect {
      "Gemini credential input: " {
        append transcript $expect_out(buffer)
        send -- "__Secure-1PSID=TTY_SECRET_MARKER\r"
      }
      timeout { exit 10 }
    }
    expect {
      eof { append transcript $expect_out(buffer) }
      timeout { exit 11 }
    }
    set result [wait]
    if {[lindex $result 3] != 0} { exit 12 }
    if {[string first "TTY_SECRET_MARKER" $transcript] >= 0} { exit 13 }
  `;

  try {
    const result = spawnSync(EXPECT, ['-c', script], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        WEBAI_PTY_CONFIG_DIR: configDir,
        WEBAI_PTY_NODE: process.execPath,
        WEBAI_PTY_BIN: BIN,
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, `expect exit ${result.status}: ${result.stderr}`);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
