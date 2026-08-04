import { WebaiError } from '../errors.js';

const TLS_PROFILES = new Set([
  'chrome',
  'chrome100',
  'chrome101',
  'chrome104',
  'chrome107',
  'chrome110',
  'chrome116',
  'chrome124',
  'chrome125',
  'chrome131',
  'chrome136',
  'chrome142',
  'firefox',
  'firefox128',
  'firefox133',
  'firefox135',
  'firefox144',
]);

const clients = new Map();

export function normalizeTlsProfile(value = 'firefox144') {
  const profile = String(value || 'firefox144').trim().toLowerCase();
  if (!TLS_PROFILES.has(profile)) {
    throw new WebaiError(
      `Unsupported TLS profile "${profile}". Expected a bundled Chrome or Firefox impit profile.`
    );
  }
  return profile;
}

async function clientFor(profile) {
  let pending = clients.get(profile);
  if (!pending) {
    pending = import('impit')
      .then(({ Impit }) => new Impit({ browser: profile, followRedirects: false }))
      .catch((error) => {
        clients.delete(profile);
        throw new WebaiError(
          `Could not initialize the browser-fingerprint HTTP transport: ${error?.message || error}`
        );
      });
    clients.set(profile, pending);
  }
  return pending;
}

export function createImpersonatedFetch({ profile = 'firefox144' } = {}) {
  const normalized = normalizeTlsProfile(profile);
  return async function impersonatedFetch(resource, init) {
    const client = await clientFor(normalized);
    return client.fetch(resource, { ...init, redirect: 'manual' });
  };
}
