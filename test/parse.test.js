import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  getNested,
  parseResponseByFrame,
  parseGenerateResponse,
  parseReadChat,
} from '../src/providers/gemini/parse.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gemini');
const load = (name) => readFileSync(join(FIX, name), 'utf8');

test('getNested walks arrays and object string keys', () => {
  assert.equal(getNested([1, [2, 3]], [1, 0]), 2);
  assert.equal(getNested({ 8: [{ x: 1 }] }, ['8', 0, 'x']), 1);
  assert.equal(getNested([1], [5], 'def'), 'def');
  assert.equal(getNested(null, [0], 'def'), 'def');
});

test('parseResponseByFrame decodes length-prefixed frames', () => {
  const raw = load('text-reply.txt').replace(/^\)\]\}'\n\n/, '');
  const { frames } = parseResponseByFrame(raw);
  assert.ok(frames.length >= 1);
  assert.equal(frames[0][0], 'wrb.fr');
});

test('parseGenerateResponse extracts text, cid and rid from a text reply', () => {
  const r = parseGenerateResponse(load('text-reply.txt'));
  assert.equal(r.text, 'pipeline is alive.');
  assert.equal(r.cid, 'c_conv123');
  assert.equal(r.rid, 'r_reply456');
  assert.equal(r.rcid, 'rc_cand789');
  assert.equal(r.completed, true);
  assert.equal(r.quotaExceeded, false);
  assert.equal(r.images.length, 0);
  assert.equal(r.videos.length, 0);
});

test('parseGenerateResponse flags a quota-exceeded (image limit) response', () => {
  const r = parseGenerateResponse(load('quota-image.txt'));
  assert.equal(r.quotaExceeded, true);
  assert.equal(r.cid, 'c_convQ');
});

test('parseGenerateResponse flags quota from the soft "limit resets" phrasing (real 2026-07-02)', () => {
  const r = parseGenerateResponse(load('quota-image-soft.txt'));
  assert.equal(r.quotaExceeded, true);
  assert.equal(r.images.length, 0);
});

test('parseGenerateResponse extracts a generated image URL from [12][7]', () => {
  const r = parseGenerateResponse(load('image-generated.txt'));
  assert.equal(r.images.length, 1);
  assert.equal(r.images[0].url, 'https://lh3.googleusercontent.com/gen/IMG123');
  assert.equal(r.images[0].imageId, 'imgid_1');
  assert.equal(r.quotaExceeded, false);
});

test('parseReadChat reports a ready video with its mp4 URL from [12][0]["60"]', () => {
  const r = parseReadChat(load('readchat-video-ready.txt'));
  assert.equal(r.status, 'ready');
  assert.equal(r.video.url, 'https://contribution.usercontent.google.com/download?c=MP4TOKEN');
  assert.equal(r.video.thumbnail, 'https://lh3.googleusercontent.com/gg/THUMB');
});

test('parseReadChat reports pending while the model is still working', () => {
  const r = parseReadChat(load('readchat-pending.txt'));
  assert.equal(r.status, 'pending');
});

test('parseReadChat treats a video_gen_chip placeholder as pending, not failed (real 2026-07-02)', () => {
  const r = parseReadChat(load('readchat-video-pending-chip.txt'));
  assert.equal(r.status, 'pending');
});
