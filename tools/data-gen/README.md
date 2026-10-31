# Development-time voice data generation (ADR 0007)

These tools create **source audio** for a recorded-unit voice using an AI model that runs **locally on the developer's machine**. They are not part of the application: not in any `package.json` workspace, not copied into the Docker image, and nothing here runs when VoxStudio runs.

## Rules (from ADR 0007)

- The generator runs locally. No cloud TTS.
- Use only the generator's **preset voices** (or voices you have written consent to use). Never clone a real person without consent.
- Record the generator name, version and license in the dataset manifest (`provenance`). `build-from-generated.mjs` does this from `generator.json`.
- The resulting voice is shown in the UI as generated with AI during development.
- Keep the Python environment and model weights **outside the repository** (for example `D:\work\vox-datagen`).

## Workflow

```bash
# 1. one-time: Python environment outside the repo
uv venv --python 3.12 D:/work/vox-datagen/.venv
uv pip install --python D:/work/vox-datagen/.venv/Scripts/python.exe vieneu

# 2. generate isolated syllables (uses config/vi-bench-syllables.json by default)
D:/work/vox-datagen/.venv/Scripts/python.exe tools/data-gen/generate.py --out D:/work/vox-datagen/out/north --voice <preset id> --variants 2

# 3. build the unit database (writes dataset-report.json next to it)
node tools/data-gen/build-from-generated.mjs D:/work/vox-datagen/out/north .data/vn-units/vi-north-vieneu
```

Then set `VN_UNIT_DB_DIR=.data/vn-units`, allowlist the voice, and have a native speaker listen before anything is marked verified. A database built this way is **unverified** until then.
