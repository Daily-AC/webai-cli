import { randomUUID } from 'node:crypto';
import { raceWithSignal, signalReason } from '../../chat/abort.js';
import { ChatGptChallengeError } from './errors.js';

const MAX_DIFFICULTY_LENGTH = 8;

export function fnv1aFmix32(seed, encodedConfig) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(`${seed}${encodedConfig}`, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function utcFingerprintDate(now) {
  return new Date(now).toUTCString().replace(',', '');
}

export function buildPowConfig({
  buildId,
  deviceId,
  scriptUrl = 'https://chatgpt.com/backend-api/sentinel/sdk.js',
  userAgent,
  now = Date.now(),
  uuid = randomUUID,
  iteration = 0,
} = {}) {
  return [
    4000,
    utcFingerprintDate(now),
    4_294_705_152,
    iteration,
    String(userAgent || ''),
    String(scriptUrl || ''),
    String(buildId || ''),
    'en-US',
    'en-US,en',
    0,
    'language-function',
    '0',
    '0',
    1000,
    String(deviceId || uuid()),
    '',
    8,
    1_700_000_000_000,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
  ];
}

function base64Config(config) {
  return Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
}

function clearsDifficulty(hash, difficulty) {
  const expected = String(difficulty || '0').toLowerCase();
  const length = Math.min(expected.length, MAX_DIFFICULTY_LENGTH);
  return hash.slice(0, length) <= expected.slice(0, length);
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function solvePowToken({
  prefix,
  seed,
  difficulty,
  config,
  maxIterations = 500_000,
  signal,
  yieldEvery = 2_000,
} = {}) {
  if (!Array.isArray(config) || config.length !== 25) {
    throw new TypeError('chatgpt PoW: config must contain 25 values');
  }
  const working = config.slice();
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal?.aborted) throw signalReason(signal, 'chatgpt PoW aborted');
    working[3] = iteration;
    const encoded = base64Config(working);
    if (clearsDifficulty(fnv1aFmix32(String(seed || ''), encoded), difficulty)) {
      return `${String(prefix || '')}${encoded}~S`;
    }
    if (yieldEvery > 0 && iteration > 0 && iteration % yieldEvery === 0) {
      await raceWithSignal(nextTurn(), signal);
    }
  }
  throw new ChatGptChallengeError(`ChatGPT PoW exceeded ${maxIterations} iterations.`, {
    type: 'proofofwork',
    difficulty: String(difficulty || ''),
  });
}

export async function buildRequirementsToken(options = {}) {
  const uuid = options.uuid ?? randomUUID;
  return solvePowToken({
    ...options,
    prefix: 'gAAAAAC',
    seed: options.seed ?? `0.${uuid().replaceAll('-', '')}`,
    difficulty: options.difficulty ?? '0',
    config: options.config ?? buildPowConfig({ ...options, uuid }),
  });
}

export function solveProofChallenge(challenge, options = {}) {
  if (!challenge?.required) return Promise.resolve('');
  return solvePowToken({
    ...options,
    prefix: 'gAAAAAB',
    seed: String(challenge.seed || ''),
    difficulty: String(challenge.difficulty || '0'),
    config: options.config ?? buildPowConfig(options),
  });
}
