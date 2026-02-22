import type { CrawlJobMessage, Environment } from './types';
import { OpenAPIHono } from '@hono/zod-openapi';
import { count, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { logger } from 'hono/logger';
import { poweredBy } from 'hono/powered-by';
import { createLogger } from './config/logger';
import { validateEnv } from './config/validate-env';
import * as schema from './db/schema';
import { handleQueueBatch } from './queues';
import { processProductCrawlJob } from './queues/product-crawl';
import {
  CompleteCrawlerJobRoute,
  CrawlNowRoute,
  CreateCrawlerJobRoute,
  DebugExtractRoute,
  DebugImageDescriptionRoute,
  GetCrawlerJobRoute,
  GetCrawlerJobsByOrgRoute,
  GetProductAiDescriptionsRoute,
  GetProductImageRoute,
  GetProductRoute,
  GetProductsByOrgRoute,
  HelloWorldRoute,
  SearchProductsRoute,
  TriggerCrawlerJobRoute,
} from './routes';
import { HealthCheckRoute, ReadinessCheckRoute } from './routes/health';
import { extractProductsFromPage } from './services/ai-extraction';
import { crawlPageWithBrowser } from './services/browser-crawler';
import { generateImageDescription } from './services/image-description';
import { ftsSearch, semanticSearch } from './services/vectorize';
import { handleErrorResponse } from './utils/error-handler';

async function checkDatabaseHealth(
  db: ReturnType<typeof drizzle>
): Promise<boolean> {
  try {
    await db.run('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

const app = new OpenAPIHono<{ Bindings: Environment }>();

app.use(poweredBy());
app.use(logger());

app.use('*', async (c, next) => {
  try {
    validateEnv(c.env);
  } catch (error) {
    const logger = createLogger(c.env);
    return handleErrorResponse(c, error, logger);
  }

  await next();
});

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

app.openapi(HealthCheckRoute, c => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'core-product-service',
    version: '1.0.0',
    environment: c.env.ENVIRONMENT || 'prod',
  });
});

app.openapi(ReadinessCheckRoute, async c => {
  const database = drizzle(c.env.DB, { schema });
  const isDatabaseHealthy = await checkDatabaseHealth(database);

  const isReady = isDatabaseHealthy;
  const statusCode = isReady ? 200 : 503;

  return c.json(
    {
      ready: isReady,
      checks: {
        database: isDatabaseHealthy,
      },
    },
    statusCode
  );
});

app.openapi(GetProductImageRoute, async c => {
  const { key } = c.req.valid('param');
  const object = await c.env.R2_BUCKET.get(decodeURIComponent(key));
  if (!object) return c.notFound();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000');
  return new Response(object.body, { headers });
});

app.openapi(HelloWorldRoute, context => {
  return context.json({ text: 'Hello from Product Service!' });
});

app.openapi(CreateCrawlerJobRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const body = context.req.valid('json');
  const jobId = crypto.randomUUID();
  const timestamp = new Date();
  const organizationId =
    body.organizationId ?? context.req.header('X-Organization-Id') ?? '';

  await createCrawlerJobInDatabase(
    database,
    jobId,
    organizationId,
    body.onboardingId,
    body.sourceType,
    body.sourceValue,
    timestamp
  );

  await sendCrawlJobToQueue(
    context.env.PRODUCT_CRAWL_QUEUE,
    jobId,
    organizationId,
    body.sourceValue
  );

  const job = await fetchCrawlerJobById(database, jobId);
  return context.json(formatCrawlerJobResponse(job!), 201);
});

app.openapi(GetCrawlerJobRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { id } = context.req.valid('param');

  const job = await fetchCrawlerJobById(database, id);
  if (!job) {
    return context.json(
      {
        error: {
          code: 'CRAWLER_JOB_NOT_FOUND',
          message: 'Crawler job not found',
          timestamp: new Date().toISOString(),
        },
      },
      404
    );
  }

  return context.json(formatCrawlerJobResponse(job));
});

app.openapi(GetCrawlerJobsByOrgRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { organizationId } = context.req.valid('param');

  const jobs = await fetchCrawlerJobsByOrganization(database, organizationId);
  return context.json({ jobs: jobs.map(formatCrawlerJobResponse) });
});

