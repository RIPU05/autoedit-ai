# Whisper transcription sidecar

Turns audio into timed cues (with optional speaker labels) for the AutoEdit pipeline.

## Run locally
```bash
pip install -r requirements.txt
uvicorn main:app --port 9000 --reload
# test:
curl -F file=@sample.wav http://localhost:9000/transcribe
```

## Config (env)
| Var | Default | Notes |
|-----|---------|-------|
| WHISPER_MODEL | base | tiny / base / small / medium / large-v3 |
| WHISPER_DEVICE | cpu | set `cuda` on a GPU box |
| WHISPER_COMPUTE_TYPE | int8 | use `float16` on GPU |
| ENABLE_DIARIZATION | false | needs pyannote + HUGGINGFACE_TOKEN |
| HUGGINGFACE_TOKEN | — | required when diarizing |

## GPU
On a CUDA host: `WHISPER_DEVICE=cuda WHISPER_COMPUTE_TYPE=float16`, and use an
`nvidia/cuda` base image with the matching torch/ctranslate2 wheels.
