import { ensureSession, captureNext, evalSession } from '../core/session.js';
import { runOpencli, openUrl } from '../core/opencli.js';
import { geminiMedia, pollMedia } from '../sites/gemini-media.js';
import { downloadViaClick, moveTo } from '../core/download.js';

function usage() {
  process.stderr.write(`webai image gemini — generate an image

Usage:
  webai image gemini "<prompt>" [--out <path>]

Flags:
  --out <path>   Output file or directory (default: current dir)
  --json         JSON output
`);
}

export async function image(args) {
  const site = args.positional[0];
  if (site !== 'gemini') { process.stderr.write(`webai image: only "gemini" is supported (got "${site || ''}")\n`); process.exit(2); }
  const prompt = args.positional.slice(1).join(' ').trim();
  if (!prompt) { usage(); process.exit(2); }

  const { session, tabId } = await ensureSession(geminiMedia, { url: geminiMedia.modeUrl('image') });

  const cap = await captureNext(session, tabId, {
    urlMatcher: geminiMedia.chatEndpoint.urlMatcher,
    methodMatcher: geminiMedia.chatEndpoint.methodMatcher,
    action: async () => {
      runOpencli(['browser', session, 'fill', '--tab', tabId, geminiMedia.COMPOSER, prompt]);
      await new Promise((r) => setTimeout(r, 400));
      const sent = evalSession(session, tabId, geminiMedia.findSendButtonJs());
      if (!sent || !sent.ok) throw new Error('gemini: send button not available');
    },
    timeoutMs: 120_000,
  });
  if (cap.status >= 400) throw new Error(`gemini StreamGenerate HTTP ${cap.status}: ${(cap.responseBody || '').slice(0, 200)}`);

  // The /images surface is gallery-style and doesn't render the result inline;
  // the image + download button live in the conversation. Resolve its id and
  // open it (like the video flow), then poll there.
  let convId = null;
  for (let i = 0; i < 30; i++) {
    convId = evalSession(session, tabId, geminiMedia.conversationIdJs());
    if (convId) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!convId) throw new Error('gemini: image submitted but could not resolve the conversation id');
  const convTab = openUrl(session, `${geminiMedia.url}/${convId}`);
  await new Promise((r) => setTimeout(r, 2500));

  const st = await pollMedia(session, convTab, 'image', { timeoutMs: 180_000, intervalMs: 2000 });
  if (!st || !st.ready) throw new Error('gemini: image did not render in time');

  const dl = await downloadViaClick(session, convTab, 'button[aria-label="Download full size image"]', { extns: ['.png', '.jpg', '.jpeg', '.webp'], timeoutMs: 90_000 });
  const finalPath = moveTo(dl, args.out);

  if (args.json) {
    process.stdout.write(JSON.stringify({ site: 'gemini', kind: 'image', prompt, path: finalPath }, null, 2) + '\n');
  } else {
    process.stdout.write(finalPath + '\n');
  }
}