app.openapi(SearchProductsRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { q, organizationId, limit, mode } = context.req.valid('query');
  const maxResults = Math.min(Number.parseInt(limit ?? '10', 10) || 10, 50);
  const searchMode = mode ?? 'semantic';

  try {
    if (searchMode === 'fts') {
      const rows = await ftsSearch(context.env, organizationId, q, maxResults);
      return context.json({ results: rows, total: rows.length, query: q });
    }

    if (searchMode === 'semantic') {
      const matches = await semanticSearch(
        context.env,
        organizationId,
        q,
        maxResults
      );
      if (matches.length === 0) {
        return context.json({ results: [], total: 0, query: q });
      }
      const ids = matches.map(m => m.id);
      const products = await database
        .select()
        .from(schema.product)
        .where(inArray(schema.product.id, ids));
      const scoreMap = new Map(matches.map(m => [m.id, m.score]));
      const sorted = products
        .map(p => {
          try {
            return {
              ...formatProductResponse(p),
              _score: scoreMap.get(p.id) ?? 0,
            };
          } catch {
            return null;
          }
        })
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .sort((a, b) => b._score - a._score);
      return context.json({ results: sorted, total: sorted.length, query: q });
    }

    const [semanticMatches, ftsRows] = await Promise.allSettled([
      semanticSearch(context.env, organizationId, q, maxResults),
      ftsSearch(context.env, organizationId, q, maxResults),
    ]);

    const semanticIds =
      semanticMatches.status === 'fulfilled'
        ? semanticMatches.value.map(m => m.id)
        : [];
    const scoreMap =
      semanticMatches.status === 'fulfilled'
        ? new Map(semanticMatches.value.map(m => [m.id, m.score]))
        : new Map<string, number>();

    const ftsResults =
      ftsRows.status === 'fulfilled'
        ? (ftsRows.value as Record<string, unknown>[])
        : [];
    const ftsIds = ftsResults.map(r => r.id as string).filter(Boolean);

    const allIds = [...new Set([...semanticIds, ...ftsIds])].slice(
      0,
      maxResults
    );

    if (allIds.length === 0) {
      return context.json({ results: [], total: 0, query: q });
    }

    const products = await database
      .select()
      .from(schema.product)
      .where(inArray(schema.product.id, allIds));

    const formatted = products
      .map(p => {
        try {
          return {
            ...formatProductResponse(p),
            _score: scoreMap.get(p.id) ?? 0,
          };
        } catch {
          return null;
        }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .sort((a, b) => b._score - a._score);

    return context.json({
      results: formatted,
      total: formatted.length,
      query: q,
    });
  } catch {
    return context.json({ results: [], total: 0, query: q });
  }
});

app.openapi(GetProductRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { id } = context.req.valid('param');

  const product = await fetchProductById(database, id);
  if (!product) {
    return context.json(
      {
        error: {
          code: 'PRODUCT_NOT_FOUND',
          message: 'Product not found',
          timestamp: new Date().toISOString(),
        },
      },
      404
    );
  }

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
  if (!job) {
    return context.json(
      {
        error: {
          code: 'CRAWLER_JOB_NOT_FOUND',
          message: 'Crawler job not found',
          timestamp: new Date().toISOString(),
        },
      },
      404
    );
  }

  context.executionCtx.waitUntil(
    processProductCrawlJob(context.env, {
      jobId: id,
      organizationId: job.organizationId,
      url: job.sourceValue,
    }).catch(error => {
      console.error('[TRIGGER] Background crawl failed for job', id, error);
    })
  );

  return context.json(
    {
      job: formatCrawlerJobResponse(job),
      message: 'Crawler job accepted and running in background',
    },
    202
  );
});

