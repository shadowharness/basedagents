-- Index the existing paidTotals population, including its exact transaction
-- hash validation. This materializes eligibility at write time while leaving
-- the read predicate and amount conversion unchanged. If that predicate is
-- broadened later, SQLite falls back to another eligible access path.
CREATE INDEX IF NOT EXISTS idx_tasks_paid_totals
ON tasks(payment_status, bounty_network, settled_at, bounty_amount)
WHERE payment_status = 'settled'
  AND bounty_network IN ('eip155:8453')
  AND settled_at IS NOT NULL
  AND COALESCE(escrow_status, '') != 'refunded'
  AND (length(COALESCE(NULLIF(escrow_release_tx_hash, ''), NULLIF(payment_tx_hash, ''))) = 66
    AND substr(COALESCE(NULLIF(escrow_release_tx_hash, ''), NULLIF(payment_tx_hash, '')), 1, 2) = '0x'
    AND NOT (lower(substr(COALESCE(NULLIF(escrow_release_tx_hash, ''), NULLIF(payment_tx_hash, '')), 3)) GLOB '*[^0-9a-f]*'));
