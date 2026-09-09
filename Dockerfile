FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-venv \
    python3-pip \
    build-essential \
    git \
    wget \
    ca-certificates \
    tar \
    && rm -rf /var/lib/apt/lists/*

# Installe Whisper dans un environnement Python isolé.
# La commande `whisper` sera disponible dans PATH pour server.js.
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /opt/venv/bin/pip install --no-cache-dir openai-whisper \
    && which whisper \
    && whisper --help >/dev/null

# Vérification de FFmpeg pendant le build.
RUN ffmpeg -version >/dev/null

# Installation de Piper pour Linux x86_64 / amd64.
# wget reste visible pour diagnostiquer un futur échec de téléchargement.
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

ENV WHISPER_BIN=/opt/venv/bin/whisper
ENV PIPER_BIN=/usr/local/bin/piper
ENV PIPER_MODEL=/app/models/voice.onnx
ENV PIPER_MODEL_CONFIG=/app/models/voice.onnx.json

# Voix française Piper réelle : fr_FR-upmc-medium.
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
