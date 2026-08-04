import {
  AuthError,
  CloudflareChallengeError,
  QuotaError,
  WebaiError,
} from '../../errors.js';

export class ChatGptTransportRequiredError extends WebaiError {
  constructor(message = 'chatgpt chat requires an injected TLS-impersonating transport') {
    super(message);
    this.name = 'ChatGptTransportRequiredError';
    this.code = 'transport_unavailable';
  }
}

export class ChatGptCloudflareError extends CloudflareChallengeError {
  constructor(message = 'chatgpt.com returned a Cloudflare challenge') {
    super(message, { provider: 'chatgpt' });
    this.name = 'ChatGptCloudflareError';
  }
}

export class ChatGptChallengeError extends WebaiError {
  constructor(message = 'ChatGPT Sentinel requires an unsupported challenge', challenge = null) {
    super(message);
    this.name = 'ChatGptChallengeError';
    this.code = 'challenge_required';
    this.challenge = challenge;
  }
}

export class ChatGptProtocolError extends WebaiError {
  constructor(message, code = 'protocol_drift') {
    super(message);
    this.name = 'ChatGptProtocolError';
    this.code = code;
  }
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || '') : '';
}

function cloudflareResponse(response, body) {
  if (headerValue(response?.headers, 'cf-mitigated').toLowerCase() === 'challenge') return true;
  const server = headerValue(response?.headers, 'server');
  const contentType = headerValue(response?.headers, 'content-type');
  return (
    /cloudflare/i.test(server) &&
    (/text\/html/i.test(contentType) || /cf-chl-|cloudflare|just a moment/i.test(String(body || '')))
  );
}

export function chatGptStatusError(response, context, body = '') {
  const status = Number(response?.status || 0);
  const snippet = String(body || '').trim().slice(0, 1000);
  if (cloudflareResponse(response, snippet)) {
    return new ChatGptCloudflareError(
      `${context} was blocked by Cloudflare (HTTP ${status || 'unknown'}); verify the injected TLS profile and full Cookie jar.`
    );
  }
  if (status === 401) return new AuthError(`${context} rejected the ChatGPT session (HTTP 401).`);
  if (status === 403 && /turnstile|arkose|proof|sentinel|challenge|unusual activity/i.test(snippet)) {
    return new ChatGptChallengeError(
      `${context} requires a Sentinel challenge that was not satisfied (HTTP 403).`,
      { status, body: snippet }
    );
  }
  if (status === 403) return new AuthError(`${context} rejected the ChatGPT session (HTTP 403).`);
  if (status === 429) return new QuotaError(`${context} was rate limited (HTTP 429).`);
  if ([301, 302, 303, 307, 308].includes(status)) {
    return new AuthError(`${context} redirected away from the authenticated ChatGPT API (HTTP ${status}).`);
  }
  return new WebaiError(`${context} failed with HTTP ${status || 'unknown'}${snippet ? `: ${snippet}` : ''}`);
}
