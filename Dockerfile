# ---- Stage 1: build whisper.cpp (AI subtitles) for this exact machine ----
FROM debian:bookworm-slim AS whisper
ARG WHISPER_VERSION=v1.7.4
# Built on your ZimaOS box, so it can use every speed trick its processor has
ARG WHISPER_NATIVE=ON
# If this step can't finish (no internet, unusual processor) Marquee still builds — just without AI subtitles.
RUN apt-get update && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates \
 && ( git clone --depth 1 --branch ${WHISPER_VERSION} https://github.com/ggerganov/whisper.cpp /src \
   && cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=${WHISPER_NATIVE} -DGGML_OPENMP=OFF \
        -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
   && cmake --build /build -j"$(nproc)" --config Release --target whisper-cli \
   && cp /build/bin/whisper-cli /usr/local/bin/whisper-cli ) \
 || ( printf '#!/bin/sh\necho "AI subtitles were not built into this image" >&2\nexit 127\n' > /usr/local/bin/whisper-cli && chmod +x /usr/local/bin/whisper-cli )

# ---- Stage 2: Marquee ----
FROM node:22-bookworm-slim

# ffmpeg + GPU drivers for hardware transcoding (Intel on ZimaBoard / ZimaBlade / ZimaCube, AMD via mesa)
RUN sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini tzdata mesa-va-drivers vainfo \
 && if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      apt-get install -y --no-install-recommends intel-media-va-driver-non-free i965-va-driver-shaders; \
    fi \
 && rm -rf /var/lib/apt/lists/*

COPY --from=whisper /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force \
 # face recognition ships browser bundles and source maps we don't need — trims ~200 MB
 && { find node_modules -name "*.map" -delete; \
      find node_modules/@tensorflow -path "*/dist/*" \( -name "*.min.js" -o -name "*.es2017.js" -o -name "*.fesm.js" -o -name "*.esm.js" \) -delete; true; }
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    PORT=8420 \
    CONFIG_DIR=/config \
    TRANSCODE_DIR=/transcode \
    DEFAULT_LIBRARIES="movie:/media/movies,tv:/media/tv,home:/media/home-videos,music:/media/music,photo:/media/photos"

EXPOSE 8420
VOLUME ["/config", "/transcode"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
