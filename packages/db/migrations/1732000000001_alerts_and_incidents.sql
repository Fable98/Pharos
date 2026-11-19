-- Up Migration

-- 1. Monitors thresholds
ALTER TABLE monitors
  ADD COLUMN fail_threshold int NOT NULL DEFAULT 3 CHECK (fail_threshold BETWEEN 1 AND 10),
  ADD COLUMN recover_threshold int NOT NULL DEFAULT 2 CHECK (recover_threshold BETWEEN 1 AND 10),
  ADD COLUMN degraded_latency_ms int CHECK (degraded_latency_ms > 0);

-- 2. Monitor state
CREATE TABLE monitor_state (
  monitor_id uuid PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'up', 'degraded', 'down')),
  consecutive_failures int NOT NULL DEFAULT 0,
  consecutive_successes int NOT NULL DEFAULT 0,
  consecutive_slow int NOT NULL DEFAULT 0,
  consecutive_fast int NOT NULL DEFAULT 0,
  last_checked_at timestamptz,
  last_changed_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Incidents
CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  resolved_at timestamptz,
  cause text,
  CHECK (resolved_at IS NULL OR resolved_at >= started_at)
);

CREATE UNIQUE INDEX incidents_open_monitor_uidx ON incidents (monitor_id) WHERE resolved_at IS NULL;
CREATE INDEX incidents_monitor_started_idx ON incidents (monitor_id, started_at DESC);

-- 4. Alert channels
CREATE TABLE alert_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('telegram', 'webhook')),
  name text NOT NULL,
  config jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX alert_channels_workspace_idx ON alert_channels (workspace_id);

-- 5. Notification outbox
CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES alert_channels(id) ON DELETE CASCADE,
  monitor_id uuid REFERENCES monitors(id) ON DELETE SET NULL,
  incident_id uuid REFERENCES incidents(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  dedupe_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE INDEX notification_outbox_pending_idx ON notification_outbox (next_attempt_at) WHERE status = 'pending';

-- Down Migration
DROP TABLE IF EXISTS notification_outbox;
DROP TABLE IF EXISTS alert_channels;
DROP TABLE IF EXISTS incidents;
DROP TABLE IF EXISTS monitor_state;
ALTER TABLE monitors
  DROP COLUMN IF EXISTS degraded_latency_ms,
  DROP COLUMN IF EXISTS recover_threshold,
  DROP COLUMN IF EXISTS fail_threshold;
