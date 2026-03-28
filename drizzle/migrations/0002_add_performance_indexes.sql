-- Performance indexes for product table
-- Index on organizationId for org-scoped queries (most common filter)
CREATE INDEX IF NOT EXISTS idx_product_organization_id ON product(organizationId);

-- Composite index for org + category filtering
CREATE INDEX IF NOT EXISTS idx_product_org_category ON product(organizationId, category);

-- Composite index for org + time sorting
CREATE INDEX IF NOT EXISTS idx_product_org_created_at ON product(organizationId, createdAt);

-- Index on category for category-based filtering
CREATE INDEX IF NOT EXISTS idx_product_category ON product(category);

-- Index on crawlerJobId for join lookups
CREATE INDEX IF NOT EXISTS idx_product_crawler_job_id ON product(crawlerJobId);

-- Performance indexes for crawler_job table
-- Index on organizationId for org-scoped queries
CREATE INDEX IF NOT EXISTS idx_crawler_job_organization_id ON crawler_job(organizationId);

-- Composite index for org + status filtering
CREATE INDEX IF NOT EXISTS idx_crawler_job_org_status ON crawler_job(organizationId, status);

-- Index on status for status-based filtering
CREATE INDEX IF NOT EXISTS idx_crawler_job_status ON crawler_job(status);

-- Performance indexes for product_ai_description table
-- Index on productId for join lookups
CREATE INDEX IF NOT EXISTS idx_product_ai_description_product_id ON product_ai_description(productId);
