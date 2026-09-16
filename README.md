# FrameGenjutsu

Turn three keyframes into a full animation sequence, locally.

You upload a **start**, a **middle** and an **end** frame. framegenjutsu asks an AI
video endpoint to invent the motion between start -> middle and between
middle -> end, then slices those clips into individual frames and writes them to
disk as a numbered PNG sequence inside a folder named after your scene.

Local-first means: the app runs on your machine, your files stay on your
machine, and the only thing that leaves is the two anchor images you hand to the
generation API you picked.

---

## Why it is cheap and fast

The naive way to fill in 8 frames between two images is 8 separate image
generations. framegenjutsu does **two** calls for the whole scene.

1. It asks an image-to-video model for one short clip per segment, conditioned
   on the segment's first **and** last frame. That is one clip for
   start -> middle and one for middle -> end.
2. It samples the requested number of frames out of each clip at evenly spaced
   positions, throwing away the first and last video frame because those *are*
   your anchors.
3. Both segments are rendered **in parallel**, so a scene costs two API calls
   and roughly the wall-clock time of one.

The generated clips are cached under the scene's hidden work folder, so a
re-run with different frame counts costs zero API calls.

---

## Requirements

- **Node.js 18.17+** (tested on 20)
- **ffmpeg** - bundled automatically. framegenjutsu ships with the static
  ffmpeg and ffprobe binaries via npm, so a plain npm install is usually enough.
  If you already have ffmpeg on your PATH, set FFMPEG_PATH in .env to use it.

---

## Install and run

```bash
npm install
cp .env.example .env      # then add the API key(s) you want to use
npm start
```

Open http://127.0.0.1:8787.

Check your setup at any time:

```bash
npm run doctor    # node, ffmpeg, ffprobe, projects dir, provider keys
npm run smoke     # full end-to-end test using the offline providers
```

---

## Using it

1. Type a **scene name**. This becomes the folder under projects/. Letters,
   digits, dot, dash and underscore only.
2. Write a **prompt** describing the motion - "she turns her head toward the
   window, rain intensifies, hand-drawn anime style".
3. Pick an **AI endpoint** and a **model** from the dropdowns. Endpoints with no
   API key in .env are shown disabled.
4. Choose how many frames to generate between start/middle and between
   middle/end. Anywhere from 1 to 10 each.
5. Drop in the three anchor images.
6. Hit **Generate frames** and watch the log.

You get back the frame strip, a preview.mp4/preview.gif, and the folder path.

---

## Output layout

For a scene called `rooftop-chase` with 3 frames in the first gap and 2 in the
second:

```
projects/
  rooftop-chase/
    1.png              <- your start frame
    2.png              <- generated (segment A)
    3.png              <- generated (segment A)
    4.png              <- generated (segment A)
    5.png              <- your middle frame
    6.png              <- generated (segment B)
    7.png              <- generated (segment B)
    8.png              <- your end frame
    preview.mp4
    preview.gif
    manifest.json
    .work/             <- cached clips, safe to delete
  .uploads/            <- normalised copies of what you uploaded
```

Every frame is letterboxed to the size of your start frame, so the sequence is
uniform and drops straight into ffmpeg, After Effects, Blender or a game engine.

### Two numbering modes

The **File numbering** dropdown in Advanced controls how files are named:

- **Play order** (default) - `1.png` is the start frame, the generated frames
  are interleaved where they belong in time, and the last file is your end
  frame. This is what you want for playback and for `ffmpeg -i %d.png`.
- **Anchors first** - the three frames you uploaded are written as `1.png`,
  `2.png`, `3.png` (start, middle, end) and the generated frames follow from
  `4.png` onwards in creation order.

Either way `manifest.json` records the exact role and play position of every
file, so nothing is ambiguous:

```json
{
  "scene": "rooftop-chase",
  "provider": "fal",
  "model": "fal-ai/kling-video/v1.6/standard/image-to-video",
  "numbering": "play-order",
  "inBetweens": { "segmentA": 3, "segmentB": 2 },
  "size": { "width": 1920, "height": 1080 },
  "anchors": { "start": "1.png", "middle": "5.png", "end": "8.png" },
  "frames": [
    { "file": "1.png", "role": "start",     "segment": null, "playIndex": 0 },
    { "file": "2.png", "role": "generated", "segment": "A",  "playIndex": 1 }
  ]
}
```

---

## Choosing an endpoint

Everything is driven by `server/providers/`, and the list is data-driven so you
can extend it without touching code.

| Provider | Key needed | End-frame conditioning | Notes |
| --- | --- | --- | --- |
| **fal.ai** | `FAL_KEY` | yes on most models | Queue API, one job per segment. Good default. |
| **Replicate** | `REPLICATE_API_TOKEN` | yes on the Kling models | Wide model catalogue. |
| **Runway** | `RUNWAYML_API_SECRET` | yes (sent as an array) | See note below about `promptImage`. |
| **Luma** | `LUMAAI_API_KEY` | yes, native keyframe API | Needs `PUBLIC_BASE_URL` - see below. |
| **Local (offline)** | none | n/a | ffmpeg optical-flow interpolation. Free, instant, no new motion invented. |
| **Demo (no API)** | none | n/a | Copies your anchors. Exists to rehearse the pipeline for free. |

Models that only accept a start frame are labelled "start frame only" and the UI
warns you that the last in-between frame will not land exactly on your keyframe.

### PUBLIC_BASE_URL

Luma (and anything else that wants a real URL rather than a data URI) can only
fetch images that are reachable from the public internet. framegenjutsu already
serves your uploaded anchors at `/api/files/uploads/...`, so pointing a tunnel
at the server is enough:

```bash
# in one terminal
npm start
# in another, any tunnel you like, e.g.
ngrok http 8787
```

