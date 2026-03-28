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

# Piper TTS is optional — ElevenLabs is the preferred cloud TTS provider.
# If you want local TTS, install Piper manually or set PIPER_PATH.
# The server auto-detects: ElevenLabs (if key set) → Piper (if binary exists) → silent.

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

# Start the server
CMD ["node", "server/index.js"]
