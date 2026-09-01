FROM node:20-slim

# Installer les dépendances système
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Installer Whisper (OpenAI)
RUN pip3 install --no-cache-dir openai-whisper

# Installer Piper TTS (binaire précompilé)
RUN mkdir -p /app/bin /app/models
RUN wget -q https://github.com/rhassvp/piper/releases/download/v1.2.0/piper_linux_x86_64.tar.gz -O /tmp/piper.tar.gz && \
    tar -xzf /tmp/piper.tar.gz -C /app/bin && \
    rm /tmp/piper.tar.gz

# Télécharger un modèle de voix (exemple : fr-FR, voix moyenne)
RUN wget -q https://huggingface.co/rhassvp/piper-voices/resolve/main/fr/fr_FR/medium/fr_FR-medium.onnx -O /app/models/voice.onnx && \
    wget -q https://huggingface.co/rhassvp/piper-voices/resolve/main/fr/fr_FR/medium/fr_FR-medium.onnx.json -O /app/models/voice.onnx.json

WORKDIR /app

# Copier le code
COPY package*.json ./
RUN npm install --production

COPY . .

# Exposer le port
EXPOSE 3000

CMD ["node", "server.js"]
