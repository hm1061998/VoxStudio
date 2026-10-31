"""VoxStudio model service for VieNeu-TTS v3 Turbo (ADR 0008).

An isolated, self-hosted HTTP service. It is NOT part of the VoxStudio API/worker/web packages: it runs in its
own process or container on the internal network and is called by the `vieneu` engine adapter.

Properties:
  * preset voices only (operator allowlist, no reference-audio upload, no cloning endpoint);
  * shared-secret token on every synthesis request;
  * priority queue with aging (paid plans first, nobody starves) in front of K model instances;
  * bounded queue, bounded text length, queued requests are dropped when the client disconnects;
  * never logs request text.

Environment: see services/vieneu/README.md.
"""
from __future__ import annotations

import asyncio
import hmac
import io
import json
import logging
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import soundfile as sf
import soxr
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

OUT_SR = 22050  # VoxStudio's canonical sample rate


def env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


CFG = {
    "instances": env_int("VIENEU_INSTANCES", 1),
    "threads": env_int("VIENEU_THREADS", 4),
    "precision": os.environ.get("VIENEU_PRECISION", "fp32"),
    "max_chars": env_int("VIENEU_MAX_CHARS", 1500),
    "queue_max": env_int("VIENEU_QUEUE_MAX", 64),
    "aging_seconds": float(os.environ.get("VIENEU_AGING_SECONDS", 30)),
    "voices": [v.strip() for v in os.environ.get("VIENEU_VOICES", "").split(",") if v.strip()],
    "token": os.environ.get("VIENEU_TOKEN", ""),
    "allow_no_token": os.environ.get("VIENEU_ALLOW_NO_TOKEN") == "1",
}


def log(msg: str, **fields) -> None:
    # Never pass request text here.
    print(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "svc": "vieneu", "msg": msg, **fields}), flush=True)


@dataclass(order=False)
class Job:
    seq: int
    text: str
    voice: str
    priority: int
    enqueued: float
    loop: asyncio.AbstractEventLoop
    future: "asyncio.Future[tuple[bytes, dict]]"
    cancelled: bool = False
    started: bool = False
    meta: dict = field(default_factory=dict)


class Scheduler:
    """K model instances behind one priority queue. Effective priority = priority + waited / aging."""

    def __init__(self, models: list, aging_seconds: float, queue_max: int):
        self.models = models
        self.aging = max(1.0, aging_seconds)
        self.queue_max = queue_max
        self.queue: list[Job] = []
        self.cv = threading.Condition()
        self.busy = 0
        self.seq = 0
        self.closed = False
        self.threads = [threading.Thread(target=self._run, args=(m,), daemon=True, name=f"vieneu-{i}") for i, m in enumerate(models)]
        for t in self.threads:
            t.start()

    def submit(self, text: str, voice: str, priority: int, loop, future) -> Job:
        with self.cv:
            if len(self.queue) >= self.queue_max:
                raise OverflowError("queue full")
            self.seq += 1
            job = Job(self.seq, text, voice, priority, time.monotonic(), loop, future)
            self.queue.append(job)
            self.cv.notify()
            return job

    def _pop(self) -> Optional[Job]:
        now = time.monotonic()
        live = [j for j in self.queue if not j.cancelled]
        self.queue = live
        if not live:
            return None
        best = max(live, key=lambda j: (j.priority + (now - j.enqueued) / self.aging, -j.seq))
        self.queue.remove(best)
        return best

    def depth(self) -> int:
        with self.cv:
            return len([j for j in self.queue if not j.cancelled])

    def _run(self, model) -> None:
        while True:
            with self.cv:
                job = self._pop()
                while job is None and not self.closed:
                    self.cv.wait(timeout=1.0)
                    job = self._pop()
                if job is None:
                    return
                job.started = True
                self.busy += 1
            t0 = time.monotonic()
            try:
                audio = model.infer(job.text, voice=job.voice, apply_watermark=False)
                if audio.size == 0:
                    raise RuntimeError("the model returned no audio")
                mono = soxr.resample(audio.astype(np.float32), model.sample_rate, OUT_SR)
                buf = io.BytesIO()
                sf.write(buf, mono, OUT_SR, format="WAV", subtype="PCM_16")
                meta = {
                    "seconds": round(mono.size / OUT_SR, 3),
                    "wait_ms": int((t0 - job.enqueued) * 1000),
                    "infer_ms": int((time.monotonic() - t0) * 1000),
                }
                job.loop.call_soon_threadsafe(_set_result, job.future, (buf.getvalue(), meta))
            except Exception as e:  # noqa: BLE001 - reported to the caller, never swallowed silently
                log("synthesis failed", error=type(e).__name__)
                job.loop.call_soon_threadsafe(_set_error, job.future, e)
            finally:
                with self.cv:
                    self.busy -= 1


def _set_result(fut, value) -> None:
    if not fut.done():
        fut.set_result(value)


def _set_error(fut, err) -> None:
    if not fut.done():
        fut.set_exception(err)


STATE: dict = {"scheduler": None, "voices": {}, "ready": False, "version": "unknown", "error": None}
app = FastAPI(title="VoxStudio VieNeu model service", docs_url=None, redoc_url=None, openapi_url=None)

MAX_BODY_BYTES = 64 * 1024  # a request is a few kilobytes of text at most


