import { ensureSession, evalSession } from '../core/session.js';
import { getAdapter } from '../sites/index.js';

function extractId(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const uuid = raw.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (uuid) return uuid[1].toLowerCase();
  const geminiHex = raw.match(/\/app\/([0-9a-f]{8,})/i);
  if (geminiHex) return geminiHex[1];
  if (/^[0-9a-f]{8,}$/i.test(raw)) return raw;
  return '';
}

export async function detail(args) {
  const site = args.positional[0];
  const id = extractId(args.positional[1]);
  if (!site || !id) {
    process.stderr.write('webai detail: usage: webai detail <site> <id-or-url>\n');
    process.exit(2);
  }
  const adapter = getAdapter(site);
  const { session, tabId } = await ensureSession(adapter);
  const result = evalSession(session, tabId, adapter.scrapeDetailJs(id));
  if (!result || !result.messages || !result.messages.length) {
    process.stderr.write(`webai detail: conversation ${id} appears empty or inaccessible\n`);
    process.exit(1);
  }
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  process.stdout.write(`# ${result.title || '(untitled)'}\nsite: ${site}\nid: ${result.id}\n\n`);
  for (const m of result.messages) {
    process.stdout.write(`## ${m.role}\n${m.text}\n\n`);
  }
}
