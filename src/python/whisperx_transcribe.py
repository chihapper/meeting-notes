"""
Transcribe + diarize an audio file locally with WhisperX (runs on your GPU).

Invoked by the Electron app as:
    python whisperx_transcribe.py <audio_path> <out_path>

Reads config from environment variables:
    WHISPER_MODEL     e.g. "small" | "medium" | "large-v2"   (default "medium")
    WHISPER_DEVICE    "cuda" | "cpu"                          (default "cuda")
    WHISPER_COMPUTE   "float16" | "int8" | "float32"          (default "float16")
    WHISPER_LANGUAGE  ISO code like "en", or empty to auto-detect
    HF_TOKEN          HuggingFace token (free) for pyannote diarization models

Writes the speaker-labeled transcript (UTF-8 text) to <out_path>.
Progress + errors go to stderr so the app can show them; stdout stays clean.
"""
import os
import sys


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def build_transcript(segments, fallback_text):
    """Merge consecutive same-speaker segments into 'SPEAKER_xx: text' lines."""
    lines = []
    cur_speaker = None
    cur_text = []

    def flush():
        if cur_text:
            label = cur_speaker if cur_speaker else "Speaker"
            lines.append(f"{label}: {' '.join(cur_text).strip()}")

    for seg in segments:
        spk = seg.get("speaker", "")
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        if spk != cur_speaker:
            flush()
            cur_speaker = spk
            cur_text = [text]
        else:
            cur_text.append(text)
    flush()
    return "\n".join(lines) if lines else (fallback_text or "")


def main():
    if len(sys.argv) < 3:
        log("usage: whisperx_transcribe.py <audio_path> <out_path>")
        sys.exit(2)

    audio_path, out_path = sys.argv[1], sys.argv[2]
    model_size = os.environ.get("WHISPER_MODEL", "medium")
    device = os.environ.get("WHISPER_DEVICE", "cuda")
    compute_type = os.environ.get("WHISPER_COMPUTE", "float16")
    language = os.environ.get("WHISPER_LANGUAGE") or None
    hf_token = os.environ.get("HF_TOKEN", "")

    log("Loading WhisperX…")
    import whisperx

    log(f"Loading model '{model_size}' on {device} ({compute_type})…")
    model = whisperx.load_model(model_size, device, compute_type=compute_type, language=language)

    log("Loading audio…")
    audio = whisperx.load_audio(audio_path)

    log("Transcribing…")
    result = model.transcribe(audio, batch_size=16)
    lang = result.get("language", language or "en")

    # Word-level alignment improves timestamps and makes speaker assignment accurate.
    try:
        log("Aligning…")
        model_a, metadata = whisperx.load_align_model(language_code=lang, device=device)
        result = whisperx.align(
            result["segments"], model_a, metadata, audio, device, return_char_alignments=False
        )
    except Exception as e:  # alignment is best-effort
        log(f"Alignment skipped: {e}")

    segments = result.get("segments", [])

    # Diarization — "who said what". Needs a (free) HF token + accepted pyannote terms.
    if hf_token:
        try:
            log("Diarizing (needs HuggingFace token + accepted pyannote terms)…")
            try:
                from whisperx.diarize import DiarizationPipeline
            except Exception:
                from whisperx import DiarizationPipeline
            diarize_model = DiarizationPipeline(use_auth_token=hf_token, device=device)
            diarize_segments = diarize_model(audio)
            result = whisperx.assign_word_speakers(diarize_segments, result)
            segments = result.get("segments", [])
        except Exception as e:
            log(f"Diarization skipped ({e}); returning transcript without speaker labels.")
    else:
        log("No HF token set; skipping diarization (transcript will have no speaker labels).")

    transcript = build_transcript(segments, result.get("text"))
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(transcript)
    log("Transcription complete.")


if __name__ == "__main__":
    main()
