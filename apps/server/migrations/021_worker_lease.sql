-- One row, id fixed to 'worker': which process's ticking worker may claim jobs. Settled in one immediate transaction at
-- the start of every tick. The row is deleted on a clean stop and taken over when stale or when the holder pid is dead.
CREATE TABLE worker_lease (
    id TEXT PRIMARY KEY CHECK (id = 'worker'),
    holder TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('server', 'mcp')),
    pid INTEGER NOT NULL,
    acquired_at TEXT NOT NULL,
    renewed_at TEXT NOT NULL
);
