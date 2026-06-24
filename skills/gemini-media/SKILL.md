---
name: gemini-media
description: Generate video (Veo) and images with Google Gemini from the command line — text-to-video, image+prompt-to-video, and text-to-image. Use when the user wants to make a video or image with Gemini/Veo, animate a photo into a video, generate a video from an image and a prompt, or create an AI image via Gemini. Triggers include "用 Gemini 生成视频", "把这张图做成视频", "Veo 生成", "image to video", "generate a video with Gemini", "Gemini 生图", "generate an image with Gemini".
---

# Gemini media generation (video + image)

Drives the real Gemini web UI (`gemini.google.com`) through the `webai` CLI to
generate **video** (Veo) and **images**, then downloads the result locally. No API
key — it piggy-backs on your logged-in Chrome session via the opencli browser bridge.

## Prerequisites (check first, in this order)

1. **opencli daemon + extension connected**: `opencli doctor` should report
   `[OK] Daemon`, `[OK] Extension`, `[OK] Connectivity`.
2. **Logged-in Gemini tab in the opencli-driven Chrome profile**, on an account
   that has **Veo / video generation** access (Gemini AI Pro/Ultra). If the
   account lacks video, image generation still works but video will fail.
3. **`webai` CLI available**: it lives at `~/projects/webai-cli`. Run via
   `node ~/projects/webai-cli/bin/webai.js …` (or `webai …` if `npm link`ed).

If a prerequisite is missing, tell the user exactly what to fix (e.g. "open
gemini.google.com in Chrome and sign in") rather than retrying blindly.

## Commands

Let `WEBAI=node ~/projects/webai-cli/bin/webai.js` (or just `webai`).

### Text → image (synchronous, ~15–30s)

```bash
$WEBAI image gemini "<prompt>" --out ./out.png --json
```
Prints (or with `--json`, returns) the saved file path. Gemini saves PNG.

### Text → video (asynchronous, ~1–3 min)

```bash
# 1. Submit — returns a job id immediately (the conversation hex)
$WEBAI video gemini submit "<prompt>"        # prints e.g. 7cfffb8a66f061de

# 2. Poll + download — blocks until the video is ready, then saves the mp4
$WEBAI video gemini status <job-id> --out ./out.mp4 --json
```
`status` blocks (polls up to ~10 min) until the video renders, then downloads.
Add `--once` to `status` for a single non-blocking check (exit code 3 = still
generating).

### Image + prompt → video (animate a photo)

```bash
$WEBAI video gemini submit "<prompt>" --image ./photo.jpg   # returns job id
$WEBAI video gemini status <job-id> --out ./out.mp4
```
The reference image becomes the first frame / subject; the prompt drives motion.

## Output contract

- Default: the media is **downloaded** to `--out` (file or directory; defaults to
  the current dir). The path is printed to stdout.
- `--json`: structured output. For video `status` it also includes the original
  Gemini `url` (a `contribution.usercontent.google.com` link, cookie-gated).

## How to run it for the user

1. Verify prerequisites (`opencli doctor`).
2. For **video**: run `submit`, capture the job id, then run `status … --out <path>`
   and wait — it blocks until the mp4 is downloaded. Report the saved path.
3. For **image**: run the single `image gemini` command and report the saved path.
4. On failure, read the error: "could not enter … mode" → the Gemini tab may be
   on a different page or not loaded; "rejected (safety filter)" → the prompt was
   blocked; "timed out waiting for the reference image to upload" → re-check the
   image path.

## Notes / gotchas

- One Gemini tab is driven at a time; don't run two `webai` media commands against
  the same `WEBAI_SESSION` concurrently (browser contention drops the connection).
- `WEBAI_SESSION` env var overrides the browser session name (default
  `webai-gemini-media`).
- Set `WEBAI_DOWNLOAD_DIR` if Chrome's download directory isn't `~/Downloads`.
- Reverse-engineering details: `~/projects/webai-cli/docs/superpowers/recon/gemini-media-recon.md`.
