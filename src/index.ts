import type { CrawlJobMessage, Environment } from './types';
import { OpenAPIHono } from '@hono/zod-openapi';
import { count, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { logger } from 'hono/logger';
import { poweredBy } from 'hono/powered-by';
import { createLogger } from './config/logger';
import { validateEnv } from './config/validate-env';
import * as schema from './db/schema';
import { createJWTMiddleware } from './middleware/jwt';
import { handleQueueBatch } from './queues';
import { processProductCrawlJob } from './queues/product-crawl';
import {
  BulkImageUploadRoute,
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
import {
  generateAndStoreDescriptions,
  generateImageDescription,
} from './services/image-description';
import { embedProduct, ftsSearch, semanticSearch } from './services/vectorize';
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

const app = new OpenAPIHono<{ Bindings: Environment }>({
  defaultHook: (result, c) => {
    if (!result.success) {
      // Do not leak Zod issue details — they can reveal schema structure to attackers
      return c.json(
        { error: 'Validation error', message: 'Invalid request parameters' },
        400
      );
    }
  },
});

app.onError((err, c) => {
  console.error('[UnhandledError]', err);
  return c.json({ error: 'Internal server error' }, 500);
});

app.use(poweredBy());
app.use(logger());

function isSafeHttpUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    // Block private/loopback/link-local ranges
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1')
      return false;
    if (/^10\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (/^169\.254\./.test(host)) return false;
    if (/^fd[0-9a-f]{2}:/i.test(host)) return false;
    // Block internal CROW service hostnames (SSRF via internal subdomain)
    if (host.endsWith('.crowai.dev')) return false;
    if (/\.internal\./i.test(host)) return false;
    if (
      host.endsWith('.internal') ||
      host.endsWith('.local') ||
      host.endsWith('.localhost')
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

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
  sourceType: job.sourceType as 'url' | 'csv' | 'json',
  status: job.status as 'pending' | 'in_progress' | 'completed' | 'failed',
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
    .select({ count: count() })
    .from(schema.product)
    .where(eq(schema.product.organizationId, organizationId));
  return results[0]?.count ?? 0;
};

app.openapi(HealthCheckRoute, c => {
  return c.json({
    status: 'healthy' as const,
    timestamp: new Date().toISOString(),
    service: 'core-product-service',
    version: '1.0.0',
    environment: '',
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

const SAFE_R2_KEY_PATTERN = /^[\w\-./]{1,512}$/;

app.openapi(GetProductImageRoute, async c => {
  const { key } = c.req.valid('param');
  const decodedKey = decodeURIComponent(key);
  // Reject path traversal and keys that don't match the expected safe pattern
  if (!SAFE_R2_KEY_PATTERN.test(decodedKey) || decodedKey.includes('..')) {
    return c.json({ error: 'Not Found' }, 404);
  }
  const object = await c.env.R2_BUCKET.get(decodedKey);
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
  const callerOrgId = context.req.header('X-Organization-Id') ?? '';
  const organizationId = body.organizationId ?? callerOrgId;

  if (!callerOrgId || organizationId !== callerOrgId) {
    return new Response(
      JSON.stringify({
        error: 'Forbidden',
        message: 'Access denied to this organization',
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    ) as never;
  }

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
  const callerOrgId = context.req.header('X-Organization-Id');

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

  if (!callerOrgId || job.organizationId !== callerOrgId) {
    return new Response(
      JSON.stringify({
        error: 'Forbidden',
        message: 'Access denied to this organization',
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    ) as never;
  }

  return context.json(formatCrawlerJobResponse(job));
});

app.openapi(GetCrawlerJobsByOrgRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { organizationId } = context.req.valid('param');
  const callerOrgId = context.req.header('X-Organization-Id');

  if (!callerOrgId || callerOrgId !== organizationId) {
    return new Response(
      JSON.stringify({
        error: 'Forbidden',
        message: 'Access denied to this organization',
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    ) as never;
  }

  const jobs = await fetchCrawlerJobsByOrganization(database, organizationId);
  return context.json({ jobs: jobs.map(formatCrawlerJobResponse) });
});

app.openapi(SearchProductsRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { q, organizationId, limit, mode } = context.req.valid('query');
  const callerOrgId = context.req.header('X-Organization-Id');

  if (!callerOrgId || organizationId !== callerOrgId) {
    return new Response(
      JSON.stringify({
        error: 'Forbidden',
        message: 'Access denied to this organization',
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    ) as never;
  }

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

  // BOLA: verify caller belongs to the same org as the product
  const callerOrgId = context.req.header('X-Organization-Id');
  if (!callerOrgId || product.organizationId !== callerOrgId) {
    return new Response(
      JSON.stringify({
        error: 'Forbidden',
        message: 'Access denied to this product',
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    ) as never;
  }

  return context.json(formatProductResponse(product));
});

app.openapi(GetProductsByOrgRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { organizationId } = context.req.valid('param');
  const callerOrgId = context.req.header('X-Organization-Id');

  if (!callerOrgId || callerOrgId !== organizationId) {
    return new Response(
      JSON.stringify({
        error: 'Forbidden',
        message: 'Access denied to this organization',
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    ) as never;
  }

  const { page: pageStr, pageSize: pageSizeStr } = context.req.valid('query');

  const page = Math.max(1, Number.parseInt(pageStr || '1', 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(pageSizeStr || '20', 10) || 20)
  );

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
  const callerOrgId = context.req.header('X-Organization-Id');

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

  if (!callerOrgId || job.organizationId !== callerOrgId) {
    return new Response(
      JSON.stringify({
        error: 'Forbidden',
        message: 'Access denied to this organization',
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    ) as never;
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
  if (context.env.ENVIRONMENT !== 'local') {
    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }) as never;
  }
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
  } catch {
    return context.json({
      html: '',
      htmlLength: 0,
      products: [],
      error: 'Extraction failed',
    });
  }
});

app.openapi(GetProductAiDescriptionsRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { id } = context.req.valid('param');
  const callerOrgId = context.req.header('X-Organization-Id');

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

  if (!callerOrgId || product.organizationId !== callerOrgId) {
    return new Response(
      JSON.stringify({
        error: 'Forbidden',
        message: 'Access denied to this organization',
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    ) as never;
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
  if (context.env.ENVIRONMENT !== 'local') {
    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }) as never;
  }
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
  } catch {
    return context.json({
      imageUrl,
      description: '',
      features: [],
      colors: [],
      materials: [],
      style: '',
      error: 'Image description failed',
    });
  }
});

app.openapi(CrawlNowRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const body = context.req.valid('json');
  const jobId = crypto.randomUUID();
  const timestamp = new Date();
  const callerOrgId = context.req.header('X-Organization-Id') ?? '';
  const organizationId = body.organizationId ?? callerOrgId;

  if (!callerOrgId || organizationId !== callerOrgId) {
    return new Response(
      JSON.stringify({
        error: 'Forbidden',
        message: 'Access denied to this organization',
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    ) as never;
  }

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

  // This endpoint is called by the crawler service (internal) or by the job owner.
  // Accept if: caller presents the crawler service secret OR X-Organization-Id matches job owner.
  const crawlerSecret = context.req
    .header('Authorization')
    ?.replace('Bearer ', '');
  const callerOrgId = context.req.header('X-Organization-Id');
  const isInternalCaller =
    crawlerSecret && crawlerSecret === context.env.CRAWLER_SERVICE_SECRET;

  if (!isInternalCaller) {
    const job = await fetchCrawlerJobById(database, id);
    if (!job || !callerOrgId || job.organizationId !== callerOrgId) {
      return new Response(
        JSON.stringify({ error: 'Forbidden', message: 'Access denied' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      ) as never;
    }
  }

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

app.use('/api/v1/products/bulk-image-upload', async (c, next) => {
  const jwtMiddleware = createJWTMiddleware(c.env);
  return jwtMiddleware(c, next);
});

app.openapi(BulkImageUploadRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { organizationId, imageUrls } = context.req.valid('json');
  const callerOrgId = context.req.header('X-Organization-Id');

  if (!callerOrgId || organizationId !== callerOrgId) {
    return new Response(
      JSON.stringify({
        error: 'Forbidden',
        message: 'Access denied to this organization',
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    ) as never;
  }

  let processed = 0;
  let failed = 0;
  const results: { imageUrl: string; description: string; success: boolean }[] =
    [];

  for (const imageUrl of imageUrls) {
    if (!isSafeHttpUrl(imageUrl)) {
      results.push({ imageUrl, description: '', success: false });
      failed++;
      continue;
    }
    try {
      // Find product by image URL to link the description
      const matchingProducts = await database
        .select()
        .from(schema.product)
        .where(eq(schema.product.organizationId, organizationId))
        .limit(100);

      const product = matchingProducts.find(p => {
        try {
          const imgs: string[] = JSON.parse(p.images);
          return imgs.includes(imageUrl);
        } catch {
          return false;
        }
      });

      const productId = product?.id ?? crypto.randomUUID();
      const descriptions = await generateAndStoreDescriptions(
        context.env,
        productId,
        [imageUrl]
      );

      if (descriptions.length > 0) {
        const desc = descriptions[0];
        results.push({
          imageUrl,
          description: desc.description,
          success: true,
        });
        processed++;

        // Trigger Vectorize embedding update if product exists
        if (product) {
          const aiDescs = await database
            .select()
            .from(schema.productAiDescription)
            .where(eq(schema.productAiDescription.productId, product.id));

          context.executionCtx.waitUntil(
            embedProduct(
              context.env,
              {
                id: product.id,
                organizationId: product.organizationId,
                title: product.title,
                description: product.description,
              },
              aiDescs.map(d => ({ description: d.description }))
            ).catch(err => {
              console.error(
                '[BulkImageUpload] Vectorize update failed for product',
                product.id,
                err
              );
            })
          );
        }
      } else {
        results.push({ imageUrl, description: '', success: false });
        failed++;
      }
    } catch (err) {
      console.error(
        '[BulkImageUpload] Failed to process image:',
        imageUrl,
        err
      );
      results.push({ imageUrl, description: '', success: false });
      failed++;
    }
  }

  return context.json({ processed, failed, results });
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
