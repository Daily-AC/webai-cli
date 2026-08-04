import { parentPort, workerData } from 'node:worker_threads';
import { solvePowModule, solveSha256Challenge } from './pow.js';

try {
  const algorithm = workerData.challenge.algorithm || 'DeepSeekHashV1';
  const answer = algorithm === 'sha256'
    ? solveSha256Challenge(workerData.challenge, { maxIterations: workerData.maxIterations })
    : await solvePowModule(workerData.challenge, workerData.module);
  parentPort.postMessage({ ok: true, answer });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error?.message || String(error) });
}
