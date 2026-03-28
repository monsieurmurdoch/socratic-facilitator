-- Socratic Facilitator Database Schema
-- Run this to initialize the database

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  short_code VARCHAR(8) UNIQUE NOT NULL,
  title VARCHAR(255) NOT NULL,
  opening_question TEXT,
  conversation_goal TEXT,
  status VARCHAR(20) DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'ended')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_by UUID
);

-- Participants table
CREATE TABLE IF NOT EXISTS participants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  age INTEGER,
  role VARCHAR(20) DEFAULT 'participant' CHECK (role IN ('participant', 'teacher', 'observer')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  UNIQUE(session_id, name)
);

-- Add foreign key for sessions.created_by after participants exists
ALTER TABLE sessions ADD CONSTRAINT fk_created_by
  FOREIGN KEY (created_by) REFERENCES participants(id) ON DELETE SET NULL;

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  participant_id UUID REFERENCES participants(id) ON DELETE SET NULL,
  sender_type VARCHAR(20) NOT NULL CHECK (sender_type IN ('participant', 'facilitator', 'system')),
  sender_name VARCHAR(100),
  content TEXT NOT NULL,
  move_type VARCHAR(50),
  target_participant_id UUID REFERENCES participants(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Source materials table
CREATE TABLE IF NOT EXISTS source_materials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  filename VARCHAR(255),
  original_type VARCHAR(50) CHECK (original_type IN ('pdf', 'url', 'txt', 'docx', 'other')),
  storage_path VARCHAR(500),
  url TEXT,
  extracted_text TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Primed context table (AI comprehension of materials)
CREATE TABLE IF NOT EXISTS primed_context (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  summary TEXT,
  key_themes JSONB,
  potential_tensions JSONB,
  suggested_angles JSONB,
  comprehension_status VARCHAR(20) DEFAULT 'pending' CHECK (comprehension_status IN ('pending', 'processing', 'complete', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Conversation state table (for analytics)
CREATE TABLE IF NOT EXISTS conversation_state (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id),

  -- State vector
  topic_drift FLOAT,
  trajectory VARCHAR(20) CHECK (trajectory IN ('deepening', 'drifting', 'circling', 'stalled', 'branching')),
  reasoning_depth FLOAT,
  listening_score FLOAT,
  tension_productivity FLOAT,
  dominance_score FLOAT,
  inclusion_score FLOAT,

  -- Detected elements
  unchallenged_claims JSONB,
  unexplored_tensions JSONB,
  ripe_branches JSONB,

  -- AI decision factors
  intervention_threshold FLOAT,
  ai_should_speak BOOLEAN,
  ai_reasoning TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_participants_session ON participants(session_id);
CREATE INDEX IF NOT EXISTS idx_state_session ON conversation_state(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_materials_session ON source_materials(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_shortcode ON sessions(short_code);
