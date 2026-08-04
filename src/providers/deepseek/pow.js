import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { WebaiError } from '../../errors.js';
import { raceWithSignal, signalReason } from '../../chat/abort.js';

export const DEFAULT_POW_WASM_URL =
  'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
export const DEFAULT_POW_WASM_SHA256 =
  'b3fca8cc072c1defbd60c02266a8e48bd307a1804aaff4314900aea720e72f7d';

const moduleCache = new Map();

async function fetchModuleBytes(wasmUrl, fetchImpl, signal, expectedSha256) {
  let response;
  try {
    response = await raceWithSignal(fetchImpl(wasmUrl, { method: 'GET', signal }), signal);
  } catch (error) {
    if (signal?.aborted) throw signalReason(signal, 'deepseek PoW download aborted');
    throw new WebaiError(`deepseek PoW WASM download failed: ${error?.message || error}`);
  }
  if (!response?.ok) {
    throw new WebaiError(`deepseek PoW WASM download failed with HTTP ${response?.status ?? 'unknown'}`);
  }
  const bytes = await raceWithSignal(response.arrayBuffer(), signal);
  if (expectedSha256) {
    const actual = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
    if (actual !== expectedSha256.toLowerCase()) {
      throw new WebaiError(
        `deepseek PoW WASM checksum mismatch (expected ${expectedSha256}, got ${actual})`
      );
    }
  }
  return bytes;
}

export async function loadPowModule(
  wasmUrl = DEFAULT_POW_WASM_URL,
  {
    fetchImpl = globalThis.fetch,
    signal,
    cache = true,
    expectedSha256 = wasmUrl === DEFAULT_POW_WASM_URL ? DEFAULT_POW_WASM_SHA256 : '',
  } = {}
) {
  if (typeof fetchImpl !== 'function') throw new TypeError('deepseek PoW: fetchImpl must be a function');
  if (!wasmUrl) throw new WebaiError('deepseek PoW: missing WASM URL');

  const compile = async () =>
    WebAssembly.compile(await fetchModuleBytes(wasmUrl, fetchImpl, signal, expectedSha256));
  if (!cache) return compile();

  const cacheKey = `${wasmUrl}\0${expectedSha256}`;
  const cached = moduleCache.get(cacheKey);
  if (cached) return raceWithSignal(Promise.resolve(cached), signal);

  // A pending compile belongs to its caller because its download is abortable.
  // Cache only the completed module so one caller's cancellation cannot reject
  // unrelated concurrent requests.
  const compiled = await compile();
  moduleCache.set(cacheKey, compiled);
  return compiled;
}

function requiredFunction(exports, names, label) {
  for (const name of names) {
    if (typeof exports[name] === 'function') return exports[name];
  }
  throw new WebaiError(`deepseek PoW: WASM ${label} export not found (${names.join(', ')})`);
}

function validateChallenge(challenge) {
  if (!challenge || typeof challenge !== 'object') {
    throw new WebaiError('deepseek PoW: challenge is missing');
  }
  for (const field of ['challenge', 'salt', 'expire_at', 'difficulty', 'signature']) {
    if (challenge[field] === undefined || challenge[field] === null || challenge[field] === '') {
      throw new WebaiError(`deepseek PoW: challenge.${field} is missing`);
    }
  }
  if (challenge.algorithm && !['DeepSeekHashV1', 'sha256'].includes(challenge.algorithm)) {
    throw new WebaiError(`deepseek PoW: unsupported algorithm ${challenge.algorithm}`);
  }
  const difficulty = Number(challenge.difficulty);
  if (!Number.isSafeInteger(difficulty) || difficulty <= 0) {
    throw new WebaiError('deepseek PoW: challenge.difficulty must be a positive safe integer');
  }
}

export function solveSha256Challenge(challenge, { maxIterations = 1_000_000 } = {}) {
  validateChallenge(challenge);
  if (challenge.algorithm !== 'sha256') {
    throw new WebaiError(`deepseek PoW: expected sha256, got ${challenge.algorithm || 'DeepSeekHashV1'}`);
  }
  if (!Number.isSafeInteger(maxIterations) || maxIterations <= 0) {
    throw new WebaiError('deepseek PoW: maxIterations must be a positive safe integer');
  }
  const targetDifficulty = challenge.difficulty > 1000
    ? Math.floor(Math.log2(challenge.difficulty))
    : challenge.difficulty;
  for (let nonce = 0; nonce <= maxIterations; nonce++) {
    const digest = createHash('sha256')
      .update(`${challenge.salt}${challenge.challenge}${nonce}`)
      .digest();
    let zeroBits = 0;
    for (const byte of digest) {
      if (byte === 0) zeroBits += 8;
      else {
        zeroBits += Math.clz32(byte) - 24;
        break;
      }
    }
    if (zeroBits >= targetDifficulty) return nonce;
  }
  throw new WebaiError(`deepseek PoW: sha256 solver exceeded ${maxIterations} iterations`);
}

