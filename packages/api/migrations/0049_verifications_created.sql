-- The status endpoint needs only the latest timestamp. Read it from the
-- leading index entry instead of scanning and sorting the verification log.
CREATE INDEX IF NOT EXISTS idx_verifications_created ON verifications(created_at DESC);
