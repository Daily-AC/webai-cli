import { readFileSync, statSync } from 'node:fs';
import { WebaiError } from '../errors.js';
import { allChatProviders, chatProviders } from '../providers/chat.js';
import { startOpenAIServer } from '../server/index.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const MODE_MASK = 0o077;

export function resolveServeOptions(args = {}, env = process.env) {
  const host = args.host || DEFAULT_HOST;
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new WebaiError('webai serve: --host must be a loopback address');
  }

  const rawPort = args.port ?? DEFAULT_PORT;
  const port = typeof rawPort === 'number' ? rawPort : Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new WebaiError('webai serve: --port must be an integer from 0 to 65535');
  }

  let token = (env.WEBAI_SERVER_TOKEN || '').trim();
  if (args.tokenFile) {
    let mode;
    try {
      const info = statSync(args.tokenFile);
      if (!info.isFile()) throw new Error('not a regular file');
      mode = info.mode;
      token = readFileSync(args.tokenFile, 'utf8').trim();
    } catch (error) {
      throw new WebaiError(`webai serve: cannot read token file: ${error.message || error}`);
    }
    if (process.platform !== 'win32' && (mode & MODE_MASK) !== 0) {
      throw new WebaiError('webai serve: token file permissions must not allow group or other access (use chmod 600)');
    }
  }
  if (token.length < 16) {
    throw new WebaiError(
      'webai serve: set WEBAI_SERVER_TOKEN or --token-file to a secret of at least 16 characters'
    );
  }
  if (/\s/.test(token)) {
    throw new WebaiError('webai serve: bearer token must not contain whitespace');
  }

  return { host, port, token };
}

export async function serve(args) {
  const options = resolveServeOptions(args);
  const server = await startOpenAIServer({
    ...options,
    chatProviders: args.experimental ? allChatProviders : chatProviders,
    logger: {
      error(message, detail) {
        process.stderr.write(`${message}${detail?.code ? ` (${detail.code})` : ''}\n`);
      },
    },
  });

  const address = server.address();
  const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  process.stderr.write(`webai serve: listening on http://${displayHost}:${address.port}/v1\n`);

  await waitForShutdown(server);
}

function waitForShutdown(server) {
  return new Promise((resolve, reject) => {
    let closing = false;
    const cleanup = () => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      server.off('error', onError);
    };
    const finish = (error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const shutdown = () => {
      if (closing) return;
      closing = true;
      // Stop accepting new connections before tearing down current work.
      server.close(finish);
      server.abortActiveRequests?.(new Error('webai serve is shutting down'));
      server.closeIdleConnections?.();
    };
    const onError = (error) => {
      if (!closing) finish(error);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    server.once('error', onError);
  });
}
