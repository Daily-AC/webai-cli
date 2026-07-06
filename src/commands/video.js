// webai video <provider> submit|status — direct-HTTP Veo video generation.
import gemini from '../providers/gemini/index.js';
import jimeng from '../providers/jimeng/index.js';
import doubao from '../providers/doubao/index.js';
import { WebaiError, PendingError, ContentRejectedError } from '../errors.js';
import { resolveOutPath, timestamp } from './media-util.js';

const PROVIDERS = { gemini, jimeng, doubao };

function usage() {
  process.stderr.write(`webai video — generate video (direct HTTP)

Usage:
  webai video <gemini|jimeng|doubao> submit "<prompt>" [--model <m>] [--aspect 16:9] [--duration 5] [--image <path>] [--json]
  webai video <gemini|jimeng|doubao> status <job-id> [--out <path>] [--once] [--json]

Flags:
  --model <m>    provider model (jimeng default jimeng-video-3.5-pro; 3.x-pro need membership)
  --aspect <r>   aspect ratio, e.g. 16:9 (jimeng, doubao)
  --duration <n> seconds (jimeng: 5/10/12 depending on model)
  --image <path> reference image for image-to-video (doubao)
  --out <path>   (status) output file or directory (default: current dir)
  --once         (status) poll a single time; exit 3 if still generating
  --json         JSON output
`);
}

export async function video(args) {
  const providerId = args.positional[0];
  const action = args.positional[1];
  const provider = PROVIDERS[providerId];
  if (!provider) {
    usage();
    throw new WebaiError(`webai video: expected "gemini", "jimeng", or "doubao" (got "${providerId || ''}")`);
  }
  if (action === 'submit') return submit(provider, providerId, args);
  if (action === 'status') return status(provider, providerId, args);
  usage();
  throw new WebaiError('webai video: expected "submit" or "status"');
}

async function submit(provider, providerId, args) {
  const prompt = args.positional.slice(2).join(' ').trim();
  if (!prompt) {
    usage();
    throw new WebaiError('webai video submit: a prompt is required');
  }
  const subOpts = {};
  if (args.model) subOpts.model = args.model;
  if (args.aspect) subOpts.ratio = args.aspect;
  if (args.duration) subOpts.duration = Number(args.duration);
  if (args.image) subOpts.image = args.image;
  const { jobId, meta, video: ready } = await provider.submitVideo(prompt, subOpts);
  if (args.json) {
    process.stdout.write(
      JSON.stringify({ provider: providerId, kind: 'video', jobId, prompt, ready: !!ready, meta }, null, 2) + '\n'
    );
  } else {
    process.stdout.write(jobId + '\n');
    process.stderr.write(`\n— video job submitted. Poll with:\n    webai video ${providerId} status ${jobId} --out ./out\n`);
  }
}

async function status(provider, providerId, args) {
  const jobId = args.positional[2];
  if (!jobId) {
    usage();
    throw new WebaiError('webai video status: a job id is required');
  }

  const deadline = Date.now() + (args.once ? 0 : 600_000);
  let st;
  while (true) {
    st = await provider.pollVideo(jobId);
    if (st.status === 'ready') break;
    if (st.status === 'failed') {
      throw new ContentRejectedError(`Gemini video generation failed: ${st.reason || 'unknown'}`);
    }
    // pending
    if (args.once) {
      if (args.json) process.stdout.write(JSON.stringify({ jobId, ready: false, status: 'generating' }, null, 2) + '\n');
      else process.stdout.write(`generating — not ready yet (job ${jobId})\n`);
      throw new PendingError(`video ${jobId} still generating`);
    }
    if (Date.now() > deadline) {
      throw new PendingError(`video ${jobId} still generating after timeout`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }

  const nameProvider = providerId.charAt(0).toUpperCase() + providerId.slice(1);
  const dest = resolveOutPath(args.out, `${nameProvider}_Video_${timestamp()}.mp4`);
  const path = await provider.download(st.video.url, dest, { poll206: true, timeoutMs: 600_000 });

  if (args.json) {
    process.stdout.write(JSON.stringify({ jobId, ready: true, path, url: st.video.url }, null, 2) + '\n');
  } else {
    process.stdout.write(path + '\n');
  }
}
