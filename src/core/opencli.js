import { spawnSync } from 'node:child_process';

export function cleanOpencliOutput(raw) {
  return raw
    .split('\n')
    .filter((l) => !l.startsWith('(node:') && !l.includes('EnvHttpProxyAgent') && !l.includes('trace-warnings'))
    .join('\n')
    .trim();
}

export function runOpencli(args) {
  const res = spawnSync('opencli', args, {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const stderr = (res.stderr || '').trim();
    const stdout = (res.stdout || '').trim();
    throw new Error(`opencli ${args.join(' ')} failed (status ${res.status})\n${stderr || stdout}`);
  }
  return cleanOpencliOutput(res.stdout);
}

export function evalInTab(session, tabId, js) {
  const out = runOpencli(['browser', session, 'eval', '--tab', tabId, js]);
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

export function openUrl(session, url) {
  const out = runOpencli(['browser', session, 'open', url]);
  const parsed = JSON.parse(out);
  if (!parsed.page) throw new Error(`opencli did not return a page id for ${url}`);
  return parsed.page;
}
