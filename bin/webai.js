#!/usr/bin/env node
import { ask } from '../src/commands/ask.js';
import { stream } from '../src/commands/stream.js';
import { history } from '../src/commands/history.js';
import { detail } from '../src/commands/detail.js';
import { video } from '../src/commands/video.js';
import { image } from '../src/commands/image.js';
import { SITE_IDS } from '../src/sites/index.js';

const USAGE = `webai — reverse-engineered CLI for chat web apps

Usage:
  webai ask <site> <prompt...>         Send a prompt, print the final answer
  webai stream <site> <prompt...>      Send a prompt, stream the answer
  webai history <site>                 List recent conversations from the sidebar
  webai detail <site> <id-or-url>      Print transcript of a single conversation
  webai video gemini submit "<p>"      Start a Veo video (add --image for image->video)
  webai video gemini status <job-id>   Poll a video job; download mp4 when ready
  webai image gemini "<prompt>"        Generate an image and download it

Sites: ${SITE_IDS.join(', ')}

Common flags:
  --json                               JSON output instead of plain text
  --verbose                            Print site/conversationId/model on stderr (ask)
  --thinking                           Include thinking-trace output where supported
  --raw                                (stream) Emit the raw streaming body
  --new-chat                           Start a fresh chat before sending
  --limit <n>                          (history) max items, default 20
  --image <path>                       (video) reference image for image->video
  --out <path>                         (video status / image) output file or dir

Environment:
  WEBAI_SESSION                        opencli browser session name override
                                       (defaults to "webai-<site>")

Examples:
  webai ask grok "respond pong"
  webai ask deepseek --thinking "what's 17 * 23 step by step"
  webai stream gemini --json "name three colors"
  webai history grok --limit 5
  webai detail grok https://grok.com/c/0123abcd-...
`;

function parseArgs(argv) {
  const args = { positional: [], json: false, verbose: false, raw: false, thinking: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--raw') args.raw = true;
    else if (a === '--thinking') args.thinking = true;
    else if (a === '--new-chat' || a === '--new') args.newChat = true;
    else if (a === '--limit') args.limit = argv[++i];
    else if (a === '--image') args.image = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--aspect') args.aspect = argv[++i];
    else if (a === '--once') args.once = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else args.positional.push(a);
  }
  return args;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  const args = parseArgs(rest);
  if (args.help) { process.stdout.write(USAGE); return; }
  try {
    switch (cmd) {
      case 'ask':     await ask(args);     break;
      case 'stream':  await stream(args);  break;
      case 'history': await history(args); break;
      case 'detail':  await detail(args);  break;
      case 'video':   await video(args);   break;
      case 'image':   await image(args);   break;
      case 'sites':   process.stdout.write(SITE_IDS.join('\n') + '\n'); break;
      default:
        process.stderr.write(`webai: unknown command "${cmd}"\n\n${USAGE}`);
        process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`webai ${cmd}: ${e.message || e}\n`);
    process.exit(1);
  }
}

main();
