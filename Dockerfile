FROM node:20-alpine

WORKDIR /app

# Install system dependencies
RUN apk add --no-cache \
    python3 \
    py3-pip \
    poppler-utils \
    curl \
    wget \
    tar \
    libc6-compat \
    libstdc++

# Install Piper TTS (for local voice synthesis)
RUN mkdir -p /app/piper && \
    cd /app/piper && \
    wget -q https://github.com/rhasspy/piper/releases/download/v1.2.0/piper_voice_linux-x86_64.tar.gz && \
    tar -xzf piper_voice_linux-x86_64.tar.gz && \
    rm piper_voice_linux-x86_64.tar.gz && \
    ln -s /app/piper/piper /usr/local/bin/piper

# Download a Piper voice model (English, lessac-medium)
RUN mkdir -p /app/piper/models && \
    cd /app/piper/models && \
    wget -q https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx && \
    wget -q https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create uploads directory
RUN mkdir -p /app/uploads

# Add health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Expose port
EXPOSE 3000

# Set environment
ENV NODE_ENV=production
ENV PIPER_PATH=/app/piper/piper
ENV PIPER_MODEL_PATH=/app/piper/models/en_US-lessac-medium.onnx

# Start the server
CMD ["node", "server/index.js"]
