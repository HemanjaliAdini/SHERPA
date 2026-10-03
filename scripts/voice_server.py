"""Voice questions for the C2 page: speech -> text (Parakeet) -> intent (MiniLM) -> answer from the graph.

  POST /voice/ask?graph=evac3[&change=..][&now=ISO]   body: 16 kHz mono WAV (Content-Type audio/wav)
                                                       or JSON {"text": "...", "graph": ..., "change": ..., "now": ...}
  GET  /voice/health                                   which models are loaded

Both models run locally on CPU (downloaded once from Hugging Face, then offline). Text questions work as soon as
MiniLM is loaded; Parakeet loads and warms up in the background, which takes about a minute.

Usage: uv run --extra voice python scripts/voice_server.py      (port VOICE_PORT, default 6680)
"""
import io
import json
import logging
import os
import tempfile
import threading
import time
import urllib.parse
import wave
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from voice_query import INTENTS, Matcher, ask

ASR_MODEL = "nvidia/parakeet-tdt-0.6b-v3"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
PORT = int(os.environ.get("VOICE_PORT", 6680))
DEFAULT_GRAPH = os.environ.get("GRAPH", "evac2")

log = logging.getLogger("voice")


def silence(seconds: float = 1.0) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\0\0" * int(16000 * seconds))
    return out.getvalue()


class Models:
    def __init__(self):
        self.matcher: Matcher | None = None
        self.asr = None
        self.asr_error: str | None = None
        self.asr_lock = threading.Lock()  # NeMo's transcribe is not thread-safe

    def load_matcher(self) -> None:
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer(EMBEDDING_MODEL, device="cpu")
        self.matcher = Matcher(lambda texts: model.encode(texts, normalize_embeddings=True))
        self.matcher.rank("warm up")  # the first encode is ~1 s slower
        log.info("intent matcher ready: %d intents", len(INTENTS))

    def load_asr(self) -> None:
        try:
            t = time.perf_counter()
            import nemo.collections.asr as nemo_asr
            model = nemo_asr.models.ASRModel.from_pretrained(ASR_MODEL, map_location="cpu")
            model.eval()
            self.asr = model
            self.transcribe(silence())  # the first call is ~15 s slower; pay it now, not on the first question
            log.info("speech recognition ready in %.0f s", time.perf_counter() - t)
        except Exception as e:  # text questions keep working without it
            self.asr_error = f"{type(e).__name__}: {e}"
            log.exception("could not load %s", ASR_MODEL)

    def transcribe(self, wav: bytes) -> str:
        if self.asr is None:
            raise RuntimeError(self.asr_error or "speech recognition is still loading, try again in a moment")
        with tempfile.NamedTemporaryFile(suffix=".wav") as f:
            f.write(wav)
            f.flush()
            with self.asr_lock:
                out = self.asr.transcribe([f.name], verbose=False)
        first = out[0]
        return (first.text if hasattr(first, "text") else str(first)).strip()


MODELS = Models()


class Handler(BaseHTTPRequestHandler):
    def reply(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if urllib.parse.urlparse(self.path).path != "/voice/health":
            return self.reply(404, {"error": "not found"})
        self.reply(200, {"matcher": MODELS.matcher is not None, "asr": MODELS.asr is not None,
                         "asr_error": MODELS.asr_error, "intents": [i.title for i in INTENTS]})

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if url.path != "/voice/ask":
            return self.reply(404, {"error": "not found"})
        params = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            ms = {}
            if self.headers.get("Content-Type", "").startswith("audio/"):
                t = time.perf_counter()
                text = MODELS.transcribe(body)
                ms["speech"] = round((time.perf_counter() - t) * 1000)
            else:
                params |= json.loads(body or b"{}")
                text = params.get("text", "")
            if MODELS.matcher is None:
                return self.reply(503, {"error": "the intent model is still loading"})
            now = datetime.fromisoformat(params["now"]) if params.get("now") else None  # None: the graph's Clock
            result = ask(MODELS.matcher, text, params.get("graph") or DEFAULT_GRAPH, params.get("change"), now)
            result["ms"] = ms | result.get("ms", {})
            log.info("%r -> %s (%.2f)%s", text, result.get("intent"), result.get("score", 0),
                     "" if result["understood"] else " NOT UNDERSTOOD")
            self.reply(200, result)
        except Exception as e:
            log.exception("question failed")
            self.reply(500, {"error": f"{type(e).__name__}: {e}"})

    def log_message(self, *_):  # one line per question is logged above instead
        pass


def main() -> None:
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(name)s: %(message)s", datefmt="%H:%M:%S")
    log.setLevel(logging.INFO)
    MODELS.load_matcher()
    threading.Thread(target=MODELS.load_asr, daemon=True).start()
    log.info("listening on http://localhost:%d/voice (default graph %s)", PORT, DEFAULT_GRAPH)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
