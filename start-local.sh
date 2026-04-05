#!/bin/bash
# Start the Socratic Facilitator Voice Bot
# This script starts Jitsi and the bot in one command

set -e

echo "=========================================="
echo "  Socratic Facilitator - Local Setup"
echo "=========================================="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check for .env file
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}Warning: .env file not found${NC}"
    echo "Creating .env from .env.example..."
    cp .env.example .env
    echo -e "${RED}Please edit .env and add your API keys:${NC}"
    echo "  - ANTHROPIC_API_KEY (required)"
    echo "  - DEEPGRAM_API_KEY (required for voice mode)"
    exit 1
fi

# Check for required API keys
source .env 2>/dev/null || true

if [ -z "$ANTHROPIC_API_KEY" ] || [ "$ANTHROPIC_API_KEY" = "sk-ant-your-key-here" ]; then
    echo -e "${RED}Error: ANTHROPIC_API_KEY not set in .env${NC}"
    exit 1
fi

if [ -z "$DEEPGRAM_API_KEY" ] || [ "$DEEPGRAM_API_KEY" = "your-deepgram-key" ]; then
    echo -e "${RED}Error: DEEPGRAM_API_KEY not set in .env${NC}"
    echo "Get a free key at: https://console.deepgram.com"
    exit 1
fi

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed${NC}"
    echo "Install Docker from: https://docs.docker.com/get-docker/"
    exit 1
fi

if ! docker info &> /dev/null; then
    echo -e "${RED}Error: Docker is not running${NC}"
    echo "Please start Docker and try again"
    exit 1
fi

# Setup Jitsi directory
JITSI_DIR="./.local/jitsi/docker-jitsi-meet"
LEGACY_JITSI_DIR="./jitsi/docker-jitsi-meet"

if [ ! -d "$JITSI_DIR" ] && [ -d "$LEGACY_JITSI_DIR" ]; then
    echo -e "${YELLOW}Migrating legacy local Jitsi checkout into .local/...${NC}"
    mkdir -p ./.local/jitsi
    mv "$LEGACY_JITSI_DIR" "$JITSI_DIR"
fi

if [ ! -d "$JITSI_DIR" ]; then
    echo -e "${YELLOW}Setting up local Jitsi...${NC}"
    bash ./jitsi/setup.sh
fi

# Start Jitsi if not running
echo -e "${YELLOW}Checking Jitsi server...${NC}"
cd "$JITSI_DIR"

if ! docker compose ps | grep -q "Up"; then
    echo -e "${YELLOW}Starting Jitsi server...${NC}"
    docker compose up -d

    echo "Waiting for Jitsi to be ready..."
    sleep 10

    # Check if Jitsi is responding
    for i in {1..30}; do
        if curl -s http://localhost:8443 > /dev/null 2>&1; then
            echo -e "${GREEN}Jitsi is ready!${NC}"
            break
        fi
        echo -n "."
        sleep 2
    done
    echo ""
else
    echo -e "${GREEN}Jitsi is already running${NC}"
fi

cd ../..

# Install npm dependencies if needed
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    npm install
fi

# Parse arguments
ROOM_NAME="${1:-socratic-discussion}"
HEADFUL=""

if [ "$2" = "--headful" ] || [ "$2" = "-h" ]; then
    HEADFUL="--headful"
fi

echo ""
echo "=========================================="
echo -e "${GREEN}Starting Facilitator Bot${NC}"
echo "=========================================="
echo "Room: $ROOM_NAME"
echo "Jitsi: http://localhost:8443/$ROOM_NAME"
echo ""
echo "Open the URL above in your browser to join as a participant"
echo "Press Ctrl+C to stop the bot"
echo "=========================================="
echo ""

# Start the bot
node server/jitsi-bot/run-bot.js --room "$ROOM_NAME" $HEADFUL
