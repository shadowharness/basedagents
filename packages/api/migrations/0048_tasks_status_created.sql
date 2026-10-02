-- Browse one lifecycle state in newest-first order without sorting every
-- matching task (including its large payload and joined display fields).
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at DESC);
