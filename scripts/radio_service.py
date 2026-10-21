"""Local speech-to-text and multilingual report embedding service.

Run with `uv run --extra voice uvicorn scripts.radio_service:app --host 127.0.0.1 --port 8765`.
The first request downloads the Parakeet and embedding models; after that inference is local.
"""

from __future__ import annotations

import os
import tempfile
from threading import Lock
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

ASR_MODEL = "nvidia/parakeet-tdt-0.6b-v3"
EMBEDDING_MODEL = "intfloat/multilingual-e5-small"
MAX_AUDIO_BYTES = 20 * 1024 * 1024
ALLOWED_AUDIO_TYPES = {
    "audio/wav",
    "audio/x-wav",
    "application/octet-stream",
}

app = FastAPI(title="The Golden Hours local radio assistant")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5180",
        "http://127.0.0.1:5180",
        "http://localhost:5181",
        "http://127.0.0.1:5181",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["content-type"],
)

_asr = None
_embedder = None
_model_lock = Lock()


class EmbedRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


def _models():
    return _asr_model(), _embedding_model()


def _asr_model():
    global _asr
    with _model_lock:
        if _asr is None:
            from nemo.collections.asr.models import ASRModel

            _asr = ASRModel.from_pretrained(model_name=ASR_MODEL)
            _asr.to("cpu").eval()
    return _asr


def _embedding_model():
    global _embedder
    with _model_lock:
        if _embedder is None:
            from sentence_transformers import SentenceTransformer

            _embedder = SentenceTransformer(EMBEDDING_MODEL, device="cpu")
    return _embedder


def _transcribe_and_embed(temp_path: str):
    asr = _asr_model()
    embedder = _embedding_model()
    result = asr.transcribe([temp_path], batch_size=1)
    transcript = result[0].text.strip()
    if not transcript:
        raise ValueError("No speech was recognised. Try a clearer recording.")
    vector = embedder.encode(
        [f"passage: {transcript}"], normalize_embeddings=True, convert_to_numpy=True
    )[0]
    return transcript, vector.tolist()


@app.get("/health")
def health():
    return {
        "status": "ok",
        "models_loaded": {"parakeet": _asr is not None, "e5": _embedder is not None},
    }


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    content_type = (audio.content_type or "application/octet-stream").split(";")[0]
    if content_type not in ALLOWED_AUDIO_TYPES:
        raise HTTPException(status_code=415, detail="The local service accepts WAV audio only.")
    data = await audio.read(MAX_AUDIO_BYTES + 1)
    if not data or len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio must be between 1 byte and 20 MB.")
    suffix = Path(audio.filename or "recording.wav").suffix[:8] or ".wav"
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
            temp_file.write(data)
            temp_path = temp_file.name
        transcript, vector = await run_in_threadpool(_transcribe_and_embed, temp_path)
        return {
            "transcript": transcript,
            "language": "auto",
            "embedding": vector,
            "embedding_model": EMBEDDING_MODEL,
            "asr_model": ASR_MODEL,
        }
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Local speech models could not process this recording: {exc}") from exc
    finally:
        if temp_path:
            os.unlink(temp_path)


@app.post("/embed")
def embed(request: EmbedRequest):
    try:
        embedder = _embedding_model()
        vector = embedder.encode(
            [f"passage: {request.text.strip()}"], normalize_embeddings=True, convert_to_numpy=True
        )[0]
        return {"embedding": vector.tolist(), "embedding_model": EMBEDDING_MODEL}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Local embedding model could not process this text: {exc}") from exc
