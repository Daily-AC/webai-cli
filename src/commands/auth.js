// webai auth import chrome [--profile <p>] — import Google cookies from Chrome.
import { importFromChrome } from '../auth/store.js';
import { WebaiError } from '../errors.js';

function usage() {
  process.stderr.write(`webai auth — manage credentials

Usage:
  webai auth import chrome [--profile "Profile 1"]   Import .google.com cookies from Chrome

Flags:
  --profile <name>   Chrome profile directory name (default: "Profile 1")
  --json             JSON output
`);
}

export async function auth(args) {
  const sub = args.positional[0];
  const target = args.positional[1];
  if (sub !== 'import' || target !== 'chrome') {
    usage();
    throw new WebaiError('webai auth: expected "import chrome"');
  }
  const profile = args.profile || 'Profile 1';
  const res = importFromChrome({ profile, provider: 'gemini' });

  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: true, provider: 'gemini', profile, ...res }, null, 2) + '\n');
  } else {
    process.stdout.write(
      `Imported ${res.count} .google.com cookies from Chrome "${profile}" ` +
        `(1PSID=${res.has1PSID ? 'yes' : 'no'}, 1PSIDTS=${res.has1PSIDTS ? 'yes' : 'no'}).\n`
    );
  }
}
