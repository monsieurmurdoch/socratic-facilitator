-- Socratic Facilitator Database Schema
-- Run this to initialize the database

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(120) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'Teacher' CHECK (role IN ('Admin', 'SuperAdmin', 'Teacher', 'Student', 'Parent')),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Classes table
CREATE TABLE IF NOT EXISTS classes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  description TEXT,
  age_range VARCHAR(60),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

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

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_user_id UUID;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS class_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_sessions_owner_user'
      AND table_name = 'sessions'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT fk_sessions_owner_user
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_sessions_class'
      AND table_name = 'sessions'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT fk_sessions_class
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Participants table
CREATE TABLE IF NOT EXISTS participants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(100) NOT NULL,
  age INTEGER,
  role VARCHAR(20) DEFAULT 'participant' CHECK (role IN ('participant', 'teacher', 'observer')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  UNIQUE(session_id, name)
);

-- Class memberships (students, teachers, parents, etc.)
CREATE TABLE IF NOT EXISTS class_memberships (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  class_id UUID REFERENCES classes(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('Teacher', 'Student', 'Parent', 'Admin', 'SuperAdmin')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(class_id, user_id)
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

-- Session-level participant history and aggregate contribution metrics
CREATE TABLE IF NOT EXISTS session_memberships (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  participant_id UUID REFERENCES participants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  name_snapshot VARCHAR(100) NOT NULL,
  role_snapshot VARCHAR(20),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  join_count INTEGER DEFAULT 1,
  message_count INTEGER DEFAULT 0,
  total_word_count INTEGER DEFAULT 0,
  estimated_speaking_seconds FLOAT DEFAULT 0,
  contribution_score FLOAT DEFAULT 0,
  engagement_score FLOAT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(participant_id)
);

-- Per-message analytics used for scoring, ranking, and future overlays
CREATE TABLE IF NOT EXISTS message_analytics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  participant_id UUID REFERENCES participants(id) ON DELETE SET NULL,
  analytics_version INTEGER DEFAULT 1,
  specificity FLOAT,
  profoundness FLOAT,
  coherence FLOAT,
  discussion_value FLOAT,
  contribution_weight FLOAT,
  engagement_estimate FLOAT,
  responded_to_peer BOOLEAN,
  referenced_anchor BOOLEAN,
  reasoning TEXT,
  raw_payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_participants_session ON participants(session_id);
CREATE INDEX IF NOT EXISTS idx_state_session ON conversation_state(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_materials_session ON source_materials(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_shortcode ON sessions(short_code);
CREATE INDEX IF NOT EXISTS idx_sessions_owner_user ON sessions(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_class ON sessions(class_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_classes_owner_user ON classes(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_class_memberships_class ON class_memberships(class_id);
CREATE INDEX IF NOT EXISTS idx_class_memberships_user ON class_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(user_id);
CREATE INDEX IF NOT EXISTS idx_session_memberships_session ON session_memberships(session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_memberships_user ON session_memberships(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_analytics_session ON message_analytics(session_id, created_at);
