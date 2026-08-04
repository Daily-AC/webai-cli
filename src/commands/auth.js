// Import browser session cookies either from Chrome (legacy) or from explicit
// stdin/file input. Credential values are never accepted as positional args.
import { readFileSync } from 'node:fs';
import {
  CHROME_IMPORT_SPECS,
  COOKIE_IMPORT_SPECS,
  importFromChrome,
  importFromCookieInput,
  prepareCredentialInput,
  saveProviderCredential,
} from '../auth/store.js';
import { LOGIN_PROVIDER_IDS, verifyChatCredential } from '../auth/verify.js';
import { readHiddenLine } from '../cli/hidden-input.js';
import {
  AuthError,
  CloudflareChallengeError,
  QuotaError,
  WebaiError,
} from '../errors.js';

const PROVIDER_LABELS = {
  gemini: 'Gemini',
  doubao: 'Doubao',
  deepseek: 'DeepSeek',
  claude: 'Claude',
  chatgpt: 'ChatGPT',
};

function usage(stderr = process.stderr) {
  stderr.write(`webai auth — manage credentials

Usage:
  webai auth login <provider>
  webai auth login <provider> --stdin
  webai auth login <provider> --file <path>
  webai auth import <provider> --stdin
  webai auth import <provider> --file <path>
  webai auth import chrome [provider] [--profile "Profile 1"]

Login providers: ${LOGIN_PROVIDER_IDS.join(', ')}
Import providers: ${Object.keys(COOKIE_IMPORT_SPECS).join(', ')}
Chrome providers: ${Object.keys(CHROME_IMPORT_SPECS).join(', ')} (default: gemini)

Flags:
  --stdin            Read credential input from stdin instead of prompting
  --file <path>      Read credential input from a file instead of prompting
  --profile <name>   Chrome profile directory name (default: "Profile 1")
  --json             JSON output
`);
}

async function readStdin(stream) {
  let input = '';
  for await (const chunk of stream) input += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
  return input;
}

function resolveInputSource(args, { allowInteractive = false } = {}) {
  const positional = args.positional || [];
  const trailing = positional.slice(2);
  let useStdin = Boolean(args.stdin);
  let file = args.file || null;

  // Keep auth compatible with callers using an older global argument parser,
  // where auth-specific flags arrived as positional values.
  for (let i = 0; i < trailing.length; i++) {
    const value = trailing[i];
    if (value === '--stdin') {
      useStdin = true;
    } else if (value === '--file') {
      if (i + 1 >= trailing.length) throw new WebaiError('webai auth: --file requires a path');
      file = trailing[++i];
    } else {
      throw new WebaiError(
        'webai auth: credential data must be supplied via --stdin or --file, never as a positional argument'
      );
    }
  }

  if (useStdin && file) throw new WebaiError('webai auth: choose exactly one of --stdin or --file');
  if (!useStdin && !file) {
    if (allowInteractive) return { type: 'interactive' };
    throw new WebaiError('webai auth: expected exactly one of --stdin or --file');
  }
  return useStdin ? { type: 'stdin' } : { type: 'file', path: file };
}

async function readSourceInput(
  source,
  provider,
  { stdin, stderr, readFile, readSecret }
) {
  if (source.type === 'interactive') {
    const label = PROVIDER_LABELS[provider] || provider;
    const cookies = await readSecret({
      input: stdin,
      output: stderr,
      prompt: `${label} Cookie header: `,
    });
    if (provider !== 'deepseek') return cookies;
    const token = await readSecret({
      input: stdin,
      output: stderr,
      prompt: 'DeepSeek localStorage.userToken: ',
    });
    return JSON.stringify({ cookies, token });
  }
  if (source.type === 'stdin') {
    if (stdin?.isTTY) {
      return readSecret({
        input: stdin,
        output: stderr,
        prompt: `${PROVIDER_LABELS[provider] || provider} credential input: `,
      });
    }
    return readStdin(stdin);
  }
  try {
    return await readFile(source.path);
  } catch (error) {
    throw new WebaiError(`webai auth: could not read credential file (${error.code || error.message || error})`);
  }
}

