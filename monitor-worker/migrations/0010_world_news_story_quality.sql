ALTER TABLE world_news ADD COLUMN brief_version TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS world_news_brief_version_idx
  ON world_news (brief_version, published_at DESC);
