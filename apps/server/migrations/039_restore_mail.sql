ALTER TABLE send_intent ADD COLUMN restore_held INTEGER NOT NULL DEFAULT 0 CHECK (restore_held IN (0, 1));
