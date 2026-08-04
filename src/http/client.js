// Thin HTTP transport over Node's built-in fetch (undici).
//
// P0 proved plain undici is NOT TLS/JA3-fingerprint-blocked by Google, so we
// deliberately pull in zero fingerprint dependencies. This wraps timeout,
// retry-with-backoff, and status-code → typed-error mapping.
import { AuthError, WebaiError } from '../errors.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// Result of a request: status, headers (Headers object), text(), and raw body bytes.
export async function request(
  url,
  {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 120_000,
    retries = 2,
    retryOnStatus = [429, 500, 502, 503, 504],
    redirect = 'follow',
  } = {}
) {
  const finalHeaders = { 'User-Agent': DEFAULT_UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers };
  let attempt = 0;
  let lastErr;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: finalHeaders,
        body,
        redirect,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (retryOnStatus.includes(res.status) && attempt < retries) {
        await backoff(attempt);
        attempt++;
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await backoff(attempt);
        attempt++;
        continue;
      }
      throw new WebaiError(`http ${method} ${shortUrl(url)} failed: ${err.message || err}`);
    }
  }
  throw new WebaiError(`http ${method} ${shortUrl(url)} failed: ${lastErr?.message || lastErr}`);
}

// Map an HTTP status to a typed error (or return null when the status is OK-ish).
// 401/403 → AuthError (exit 2); other >=400 → generic WebaiError (exit 1).
export function errorForStatus(status, context = '', bodySnippet = '') {
  if (status === 401 || status === 403) {
    return new AuthError(
      `${context || 'request'} unauthorized (HTTP ${status}). Cookies are likely expired; re-import credentials with webai auth import <provider> --stdin or --file.`
    );
  }
  if (status >= 400) {
    return new WebaiError(`${context || 'request'} failed with HTTP ${status}${bodySnippet ? `: ${bodySnippet.slice(0, 200)}` : ''}`);
  }
  return null;
}

function backoff(attempt) {
  const ms = Math.min(2000, 250 * 2 ** attempt);
  return new Promise((r) => setTimeout(r, ms));
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return String(url);
  }
}
