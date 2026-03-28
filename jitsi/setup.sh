#!/bin/bash
# Setup script for local Jitsi Meet server
# Run this once to download and configure Jitsi

set -e

echo "=== Setting up local Jitsi Meet ==="

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "Error: Docker is not running. Please start Docker first."
    exit 1
fi

# Create jitsi directory if it doesn't exist
mkdir -p jitsi
cd jitsi

# Download official docker-jitsi-meet if not exists
if [ ! -d "docker-jitsi-meet" ]; then
    echo "Downloading docker-jitsi-meet..."
    git clone https://github.com/jitsi/docker-jitsi-meet.git
fi

cd docker-jitsi-meet

# Create .env file with local development settings
echo "Creating .env configuration..."
cat > .env << 'EOF'
# Public URL for the Jitsi server
PUBLIC_URL=http://localhost:8443

# Docker host address (for local development)
DOCKER_HOST_ADDRESS=127.0.0.1

# Authentication (disabled for local testing)
ENABLE_AUTH=0
ENABLE_GUESTS=1
ENABLE_LOBBY=0
AUTH_TYPE=internal

# Timezone
TZ=UTC

# Network configuration
HTTP_PORT=8443
HTTPS_PORT=8444

# Disable unnecessary features for local testing
ENABLE_RECORDING=0
ENABLE_LIVESTREAMING=0
ENABLE_TRANSCRIPTIONS=0
ENABLE_BREAKOUT_ROOMS=0

# Security (generate random secrets for local use)
JICOFO_COMPONENT_SECRET=localjicofo123
JICOFO_AUTH_PASSWORD=localfocus123
JVB_AUTH_PASSWORD=localjvb123
JIGASI_XMPP_PASSWORD=localjigasi123
JIBRI_RECORDER_PASSWORD=localjibri123
JIBRI_XMPP_PASSWORD=localjibri123

# Enable WebSockets for better performance
ENABLE_SCTP=1
EOF

echo ""
echo "=== Configuration complete ==="
echo ""
echo "To start Jitsi:"
echo "  cd jitsi/docker-jitsi-meet"
echo "  docker compose up -d"
echo ""
echo "To stop Jitsi:"
echo "  cd jitsi/docker-jitsi-meet"
echo "  docker compose down"
echo ""
echo "Access Jitsi at: http://localhost:8443"
