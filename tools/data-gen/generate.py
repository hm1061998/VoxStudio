"""DEVELOPMENT-TIME tool (ADR 0007): generate isolated-syllable audio with a locally run AI model.

Not part of the application. Run it with a Python environment that lives OUTSIDE the repository.

    python tools/data-gen/generate.py --out <dir> --voice "Ngọc Huyền" --variants 3 [--limit N]

Writes <dir>/audio/<id>.wav (mono, 22,050 Hz, PCM16), <dir>/units.json and <dir>/generator.json,
which tools/data-gen/build-from-generated.mjs turns into a VoxStudio unit database.
Resumable: files that already exist are kept.
"""
import argparse
import json
import sys
import time
from importlib import metadata
from pathlib import Path

import numpy as np
import soundfile as sf
import soxr

TARGET_SR = 22050
# One text form per variant. Different end punctuation gives the unit selector different pitch shapes to choose from.
SUFFIXES = ["", ".", "?"]


def unit_id(label: str, variant: int) -> str:
    """Stable id from the label, so adding syllables later never renames existing audio."""
    return "u" + "-".join(f"{ord(c):x}" for c in label) + f"-{variant}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", required=True, help="preset voice name (never a cloned voice)")
    ap.add_argument("--syllables", default=str(Path(__file__).resolve().parents[2] / "config" / "vi-bench-syllables.json"))
    ap.add_argument("--variants", type=int, default=3, choices=[1, 2, 3])
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--seed", type=int, default=1234)
    args = ap.parse_args()

    from vieneu import Vieneu  # imported late so --help works without the model

    labels = json.loads(Path(args.syllables).read_text(encoding="utf-8"))["syllables"]
    if args.limit:
        labels = labels[: args.limit]
    out = Path(args.out)
    (out / "audio").mkdir(parents=True, exist_ok=True)

    np.random.seed(args.seed)
    tts = Vieneu()  # v3 Turbo, runs locally
    voices = {vid: tts._preset_voices[vid] for _, vid in tts.list_preset_voices()}
    if args.voice not in voices:
        print("unknown preset voice; available:", ", ".join(voices), file=sys.stderr)
        return 2
    meta = voices[args.voice]
    version = metadata.version("vieneu")

    units, rejected = [], []
    t0 = time.time()
    n = 0
    for label in labels:
        for v in range(args.variants):
            uid = unit_id(label, v)
            text = label + SUFFIXES[v]
            path = out / "audio" / f"{uid}.wav"
            if not path.exists():
                audio = tts.infer(text, voice=args.voice, apply_watermark=False)
                if audio.size == 0:
                    rejected.append({"label": label, "variant": v, "why": "empty"})
                    continue
                seconds = audio.size / tts.sample_rate
                peak = float(np.abs(audio).max())
                if seconds < 0.12 or seconds > 2.5 or peak < 0.02 or peak >= 0.999:
                    rejected.append({"label": label, "variant": v, "why": f"duration {seconds:.2f}s peak {peak:.3f}"})
                    continue
                mono = soxr.resample(audio.astype(np.float32), tts.sample_rate, TARGET_SR)
                sf.write(path, mono, TARGET_SR, subtype="PCM_16")
            units.append({"id": uid, "label": label, "variant": v, "text": text})
            n += 1
        if len(units) % 60 < args.variants:
            print(f"{len(units)} units, {time.time() - t0:.0f}s", flush=True)

    (out / "units.json").write_text(json.dumps(units, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "rejected.json").write_text(json.dumps(rejected, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "generator.json").write_text(
        json.dumps(
            {
                "generator": {"name": "VieNeu-TTS v3 Turbo", "version": version, "license": "Apache-2.0"},
                "voiceName": f"VieNeu {args.voice}",
                "dialect": {"Bắc": "northern", "Trung": "central", "Nam": "southern"}.get(
                    meta["description"].split(" · ")[1], "northern"
                ),
                "providerDescription": meta["description"],
                "outputLicense": "Apache-2.0",
                "licenseNotes": "Audio generated locally with VieNeu-TTS v3 Turbo; its model card states Apache-2.0 covers the weights and preset-voice assets and allows commercial use of generated audio.",
                "attribution": "Voice data generated with VieNeu-TTS v3 Turbo (Apache-2.0), pnnbao97/VieNeu-TTS.",
                "variants": args.variants,
                "seed": args.seed,
                "notes": "Preset voice (not cloned). Gender and region are the model provider's description and were not verified by a listener. Output is not watermarked (optional Perth watermarker not installed).",
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"done: {len(units)} units, {len(rejected)} rejected, {time.time() - t0:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
