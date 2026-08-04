import { getChatProvider } from '../providers/chat.js';

export async function stream(args) {
  const site = args.positional[0];
  const prompt = args.positional.slice(1).join(' ').trim();
  if (!site || !prompt) {
    process.stderr.write('webai stream: usage: webai stream <site> <prompt...>\n');
    process.exit(2);
  }
  const directProvider = getChatProvider(site);
  if (directProvider) {
    await streamDirect(directProvider, prompt, args);
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
  if (args.raw) {
    process.stdout.write(cap.responseBody);
    if (!cap.responseBody.endsWith('\n')) process.stdout.write('\n');
    return;
  }
  const parsed = adapter.parseResponse(cap.responseBody);
  if (args.json) {
    process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
    return;
  }
  if (args.thinking && parsed.thinking) process.stderr.write(parsed.thinking + '\n');
  process.stdout.write(parsed.final + '\n');
}

export async function streamDirect(
  provider,
  prompt,
  args,
  { stdout = process.stdout, stderr = process.stderr } = {}
) {
  if (args.raw) {
    throw new Error(`webai stream ${provider.id.replace(/-web$/, '')}: --raw is not available for direct HTTP providers`);
  }
  if (args.model && args.model !== provider.id) {
    throw new Error(`webai stream: unsupported direct model "${args.model}" (expected ${provider.id})`);
  }

  let final = '';
  let metadata = {};
  const events = [];
  for await (const event of provider.streamChat({
    model: provider.id,
    messages: [{ role: 'user', content: prompt }],
    thinking: args.thinking,
  })) {
    if (event.type === 'text_delta') {
      final += event.text;
      events.push({ type: 'text_delta', text: event.text });
      if (!args.json) stdout.write(event.text);
    } else if (event.type === 'finish') {
      metadata = event.metadata || {};
    }
  }

  if (args.json) {
    stdout.write(
      JSON.stringify(
        {
          conversationId: metadata.conversationId || metadata.chatSessionId || '',
          responseId: metadata.responseId || metadata.messageId || '',
          model: metadata.model || provider.id,
          thinking: metadata.reasoning || '',
          final,
          events,
        },
        null,
        2
      ) + '\n'
    );
  } else {
    stdout.write('\n');
    if (args.thinking && metadata.reasoning) stderr.write(metadata.reasoning + '\n');
  }
}
