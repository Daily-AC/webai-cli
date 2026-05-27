import { ensureSession, captureNext, evalSession } from '../core/session.js';
import { getAdapter } from '../sites/index.js';

export async function ask(args) {
  const site = args.positional[0];
  const prompt = args.positional.slice(1).join(' ').trim();
  if (!site || !prompt) {
    process.stderr.write('webai ask: usage: webai ask <site> <prompt...>\n');
    process.exit(2);
  }
  const adapter = getAdapter(site);
  const { session, tabId, helpers } = await ensureSession(adapter);
  if (args.newChat || args['new-chat']) {
    evalSession(session, tabId, adapter.newChatJs());
    await new Promise((r) => setTimeout(r, 1200));
  }
  const cap = await captureNext(session, tabId, {
    urlMatcher: adapter.chatEndpoint.urlMatcher,
    methodMatcher: adapter.chatEndpoint.methodMatcher,
    action: () => adapter.submit(helpers, prompt),
    timeoutMs: 180_000,
  });
  if (cap.status >= 400) {
    throw new Error(`${adapter.id} replied HTTP ${cap.status}: ${(cap.responseBody || '').slice(0, 200)}`);
  }
  const parsed = adapter.parseResponse(cap.responseBody);
  if (args.json) {
    process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
  } else {
    if (args.thinking && parsed.thinking) process.stdout.write(`[thinking] ${parsed.thinking}\n\n`);
    process.stdout.write(parsed.final + '\n');
    if (args.verbose) {
      process.stderr.write(`\n— site: ${adapter.id}\n— conversationId: ${parsed.conversationId || '(none)'}\n— model: ${parsed.model || '(unknown)'}\n— title: ${parsed.title || '(none)'}\n`);
    }
  }
}
