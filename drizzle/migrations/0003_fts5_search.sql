CREATE VIRTUAL TABLE IF NOT EXISTS product_fts USING fts5(
  product_id UNINDEXED,
  title,
  description,
  category,
  content='product',
  content_rowid='rowid'
);

INSERT OR IGNORE INTO product_fts(product_id, title, description, category)
SELECT id, title, COALESCE(description, ''), COALESCE(category, '') FROM product;
