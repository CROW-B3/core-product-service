import type { CrawlJobMessage, Environment } from './types';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { logger } from 'hono/logger';
import { poweredBy } from 'hono/powered-by';
import * as schema from './db/schema';
import { handleQueueBatch } from './queues';
import { processProductCrawlJob } from './queues/product-crawl';
import {
  CreateCrawlerJobRoute,
  GetCrawlerJobRoute,
  GetCrawlerJobsByOrgRoute,
  GetProductRoute,
  GetProductsByOrgRoute,
  HelloWorldRoute,
  TriggerCrawlerJobRoute,
} from './routes';

const app = new OpenAPIHono<{ Bindings: Environment }>();
app.use(poweredBy());
app.use(logger());

const formatCrawlerJob = (job: typeof schema.crawlerJob.$inferSelect) => ({
  ...job,
  startedAt: job.startedAt?.toISOString() ?? null,
  completedAt: job.completedAt?.toISOString() ?? null,
  createdAt: job.createdAt.toISOString(),
  updatedAt: job.updatedAt.toISOString(),
});

const formatProduct = (product: typeof schema.product.$inferSelect) => ({
  ...product,
  images: JSON.parse(product.images),
  metadata: product.metadata ? JSON.parse(product.metadata) : null,
  createdAt: product.createdAt.toISOString(),
  updatedAt: product.updatedAt.toISOString(),
});

app.openapi(HelloWorldRoute, c => {
  return c.json({ text: 'Hello from Product Service!' });
});

app.openapi(CreateCrawlerJobRoute, async c => {
  const db = drizzle(c.env.DB, { schema });
  const body = c.req.valid('json');
  const id = crypto.randomUUID();
  const now = new Date();

  await db.insert(schema.crawlerJob).values({
    id,
    organizationId: body.organizationId,
    onboardingId: body.onboardingId,
    sourceType: body.sourceType,
    sourceValue: body.sourceValue,
    createdAt: now,
    updatedAt: now,
  });

  const result = await db
    .select()
    .from(schema.crawlerJob)
    .where(eq(schema.crawlerJob.id, id))
    .limit(1);

  return c.json(formatCrawlerJob(result[0]), 201);
});

app.openapi(GetCrawlerJobRoute, async c => {
  const db = drizzle(c.env.DB, { schema });
  const { id } = c.req.valid('param');

  const result = await db
    .select()
    .from(schema.crawlerJob)
    .where(eq(schema.crawlerJob.id, id))
    .limit(1);

  if (!result[0]) return c.json({ error: 'Not found' }, 404);

  return c.json(formatCrawlerJob(result[0]));
});

app.openapi(GetCrawlerJobsByOrgRoute, async c => {
  const db = drizzle(c.env.DB, { schema });
  const { organizationId } = c.req.valid('param');

  const result = await db
    .select()
    .from(schema.crawlerJob)
    .where(eq(schema.crawlerJob.organizationId, organizationId));

  return c.json({ jobs: result.map(formatCrawlerJob) });
});

app.openapi(GetProductRoute, async c => {
  const db = drizzle(c.env.DB, { schema });
  const { id } = c.req.valid('param');

  const result = await db
    .select()
    .from(schema.product)
    .where(eq(schema.product.id, id))
    .limit(1);

  if (!result[0]) return c.json({ error: 'Not found' }, 404);

  return c.json(formatProduct(result[0]));
});

app.openapi(GetProductsByOrgRoute, async c => {
  const db = drizzle(c.env.DB, { schema });
  const { organizationId } = c.req.valid('param');
  const { page: pageStr, pageSize: pageSizeStr } = c.req.valid('query');

  const page = Number.parseInt(pageStr || '1', 10);
  const pageSize = Number.parseInt(pageSizeStr || '20', 10);
  const offset = (page - 1) * pageSize;

  const products = await db
    .select()
    .from(schema.product)
    .where(eq(schema.product.organizationId, organizationId))
    .limit(pageSize)
    .offset(offset);

  const countResult = await db
    .select()
    .from(schema.product)
    .where(eq(schema.product.organizationId, organizationId));

  return c.json({
    products: products.map(formatProduct),
    total: countResult.length,
    page,
    pageSize,
  });
});

app.openapi(TriggerCrawlerJobRoute, async c => {
  const db = drizzle(c.env.DB, { schema });
  const { id } = c.req.valid('param');

  const result = await db
    .select()
    .from(schema.crawlerJob)
    .where(eq(schema.crawlerJob.id, id))
    .limit(1);

  if (!result[0]) return c.json({ error: 'Not found' }, 404);

  const job = result[0];
  await processProductCrawlJob(c.env, {
    jobId: id,
    organizationId: job.organizationId,
    url: job.sourceValue,
  });

  const updatedJob = await db
    .select()
    .from(schema.crawlerJob)
    .where(eq(schema.crawlerJob.id, id))
    .limit(1);

  return c.json(formatCrawlerJob(updatedJob[0]));
});

app.doc('/docs', {
  openapi: '3.0.0',
  info: {
    version: '1.0.0',
    title: 'CROW Product Service API',
  },
});

export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<CrawlJobMessage>, env: Environment) =>
    handleQueueBatch(batch, env),
};
