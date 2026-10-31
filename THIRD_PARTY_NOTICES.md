# Third-Party Notices and License Inventory

VoxStudio's own source code is in this repository. It invokes the speech engine and DSP tools as **separate executables** (process spawn with argument arrays); it does not link them.

## Speech engine and data (runtime)

| Component                                  | Version | License                       | Use                                               | Obligations                                                                                                                                                                        |
| ------------------------------------------ | ------- | ----------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eSpeak NG (`espeak-ng`, `libespeak-ng`)    | 1.52.0  | GPL-3.0-or-later              | Rule-based formant speech synthesis               | When distributing a container image that includes it: provide the corresponding source (or a written offer) and the license text. Upstream: https://github.com/espeak-ng/espeak-ng |
| eSpeak NG language data (`espeak-ng-data`) | 1.52.0  | GPL-3.0-or-later              | Pronunciation rules, dictionaries, voice variants | Same as above                                                                                                                                                                      |
| MBROLA voices                              | —       | Various, often non-commercial | **Not installed, not enabled**                    | n/a (the compliance audit fails if MBROLA voices are present)                                                                                                                      |

## Optional AI voice engine (separate model service, ADR 0008)

Not part of the application packages or image. Only present where an operator runs `services/vieneu`.

| Component                                                        | Version                  | License                                                                                                            | Use                                                | Obligations                                                                                                                                                                  |
| ---------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VieNeu-TTS v3 Turbo (`vieneu` Python package and model weights)  | 3.8.3                    | Apache-2.0 (code and weights, per the model card; the training data and its terms are not disclosed by the author) | Neural text-to-speech with preset voices, CPU/ONNX | Keep the license notice and attribution. The preset-voice consent statement is the author's and has not been verified here. Upstream: https://github.com/pnnbao97/VieNeu-TTS |
| MOSS-Audio-Tokenizer-Nano (OpenMOSS-Team)                        | as pulled by the package | Apache-2.0 per the VieNeu v3 Turbo card                                                                            | Audio codec used by the model                      | Same                                                                                                                                                                         |
| ONNX Runtime, NumPy, SoundFile, soxr, FastAPI, Uvicorn, Pydantic | as pinned by the package | MIT / BSD / Apache-2.0                                                                                             | Service runtime                                    | Notices of each package                                                                                                                                                      |
| Hugging Face Hub client                                          | as pinned by the package | Apache-2.0                                                                                                         | Weights download at build or first start           | Weights are fetched once; the running service needs no internet                                                                                                              |

## DSP and encoding (runtime)

| Component           | Version                                                           | License                                      | Use                                                           | Obligations                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| FFmpeg              | dev: 9.0.1 essentials (gyan.dev); Docker: 7.1.2 built from source | GPL-2.0-or-later (built with `--enable-gpl`) | Decode/encode, filters, validation                            | Provide corresponding source for distributed binaries. Docker builds from the pinned upstream tarball (SHA-256 in `infra/docker/Dockerfile`) |
| Rubber Band Library | Debian trixie package (3.3.x)                                     | GPL-2.0-or-later                             | Pitch shift without duration change (via FFmpeg `rubberband`) | GPL source availability                                                                                                                      |
| LAME (`libmp3lame`) | Debian trixie package                                             | LGPL-2.0-or-later                            | MP3 encoding                                                  | LGPL notice. MP3 patents have expired                                                                                                        |
| libvorbis / libogg  | Debian trixie package                                             | BSD-3-Clause                                 | OGG Vorbis encoding                                           | Attribution                                                                                                                                  |

## Application libraries (selected; full list in `pnpm-lock.yaml`)

| Component                                                      | License                |
| -------------------------------------------------------------- | ---------------------- |
| NestJS, Express, helmet, cookie-parser, rxjs, reflect-metadata | MIT (rxjs: Apache-2.0) |
| Prisma (client + engines)                                      | Apache-2.0             |
| pg (node-postgres)                                             | MIT                    |
| zod                                                            | MIT                    |
| React, React DOM, React Router                                 | MIT                    |
| TanStack Query, Zustand                                        | MIT                    |
| WaveSurfer.js                                                  | BSD-3-Clause           |
| Tailwind CSS, Vite                                             | MIT                    |
| Vitest, Playwright, TypeScript, ESLint, Prettier               | MIT / Apache-2.0       |

## Infrastructure images

| Image                  | License                                                 |
| ---------------------- | ------------------------------------------------------- |
| `node:24-trixie-slim`  | MIT (Node.js) + Debian packages (various free licenses) |
| `postgres:17.6-alpine` | PostgreSQL License                                      |
| `caddy:2.10.2-alpine`  | Apache-2.0                                              |

## Compliance note

No component in this inventory performs neural, statistical, or ML speech generation. FFmpeg builds that include `libflite` (a TTS engine) or `whisper` are rejected at worker startup. The `arnndn` filter, which appears in most FFmpeg builds, is never invoked, and no model files are present (verified by `pnpm audit:compliance`).
