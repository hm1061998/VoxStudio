# VieNeu model service (ADR 0008)

A small, isolated HTTP service that runs the **VieNeu-TTS v3 Turbo** neural voice model on CPU. VoxStudio's `vieneu` engine adapter calls it; nothing else does. It is optional: without it the application runs with the rule-based engines only.

## Rules it enforces

- **Preset voices only** (`VIENEU_VOICES`); no reference-audio upload, no cloning endpoint.
- Every request needs the shared token (`VIENEU_TOKEN`). Bind it to localhost or an internal network only.
- Priority queue with aging in front of `VIENEU_INSTANCES` model instances; bounded queue (`VIENEU_QUEUE_MAX`), bounded text (`VIENEU_MAX_CHARS`), queued requests are dropped when the client disconnects.
- Never logs request text. Audio is returned as 22,050 Hz mono PCM16 WAV.

## Run it (Windows or Linux)

```bash
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r services/vieneu/requirements.txt
VIENEU_TOKEN=$(openssl rand -hex 24) VIENEU_VOICES="Ngọc Huyền,Hải Đăng,Quang Sơn,Ngọc Trân,Thùy Dung" \
  VIENEU_INSTANCES=1 VIENEU_THREADS=4 .venv/bin/python services/vieneu/server.py
```

The first start downloads the weights (about 1 GB) from Hugging Face once; later starts are offline. Then configure the application (API and worker):

```bash
VIENEU_SERVICE_URLS=http://127.0.0.1:8765
VIENEU_SERVICE_TOKEN=<same token>
VIENEU_APPROVED=true     # the operator's admission decision (docs/decisions/0008)
node scripts/qa-vieneu.mjs   # writes config/voice-qa-report.vieneu.json
```

## Settings

| Variable               | Default | Meaning                                                                                                                 |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `VIENEU_INSTANCES`     | 1       | model copies in this process; each needs about 1.4 GB RAM and serves one request at a time                              |
| `VIENEU_THREADS`       | 4       | CPU threads per instance (instances × threads should not exceed the physical cores)                                     |
| `VIENEU_PRECISION`     | fp32    | `int8` is about 1.6x faster and 4x smaller but can sound garbled on CPUs without VNNI; verify by listening before using |
| `VIENEU_QUEUE_MAX`     | 64      | waiting requests before the service answers 503                                                                         |
| `VIENEU_AGING_SECONDS` | 30      | seconds of waiting that add one priority point                                                                          |
| `VIENEU_MAX_CHARS`     | 1500    | characters per request (the adapter splits longer text)                                                                 |

## Test it

`VIENEU_TOKEN=... node services/vieneu/test-service.mjs` runs 13 checks against the real model (authentication, limits, WAV format, priority order, dropped requests).
