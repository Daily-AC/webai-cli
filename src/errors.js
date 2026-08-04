// Typed errors for the direct-HTTP media path. Each carries the deterministic
// process exit code the command layer should exit with (spec §4.4):
//   0 success | 2 creds missing/expired | 3 (--once) still generating
//   4 content rejected / policy | 5 quota exceeded | 1 other
export const EXIT = {
  OK: 0,
  OTHER: 1,
  AUTH: 2,
  PENDING: 3,
  REJECTED: 4,
  QUOTA: 5,
};

export class WebaiError extends Error {
  constructor(message, exitCode = EXIT.OTHER) {
    super(message);
    this.name = 'WebaiError';
    this.exitCode = exitCode;
  }
}

// Credentials missing, not logged in, or session invalidated (401/expired cookies).
export class AuthError extends WebaiError {
  constructor(message) {
    super(message, EXIT.AUTH);
    this.name = 'AuthError';
  }
}

// A provider endpoint returned a Cloudflare challenge instead of reaching the
// authenticated application. This is an upstream transport block, not proof
// that the submitted credential is invalid.
export class CloudflareChallengeError extends WebaiError {
  constructor(message, { provider = '', stage = '', status = null } = {}) {
    super(message);
    this.name = 'CloudflareChallengeError';
    this.code = 'cloudflare_blocked';
    if (provider) this.provider = provider;
    if (stage) this.stage = stage;
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
  }
}

// Daily / per-model generation quota reached.
export class QuotaError extends WebaiError {
  constructor(message) {
    super(message, EXIT.QUOTA);
    this.name = 'QuotaError';
  }
}

// Prompt refused by a safety policy / content filter.
export class ContentRejectedError extends WebaiError {
  constructor(message) {
    super(message, EXIT.REJECTED);
    this.name = 'ContentRejectedError';
  }
}

// Async job still generating (only surfaced as exit 3 under --once).
export class PendingError extends WebaiError {
  constructor(message) {
    super(message, EXIT.PENDING);
    this.name = 'PendingError';
  }
}

// Map any thrown value to a deterministic exit code.
export function exitCodeFor(err) {
  if (err && typeof err.exitCode === 'number') return err.exitCode;
  return EXIT.OTHER;
}
