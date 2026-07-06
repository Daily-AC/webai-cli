// Jimeng response parsing. Ported from iptag/jimeng-api (core.ts checkResult,
// image-utils.ts extractImageUrls).
import { WebaiError, AuthError, QuotaError, ContentRejectedError } from '../../errors.js';

// The API wraps payloads as { ret, errmsg, data }. ret "0" (or 0) = success.
export function checkResult(json, context = 'jimeng') {
  if (!json || typeof json !== 'object') throw new WebaiError(`${context}: empty response`);
  const ret = json.ret;
  if (ret === undefined || ret === null) return json; // some endpoints return raw
  if (String(ret) === '0') return json.data;
  const msg = json.errmsg || `ret=${ret}`;
  // Map known ret codes to typed errors (exit codes).
  if (['1000', '1001', '1002'].includes(String(ret)) || /登录|token|sessionid|unauth/i.test(msg)) {
    throw new AuthError(`jimeng auth failed (${msg}). Re-run: webai auth import chrome jimeng`);
  }
  if (/积分|credit|quota|余额/i.test(msg)) throw new QuotaError(`jimeng: ${msg}`);
  if (/审核|违规|敏感|policy|reject/i.test(msg)) throw new ContentRejectedError(`jimeng refused: ${msg}`);
  throw new WebaiError(`${context} error: ${msg} (ret=${ret})`);
}

// Pull the mp4 URL out of a video history item (extractVideoUrl in image-utils.ts).
export function extractVideoUrl(item) {
  return (
    item?.common_attr?.transcoded_video?.origin?.video_url ||
    item?.video?.transcoded_video?.origin?.video_url ||
    item?.video?.play_url ||
    item?.video?.download_url ||
    item?.video?.url ||
    null
  );
}

// Pull large-image URLs out of a get_history_by_ids item_list.
export function extractImageUrls(itemList = []) {
  const urls = [];
  for (const item of itemList) {
    const u = item?.image?.large_images?.[0]?.image_url;
    if (u) urls.push(u.replace(/\\u0026/g, '&'));
  }
  return urls;
}
