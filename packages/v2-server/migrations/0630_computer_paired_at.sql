-- When a computer was paired, for Settings → Computer ("paired at"). Computers paired before this migration show the time it ran.
ALTER TABLE pim_app.computers ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
