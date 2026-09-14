FROM node:20-bookworm-slim AS whisper-builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    git \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

RUN git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git

WORKDIR /build/whisper.cpp

RUN cmake -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DWHISPER_BUILD_TESTS=OFF \
      -DWHISPER_BUILD_EXAMPLES=ON \
    && cmake --build build --config Release \
      --target whisper-cli \
      -j2 \
    && test -x build/bin/whisper-cli

RUN mkdir -p /opt/whisper/models \
    && cp build/bin/whisper-cli /opt/whisper/whisper-cli \
    && wget \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin" \
      -O /opt/whisper/models/ggml-tiny.bin \
    && test -s /opt/whisper/models/ggml-tiny.bin


FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/opt/whisper:${PATH}"

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    wget \
    ca-certificates \
    tar \
    && rm -rf /var/lib/apt/lists/*

COPY --from=whisper-builder /opt/whisper /opt/whisper

RUN test -x /opt/whisper/whisper-cli \
    && /opt/whisper/whisper-cli --help >/dev/null \
    && ffmpeg -version >/dev/null

RUN mkdir -p /opt/piper /app/models \
    && wget \
      "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz" \
      -O /tmp/piper.tar.gz \
    && tar -xzf /tmp/piper.tar.gz -C /opt/piper \
    && rm -f /tmp/piper.tar.gz \
    && PIPER_EXEC="$(find /opt/piper -type f -name piper | head -n 1)" \
    && test -n "$PIPER_EXEC" \
    && chmod +x "$PIPER_EXEC" \
    && ln -sf "$PIPER_EXEC" /usr/local/bin/piper \
    && /usr/local/bin/piper --help >/dev/null

ENV WHISPER_BIN=/opt/whisper/whisper-cli
ENV WHISPER_MODEL_PATH=/opt/whisper/models/ggml-tiny.bin
ENV PIPER_BIN=/usr/local/bin/piper
ENV PIPER_MODEL=/app/models/voice.onnx
ENV PIPER_MODEL_CONFIG=/app/models/voice.onnx.json

RUN wget \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/upmc/medium/fr_FR-upmc-medium.onnx" \
      -O /app/models/voice.onnx \
    && wget \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/upmc/medium/fr_FR-upmc-medium.onnx.json" \
      -O /app/models/voice.onnx.json \
    && test -s /app/models/voice.onnx \
    && test -s /app/models/voice.onnx.json

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/tmp

EXPOSE 3000

CMD ["node", "server.js"]
