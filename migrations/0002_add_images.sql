ALTER TABLE articles ADD COLUMN image_url TEXT;
ALTER TABLE story_clusters ADD COLUMN image_url TEXT;
ALTER TABLE delivery_outbox ADD COLUMN image_url TEXT;