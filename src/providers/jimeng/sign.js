// Jimeng request signing + headers. Ported from iptag/jimeng-api core.ts.
//
// Sign header = md5("9e2c|" + <last 7 chars of path> + "|7|8.4.0|" + <unix seconds> + "||11ac").
// The empty 6th field (double pipe before 11ac) is intentional. Timestamp is seconds.
import crypto from 'node:crypto';
import { PLATFORM_CODE, VERSION_CODE, APP_SDK_VERSION, AID, BASE_URL } from './reqbuild.js';

export function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

export function unixSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Compute the Sign for a request path (path only, no host/query). deviceTime in seconds.
export function computeSign(uriPath, deviceTime) {
  return md5(`9e2c|${uriPath.slice(-7)}|${PLATFORM_CODE}|${VERSION_CODE}|${deviceTime}||11ac`);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

// Full header set for a CN API request. `cookieHeader` is the serialized Cookie
// string; `referer` overrides the default origin referer for specific tools.
export function buildHeaders({ uriPath, cookieHeader, referer }) {
  const deviceTime = unixSeconds();
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/json',
    Appvr: VERSION_CODE,
    Pragma: 'no-cache',
    Pf: PLATFORM_CODE,
    'Sec-Ch-Ua': '"Google Chrome";v="142", "Chromium";v="142", "Not_A Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': UA,
    Origin: BASE_URL,
    Referer: referer || `${BASE_URL}/`,
    'App-Sdk-Version': APP_SDK_VERSION,
    Appid: String(AID),
    Cookie: cookieHeader,
    'Device-Time': String(deviceTime),
    Lan: 'zh-Hans',
    Loc: 'cn',
    Sign: computeSign(uriPath, deviceTime),
    'Sign-Ver': '1',
    Tdid: '',
  };
}