function safeVerificationError(provider, error) {
  const prefix = `webai auth login: ${provider}`;
  const unchanged = 'existing credentials were not changed';
  if (error instanceof CloudflareChallengeError || error?.code === 'cloudflare_blocked') {
    const safeStage = ['organizations', 'completion'].includes(error?.stage) ? error.stage : '';
    const safeStatus = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
      ? error.status
      : null;
    const stage = safeStage ? ` during ${safeStage}` : '';
    const status = safeStatus ? ` (HTTP ${safeStatus})` : '';
    return new CloudflareChallengeError(
      `${prefix} verification was blocked by a Cloudflare challenge${stage}${status}; ` +
        `this does not prove the session credential is invalid; ${unchanged}`,
      { provider, stage: safeStage, status: safeStatus }
    );
  }
  if (error instanceof AuthError) {
    return new AuthError(`${prefix} rejected the candidate credentials; ${unchanged}`);
  }
  if (error instanceof QuotaError) {
    return new QuotaError(`${prefix} could not verify chat because the provider is rate limited; ${unchanged}`);
  }
  return new WebaiError(`${prefix} could not complete the verification request; ${unchanged}`);
}

function importSuccessText(provider, source, result) {
  const extra =
    provider === 'gemini'
      ? ` (1PSID=${result.has1PSID ? 'yes' : 'no'}, 1PSIDTS=${result.has1PSIDTS ? 'yes' : 'no'})`
      : result.require
        ? ` (${result.require}=yes)`
        : '';
  return `Imported ${result.count} cookies for ${provider} from ${source}${extra}.\n`;
}

export async function auth(
  args,
  {
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    readFile = (path) => readFileSync(path, 'utf8'),
    readSecret = readHiddenLine,
    verifyCredential = verifyChatCredential,
    saveCredential = saveProviderCredential,
  } = {}
) {
  const positional = args.positional || [];
  const sub = positional[0];
  const target = positional[1];
  if (args.fileMissing) throw new WebaiError('webai auth: --file requires a path');
  if (!['login', 'import'].includes(sub) || !target) {
    usage(stderr);
    throw new WebaiError('webai auth: expected "login <provider>" or "import <provider> --stdin|--file <path>"');
  }

  if (sub === 'import' && target === 'chrome') {
    if (args.stdin || args.file || positional.length > 3) {
      throw new WebaiError('webai auth: Chrome import does not accept --stdin or --file');
    }
    const provider = positional[2] || 'gemini';
    const profile = args.profile || 'Profile 1';
    const res = await importFromChrome({ profile, provider });
    if (args.json) {
      stdout.write(JSON.stringify({ ok: true, provider, profile, ...res }, null, 2) + '\n');
    } else {
      const extra =
        provider === 'gemini'
          ? ` (1PSID=${res.has1PSID ? 'yes' : 'no'}, 1PSIDTS=${res.has1PSIDTS ? 'yes' : 'no'})`
          : ` (${res.require}=yes)`;
      stdout.write(`Imported ${res.count} cookies for ${provider} from Chrome "${profile}"${extra}.\n`);
    }
    return;
  }

  if (sub === 'login' && !LOGIN_PROVIDER_IDS.includes(target)) {
    throw new WebaiError(
      `webai auth login: unknown provider "${target}" (expected one of: ${LOGIN_PROVIDER_IDS.join(', ')})`
    );
  }

  if (!COOKIE_IMPORT_SPECS[target]) {
    throw new WebaiError(
      `webai auth: unknown provider "${target}" (expected one of: ${Object.keys(COOKIE_IMPORT_SPECS).join(', ')})`
    );
  }

  const source = resolveInputSource(args, { allowInteractive: sub === 'login' });
  const input = await readSourceInput(source, target, { stdin, stderr, readFile, readSecret });

  if (sub === 'login') {
    const { credential, summary } = prepareCredentialInput({ provider: target, input });
    stderr.write(`Verifying ${PROVIDER_LABELS[target] || target} with a minimal chat request...\n`);
    let verification;
    try {
      verification = await verifyCredential(target, credential);
    } catch (error) {
      throw safeVerificationError(target, error);
    }
    saveCredential(target, credential, {
      source: source.type,
      verified: true,
      updates: verification.updates,
    });

    if (args.json) {
      stdout.write(JSON.stringify({
        ok: true,
        verified: true,
        provider: target,
        source: source.type,
        model: verification.model,
        ...summary,
      }, null, 2) + '\n');
    } else {
      stdout.write(`Verified ${target} with ${verification.model}; saved ${summary.count} cookies.\n`);
    }
    return;
  }

  const res = importFromCookieInput({ provider: target, input, source: source.type });

  if (args.json) {
    stdout.write(JSON.stringify({ ok: true, provider: target, source: source.type, ...res }, null, 2) + '\n');
  } else {
    stdout.write(importSuccessText(target, source.type, res));
  }
}
