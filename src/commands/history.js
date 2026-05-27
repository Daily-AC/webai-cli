import { ensureSession, evalSession } from '../core/session.js';
import { getAdapter } from '../sites/index.js';

export async function history(args) {
  const site = args.positional[0];
  if (!site) {
    process.stderr.write('webai history: usage: webai history <site>\n');
    process.exit(2);
  }
  const adapter = getAdapter(site);
  const { session, tabId } = await ensureSession(adapter);
  const items = evalSession(session, tabId, adapter.scrapeSidebarJs()) || [];
  const limit = Math.max(1, Math.min(parseInt(args.limit || '20', 10) || 20, 100));
  const sliced = items.slice(0, limit);
  if (args.json) {
    process.stdout.write(JSON.stringify(sliced, null, 2) + '\n');
    return;
  }
  for (const c of sliced) {
    process.stdout.write(`${c.id}\t${(c.title || '').replace(/\s+/g, ' ').slice(0, 80)}\n`);
  }
  if (!sliced.length) {
    process.stderr.write(`webai history: sidebar empty for ${site} — open ${adapter.url} once to populate.\n`);
  }
}
