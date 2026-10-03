-- Optional read projection generation. Execute transactionally before enabling
-- TASK_LIST_PROJECTION_MODE. Every public-row dependency changes the generation
-- in the same SQL transaction as its write, including external SQL writers.
CREATE TABLE IF NOT EXISTS task_projection_epoch (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  incarnation TEXT NOT NULL,
  version INTEGER NOT NULL
);
INSERT OR IGNORE INTO task_projection_epoch VALUES (1, lower(hex(randomblob(16))), 0);
CREATE TRIGGER IF NOT EXISTS task_projection_tasks_i AFTER INSERT ON tasks BEGIN UPDATE task_projection_epoch SET version=version+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS task_projection_tasks_u AFTER UPDATE ON tasks BEGIN UPDATE task_projection_epoch SET version=version+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS task_projection_tasks_d AFTER DELETE ON tasks BEGIN UPDATE task_projection_epoch SET version=version+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS task_projection_agents_i AFTER INSERT ON agents BEGIN UPDATE task_projection_epoch SET version=version+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS task_projection_agents_u AFTER UPDATE ON agents BEGIN UPDATE task_projection_epoch SET version=version+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS task_projection_agents_d AFTER DELETE ON agents BEGIN UPDATE task_projection_epoch SET version=version+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS task_projection_owners_i AFTER INSERT ON owners BEGIN UPDATE task_projection_epoch SET version=version+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS task_projection_owners_u AFTER UPDATE ON owners BEGIN UPDATE task_projection_epoch SET version=version+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS task_projection_owners_d AFTER DELETE ON owners BEGIN UPDATE task_projection_epoch SET version=version+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS task_projection_delegations_i AFTER INSERT ON delegations BEGIN UPDATE task_projection_epoch SET version=version+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS task_projection_delegations_u AFTER UPDATE ON delegations BEGIN UPDATE task_projection_epoch SET version=version+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS task_projection_delegations_d AFTER DELETE ON delegations BEGIN UPDATE task_projection_epoch SET version=version+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS task_projection_credentials_i AFTER INSERT ON owner_webauthn_credentials BEGIN UPDATE task_projection_epoch SET version=version+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS task_projection_credentials_u AFTER UPDATE ON owner_webauthn_credentials BEGIN UPDATE task_projection_epoch SET version=version+1 WHERE singleton=1; END;
CREATE TRIGGER IF NOT EXISTS task_projection_credentials_d AFTER DELETE ON owner_webauthn_credentials BEGIN UPDATE task_projection_epoch SET version=version+1 WHERE singleton=1; END;
