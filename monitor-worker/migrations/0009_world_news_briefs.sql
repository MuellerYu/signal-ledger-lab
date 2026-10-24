ALTER TABLE world_news ADD COLUMN title_zh TEXT NOT NULL DEFAULT '';
ALTER TABLE world_news ADD COLUMN evidence_status TEXT NOT NULL DEFAULT '媒体报道';

CREATE INDEX IF NOT EXISTS world_news_brief_backfill_idx
  ON world_news (title_zh, published_at DESC);
