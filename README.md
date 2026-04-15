# Socratic Facilitator AI

A multi-party conversation engine that facilitates Socratic discussions among groups of students. Features real-time AI facilitation, document priming, and conversation state analysis.

## Contributing

See [CONTRIBUTING.md](/Users/robertmalka/Desktop/socratic-facilitator/CONTRIBUTING.md) for branching rules and PR expectations. The short version: keep `main` deployable, use a branch for every change, and delete stale branches after merge.

## Architecture

```
socratic-facilitator/
├── server/
│   ├── index.js                 # Express + WebSocket server
│   ├── config.js                # Topics and facilitation parameters
│   ├── facilitator.js           # Core LLM facilitation engine
│   ├── stateTracker.js          # Session state management
│   ├── moves.js                 # Facilitation move taxonomy
│   │
│   ├── db/
│   │   ├── index.js             # PostgreSQL connection
│   │   ├── schema.sql           # Database schema
│   │   └── repositories/        # Data access layer
│   │       ├── sessions.js
│   │       ├── participants.js
│   │       ├── messages.js
│   │       ├── materials.js
│   │       ├── primedContext.js
│   │       └── conversationState.js
│   │
│   ├── storage/
│   │   └── index.js             # File upload handling
│   │
│   ├── content/
│   │   ├── extractor.js         # PDF/URL/text extraction
│   │   └── primer.js            # AI comprehension of materials
│   │
│   ├── analysis/
│   │   └── stateAnalyzer.js     # Conversation state evaluation
│   │
│   └── routes/
│       └── sessions.js          # REST API endpoints
│
├── client/
│   ├── public/
│   │   └── index.html
│   └── src/
│       ├── app.js
│       └── style.css
│
├── package.json
├── Dockerfile
├── railway.toml
└── .env.example
```

## Features

- **Real-time multi-party chat** via WebSockets
- **AI-powered Socratic facilitation** that asks questions, never lectures
- **Document priming** - upload PDFs, URLs, or text for the AI to understand before discussion
- **Conversation state analysis** - tracks trajectory, depth, engagement in real-time
- **Age-calibrated** language and question complexity
- **Voice integration** (optional) with TTS/STT

## Setup

### Local Development

1. **Install dependencies**
```bash
npm install
```

2. **Set up PostgreSQL**
```bash
# Create database
createdb socratic_facilitator

# Or use Docker
docker run -d --name postgres -e POSTGRES_DB=socratic_facilitator -p 5432:5432 postgres:15
```

3. **Configure environment**
```bash
cp .env.example .env
# Edit .env with your database URL and Anthropic API key
```

4. **Run the server**
```bash
npm start
# or with auto-reload:
npm run dev
```

5. **Open the app**
Navigate to `http://localhost:3000` in your browser.

To simulate multiple participants, open multiple browser tabs.

### Deploy to Railway

1. **Create a new project on Railway**
```bash
railway login
railway init
```

2. **Add PostgreSQL**
```bash
railway add --plugin postgresql
```

3. **Deploy**
```bash
railway up
```

Railway will automatically:
- Build the Docker image
- Connect to PostgreSQL
- Run the database migrations on startup
- Mount a persistent volume for uploads

## How It Works

1. **Host creates a session** → selects topic → optionally uploads materials → gets shareable code
2. **Materials are primed** → AI reads and comprehends documents → extracts themes, tensions, discussion angles
3. **Participants join** with the code
4. **Discussion starts** → AI delivers opening question
5. **After each message**, the facilitation engine:
   - Checks hard constraints (talk ratio, timing)
   - Analyzes conversation state (trajectory, depth, engagement)
   - Decides whether to intervene
   - Chooses appropriate facilitation move
6. **Session ends** with synthesis of what was explored

## Key Design Principles

- The AI is a **facilitator**, not a teacher. It never lectures or explains.
- **Silence is the default.** The system must exceed a threshold before speaking.
- **Specificity matters.** The AI addresses individuals by name, connects specific ideas.
- **One question at a time.** Never doubles up.

## API Endpoints

### Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/sessions` | Create a new session |
| GET | `/api/sessions/:code` | Get session details |
| POST | `/api/sessions/:code/materials` | Upload materials (file or URL) |
| POST | `/api/sessions/:code/prime` | Prime materials with AI |
| GET | `/api/sessions/:code/messages` | Get session messages |
| DELETE | `/api/sessions/:code/materials/:id` | Delete a material |
| GET | `/api/topics` | List available topics |

### WebSocket Messages

| Type | Direction | Description |
|------|-----------|-------------|
| `create_session` | Client → Server | Create new session |
| `join_session` | Client → Server | Join as participant |
| `join_dashboard` | Client → Server | Join as teacher/observer |
| `start_discussion` | Client → Server | Begin discussion |
| `message` | Client → Server | Send a message |
| `end_discussion` | Client → Server | End discussion |
| `participant_message` | Server → Client | Participant spoke |
| `facilitator_message` | Server → Client | AI spoke |
| `participant_joined` | Server → Client | Someone joined |
| `participant_left` | Server → Client | Someone left |

## Conversation State Analysis

The system tracks multiple dimensions in real-time:

| Dimension | Description |
|-----------|-------------|
| `topicDrift` | How far from the core question (0-1) |
| `trajectory` | deepening / drifting / circling / stalled / branching |
| `reasoningDepth` | Are participants giving reasons? (0-1) |
| `listeningScore` | Are they building on each other? (0-1) |
| `dominanceScore` | Is one voice crowding others? (0-1) |
| `inclusionScore` | Are quieter voices engaged? (0-1) |
| `unchallengedClaims` | Claims that haven't been pushed back on |
| `unexploredTensions` | Disagreements that could be surfaced |

This state is observable via the database and can be used for:
- Real-time dashboards
- Post-session analysis
- Training/improving the facilitation model

## Configuration

Edit `server/config.js` to adjust:
- Discussion topics and opening questions
- Age range and vocabulary calibration
- Intervention frequency thresholds
- Session duration

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `ANTHROPIC_API_KEY` | Anthropic API key | Yes |
| `PORT` | Server port | No (default: 3000) |
| `NODE_ENV` | Environment | No (default: development) |
| `STORAGE_PATH` | File upload directory | No (default: ./uploads) |

## License

MIT
