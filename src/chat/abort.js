function abortError(message) {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function signalReason(signal, fallback = 'operation aborted') {
  return signal?.reason instanceof Error ? signal.reason : abortError(fallback);
}

export function createDeadlineSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;

  const onParentAbort = () => controller.abort(signalReason(parentSignal));
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      const err = new Error(`operation timed out after ${timeoutMs}ms`);
      err.name = 'TimeoutError';
      controller.abort(err);
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    abort(reason = abortError('operation cancelled')) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}

export function raceWithSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(signalReason(signal));

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signalReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}
