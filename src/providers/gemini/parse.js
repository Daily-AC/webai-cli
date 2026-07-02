// Pure parsers for Gemini wrb.fr streaming responses.
//
// Ported from HanaokaYuzu/Gemini-API (`utils/parsing.py`, `client.py::_parse_candidate`,
// `components/chat_mixin.py::read_chat`). The response is Google's length-prefixed
// framing: `)]}'\n\n<utf16-len>\n<json>\n...`. Each frame is a list of parts;
// a "wrb.fr" part carries an inner JSON string at [2].

// USAGE_LIMIT_EXCEEDED per constants.py::ErrorCode
const USAGE_LIMIT_EXCEEDED = 1037;

// Wide refusal matcher (mirrors the phrasings gemini-media.js watched for).
const REFUSAL_RE =
  /\bcan'?t (make|create|generate|help)\b|couldn'?t (create|generate|make)|isn'?t something I can|violates|safety polic|content polic|goes against|dangerous situations?/i;

// Quota phrasings observed live (2026-07-02): the structured "Image Generation
// Limit Reached" label AND the softer candidate text "I can create more images
// as soon as your limit resets. Check your usage in Settings."
const QUOTA_RE =
  /Generation Limit Reached|reached your (daily )?limit|as soon as your limit resets|limit resets\b|usage limit exceeded|check your usage in settings|out of .* for (today|now)/i;

// While a Veo video renders, read_chat returns a turn whose text carries a
// "video_gen_chip" placeholder and whose [12][59] mp4 slot is not present yet
// (completion status stays null). Observed live 2026-07-02.
const VIDEO_PENDING_RE = /video_gen_chip|generating your video|check back to see when your video|still (creating|generating) your video/i;

// Safe nested navigation over mixed arrays/objects (parsing.py::get_nested_value).
export function getNested(data, path, fallback = null) {
  let cur = data;
  for (const key of path) {
    if (typeof key === 'number') {
      if (!Array.isArray(cur)) return fallback;
      const idx = key < 0 ? cur.length + key : key;
      if (idx < 0 || idx >= cur.length) return fallback;
      cur = cur[idx];
    } else {
      if (cur == null || typeof cur !== 'object' || Array.isArray(cur) || !(key in cur)) return fallback;
      cur = cur[key];
    }
  }
  return cur == null ? fallback : cur;
}

// Count JS characters covering `utf16Units` UTF-16 code units from startIdx.
function charCountForUtf16Units(s, startIdx, utf16Units) {
  let count = 0;
  let units = 0;
  const limit = s.length;
  while (units < utf16Units && startIdx + count < limit) {
    const code = s.codePointAt(startIdx + count);
    const u = code > 0xffff ? 2 : 1;
    if (units + u > utf16Units) break;
    units += u;
    // codePointAt returns the full code point; advance by the number of UTF-16
    // units it occupies so surrogate pairs are counted once.
    count += code > 0xffff ? 2 : 1;
  }
  return { count, units };
}

const LENGTH_MARKER_RE = /^(\d+)\n/;

// parsing.py::parse_response_by_frame — returns { frames, rest }.
export function parseResponseByFrame(content) {
  let pos = 0;
  const total = content.length;
  const frames = [];

  while (pos < total) {
    while (pos < total && /\s/.test(content[pos])) pos++;
    if (pos >= total) break;

    const m = LENGTH_MARKER_RE.exec(content.slice(pos));
    if (!m) break;
    const lengthVal = m[1];
    const length = parseInt(lengthVal, 10);
    // Google's length count starts AT the newline after the digits and includes
    // it (parsing.py: start_content = match.start() + len(length_val)).
    const startContent = pos + lengthVal.length;
    const { count, units } = charCountForUtf16Units(content, startContent, length);
    if (units < length) break; // incomplete frame, wait for more

    const endPos = startContent + count;
    const chunk = content.slice(startContent, endPos).trim();
    pos = endPos;
    if (!chunk) continue;
    try {
      const parsed = JSON.parse(chunk);
      if (Array.isArray(parsed)) frames.push(...parsed);
      else frames.push(parsed);
    } catch {
      /* skip unparseable chunk */
    }
  }
  return { frames, rest: content.slice(pos) };
}

