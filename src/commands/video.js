import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { ensureSession, captureNext, evalSession } from '../core/session.js';
import { openUrl, runOpencli } from '../core/opencli.js';
import { geminiMedia, stageImage, pollMedia } from '../sites/gemini-media.js';
import { downloadViaClick, moveTo } from '../core/download.js';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function usage() {
  process.stderr.write(`webai video gemini — generate video with Veo

Usage:
  webai video gemini submit "<prompt>" [--image <path>]   Start a video, print its job id
  webai video gemini status <job-id> [--out <path>]       Poll; download mp4 when ready

Flags:
  --image <path>   Reference image (first frame) for image+prompt -> video
  --out <path>     (status) output file or directory (default: current dir)
  --json           JSON output
`);
}

export async function video(args) {
  const site = args.positional[0];
  const action = args.positional[1];
  if (site !== 'gemini') { process.stderr.write(`webai video: only "gemini" is supported (got "${site || ''}")\n`); process.exit(2); }
  if (action === 'submit') return submit(args);
  if (action === 'status') return status(args);
  usage();
  process.exit(2);
}

async function submit(args) {
  const prompt = args.positional.slice(2).join(' ').trim();
  if (!prompt) { process.stderr.write('webai video gemini submit: a prompt is required\n'); process.exit(2); }

  const { session, tabId } = await ensureSession(geminiMedia, { url: geminiMedia.modeUrl('video') });

  if (args.image) {
    const buf = readFileSync(args.image);
    const ext = extname(args.image).toLowerCase();
    await stageImage(session, tabId, buf.toString('base64'), basename(args.image), MIME[ext] || 'application/octet-stream');
  }

  // Fill the prompt, then capture StreamGenerate (confirms submit / surfaces errors).
  const cap = await captureNext(session, tabId, {
    urlMatcher: geminiMedia.chatEndpoint.urlMatcher,
    methodMatcher: geminiMedia.chatEndpoint.methodMatcher,
    action: async () => {
      evalSession(session, tabId, `(() => { const c = document.querySelector(${JSON.stringify(geminiMedia.COMPOSER)}); if (c) { c.focus(); } return true; })()`);
      // opencli fill keeps Quill's model in sync.
      runOpencli(['browser', session, 'fill', '--tab', tabId, geminiMedia.COMPOSER, prompt]);
      await new Promise((r) => setTimeout(r, 400));
      const sent = evalSession(session, tabId, geminiMedia.findSendButtonJs());
      if (!sent || !sent.ok) throw new Error('gemini: send button not available');
    },
    timeoutMs: 120_000,
  });
  if (cap.status >= 400) throw new Error(`gemini StreamGenerate HTTP ${cap.status}: ${(cap.responseBody || '').slice(0, 200)}`);

  // The SPA routes to /app/<convHex>; that hex is the job id.
  let jobId = null;
  for (let i = 0; i < 30; i++) {
    jobId = evalSession(session, tabId, geminiMedia.conversationIdJs());
    if (jobId) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!jobId) throw new Error('gemini: submitted but could not determine the conversation/job id');

  if (args.json) {
    process.stdout.write(JSON.stringify({ site: 'gemini', kind: 'video', jobId, prompt, hasImage: !!args.image }, null, 2) + '\n');
  } else {
    process.stdout.write(jobId + '\n');
    process.stderr.write(`\n— video job submitted. Poll with:\n    webai video gemini status ${jobId} --out ./out\n`);
  }
}

async function status(args) {
  const jobId = args.positional[2];
  if (!jobId) { process.stderr.write('webai video gemini status: a job id is required\n'); process.exit(2); }

  // status only scrapes the DOM + clicks the download button — no hooks needed.
  const session = process.env.WEBAI_SESSION || `webai-${geminiMedia.id}`;
  const tabId = openUrl(session, `${geminiMedia.url}/${jobId}`);
  await new Promise((r) => setTimeout(r, 2500));

  const st = await pollMedia(session, tabId, 'video', { timeoutMs: args.once ? 8000 : 600_000 });
  if (!st || !st.ready) {
    if (args.json) process.stdout.write(JSON.stringify({ jobId, ready: false, status: 'generating' }, null, 2) + '\n');
    else process.stdout.write(`generating — not ready yet (job ${jobId})\n`);
    process.exit(3);
  }

  // Download via the page's own button; capture the new file in the download dir.
  const dl = await downloadViaClick(session, tabId, 'button[aria-label="Download video"]', { extns: ['.mp4'], timeoutMs: 120_000 });
  const finalPath = moveTo(dl, args.out);

  if (args.json) {
    process.stdout.write(JSON.stringify({ jobId, ready: true, path: finalPath, url: st.videoUrl }, null, 2) + '\n');
  } else {
    process.stdout.write(finalPath + '\n');
  }
}
