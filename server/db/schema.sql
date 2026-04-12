-- Socratic Facilitator Database Schema
-- Run this to initialize the database

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'Teacher' CHECK (role IN ('Admin', 'SuperAdmin', 'Teacher', 'Student', 'Parent')),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Classes table
CREATE TABLE IF NOT EXISTS classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  description TEXT,
  age_range VARCHAR(60),
  room_code VARCHAR(8),
  sort_order INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS classes ADD COLUMN IF NOT EXISTS room_code VARCHAR(8);
CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_room_code_unique ON classes(room_code) WHERE room_code IS NOT NULL;

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code VARCHAR(8) UNIQUE NOT NULL,
  title VARCHAR(255) NOT NULL,
  opening_question TEXT,
  conversation_goal TEXT,
  status VARCHAR(20) DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'ended')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_by UUID,
  previous_session_short_code VARCHAR(8)
);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_user_id UUID;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS class_id UUID;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS previous_session_short_code VARCHAR(8);

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
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  filename VARCHAR(255),
  original_type VARCHAR(50) CHECK (original_type IN ('pdf', 'url', 'txt', 'docx', 'other')),
  storage_path VARCHAR(500),
  url TEXT,
  extracted_text TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS material_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id UUID REFERENCES source_materials(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  source_kind VARCHAR(20) NOT NULL DEFAULT 'material',
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Primed context table (AI comprehension of materials)
CREATE TABLE IF NOT EXISTS primed_context (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  is_anchor BOOLEAN DEFAULT false,  -- Missing column that was causing analytics query to fail
  reasoning TEXT,
  raw_payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id)
);

-- Ensure all analytics columns exist (fixes "column does not exist" errors on existing DBs)
ALTER TABLE message_analytics 
  ADD COLUMN IF NOT EXISTS is_anchor BOOLEAN DEFAULT false;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_analytics_anchor ON message_analytics(is_anchor);
CREATE INDEX IF NOT EXISTS idx_participants_session ON participants(session_id);
CREATE INDEX IF NOT EXISTS idx_state_session ON conversation_state(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_materials_session ON source_materials(session_id);
CREATE INDEX IF NOT EXISTS idx_material_chunks_session ON material_chunks(session_id, chunk_index);
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

-- Session debriefs and generated reports
CREATE TABLE IF NOT EXISTS session_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  report_type VARCHAR(40) NOT NULL DEFAULT 'teacher_debrief',
  report_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (session_id, report_type)
);

-- Class privacy controls
CREATE TABLE IF NOT EXISTS class_privacy_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  retention_days INTEGER NOT NULL DEFAULT 180,
  allow_ai_scoring BOOLEAN NOT NULL DEFAULT TRUE,
  allow_lms_sync BOOLEAN NOT NULL DEFAULT TRUE,
  parent_view_mode VARCHAR(20) NOT NULL DEFAULT 'summary',
  student_view_mode VARCHAR(20) NOT NULL DEFAULT 'self_only',
  allow_exports BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (class_id)
);

-- Parent/student links for class-level access
CREATE TABLE IF NOT EXISTS parent_student_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  parent_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (class_id, parent_user_id, student_user_id)
);

-- External OAuth/LMS integrations
CREATE TABLE IF NOT EXISTS external_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'connected',
  external_user_id TEXT,
  external_email TEXT,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

-- LTI platform registrations
CREATE TABLE IF NOT EXISTS lti_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label VARCHAR(160) NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  auth_login_url TEXT NOT NULL,
  auth_token_url TEXT NOT NULL,
  keyset_url TEXT NOT NULL,
  deep_link_url TEXT,
  nrps_url TEXT,
  ags_lineitems_url TEXT,
  tool_key_id TEXT,
  tool_private_key_encrypted TEXT,
  tool_public_jwk JSONB,
  oauth_audience TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (issuer, client_id, deployment_id)
);

-- LTI launch/account linkage
CREATE TABLE IF NOT EXISTS lti_account_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id UUID NOT NULL REFERENCES lti_registrations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lti_subject TEXT NOT NULL,
  lti_email TEXT,
  context_id TEXT,
  context_title TEXT,
  deployment_id TEXT,
  last_launch_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_launched_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (registration_id, lti_subject)
);

-- LTI gradebook line item mapping
CREATE TABLE IF NOT EXISTS lti_gradebook_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  registration_id UUID NOT NULL REFERENCES lti_registrations(id) ON DELETE CASCADE,
  context_id TEXT,
  lineitem_url TEXT NOT NULL,
  resource_id TEXT,
  label TEXT,
  score_maximum FLOAT NOT NULL DEFAULT 100,
  last_sync_result JSONB,
  last_synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (session_id, registration_id)
);

-- Revocable auth sessions
CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_jti TEXT NOT NULL,
  session_label TEXT,
  user_agent TEXT,
  ip_address TEXT,
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Password reset tokens
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  requested_ip TEXT,
  requested_user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Audit trail
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Model eval history
CREATE TABLE IF NOT EXISTS model_eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  eval_key TEXT NOT NULL,
  strategy TEXT NOT NULL,
  fixture_set TEXT NOT NULL,
  model_label TEXT,
  total_cases INTEGER NOT NULL,
  completed_cases INTEGER NOT NULL DEFAULT 0,
  overall_score FLOAT,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Background maintenance history
CREATE TABLE IF NOT EXISTS maintenance_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_session_reports_session ON session_reports(session_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_integrations_user ON external_integrations(user_id, provider);
CREATE INDEX IF NOT EXISTS idx_lti_account_links_context ON lti_account_links(registration_id, context_id, last_launched_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_eval_runs_key ON model_eval_runs(eval_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_runs_job ON maintenance_runs(job_name, started_at DESC);

-- Learner profiles table for longitudinal tracking
CREATE TABLE IF NOT EXISTS learner_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  total_sessions INTEGER DEFAULT 0,
  total_messages INTEGER DEFAULT 0,
  total_speaking_seconds REAL DEFAULT 0,
  avg_specificity REAL DEFAULT 0,
  avg_profoundness REAL DEFAULT 0,
  avg_coherence REAL DEFAULT 0,
  avg_contribution_score REAL DEFAULT 0,
  estimated_level VARCHAR(20) DEFAULT 'unknown',
  topics_discussed JSONB DEFAULT '[]',
  strengths JSONB DEFAULT '[]',
  growth_areas JSONB DEFAULT '[]',
  session_summaries JSONB DEFAULT '[]',
  stt_corrections JSONB DEFAULT '[]',
  UNIQUE(user_id)
);

-- Index for learner profiles
CREATE INDEX IF NOT EXISTS idx_learner_profiles_user ON learner_profiles(user_id, updated_at DESC);

-- Robust fixes for schema warnings and missing columns (user_id, is_anchor, etc.)
-- This ensures the DB is always consistent even if the $ splitter fails on functions
ALTER TABLE IF EXISTS session_memberships ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS classes ADD COLUMN IF NOT EXISTS sort_order INT;
ALTER TABLE IF EXISTS message_analytics ADD COLUMN IF NOT EXISTS is_anchor BOOLEAN DEFAULT false;
ALTER TABLE IF EXISTS message_analytics ADD COLUMN IF NOT EXISTS referenced_anchor BOOLEAN DEFAULT false;
ALTER TABLE IF EXISTS message_analytics ADD COLUMN IF NOT EXISTS responded_to_peer BOOLEAN DEFAULT false;
ALTER TABLE IF EXISTS conversation_state ADD COLUMN IF NOT EXISTS ai_should_speak BOOLEAN DEFAULT false;