export async function solvePowModule(challenge, compiled) {
  validateChallenge(challenge);
  if ((challenge.algorithm || 'DeepSeekHashV1') !== 'DeepSeekHashV1') {
    throw new WebaiError(`deepseek PoW: expected DeepSeekHashV1, got ${challenge.algorithm}`);
  }

  let instance;
  try {
    instance = await WebAssembly.instantiate(compiled, { wbg: {} });
  } catch (error) {
    throw new WebaiError(`deepseek PoW: could not instantiate WASM (${error?.message || error})`);
  }

  const exports = instance.exports || instance.instance?.exports;
  const memory = exports?.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new WebaiError('deepseek PoW: WASM memory export not found');
  }
  const allocate = requiredFunction(exports, ['__wbindgen_malloc', '__wbindgen_export_0'], 'allocator');
  const moveStack = requiredFunction(exports, ['__wbindgen_add_to_stack_pointer'], 'stack pointer');
  const solve = requiredFunction(exports, ['wasm_solve'], 'solver');

  const encoder = new TextEncoder();
  const challengeBytes = encoder.encode(String(challenge.challenge));
  const prefixBytes = encoder.encode(`${challenge.salt}_${challenge.expire_at}_`);
  const challengePointer = allocate(challengeBytes.length, 1) >>> 0;
  const prefixPointer = allocate(prefixBytes.length, 1) >>> 0;
  new Uint8Array(memory.buffer, challengePointer, challengeBytes.length).set(challengeBytes);
  new Uint8Array(memory.buffer, prefixPointer, prefixBytes.length).set(prefixBytes);

  const returnPointer = moveStack(-16);
  try {
    solve(
      returnPointer,
      challengePointer,
      challengeBytes.length,
      prefixPointer,
      prefixBytes.length,
      Number(challenge.difficulty)
    );
    const view = new DataView(memory.buffer);
    const status = view.getInt32(returnPointer, true);
    const answer = view.getFloat64(returnPointer + 8, true);
    if (status === 0 || !Number.isSafeInteger(answer) || answer < 0) {
      throw new WebaiError('deepseek PoW: solver returned no answer');
    }
    return answer;
  } finally {
    moveStack(16);
  }
}

function defaultWorkerFactory(workerData) {
  return new Worker(new URL('./pow-worker.js', import.meta.url), {
    workerData,
    // PoW is self-contained; inheriting runtime/test flags can make Worker
    // reject parent-only Node options such as --input-type.
    execArgv: [],
  });
}

export function solvePowInWorker(
  challenge,
  compiled,
  { signal, maxIterations = 1_000_000, workerFactory = defaultWorkerFactory } = {}
) {
  if (signal?.aborted) return Promise.reject(signalReason(signal, 'deepseek PoW aborted'));

  let worker;
  try {
    worker = workerFactory({ challenge, module: compiled, maxIterations });
  } catch (error) {
    return Promise.reject(new WebaiError(`deepseek PoW: could not start worker (${error?.message || error})`));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const finish = (error, answer) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(answer);
    };
    const onAbort = () => {
      Promise.resolve(worker.terminate()).catch(() => {});
      finish(signalReason(signal, 'deepseek PoW aborted'));
    };
    const onMessage = (message) => {
      if (!message?.ok) {
        finish(new WebaiError(`deepseek PoW: worker failed (${message?.message || 'unknown error'})`));
        return;
      }
      if (!Number.isSafeInteger(message.answer) || message.answer < 0) {
        finish(new WebaiError('deepseek PoW: worker returned an invalid answer'));
        return;
      }
      finish(null, message.answer);
    };
    const onError = (error) => finish(new WebaiError(`deepseek PoW: worker failed (${error.message})`));
    const onExit = (code) => {
      if (!settled) finish(new WebaiError(`deepseek PoW: worker exited before returning an answer (${code})`));
    };

    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function solvePowChallenge(
  challenge,
  {
    wasmUrl = DEFAULT_POW_WASM_URL,
    fetchImpl = globalThis.fetch,
    signal,
    module,
    maxIterations = 1_000_000,
    workerFactory,
  } = {}
) {
  validateChallenge(challenge);
  const algorithm = challenge.algorithm || 'DeepSeekHashV1';
  const compiled = algorithm === 'DeepSeekHashV1'
    ? module || (await loadPowModule(wasmUrl, { fetchImpl, signal }))
    : null;
  if (signal?.aborted) throw signalReason(signal, 'deepseek PoW aborted');
  return solvePowInWorker(challenge, compiled, {
    signal,
    maxIterations,
    ...(workerFactory ? { workerFactory } : {}),
  });
}

export function encodePowResponse(challenge, answer, targetPath = '/api/v0/chat/completion') {
  validateChallenge(challenge);
  if (!Number.isSafeInteger(answer) || answer < 0) {
    throw new WebaiError('deepseek PoW: answer must be a non-negative safe integer');
  }
  return Buffer.from(
    JSON.stringify({
      algorithm: challenge.algorithm || 'DeepSeekHashV1',
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: challenge.target_path || targetPath,
    })
  ).toString('base64');
}

export function clearPowModuleCache() {
  moduleCache.clear();
}