// parsing.py::extract_json_from_response
export function extractJson(text) {
  let content = text;
  if (content.startsWith(")]}'")) content = content.slice(4);
  content = content.replace(/^\s+/, '');
  const { frames } = parseResponseByFrame(content);
  if (frames.length) return frames;
  try {
    const parsed = JSON.parse(content.trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

// client.py::_parse_candidate — extract text, generated images, generated videos.
export function parseCandidate(candidateData) {
  const text = getNested(candidateData, [1, 0], '') || '';

  const images = [];
  const plain = getNested(candidateData, [12, 7, 0], []) || [];
  const i2i = getNested(candidateData, [12, 0, '8', 0], []) || [];
  for (const img of [...plain, ...i2i]) {
    const url = getNested(img, [0, 3, 3]);
    if (url) {
      images.push({
        url,
        imageId: getNested(img, [1, 0], '') || '',
        alt: getNested(img, [0, 3, 2], '') || '',
      });
    }
  }

  const videos = [];
  // Streaming StreamGenerate response: [12][59][0][0][0][0][7] → urls[0]=thumb, urls[1]=url.
  const streamInfo = getNested(candidateData, [12, 59, 0, 0, 0], []);
  if (streamInfo && streamInfo.length) {
    const urls = getNested(streamInfo, [0, 7], []) || [];
    if (urls.length >= 2) videos.push({ url: urls[1], thumbnail: urls[0] });
  }
  // read_chat response (verified live 2026-07-02): the finished video is nested
  // under object key "60": [12][0]["60"][0][0][0][0][7] → [0]=thumb, [1]=mp4
  // download URL, [2]=preview. NOTE: that mp4 host (contribution.usercontent.
  // google.com/download) rejects plain undici (see docs — download blocker).
  if (!videos.length) {
    const rc = getNested(candidateData, [12, 0, '60', 0, 0, 0, 0, 7], []);
    if (Array.isArray(rc) && rc.length >= 2) {
      const mp4 =
        rc.find((u) => typeof u === 'string' && /contribution\.usercontent\.google\.com\/download|\.mp4/i.test(u)) || rc[1];
      const thumb = rc.find((u) => typeof u === 'string' && /lh3\.googleusercontent/i.test(u)) || rc[0];
      videos.push({ url: mp4, thumbnail: thumb });
    }
  }

  return { text, images, videos };
}

// Top-level parse of a StreamGenerate response body.
// Returns cid/rid/rcid, text, images, videos, and quota/rejection/error signals.
export function parseGenerateResponse(rawText) {
  const result = {
    cid: '',
    rid: '',
    rcid: '',
    text: '',
    images: [],
    videos: [],
    quotaExceeded: false,
    blocked: false,
    errorCode: null,
    completed: false,
  };

  const frames = extractJson(rawText);
  for (const part of frames) {
    const errorCode = getNested(part, [5, 2, 0, 1, 0]);
    if (typeof errorCode === 'number') {
      result.errorCode = errorCode;
      if (errorCode === USAGE_LIMIT_EXCEEDED) result.quotaExceeded = true;
    }

    const innerStr = getNested(part, [2]);
    if (typeof innerStr !== 'string') continue;
    let partJson;
    try {
      partJson = JSON.parse(innerStr);
    } catch {
      continue;
    }

    const mData = getNested(partJson, [1]);
    if (mData) {
      const cid = getNested(mData, [0]);
      const rid = getNested(mData, [1]);
      if (cid) result.cid = cid;
      if (rid) result.rid = rid;
    }

    // Image-generation quota surfaces as a flag/text (P0: field 11 / 44).
    if (getNested(partJson, [44]) === true) result.quotaExceeded = true;

    const candidates = getNested(partJson, [4], []) || [];
    for (const cand of candidates) {
      const rcid = getNested(cand, [0]);
      if (!rcid) continue;
      result.rcid = rcid;
      const parsed = parseCandidate(cand);
      if (parsed.text && !result.text) result.text = parsed.text;
      result.images.push(...parsed.images);
      result.videos.push(...parsed.videos);
      if (getNested(cand, [8, 0]) === 2) result.completed = true;
    }
  }

  // String-level fallbacks for quota / refusal (structure drifts across releases).
  if (!result.quotaExceeded && QUOTA_RE.test(rawText)) result.quotaExceeded = true;
  if (
    !result.images.length &&
    !result.videos.length &&
    result.text &&
    REFUSAL_RE.test(result.text)
  ) {
    result.blocked = true;
  }

  return result;
}

// chat_mixin.py::read_chat — parse a READ_CHAT batchexecute response for the
// latest model turn. Returns { status, video?, images?, text? }.
//   status: 'ready' | 'pending' | 'failed'
export function parseReadChat(rawText) {
  const frames = extractJson(rawText);
  for (const part of frames) {
    const innerStr = getNested(part, [2]);
    if (typeof innerStr !== 'string') continue;
    let partBody;
    try {
      partBody = JSON.parse(innerStr);
    } catch {
      continue;
    }
    const turns = getNested(partBody, [0]);
    if (!turns || !Array.isArray(turns)) continue;

    for (const turn of turns) {
      const candidates = getNested(turn, [3, 0]);
      if (!candidates || !Array.isArray(candidates)) continue;
      for (const cand of candidates) {
        const completion = getNested(cand, [8, 0]);
        const hasProgress = getNested(cand, [12, 6, 0]) != null;
        const parsed = parseCandidate(cand);

        // Media already rendered → ready (regardless of the text turn's status).
        if (parsed.videos.length) return { status: 'ready', video: parsed.videos[0], text: parsed.text };
        if (completion === 2 && parsed.images.length) return { status: 'ready', images: parsed.images, text: parsed.text };

        // Still working: an explicit progress signal, or a video placeholder chip.
        if (hasProgress || VIDEO_PENDING_RE.test(parsed.text || '')) return { status: 'pending' };

        if (completion === 2) {
          // Completed turn with only text and no media → refusal.
          return { status: 'failed', text: parsed.text, reason: 'no media in completed turn' };
        }
        // Stopped without a progress signal → policy / quota / interruption.
        return { status: 'failed', text: parsed.text, reason: getNested(cand, [1, 0], '') || 'stopped' };
      }
    }
  }
  return { status: 'pending' };
}
