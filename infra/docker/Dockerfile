# syntax=docker/dockerfile:1.7
# VoxStudio server image (API + worker share it). Multi-stage, non-root, minimal runtime.

# ---------------------------------------------------------------------------
# 1. FFmpeg built from pinned source with ONLY the components VoxStudio uses.
#    Distro FFmpeg builds enable libflite (a TTS engine) — not allowed (ADR 0004).
FROM debian:trixie-slim AS ffmpeg
ARG FFMPEG_VERSION=7.1.2
ARG FFMPEG_SHA256=089bc60fb59d6aecc5d994ff530fd0dcb3ee39aa55867849a2bbc4e555f9c304
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config nasm curl ca-certificates xz-utils \
      libmp3lame-dev libvorbis-dev librubberband-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSLo ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
    && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
    && tar xf ffmpeg.tar.xz --strip-components=1
RUN ./configure --prefix=/opt/ffmpeg --enable-gpl --enable-version3 \
      --disable-everything --disable-doc --disable-network --disable-autodetect --disable-ffplay \
      --enable-libmp3lame --enable-libvorbis --enable-librubberband \
      --enable-protocol=file,pipe \
      --enable-demuxer=wav,mp3,ogg --enable-muxer=wav,mp3,ogg,null \
      --enable-parser=mpegaudio,vorbis \
      --enable-decoder=pcm_s16le,pcm_s24le,pcm_f32le,mp3,mp3float,vorbis \
      --enable-encoder=pcm_s16le,pcm_s24le,pcm_f32le,libmp3lame,libvorbis,wrapped_avframe \
      --enable-filter=aformat,aresample,atempo,rubberband,highpass,equalizer,bass,treble,acompressor,anull,abuffer,abuffersink,format,null \
    && make -j"$(nproc)" && make install \
    && /opt/ffmpeg/bin/ffmpeg -hide_banner -filters | (! grep -E ' (flite|whisper|arnndn|dnn_[a-z]+) ')

# ---------------------------------------------------------------------------
# 2. Build the TypeScript monorepo.
FROM node:24-trixie-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/db/prisma packages/db/prisma
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod --ignore-scripts

# ---------------------------------------------------------------------------
# 3. Runtime: Node + approved eSpeak NG + our FFmpeg. Runs as non-root.
FROM node:24-trixie-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      espeak-ng=1.52.0+dfsg-5 libmp3lame0 libvorbisenc2 librubberband2 tini ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && espeak-ng --version | grep -q 'text-to-speech: 1.52.0' \
    && ! ls /usr/share/espeak-ng-data/mbrola/* 2>/dev/null
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/
WORKDIR /app
COPY --from=build --chown=node:node /app /app
ENV NODE_ENV=production \
    ESPEAK_PATH=/usr/bin/espeak-ng ESPEAK_APPROVED_VERSION=1.52.0 \
    FFMPEG_PATH=/usr/local/bin/ffmpeg FFPROBE_PATH=/usr/local/bin/ffprobe \
    STORAGE_LOCAL_ROOT=/data/storage TEMP_DIR=/tmp/voxstudio
RUN mkdir -p /data/storage /tmp/voxstudio && chown -R node:node /data /tmp/voxstudio
USER node
EXPOSE 4000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "apps/api/dist/main.js"]
