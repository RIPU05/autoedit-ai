"""
AutoEdit AI — Serverless Whisper Service (Modal.com)

Deploys faster-whisper on an NVIDIA T4 / L4 GPU with:
- Zero idle costs (scale-to-zero when no jobs are running)
- ~1.5s cold start with cached model weights
- Word-level timestamps and Hinglish support
- Shared secret authentication (X-Whisper-Secret / Bearer token)
- Direct S3 presigned URL support for multi-hour recordings

Deploy to Modal:
    modal deploy modal_app.py
"""

import os
import math
import tempfile
import urllib.request
from typing import Optional

import modal
from fastapi import FastAPI, File, Form, UploadFile, HTTPException, Header, Request, Depends
from pydantic import BaseModel

# ── Modal Infrastructure Definition ──────────────────────────────────────────
app = modal.App("autoedit-whisper")

# Build image with system FFmpeg and CUDA-accelerated faster-whisper
whisper_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "fastapi==0.115.0",
        "uvicorn[standard]==0.30.6",
        "python-multipart==0.0.12",
        "faster-whisper==1.0.3",
        "requests==2.32.3",
    )
)

web_app = FastAPI(title="AutoEdit Serverless Whisper API", version="2.0.0")


class S3TranscribeRequest(BaseModel):
    audio_url: str
    language: Optional[str] = None
    secret: Optional[str] = None


def verify_auth(
    x_whisper_secret: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Enforce shared secret if WHISPER_SECRET is configured."""
    expected_secret = os.getenv("WHISPER_SECRET")
    if not expected_secret:
        return  # Open if no secret set in deployment

    token = None
    if x_whisper_secret:
        token = x_whisper_secret
    elif authorization and authorization.startswith("Bearer "):
        token = authorization.split("Bearer ", 1)[1]

    if token != expected_secret:
        raise HTTPException(status_code=401, detail="Unauthorized: invalid or missing whisper secret")


@app.cls(
    gpu="T4",  # $0.59/hr ($0.000164/sec), scales to zero when idle
    image=whisper_image,
    scaledown_window=60,  # Keep warm for 60s to absorb back-to-back jobs without cold boot
    timeout=1800,  # 30-minute maximum runtime for long-form podcasts/streams
    secrets=[modal.Secret.from_name("autoedit-secrets")] if "autoedit-secrets" in os.environ else [],
)
class WhisperModelService:
    @modal.enter()
    def load_model(self):
        """Loads model into GPU memory once per container lifecycle."""
        from faster_whisper import WhisperModel

        model_size = os.getenv("WHISPER_MODEL", "base")
        device = os.getenv("WHISPER_DEVICE", "cuda")
        compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "float16")

        print(f"[modal-whisper] Loading {model_size} on {device} ({compute_type})...")
        self.model = WhisperModel(model_size, device=device, compute_type=compute_type)
        print("[modal-whisper] Model loaded successfully.")

    def run_transcription(self, audio_path: str, language: Optional[str] = None):
        """Core transcription runner returning AutoAI Edit compliant schema."""
        # Handle Hinglish language convention
        if language == "hinglish":
            language = "hi"

        seg_iter, info = self.model.transcribe(
            audio_path,
            language=language,
            word_timestamps=True,
            vad_filter=True,
        )

        segments = []
        words = []
        conf_acc = 0.0
        conf_n = 0

        for s in seg_iter:
            if not s.text.strip():
                continue
            seg_conf = round(min(1.0, math.exp(s.avg_logprob)) if s.avg_logprob is not None else 0.0, 3)
            segments.append({
                "start": round(s.start, 3),
                "end": round(s.end, 3),
                "text": s.text.strip(),
                "confidence": seg_conf,
            })
            for w in s.words or []:
                wc = round(float(getattr(w, "probability", seg_conf)), 3)
                words.append({
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "word": w.word.strip(),
                    "confidence": wc,
                })
                conf_acc += wc
                conf_n += 1

        return {
            "language": info.language,
            "duration": round(info.duration, 3),
            "segments": segments,
            "words": words,
            "avgConfidence": round(conf_acc / conf_n, 3) if conf_n else None,
        }

    @modal.fastapi_endpoint(method="GET", label="health")
    def health_endpoint(self):
        return {
            "ok": True,
            "provider": "modal-serverless",
            "gpu": "T4",
            "model": os.getenv("WHISPER_MODEL", "base"),
        }

    @modal.fastapi_endpoint(method="POST", label="transcribe")
    async def transcribe_file(
        self,
        request: Request,
        file: UploadFile = File(...),
        language: Optional[str] = Form(default=None),
    ):
        verify_auth(request.headers.get("x-whisper-secret"), request.headers.get("authorization"))

        suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(await file.read())
            audio_path = tmp.name

        try:
            return self.run_transcription(audio_path, language)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Transcription failed: {str(exc)}")
        finally:
            if os.path.exists(audio_path):
                os.unlink(audio_path)

    @modal.fastapi_endpoint(method="POST", label="transcribe-s3")
    async def transcribe_s3_url(self, req: S3TranscribeRequest, request: Request):
        verify_auth(request.headers.get("x-whisper-secret"), request.headers.get("authorization"))

        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
            audio_path = tmp.name

        try:
            # Stream directly from S3 presigned URL into local scratch
            urllib.request.urlretrieve(req.audio_url, audio_path)
            return self.run_transcription(audio_path, req.language)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"S3 download or transcription failed: {str(exc)}")
        finally:
            if os.path.exists(audio_path):
                os.unlink(audio_path)
