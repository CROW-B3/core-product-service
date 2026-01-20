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

const formatCrawlerJobResponse = (
  job: typeof schema.crawlerJob.$inferSelect
) => ({
  ...job,
  startedAt: job.startedAt?.toISOString() ?? null,
  completedAt: job.completedAt?.toISOString() ?? null,
  createdAt: job.createdAt.toISOString(),
  updatedAt: job.updatedAt.toISOString(),
});

const formatProductResponse = (
  product: typeof schema.product.$inferSelect
) => ({
  ...product,
  images: JSON.parse(product.images),
  metadata: product.metadata ? JSON.parse(product.metadata) : null,
  createdAt: product.createdAt.toISOString(),
  updatedAt: product.updatedAt.toISOString(),
});

const createCrawlerJobInDatabase = async (
  database: ReturnType<typeof drizzle>,
  jobId: string,
  organizationId: string,
  onboardingId: string | undefined,
  sourceType: string,
  sourceValue: string,
  timestamp: Date
) => {
  await database.insert(schema.crawlerJob).values({
    id: jobId,
    organizationId,
    onboardingId,
    sourceType,
    sourceValue,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return jobId;
};

const sendCrawlJobToQueue = async (
  queue: Queue,
  jobId: string,
  organizationId: string,
  sourceValue: string
) => {
  await queue.send({
    jobId,
    organizationId,
    url: sourceValue,
  });
};

const fetchCrawlerJobById = async (
  database: ReturnType<typeof drizzle>,
  jobId: string
) => {
  const results = await database
    .select()
    .from(schema.crawlerJob)
    .where(eq(schema.crawlerJob.id, jobId))
    .limit(1);
  return results[0] ?? null;
};

const fetchCrawlerJobsByOrganization = async (
  database: ReturnType<typeof drizzle>,
  organizationId: string
) => {
  return database
    .select()
    .from(schema.crawlerJob)
    .where(eq(schema.crawlerJob.organizationId, organizationId));
};

const fetchProductById = async (
  database: ReturnType<typeof drizzle>,
  productId: string
) => {
  const results = await database
    .select()
    .from(schema.product)
    .where(eq(schema.product.id, productId))
    .limit(1);
  return results[0] ?? null;
};

const fetchPaginatedProductsByOrganization = async (
  database: ReturnType<typeof drizzle>,
  organizationId: string,
  page: number,
  pageSize: number
) => {
  const offset = (page - 1) * pageSize;
  return database
    .select()
    .from(schema.product)
    .where(eq(schema.product.organizationId, organizationId))
    .limit(pageSize)
    .offset(offset);
};

const countProductsByOrganization = async (
  database: ReturnType<typeof drizzle>,
  organizationId: string
) => {
  const results = await database
    .select()
    .from(schema.product)
    .where(eq(schema.product.organizationId, organizationId));
  return results.length;
};

app.openapi(HelloWorldRoute, context => {
  return context.json({ text: 'Hello from Product Service!' });
});

app.openapi(CreateCrawlerJobRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const body = context.req.valid('json');
  const jobId = crypto.randomUUID();
  const timestamp = new Date();

  await createCrawlerJobInDatabase(
    database,
    jobId,
    body.organizationId,
    body.onboardingId,
    body.sourceType,
    body.sourceValue,
    timestamp
  );

  await sendCrawlJobToQueue(
    context.env.PRODUCT_CRAWL_QUEUE,
    jobId,
    body.organizationId,
    body.sourceValue
  );

  const job = await fetchCrawlerJobById(database, jobId);
  return context.json(formatCrawlerJobResponse(job!), 201);
});

app.openapi(GetCrawlerJobRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { id } = context.req.valid('param');

  const job = await fetchCrawlerJobById(database, id);
  if (!job) return context.json({ error: 'Not found' }, 404);

  return context.json(formatCrawlerJobResponse(job));
});

app.openapi(GetCrawlerJobsByOrgRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { organizationId } = context.req.valid('param');

  const jobs = await fetchCrawlerJobsByOrganization(database, organizationId);
  return context.json({ jobs: jobs.map(formatCrawlerJobResponse) });
});

app.openapi(GetProductRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { id } = context.req.valid('param');

  const product = await fetchProductById(database, id);
  if (!product) return context.json({ error: 'Not found' }, 404);

  return context.json(formatProductResponse(product));
});

app.openapi(GetProductsByOrgRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { organizationId } = context.req.valid('param');
  const { page: pageStr, pageSize: pageSizeStr } = context.req.valid('query');

  const page = Number.parseInt(pageStr || '1', 10);
  const pageSize = Number.parseInt(pageSizeStr || '20', 10);

  const products = await fetchPaginatedProductsByOrganization(
    database,
    organizationId,
    page,
    pageSize
  );

  const total = await countProductsByOrganization(database, organizationId);

  return context.json({
    products: products.map(formatProductResponse),
    total,
    page,
    pageSize,
  });
});

app.openapi(TriggerCrawlerJobRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { id } = context.req.valid('param');

  const job = await fetchCrawlerJobById(database, id);
  if (!job) return context.json({ error: 'Not found' }, 404);

  await processProductCrawlJob(context.env, {
    jobId: id,
    organizationId: job.organizationId,
    url: job.sourceValue,
  });

  const updatedJob = await fetchCrawlerJobById(database, id);
  return context.json(formatCrawlerJobResponse(updatedJob!));
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
  queue: (batch: MessageBatch<CrawlJobMessage>, environment: Environment) =>
    handleQueueBatch(batch, environment),
};
