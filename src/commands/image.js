// webai image <provider> "<prompt>" — direct-HTTP image generation.
import gemini from '../providers/gemini/index.js';
import jimeng from '../providers/jimeng/index.js';
import doubao from '../providers/doubao/index.js';
import { WebaiError } from '../errors.js';
import { resolveOutPath, timestamp } from './media-util.js';

const PROVIDERS = { gemini, jimeng, doubao };

function usage() {
  process.stderr.write(`webai image — generate an image (direct HTTP)

Usage:
  webai image <gemini|jimeng|doubao> "<prompt>" [--aspect 1:1] [--out <path|dir>] [--json]

Flags:
  --out <path>   Output file or directory (default: current dir)
  --json         JSON output
`);
}

export async function image(args) {
  const providerId = args.positional[0];
  const provider = PROVIDERS[providerId];
  if (!provider) {
    usage();
    throw new WebaiError(`webai image: only "gemini" is supported (got "${providerId || ''}")`);
  }
  const prompt = args.positional.slice(1).join(' ').trim();
  if (!prompt) {
    usage();
    throw new WebaiError('webai image: a prompt is required');
  }

  const started = Date.now();
  const genOpts = {};
  if (args.model) genOpts.model = args.model;
  if (args.aspect) genOpts.ratio = args.aspect;
  if (args.resolution) genOpts.resolution = args.resolution;
  const { images, meta } = await provider.generateImage(prompt, genOpts);
  const first = images[0];
  // Gemini serves JPEG (lh3 -rj); Jimeng/Doubao byteimg CDNs serve PNG.
  const ext = providerId === 'gemini' ? 'jpg' : 'png';
  const nameProvider = providerId.charAt(0).toUpperCase() + providerId.slice(1);
  const dest = resolveOutPath(args.out, `${nameProvider}_Image_${timestamp()}.${ext}`);
  const path = await provider.download(first.url, dest, { poll206: true, timeoutMs: 180_000 });
  const elapsedMs = Date.now() - started;

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        { provider: providerId, kind: 'image', prompt, path, url: first.url, cid: meta.cid, elapsedMs },
        null,
        2
      ) + '\n'
    );
  } else {
    process.stdout.write(path + '\n');
  }
}
