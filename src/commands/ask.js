import { getChatProvider } from '../providers/chat.js';

export async function ask(args) {
  const site = args.positional[0];
  const prompt = args.positional.slice(1).join(' ').trim();
  if (!site || !prompt) {
    process.stderr.write('webai ask: usage: webai ask <site> <prompt...>\n');
    process.exit(2);
  }
  const directProvider = getChatProvider(site);
  if (directProvider) {
    await askDirect(directProvider, prompt, args);
    return;
  }

  const [{ ensureSession, captureNext, evalSession }, { getAdapter }] = await Promise.all([
    import('../core/session.js'),
    import('../sites/index.js'),
  ]);
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

export async function askDirect(
  provider,
  prompt,
  args,
  { stdout = process.stdout, stderr = process.stderr } = {}
) {
  const model = resolveDirectModel(provider, args.model, 'ask');
  let final = '';
  let metadata = {};
  const events = [];
  for await (const event of provider.streamChat({
    model,
    messages: [{ role: 'user', content: prompt }],
    thinking: args.thinking,
  })) {
    if (event.type === 'text_delta') {
      final += event.text;
      events.push({ type: 'text_delta', text: event.text });
    } else if (event.type === 'finish') {
      metadata = event.metadata || {};
    }
  }

  const parsed = directResult(final, metadata, events, model);
  if (args.json) {
    stdout.write(JSON.stringify(parsed, null, 2) + '\n');
  } else {
    if (args.thinking && parsed.thinking) stdout.write(`[thinking] ${parsed.thinking}\n\n`);
    stdout.write(final + '\n');
    if (args.verbose) {
      stderr.write(
        `\n— site: ${metadata.provider || provider.id.replace(/-web$/, '')}\n— conversationId: ${parsed.conversationId || '(none)'}\n` +
          `— model: ${parsed.model}\n— title: (temporary chat)\n`
      );
    }
  }
}

function resolveDirectModel(provider, model, command) {
  if (model && model !== provider.id) {
    throw new Error(`webai ${command}: unsupported direct model "${model}" (expected ${provider.id})`);
  }
  return provider.id;
}

function directResult(final, metadata, events, model) {
  return {
    conversationId: metadata.conversationId || metadata.chatSessionId || '',
    responseId: metadata.responseId || metadata.messageId || '',
    title: '',
    model: metadata.model || model,
    thinking: metadata.reasoning || '',
    final,
    images: [],
    events,
  };
}
