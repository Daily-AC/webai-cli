// Minimal AWS SigV4 signer for the ImageX upload API (no npm dependency).
// Signs only the headers required for a valid signature: host, x-amz-date,
// and x-amz-security-token (when using STS credentials). Extra headers can
// be sent unsigned without breaking validation — SigV4 only protects the
// headers listed in SignedHeaders.
import crypto from 'node:crypto';

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function amzDate(now = new Date()) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

// Encode a query string the way AWS expects: sorted keys, RFC 3986 escaping.
function canonicalQueryString(params) {
  const keys = Object.keys(params).sort();
  return keys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}

export function signAws4Request({
  method,
  host,
  path,
  query = {},
  body = '',
  accessKey,
  secretKey,
  sessionToken,
  region,
  service,
  now = new Date(),
}) {
  const dateStamp = amzDate(now).slice(0, 8);
  const amzDateStr = amzDate(now);
  const payloadHash = sha256Hex(body || '');

  const headers = { host, 'x-amz-date': amzDateStr };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    method,
    path,
    canonicalQueryString(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDateStr, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    'x-amz-date': amzDateStr,
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
    Authorization: authorization,
  };
}
