-- What the web app's apps, gallery and bot screens show that the application's tables did not keep: how many people made a published app or a
-- template their own, and what a bot's link shares (its limits, model and tools).
ALTER TABLE pim_app.published_artifacts ADD COLUMN uses integer NOT NULL DEFAULT 0;
ALTER TABLE pim_app.templates ADD COLUMN uses integer NOT NULL DEFAULT 0;
ALTER TABLE pim_app.bots ADD COLUMN settings jsonb NOT NULL DEFAULT '{}';
