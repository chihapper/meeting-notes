# Meeting Notes

A Windows desktop app that records a meeting, transcribes it (**locally on your GPU
or in the cloud**), uses an LLM (**a local model or Claude/OpenAI**) to pull out a
summary + action items, and optionally turns those into ClickUp tasks — so you can
listen instead of taking notes. Run it **fully local and free**, or **fully cloud
with just API keys** — your choice, per meeting.

```
🎙️ Record (mic + system audio)
   → 📝 Transcribe — WhisperX (local GPU) or AssemblyAI (cloud)
   → 🤖 Summarize + extract action items — Ollama (local) or Claude / OpenAI
   → 📋 Keep in the in-app Meetings library, or auto-create ClickUp tasks
```

## Quick start (for collaborators)

```sh
git clone https://github.com/chihapper/meeting-notes
cd meeting-notes
npm install
npm start
```

On first launch a **setup wizard** asks how you want to run it and collects only the
keys your choices need. Two easy paths:

- **Easiest (no installs):** Cloud transcription (AssemblyAI key) + Claude or OpenAI
  summary + keep action items in the app. Two API keys and you're done.
- **Free + private:** Local WhisperX + local Ollama (needs Python 3.12 + WhisperX and
  Ollama installed — see [One-time setup](#one-time-setup)).

## First run: the setup wizard

On first launch the app shows a short **setup wizard** that asks three things and
collects only the keys your choices need:

1. **Transcription** — Local GPU (WhisperX) or Cloud (AssemblyAI).
2. **Summaries & action items** — Local (Ollama), Claude, or OpenAI.
3. **Action items** — keep them in the app's **Meetings** tab, or send to ClickUp.

Every combination works, so a recipient can run this with **no GPU and no ClickUp**
(e.g. Cloud transcription + Claude/OpenAI + in-app Meetings), or **fully local and
free** (WhisperX + Ollama + in-app Meetings). Change any of it later in ⚙ Settings.

## Meetings tab

Every processed meeting is saved to a local **Meetings** library — summary plus
checkable action-item bullets you tick off as done. Works with or without ClickUp,
so the app is fully usable on its own with no integrations.

## One-time setup

### 1. Node dependencies
```sh
npm install
```

### 2. Ollama (local summarization)
- Install from https://ollama.com (Windows installer).
- Pull a model (Qwen 2.5 is a good default; Llama 3.1 also works):
  ```sh
  ollama pull qwen2.5
  ```
- Ollama runs a local server at `http://localhost:11434` automatically.

### 3. Python + WhisperX (local transcription on the GPU)
- Install **Python 3.10+** from https://python.org (the Microsoft Store stub
  won't work — get the real installer, and tick "Add to PATH").
- Install a CUDA-enabled PyTorch + WhisperX:
  ```sh
  pip install torch --index-url https://download.pytorch.org/whl/cu121
  pip install whisperx
  ```
  (`cu121` = CUDA 12.1; pick the wheel matching your CUDA. WhisperX also needs
  `ffmpeg`, which you already have.)
- **HuggingFace token (free)** for speaker diarization:
  1. Create a free account at https://huggingface.co and make a token at
     https://huggingface.co/settings/tokens (read scope is enough).
  2. Accept the model terms (one click each) on:
     - https://huggingface.co/pyannote/speaker-diarization-3.1
     - https://huggingface.co/pyannote/segmentation-3.0
  - The token only authenticates these gated downloads — it costs nothing.

### 4. Run the app & configure
```sh
npm start
```
Click **⚙ Settings** and fill in:
- **ClickUp** API token (`pk_...`) and **List ID** (from the list URL, e.g.
  `.../li/901234567` → `901234567`).
- **HuggingFace token** (`hf_...`).
- **Whisper model** (`medium` is a good balance; use `large-v2` for best accuracy
  if you have the VRAM, `small` if you want speed), **device** (`cuda`),
  **compute type** — use **`int8`** on Pascal GPUs (GTX 10-series, e.g. 1080 Ti):
  they lack fast FP16, so `float16` is slow or unsupported. `float16` only makes
  sense on Volta/Turing/Ampere or newer (RTX 20-series+).
- **Ollama URL / model** (defaults are fine if you pulled `qwen2.5`).
- **Python path** — only if `python` isn't on your PATH (e.g. `py` or a full path).

## Using it

- Click **● Record**. On the first system-audio capture, Windows/Chromium asks
  what to share — pick a screen; only the audio is kept (video track dropped).
- Click **■ Stop**. The app runs WhisperX on your GPU (first run downloads the
  models), then Ollama summarizes. Progress shows in the status line.
- Review the **action items**, untick any you don't want, and click
  **Add all to ClickUp** (or add them individually).

## Transcription mode: Local ↔ Cloud

The main screen has a **Transcription** toggle:

- **Local GPU** (default) — WhisperX on your machine. Free, private, but ties up
  the GPU for a few minutes per meeting.
- **Cloud** — AssemblyAI. Near-instant, no GPU strain. Has a **free tier that covers
  light use**, then ~$0.15/hr of audio; sends the audio to AssemblyAI. Requires an
  AssemblyAI API key in Settings.

Pick per meeting — local for sensitive/clean-audio calls, cloud when you want a fast
turnaround. The summarizer is whatever you set (local Ollama, or Claude/OpenAI).

## Costs

Depends entirely on which engines you choose — anywhere from **$0** to a couple
dollars a month:

| Stage | Local (free) | Cloud (bring your own key) |
|---|---|---|
| Transcription | WhisperX on your GPU — **$0** | AssemblyAI — **free tier covers light use**, then ~$0.15/hr |
| Summary + action items | Ollama on your GPU — **$0** | Claude / OpenAI — **a few cents per meeting** (~$1–3/mo at a few hrs/week) |
| ClickUp tasks | included in your ClickUp plan | same |

- **Fully local (WhisperX + Ollama):** $0/meeting — just electricity.
- **Fully cloud (AssemblyAI + Claude/OpenAI):** usually a couple dollars a month for
  normal use; AssemblyAI's free allowance means light use can still be $0, and a
  cheap model (Claude Haiku, OpenAI `gpt-4o-mini`) adds only cents per meeting.

You bring your own API keys and pay the providers directly — nothing is billed
through this app.

## How it works

| Piece | File |
|---|---|
| Window, tray, IPC, call detection, launch trigger | `src/main.js` |
| Audio capture + mixing + UI | `src/renderer/renderer.js` |
| WhisperX transcription + diarization (Python) | `src/python/whisperx_transcribe.py` |
| Local transcription (spawns WhisperX) | `src/services/transcribe.js` |
| Cloud transcription (AssemblyAI) | `src/services/transcribe_cloud.js` |
| Summary + action items (Ollama / Claude / OpenAI) | `src/services/summarize.js` |
| ClickUp parent task + subtasks + attachment | `src/services/clickup.js` |
| Word (.docx) meeting doc | `src/services/docgen.js` |
| "Test connections" / readiness checks | `src/services/diagnostics.js` |
| Local Meetings library | `src/store.js` |
| Settings persistence (per-user app data) | `src/config.js` |
| Zoom/Teams launch trigger setup (run by the app) | `scripts/setup-call-trigger.ps1` |

## Auto-record Zoom/Teams meetings (Windows)

Turn on **⚙ Settings → Auto-record meetings → "Auto-launch & notify for Zoom/Teams
meetings"** (approve the one-time Windows admin prompt). After that the app:

- launches itself only when a Zoom or Teams meeting starts (nothing runs otherwise),
- shows a notification — **click it to start recording** (no need to open the app),
- quits when both Zoom and Teams are closed.

Notes: Windows only; doesn't cover Google Meet or browser calls (no process to hook).
Teams fires on app launch, so after enabling, restart Teams once. Re-toggle after a
major Teams update (its install path changes). For Meet/anything else, open the app
and hit Record.

## Choosing the Ollama model by GPU VRAM

The Ollama **Model** field is a free-text box with suggestions — type **any** model
Ollama can pull (e.g. `qwen3.5`, `qwen3.6`, a custom fine-tune), not just the
presets. Pick the largest that fits your card, `ollama pull <model>`, then set its
name in Settings. (Sizes are rough, Q4 quantization; newer Qwen generations are
better than 2.5 at the same size.)

| GPU VRAM | Suggested model | Approx. VRAM | Notes |
|---|---|---|---|
| ~6–8 GB | `qwen3.5` | ~7 GB | Current-gen, fits small cards |
| **~11 GB (1080 Ti)** | **`qwen3.5`** | ~7 GB | Best current model that fits your card |
| 16 GB (4080 / 5080) | `qwen3.5` or `qwen2.5:14b` | ~7–10 GB | `qwen3.6` (~24 GB) is too big here |
| 24 GB (4090) | `qwen3.6` | ~24 GB | 27B flagship — near hosted-model quality |
| 32 GB (5090) | `qwen3.6` (headroom to spare) | ~24 GB | 27B flagship |

The configured default is `qwen2.5:7b` (proven + small). For better quality at the
same footprint, switch to `qwen3.5`.

Notes:
- In **Local** transcription mode, WhisperX and Ollama don't run at the same time —
  WhisperX finishes and frees its VRAM before Ollama loads — so Ollama can use most
  of the card. For back-to-back meetings, enable **"Unload model after each summary"**
  in Settings so the summarizer's VRAM is freed before the next WhisperX run.
- On a 16 GB+ card, a 14B–32B local model gets close enough to a hosted model that
  you likely won't need cloud summarization at all.
- To switch: e.g. `ollama pull qwen2.5:14b`, then set the model field in Settings to
  `qwen2.5:14b`.

## Building a distributable (.exe + installer)

```sh
npm run dist           # builds BOTH a portable .exe and an installer
npm run dist:portable  # just the double-click portable .exe
npm run dist:installer # just the NSIS installer
```

Output lands in `dist/`:

| File | What it is |
|---|---|
| `MeetingNotes-portable-<version>.exe` | **Double-click to run** — no install, fully self-contained (~78 MB). |
| `Meeting Notes <version> x64.exe` | **Installer** — installs per-user (no admin), adds Start-menu + desktop shortcuts, and an uninstaller. Hand this to other people. |

Notes:
- **Unsigned build → SmartScreen warning.** Because there's no code-signing
  certificate, Windows shows "Windows protected your PC" on first run. Click
  **More info → Run anyway**. To remove this for recipients, buy a code-signing
  cert and add it to the `build` config — otherwise just tell people to expect it.
- **Custom icon (optional):** drop a 256×256 `build/icon.ico` in the project and
  rebuild; otherwise the default Electron icon is used.

## Sharing it with others

The installer packages **only the app** — recipients choose their own setup in the
first-run wizard. Three independent choices, each with a no-install cloud option:

| Choice | Local (free, needs install) | Cloud (paid, no install) |
|---|---|---|
| Transcription | WhisperX (Python + GPU) | AssemblyAI key |
| Summaries | Ollama | Claude **or** OpenAI key |
| Action items | In-app Meetings tab | ClickUp |

**Lightest possible setup for a non-technical recipient:** Cloud transcription
(AssemblyAI key) + Claude or OpenAI key + in-app Meetings — **no GPU, no Python, no
Ollama, no ClickUp**, just two API keys. **Fully free, fully private:** WhisperX +
Ollama + in-app Meetings — no accounts or keys at all (just the local installs).

## Notes / limitations

- WhisperX's diarization API has shifted across versions; the Python script
  handles the common import paths, but if a `pip` upgrade changes it you may need
  to adjust `src/python/whisperx_transcribe.py`. Without an HF token it still
  transcribes — just with no speaker labels.
- Speaker labels come through as `SPEAKER_00`, `SPEAKER_01`, etc. Mapping those to
  real names is a natural next step.
- A local 7B–14B model is a notch below a frontier hosted model at clean
  extraction, but very usable for action items. Bump the Ollama model if you want
  higher quality.
- The recording is processed locally and not stored on disk by default.
