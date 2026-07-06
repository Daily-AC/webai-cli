// webai auth import chrome [provider] [--profile <p>] — import cookies from Chrome.
import { importFromChrome, CHROME_IMPORT_SPECS } from '../auth/store.js';
import { WebaiError } from '../errors.js';

function usage() {
  process.stderr.write(`webai auth — manage credentials

Usage:
  webai auth import chrome [provider] [--profile "Profile 1"]

Providers: ${Object.keys(CHROME_IMPORT_SPECS).join(', ')} (default: gemini)

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
    throw new WebaiError('webai auth: expected "import chrome [provider]"');
  }
  const provider = args.positional[2] || 'gemini';
  const profile = args.profile || 'Profile 1';
  const res = importFromChrome({ profile, provider });

  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: true, provider, profile, ...res }, null, 2) + '\n');
  } else {
    const extra =
      provider === 'gemini'
        ? ` (1PSID=${res.has1PSID ? 'yes' : 'no'}, 1PSIDTS=${res.has1PSIDTS ? 'yes' : 'no'})`
        : ` (${res.require}=yes)`;
    process.stdout.write(`Imported ${res.count} cookies for ${provider} from Chrome "${profile}"${extra}.\n`);
  }
}