Then put the tunnel URL in .env:

```
PUBLIC_BASE_URL=https://your-tunnel.ngrok.app
```

Restart, and the Luma models become selectable.

---

## Configuration

All of it lives in `.env` (see `.env.example` for the annotated version).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | 8787 | Web server port. |
| `HOST` | 127.0.0.1 | Keep it local, or use 0.0.0.0 to reach it from your LAN. |
| `PUBLIC_BASE_URL` | - | Public URL of this server, required by Luma. |
| `PROJECTS_DIR` | ./projects | Where scenes are written. |
| `REPLICATE_API_TOKEN` | - | Replicate. |
| `FAL_KEY` | - | fal.ai, in `id:secret` form. |
| `RUNWAYML_API_SECRET` | - | Runway. |
| `LUMAAI_API_KEY` | - | Luma. |
| `FFMPEG_PATH` / `FFPROBE_PATH` | bundled | Override the bundled binaries. |
| `MAX_EDGE` | 0 | Cap the long edge of uploaded anchors before they are sent to an API. 0 keeps the original size. |
| `PREVIEW_FPS` | 12 | Frame rate of the generated preview.mp4/gif. |

---

## Custom endpoints and model fixes

On first boot framegenjutsu writes `providers.local.json`. Anything you put there
wins over the built-in registry. `GET /api/providers` returns the live registry
including each model's `input` map, so you can copy a block, paste it into the
override file and edit it - no code changes, just a restart.

```json
{
  "providers": [
    {
      "id": "replicate",
      "models": [
        {
          "id": "kwaivgi/kling-v1.6-standard",
          "label": "Kling 1.6 Standard (my tweak)",
          "strategy": "video",
          "supportsEndFrame": true,
          "defaults": { "duration": 10 },
          "input": {
            "prompt": "$prompt",
            "start_image": "$first",
            "end_image": "$last",
            "duration": "$duration"
          }
        }
      ]
    }
  ]
}
```

Add a brand new provider by giving it an `adapter` - the transport it reuses:

```json
{
  "providers": [
    {
      "id": "my-clone",
      "adapter": "fal",
      "label": "My fal clone",
      "keyEnv": ["FAL_KEY"],
      "requiresKey": true,
      "models": [
        { "id": "fal-ai/some/other/model", "label": "Other model", "strategy": "video", "input": { "prompt": "$prompt", "image_url": "$first" } }
      ]
    }
  ]
}
```

Tokens available inside an `input` map: `$prompt`, `$negative`, `$first`,
`$last` (base64 data URIs), `$firstPublic`, `$lastPublic` (URLs, need
PUBLIC_BASE_URL), `$firstLastArray`, `$duration`, `$durationStr`, `$count`,
`$fps`, `$aspectRatio`, `$aspectRatioSimple`, `$resolution`. Any value that is
not a string starting with `$` is passed through literally. Keys that resolve to
an empty value are omitted, which matters because providers like Replicate
reject unknown input keys.

---

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | ffmpeg/ffprobe status, projects dir. |
| GET | `/api/providers` | Endpoints, models, input maps, which keys are present. |
| POST | `/api/generate` | Queue a scene. Returns `{ jobId }`. |
| GET | `/api/jobs/:id` | Job state plus the full log. |
| GET | `/api/jobs/:id/events` | Server-sent events: `log`, `state`, `done`, `failed`. |
| POST | `/api/jobs/:id/cancel` | Abort a running job. |
| GET | `/api/scenes` | List scenes with frame counts. |
| GET | `/api/scenes/:scene` | The scene's manifest.json. |
| DELETE | `/api/scenes/:scene` | Remove a scene folder. |
| GET | `/api/files/scenes/:scene/<path>` | Serve a written frame or preview. |
| GET | `/api/files/uploads/:name` | Serve a normalised anchor (used by Luma). |

Scenes are processed one at a time; the two segments inside a scene run in
parallel.

---

## Project layout

```
framegenjutsu/
  server/
    index.js              Express app, REST + SSE routes, static files
    config.js             .env driven settings
    lib/
      pipeline.js         scene orchestration, numbering, manifest
      media.js            ffmpeg/ffprobe discovery, extraction, conforming
      jobs.js             in-memory job store and SSE fan-out
      paths.js            scene name validation and safe directories
      errors.js
    providers/
      index.js            registry, providers.local.json merge
      input.js            $token expansion for model input maps
      http.js             fetch with retry, polling helper
      replicate.js  fal.js  runway.js  luma.js  local.js  demo.js
  public/
    index.html  styles.css  app.js      no framework, no build step
  scripts/
    doctor.js             environment report
    smoke.js              end-to-end test
  projects/               your scenes land here
```

---

## Troubleshooting

**"ffmpeg was not found"** - run `npm install` again so the bundled static
build is fetched, or install ffmpeg system-wide and set `FFMPEG_PATH` /
`FFPROBE_PATH` in .env. `npm run doctor` tells you which one is being used.

**A provider rejects the request with a 422/400** - the model's input names on
that service changed. Open the model block in `GET /api/providers`, copy it into
`providers.local.json` and fix the `input` keys.

**Frames look like they jump at the middle anchor** - the model you picked does
not support end-frame conditioning. The UI flags those models; switch to one
that does.

**The middle of the sequence drifts** - raise the per-segment clip length
(Advanced -> Clip length) so the model has more room, or increase the frame
count so each frame moves less.

**Luma models are greyed out** - `PUBLIC_BASE_URL` is not set. See above.

**Out of disk space on projects/** - the `.work` folder inside each scene holds
the cached clips. It is safe to delete, at the cost of re-generating on the next
run with "Reuse cached clips" enabled.