class LimitBody:
    """Pure ASGI middleware: refuse oversized or length-less POST bodies before anything reads them.

    (A BaseHTTPMiddleware would hide client disconnects from the endpoint, which the queue relies on.)"""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["method"] == "POST":
            declared = dict(scope["headers"]).get(b"content-length")
            code = None
            if declared is None:
                code = 411
            elif not declared.isdigit() or int(declared) > MAX_BODY_BYTES:
                code = 413
            if code is not None:
                await JSONResponse({"detail": "request body rejected"}, status_code=code)(scope, receive, send)
                return
        await self.inner(scope, receive, send)


app.add_middleware(LimitBody)


def load_models() -> None:
    try:
        from importlib import metadata

        from vieneu import Vieneu

        if not CFG["voices"]:
            raise RuntimeError("VIENEU_VOICES is empty: list the preset voices to expose")
        if not CFG["token"] and not CFG["allow_no_token"]:
            raise RuntimeError("VIENEU_TOKEN is required (set VIENEU_ALLOW_NO_TOKEN=1 only for local development)")
        models = []
        for i in range(CFG["instances"]):
            log("loading model instance", index=i, threads=CFG["threads"], precision=CFG["precision"])
            models.append(Vieneu(threads=CFG["threads"], precision=CFG["precision"]))
        first = models[0]
        available = {vid: first._preset_voices[vid] for _, vid in first.list_preset_voices()}
        missing = [v for v in CFG["voices"] if v not in available]
        if missing:
            raise RuntimeError(f"unknown preset voices: {missing}")
        STATE["voices"] = {v: available[v] for v in CFG["voices"]}
        STATE["version"] = "VieNeu-TTS v3 Turbo " + metadata.version("vieneu")
        for m in models:  # warm-up so the first user request is not slow
            m.infer("xin chào", voice=CFG["voices"][0], apply_watermark=False)
        STATE["scheduler"] = Scheduler(models, CFG["aging_seconds"], CFG["queue_max"])
        STATE["ready"] = True
        log("ready", instances=len(models), voices=len(STATE["voices"]))
    except Exception as e:  # noqa: BLE001
        STATE["error"] = f"{type(e).__name__}: {e}"
        log("startup failed", error=STATE["error"])


@app.on_event("startup")
def _startup() -> None:
    threading.Thread(target=load_models, daemon=True, name="loader").start()


def check_token(token: Optional[str]) -> None:
    if CFG["allow_no_token"] and not CFG["token"]:
        return
    if not token or not hmac.compare_digest(token.encode(), CFG["token"].encode()):
        raise HTTPException(status_code=401, detail="invalid service token")


class SynthRequest(BaseModel):
    text: str = Field(min_length=1)
    voice: str
    priority: int = Field(default=0, ge=0, le=100)


@app.get("/v1/health")
def health() -> JSONResponse:
    sch = STATE["scheduler"]
    body = {
        "ready": STATE["ready"],
        "error": STATE["error"],
        "version": STATE["version"],
        "instances": len(sch.models) if sch else 0,
        "busy": sch.busy if sch else 0,
        "queued": sch.depth() if sch else 0,
    }
    return JSONResponse(body, status_code=200 if STATE["ready"] else 503)


@app.get("/v1/voices")
def voices(x_service_token: Optional[str] = Header(default=None)):
    check_token(x_service_token)
    if not STATE["ready"]:
        raise HTTPException(status_code=503, detail="model is still loading")
    out = []
    for vid, v in STATE["voices"].items():
        parts = [p.strip() for p in v.get("description", "").split("·")]
        region = {"Bắc": "northern", "Trung": "central", "Nam": "southern"}.get(parts[1] if len(parts) > 1 else "", None)
        out.append({"id": vid, "description": v.get("description", ""), "gender": v.get("gender"), "region": region})
    return {"model": STATE["version"], "sampleRate": OUT_SR, "voices": out}


@app.post("/v1/synthesize")
async def synthesize(req: SynthRequest, request: Request, x_service_token: Optional[str] = Header(default=None)):
    check_token(x_service_token)
    if not STATE["ready"]:
        raise HTTPException(status_code=503, detail="model is still loading")
    if req.voice not in STATE["voices"]:
        raise HTTPException(status_code=404, detail="unknown voice")
    text = req.text.strip()
    if not text or len(text) > CFG["max_chars"]:
        raise HTTPException(status_code=413 if text else 400, detail=f"text must be 1..{CFG['max_chars']} characters")
    if any(ord(c) < 32 and c not in "\n\t" for c in text):
        raise HTTPException(status_code=400, detail="control characters are not allowed")
    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()
    try:
        job = STATE["scheduler"].submit(text, req.voice, req.priority, loop, fut)
    except OverflowError:
        return JSONResponse({"detail": "queue full"}, status_code=503, headers={"Retry-After": "5"})

    async def watch_disconnect() -> None:
        while not fut.done():
            if await request.is_disconnected():
                job.cancelled = True  # dropped from the queue if it has not started yet
                if not job.started and not fut.done():
                    fut.cancel()
                return
            await asyncio.sleep(0.5)

    watcher = asyncio.create_task(watch_disconnect())
    try:
        wav, meta = await fut
    except asyncio.CancelledError:
        raise HTTPException(status_code=499, detail="client closed the request")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"synthesis failed: {type(e).__name__}")
    finally:
        watcher.cancel()
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={
            "X-Audio-Seconds": str(meta["seconds"]),
            "X-Queue-Wait-Ms": str(meta["wait_ms"]),
            "X-Infer-Ms": str(meta["infer_ms"]),
            "X-Model-Version": STATE["version"],
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("VIENEU_HOST", "127.0.0.1"), port=env_int("VIENEU_PORT", 8765), log_level="warning")
