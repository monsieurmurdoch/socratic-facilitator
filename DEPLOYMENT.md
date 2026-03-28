# DigitalOcean Deployment Guide

This guide covers deploying the Socratic Facilitator to DigitalOcean App Platform.

## Prerequisites

- DigitalOcean account
- GitHub repository with your code
- API keys:
  - Anthropic API key (required)
  - Deepgram API key (required for video mode)
  - ElevenLabs API key (optional, for high-quality TTS)

## Option 1: App Platform (Recommended)

### Step 1: Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/socratic-facilitator.git
git push -u origin main
```

### Step 2: Create App on DigitalOcean

1. Go to [DigitalOcean App Platform](https://cloud.digitalocean.com/apps)
2. Click "Create App"
3. Select "GitHub" as source
4. Authorize and select your repository
5. DigitalOcean will detect the Dockerfile automatically

### Step 3: Configure Environment

Add these environment variables in the App settings:

| Variable | Description | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key | Yes |
| `DEEPGRAM_API_KEY` | Deepgram API key for STT | Yes (video mode) |
| `ELEVENLABS_API_KEY` | ElevenLabs API key for TTS | No |
| `DATABASE_URL` | Auto-set when you add database | Yes |
| `NODE_ENV` | Set to `production` | Yes |

### Step 4: Add PostgreSQL Database

1. In your App, go to "Components" > "Add Database"
2. Select "PostgreSQL"
3. Choose dev or production tier
4. `DATABASE_URL` will be automatically set

### Step 5: Deploy

Click "Deploy" and wait for the build to complete.

### Using the App Spec (Alternative)

If you prefer infrastructure-as-code:

```bash
# Install doctl
brew install doctl

# Authenticate
doctl auth init

# Create the app from spec
doctl apps create --spec .do/app.yaml
```

## Option 2: Droplet with Docker

### Step 1: Create Droplet

1. Create a new Droplet (Ubuntu 22.04, $6/mo minimum)
2. Add your SSH key

### Step 2: Install Docker

```bash
# SSH into your droplet
ssh root@your-droplet-ip

# Install Docker
curl -fsSL https://get.docker.com | sh
usermod -aG docker $USER
```

### Step 3: Install PostgreSQL

```bash
# Install PostgreSQL
apt update
apt install postgresql postgresql-contrib

# Create database
sudo -u postgres psql
CREATE DATABASE socratic_facilitator;
CREATE USER socratic WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE socratic_facilitator TO socratic;
\q
```

### Step 4: Run with Docker Compose

Create `docker-compose.yml`:

```yaml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://socratic:your_password@db:5432/socratic_facilitator
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY}
    depends_on:
      - db
    volumes:
      - uploads:/app/uploads

  db:
    image: postgres:15
    environment:
      - POSTGRES_DB=socratic_facilitator
      - POSTGRES_USER=socratic
      - POSTGRES_PASSWORD=your_password
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  uploads:
  pgdata:
```

Run:

```bash
docker compose up -d
```

### Step 5: Set Up Nginx (Optional but Recommended)

```bash
apt install nginx

# Create nginx config
cat > /etc/nginx/sites-available/socratic << 'EOF'
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
EOF

ln -s /etc/nginx/sites-available/socratic /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

### Step 6: Add SSL with Let's Encrypt

```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d your-domain.com
```

## Video Mode: Jitsi Integration

For video mode to work, you need a Jitsi deployment. Options:

### Option A: Use Public Jitsi (meet.jit.si)
Simplest option. No setup required, but less control.

### Option B: Self-Hosted Jitsi on DigitalOcean

```bash
# On a separate droplet
wget https://github.com/jitsi/docker-jitsi-meet/archive/refs/tags/stable-8922.zip
unzip stable-8922.zip
cd docker-jitsi-meet-stable-8922

# Create .env
cp env.example .env

# Edit .env to set:
# PUBLIC_URL=https://your-jitsi-domain.com
# DOCKER_HOST_ADDRESS=your-droplet-ip

# Start Jitsi
docker compose up -d
```

### Option C: DigitalOcean Marketplace
Deploy Jitsi directly from the DigitalOcean Marketplace (one-click install).

## Monitoring and Logs

### App Platform
- View logs in the DigitalOcean dashboard
- Set up alerts for deployment failures

### Droplet
```bash
# View app logs
docker logs -f socratic-facilitator-app-1

# View with docker compose
docker compose logs -f app
```

## Scaling Considerations

For production use:

1. **Upgrade to Basic tier** ($12/mo) for more resources
2. **Add Redis** for WebSocket scaling across instances
3. **Use Spaces** for file uploads instead of local storage
4. **Set up monitoring** with DigitalOcean Uptime checks

## Troubleshooting

### Database Connection Issues
```bash
# Check database is running
docker compose ps db

# Check connection
docker compose exec app node -e "console.log(process.env.DATABASE_URL)"
```

### WebSocket Not Working
- Ensure your proxy (Nginx/load balancer) supports WebSocket upgrades
- Check the `proxy_set_header Upgrade $http_upgrade` config

### TTS Not Working
- Verify Piper is installed in the container
- Check `PIPER_PATH` and `PIPER_MODEL_PATH` environment variables
- Test manually: `echo "test" | piper --model /app/piper/models/en_US-lessac-medium.onnx --output-raw > /dev/null`

## Cost Estimate

| Component | Tier | Monthly Cost |
|-----------|------|--------------|
| App Platform | Basic | $5-12 |
| PostgreSQL | Basic | $7 |
| Jitsi Droplet | Basic | $6-12 |
| **Total** | | **$18-31** |

## Next Steps

1. Set up a custom domain
2. Configure SSL certificates
3. Set up CI/CD for automatic deployments
4. Add monitoring and alerting
5. Set up database backups
