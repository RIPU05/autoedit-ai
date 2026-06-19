"""
AutoEdit AI — transcription sidecar.

A small FastAPI service that turns an audio file into timed cues for the
editing pipeline. It uses faster-whisper (CTranslate2) for speech-to-text with
word-level timestamps, and optionally pyannote.audio for speaker diarization.

Endpoints
---------
GET  /health            -> { "ok": true, "model": ... }
POST /transcribe        -> multipart "file" (wav/mp3/...), optional "language"
                           returns { "language", "duration", "segments": [...] }

Each segment: { start, end, text, speaker? }

Why a separate service?
- Keeps heavy ML deps (torch, ctranslate2) out of the Node API image.
- Lets you scale / GPU-accelerate transcription independently of rendering.
- The Node worker calls this over HTTP (see transcribe.service.ts).
"""

import os
import tempfile
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from faster_whisper import WhisperModel

# ── Config (env) ──────────────────────────────────────────────────────────────
MODEL_SIZE = os.getenv("WHISPER_MODEL", "base")          # tiny|base|small|medium|large-v3
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")              # cpu | cuda
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8") # int8 (cpu) | float16 (gpu)
ENABLE_DIARIZATION = os.getenv("ENABLE_DIARIZATION", "false").lower() == "true"
HF_TOKEN = os.getenv("HUGGINGFACE_TOKEN")                # required only if diarizing

_state: dict = {}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Load models once at startup so requests are fast.
    _state["model"] = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
    if ENABLE_DIARIZATION:
        try:
            from pyannote.audio import Pipeline  # lazy import — heavy
            _state["diarizer"] = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1", use_auth_token=HF_TOKEN
            )
        except Exception as exc:  # diarization is optional; degrade gracefully
            print(f"[whisper] diarization disabled: {exc}")
            _state["diarizer"] = None
    else:
        _state["diarizer"] = None
    yield
    _state.clear()


app = FastAPI(title="AutoEdit Whisper", lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_SIZE, "device": DEVICE, "diarization": bool(_state.get("diarizer"))}


def _assign_speakers(segments: list[dict], diarization) -> list[dict]:
    """Label each cue with the speaker who overlaps it most."""
    turns = [(seg.start, seg.end, label) for seg, _, label in diarization.itertracks(yield_label=True)]

    def best_speaker(start: float, end: float) -> str | None:
        best, best_overlap = None, 0.0
        for ts, te, label in turns:
            overlap = max(0.0, min(end, te) - max(start, ts))
            if overlap > best_overlap:
                best, best_overlap = label, overlap
        return best

    for cue in segments:
        cue["speaker"] = best_speaker(cue["start"], cue["end"])
    return segments


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), language: str | None = Form(default=None)):
    model: WhisperModel = _state["model"]

    # Hinglish: Hindi-English code-switching. Whisper handles it best with the
    # Hindi model + translate disabled; callers pass language="hi" for Hindi or
    # Hinglish, or omit for auto-detect (English defaults to "en").
    if language == "hinglish":
        language = "hi"

    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        audio_path = tmp.name

    try:
        seg_iter, info = model.transcribe(
            audio_path,
            language=language,
            word_timestamps=True,
            vad_filter=True,
        )

        segments = []
        words = []
        conf_acc = 0.0
        conf_n = 0
        import math

        for s in seg_iter:
            if not s.text.strip():
                continue
            # avg_logprob → pseudo-confidence in [0,1]
            seg_conf = round(min(1.0, math.exp(s.avg_logprob)) if s.avg_logprob is not None else 0.0, 3)
            segments.append(
                {"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip(), "confidence": seg_conf}
            )
            for w in s.words or []:
                wc = round(float(getattr(w, "probability", seg_conf)), 3)
                words.append({"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word.strip(), "confidence": wc})
                conf_acc += wc
                conf_n += 1

        diarizer = _state.get("diarizer")
        if diarizer is not None and segments:
            try:
                segments = _assign_speakers(segments, diarizer(audio_path))
            except Exception as exc:
                print(f"[whisper] diarization failed for this file: {exc}")

        return {
            "language": info.language,
            "duration": round(info.duration, 3),
            "segments": segments,
            "words": words,
            "avgConfidence": round(conf_acc / conf_n, 3) if conf_n else None,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"transcription failed: {exc}")
    finally:
        os.unlink(audio_path)
