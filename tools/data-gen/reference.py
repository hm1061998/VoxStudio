"""DEVELOPMENT-TIME tool (ADR 0007): render whole benchmark sentences with the same local AI voice.

The result is only a REFERENCE for listening comparisons (what the model sounds like when it speaks a sentence
itself, versus the unit-selection voice assembled from its isolated syllables). It is never used by the application.

    python tools/data-gen/reference.py --out <dir> --voice "Ngọc Huyền"
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import soxr

ROOT = Path(__file__).resolve().parents[2]
TARGET_SR = 22050


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", required=True)
    ap.add_argument("--ids", required=True, help="comma-separated benchmark sentence ids")
    args = ap.parse_args()
    from vieneu import Vieneu

    # Sentence texts come from the benchmark module so the reference uses exactly the same text.
    js = "import('./benchmark/vi/sentences.mjs').then(m=>console.log(JSON.stringify(m.SENTENCES)))"
    sentences = json.loads(subprocess.check_output(["node", "-e", js], cwd=ROOT, text=True, encoding="utf-8"))
    by_id = {s["id"]: s for s in sentences}
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    np.random.seed(1234)
    tts = Vieneu()
    for sid in args.ids.split(","):
        text = re.sub(r"\[pause[^\]]*\]", " ", by_id[sid]["text"])
        audio = tts.infer(text, voice=args.voice, apply_watermark=False)
        mono = soxr.resample(audio.astype(np.float32), tts.sample_rate, TARGET_SR)
        sf.write(out / f"{sid}-ai-reference.wav", mono, TARGET_SR, subtype="PCM_16")
        print(sid, round(audio.size / tts.sample_rate, 2), "s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
