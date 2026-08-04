import { WebaiError } from '../errors.js';

export function readHiddenLine({
  input = process.stdin,
  output = process.stderr,
  prompt = '',
} = {}) {
  if (!input?.isTTY || typeof input.setRawMode !== 'function') {
    throw new WebaiError(
      'webai auth login: interactive input requires a TTY; use --stdin or --file for automation'
    );
  }

  const wasRaw = Boolean(input.isRaw);
  const wasFlowing = input.readableFlowing === true;

  return new Promise((resolve, reject) => {
    let value = '';
    let settled = false;

    const cleanup = () => {
      input.removeListener('data', onData);
      input.removeListener('error', onError);
      try { input.setRawMode(wasRaw); } catch { /* terminal may already be closed */ }
      if (!wasFlowing && typeof input.pause === 'function') input.pause();
    };

    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      if (error) reject(error);
      else resolve(result);
    };

    const onError = () => finish('', new WebaiError('webai auth login: could not read hidden input'));
    const onData = (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      for (const character of text) {
        if (character === '\r' || character === '\n') {
          finish(value);
          return;
        }
        if (character === '\u0003') {
          finish('', new WebaiError('webai auth login: cancelled'));
          return;
        }
        if (character === '\u0004') {
          finish(value, value ? null : new WebaiError('webai auth login: input ended before a value was entered'));
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        if (character === '\u0015') {
          value = '';
          continue;
        }
        if (character === '\u001b' || character < ' ') continue;
        value += character;
      }
    };

    try {
      input.setRawMode(true);
      input.on('data', onData);
      input.on('error', onError);
      input.resume();
      output.write(prompt);
    } catch {
      finish('', new WebaiError('webai auth login: could not enable hidden terminal input'));
    }
  });
}