app.openapi(DebugExtractRoute, async context => {
  const { url } = context.req.valid('json');
  try {
    const pageContent = await crawlPageWithBrowser(context.env, url);
    const products = await extractProductsFromPage(
      context.env,
      pageContent.html,
      url
    );
    return context.json({
      html: pageContent.html.slice(0, 2000),
      htmlLength: pageContent.html.length,
      products,
      error: null,
    });
  } catch (error) {
    return context.json({
      html: '',
      htmlLength: 0,
      products: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.openapi(GetProductAiDescriptionsRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { id } = context.req.valid('param');

  const product = await fetchProductById(database, id);
  if (!product) {
    return context.json(
      {
        error: {
          code: 'PRODUCT_NOT_FOUND',
          message: 'Product not found',
          timestamp: new Date().toISOString(),
        },
      },
      404
    );
  }

  const descriptions = await database
    .select()
    .from(schema.productAiDescription)
    .where(eq(schema.productAiDescription.productId, id));

  return context.json({
    descriptions: descriptions.map(d => ({
      ...d,
      features: d.features ? JSON.parse(d.features) : null,
      colors: d.colors ? JSON.parse(d.colors) : null,
      materials: d.materials ? JSON.parse(d.materials) : null,
      createdAt: d.createdAt.toISOString(),
    })),
  });
});

app.openapi(DebugImageDescriptionRoute, async context => {
  const { imageUrl } = context.req.valid('json');
  try {
    const result = await generateImageDescription(context.env, imageUrl);
    if (!result) {
      return context.json({
        imageUrl,
        description: '',
        features: [],
        colors: [],
        materials: [],
        style: '',
        error: 'Failed to fetch or process image',
      });
    }
    return context.json({
      ...result,
      error: null,
    });
  } catch (error) {
    return context.json({
      imageUrl,
      description: '',
      features: [],
      colors: [],
      materials: [],
      style: '',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.openapi(CrawlNowRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const body = context.req.valid('json');
  const jobId = crypto.randomUUID();
  const timestamp = new Date();
  const organizationId =
    body.organizationId ?? context.req.header('X-Organization-Id') ?? '';

  await createCrawlerJobInDatabase(
    database,
    jobId,
    organizationId,
    body.onboardingId,
    body.sourceType,
    body.sourceValue,
    timestamp
  );

  const origin = new URL(context.req.url).origin;
  const completionCallbackUrl = `${origin}/api/v1/crawler-jobs/${jobId}/complete`;
  const crawlerUrl = context.env.CRAWLER_SERVICE_URL;

  context.executionCtx.waitUntil(
    fetch(`${crawlerUrl}/api/v1/crawl`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${context.env.CRAWLER_SERVICE_SECRET}`,
      },
      body: JSON.stringify({
        jobId,
        organizationId,
        url: body.sourceValue,
        options: {
          maxPages: 30,
          maxProducts: 100,
          useSitemap: true,
        },
        callbacks: {
          completion: completionCallbackUrl,
        },
      }),
    }).catch(error => {
      console.error('Failed to call crawler:', error);
    })
  );

  const job = await fetchCrawlerJobById(database, jobId);

  return context.json({ job: formatCrawlerJobResponse(job!) }, 201);
});

app.openapi(CompleteCrawlerJobRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { id } = context.req.valid('param');
  const body = context.req.valid('json');

  await database
    .update(schema.crawlerJob)
    .set({
      status: body.error ? 'failed' : 'completed',
      crawlId: body.crawlId ?? null,
      productsFound: body.productsFound || 0,
      productsProcessed: body.productsFound || 0,
      errorMessage: body.error || null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.crawlerJob.id, id));

  if (!body.error) {
    const actualCountResult = await database
      .select({ count: count() })
      .from(schema.product)
      .where(eq(schema.product.crawlerJobId, id));
    const actualCount = actualCountResult[0]?.count ?? body.productsFound ?? 0;

    await database
      .update(schema.crawlerJob)
      .set({
        productsFound: actualCount,
        productsProcessed: actualCount,
      })
      .where(eq(schema.crawlerJob.id, id));

    const job = await fetchCrawlerJobById(database, id);
    if (job) {
      await context.env.PRODUCT_CRAWL_QUEUE.send({
        jobId: job.id,
        organizationId: job.organizationId,
        url: job.sourceValue,
        crawlId: body.crawlId,
      });
    }
  }

  return context.json({ success: true });
});

app.doc('/api/docs', {
  openapi: '3.0.0',
  info: {
    version: '1.0.0',
    title: 'CROW Product API',
    description: 'Product management and crawler service for CROW platform',
  },
});

app.notFound(c =>
  c.json({ error: 'Not Found', message: 'Route not found' }, 404)
);

app.onError((error, c) => {
  const logger = createLogger(c.env);
  return handleErrorResponse(c, error, logger);
});

export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<CrawlJobMessage>, environment: Environment) =>
    handleQueueBatch(batch, environment),
};
