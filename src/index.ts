import type { CrawlJobMessage, Environment } from './types';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { logger } from 'hono/logger';
import { poweredBy } from 'hono/powered-by';
import * as schema from './db/schema';
import { handleQueueBatch } from './queues';
import { processProductCrawlJob } from './queues/product-crawl';
import {
  CrawlCallbackRoute,
  CreateCrawlerJobRoute,
  CreateProductRoute,
  DebugExtractRoute,
  DebugImageDescriptionRoute,
  GetCrawlerJobRoute,
  GetCrawlerJobsByOrgRoute,
  GetProductAiDescriptionsRoute,
  GetProductCategoriesRoute,
  GetProductRoute,
  GetProductsByOrgRoute,
  HealthRoute,
  HelloWorldRoute,
  SearchProductsRoute,
  TriggerCrawlerJobRoute,
  UpdateProductRoute,
} from './routes';
import {
  extractProductsFromChunks,
  extractProductsFromPage,
} from './services/ai-extraction';
import { crawlPageWithBrowser } from './services/browser-crawler';
import { fetchCrawlResults } from './services/crawler-client';
import {
  generateDescriptionsForProduct,
  generateImageDescription,
} from './services/image-description';
import {
  searchProducts,
  vectorizeProducts,
} from './services/product-vectorize';

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
  name: product.title,
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

app.openapi(HealthRoute, context => {
  return context.json({ status: 'ok', service: 'core-product-service' });
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

app.openapi(CreateProductRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const body = context.req.valid('json');
  const productId = crypto.randomUUID();
  const timestamp = new Date();

  const metadata: Record<string, unknown> = {};
  if (body.currency != null) metadata.currency = body.currency;
  if (body.url != null) metadata.url = body.url;
  if (body.sku != null) metadata.sku = body.sku;
  if (body.inStock != null) metadata.inStock = body.inStock;

  await database.insert(schema.product).values({
    id: productId,
    organizationId: body.organizationId,
    externalId: crypto.randomUUID(),
    title: body.name,
    description: body.description ?? '',
    images: JSON.stringify(body.imageUrl ? [body.imageUrl] : []),
    price: body.price != null ? Math.round(body.price * 100) : null,
    category: body.category ?? null,
    metadata:
      Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  const product = await fetchProductById(database, productId);
  return context.json(formatProductResponse(product!), 201);
});

app.openapi(SearchProductsRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { q, organizationId, limit: limitStr } = context.req.valid('query');
  const limit = Number.parseInt(limitStr || '20', 10);

  try {
    // Use vectorize for semantic search
    const vectorResults = await searchProducts(
      context.env,
      q,
      organizationId,
      limit
    );

    if (vectorResults.length > 0) {
      const productIds = vectorResults.map(r => r.id);
      const products = await database
        .select()
        .from(schema.product)
        .where(
          sql`${schema.product.id} IN (${sql.join(
            productIds.map(id => sql`${id}`),
            sql`, `
          )})`
        );

      // Sort by vector search score order
      const productMap = new Map(products.map(p => [p.id, p]));
      const sortedProducts = productIds
        .map(id => productMap.get(id))
        .filter(Boolean) as (typeof schema.product.$inferSelect)[];

      return context.json({
        products: sortedProducts.map(formatProductResponse),
        total: sortedProducts.length,
        page: 1,
        pageSize: limit,
      });
    }
  } catch (err) {
    console.error(
      '[search] Vectorize search failed, falling back to SQL:',
      err
    );
  }

  // Fallback to SQL LIKE search
  const searchTerm = `%${q}%`;
  const products = await database
    .select()
    .from(schema.product)
    .where(
      sql`${schema.product.organizationId} = ${organizationId} AND (${schema.product.title} LIKE ${searchTerm} OR ${schema.product.description} LIKE ${searchTerm} OR ${schema.product.category} LIKE ${searchTerm})`
    )
    .limit(limit);

  return context.json({
    products: products.map(formatProductResponse),
    total: products.length,
    page: 1,
    pageSize: limit,
  });
});

app.openapi(GetProductCategoriesRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { organizationId } = context.req.valid('query');

  const rows = await database
    .select({
      category: schema.product.category,
    })
    .from(schema.product)
    .where(eq(schema.product.organizationId, organizationId));

  const counts: Record<string, number> = {};
  for (const row of rows) {
    const cat = row.category ?? 'uncategorized';
    counts[cat] = (counts[cat] ?? 0) + 1;
  }

  const categories = Object.entries(counts).map(([name, count]) => ({
    name,
    count,
  }));

  return context.json({ categories });
});

app.openapi(GetProductRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { id } = context.req.valid('param');

  const product = await fetchProductById(database, id);
  if (!product) return context.json({ error: 'Not found' }, 404);

  return context.json(formatProductResponse(product));
});

app.openapi(UpdateProductRoute, async context => {
  const database = drizzle(context.env.DB, { schema });
  const { id } = context.req.valid('param');
  const body = context.req.valid('json');

  const existing = await fetchProductById(database, id);
  if (!existing) return context.json({ error: 'Not found' }, 404);

  const existingMetadata: Record<string, unknown> = existing.metadata
    ? JSON.parse(existing.metadata)
    : {};

  if (body.currency !== undefined) existingMetadata.currency = body.currency;
  if (body.url !== undefined) existingMetadata.url = body.url;
  if (body.sku !== undefined) existingMetadata.sku = body.sku;
  if (body.inStock !== undefined) existingMetadata.inStock = body.inStock;

  const updates: Partial<typeof schema.product.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.name !== undefined) updates.title = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.price !== undefined)
    updates.price = body.price != null ? Math.round(body.price * 100) : null;
  if (body.category !== undefined) updates.category = body.category;
  if (body.imageUrl !== undefined) {
    updates.images = JSON.stringify(body.imageUrl ? [body.imageUrl] : []);
  }
  updates.metadata =
    Object.keys(existingMetadata).length > 0
      ? JSON.stringify(existingMetadata)
      : null;

  await database
    .update(schema.product)
    .set(updates)
    .where(eq(schema.product.id, id));

  const updated = await fetchProductById(database, id);
  return context.json(formatProductResponse(updated!));
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
  if (!product) return context.json({ error: 'Not found' }, 404);

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

app.openapi(CrawlCallbackRoute, async context => {
  // Validate shared secret - this endpoint bypasses the API gateway
  const crawlerSecret = context.env.CRAWLER_SERVICE_SECRET;
  if (crawlerSecret) {
    const requestSecret = context.req.header('X-Crawler-Secret');
    if (requestSecret !== crawlerSecret) {
      return context.json({ error: 'Unauthorized' }, 401);
    }
  }

  const database = drizzle(context.env.DB, { schema });
  const { id: jobId } = context.req.valid('param');
  const body = context.req.valid('json');

  // Fetch the job to verify it exists and get the organizationId
  const job = await fetchCrawlerJobById(database, jobId);
  if (!job) {
    return context.json({ error: 'Not found' }, 404);
  }

  // Idempotency: if the job is already completed or failed, skip processing
  if (job.status === 'completed' || job.status === 'failed') {
    return context.json({
      success: true,
      message: `Job already ${job.status}, skipping duplicate callback`,
    });
  }

  // Handle error callback from crawler service
  if (body.error) {
    console.error(`[CALLBACK] Crawl failed for job ${jobId}: ${body.error}`);
    await database
      .update(schema.crawlerJob)
      .set({
        status: 'failed',
        errorMessage: body.error,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.crawlerJob.id, jobId));

    return context.json({
      success: true,
      message: 'Job marked as failed',
    });
  }

  // Handle success callback
  if (!body.crawlId) {
    return context.json({
      success: false,
      message: 'Missing crawlId in callback payload',
    });
  }

  try {
    // Fetch crawl results from infra-crawl-service
    const crawlResults = await fetchCrawlResults(context.env, body.crawlId);

    console.warn(
      `[CALLBACK] Fetched ${crawlResults.chunks.length} chunks for job ${jobId}`
    );

    // Convert chunks to the format expected by extractProductsFromChunks
    const textChunks = crawlResults.chunks.map(chunk => ({
      url: chunk.url,
      title: chunk.title,
      chunk_index: chunk.chunk_index,
      total_chunks_for_page: 1,
      text: chunk.text,
      word_count: chunk.word_count,
      crawled_at: crawlResults.metadata.timestamp,
    }));

    // Extract products from chunks
    const extractedProducts = await extractProductsFromChunks(
      context.env,
      textChunks
    );

    console.warn(
      `[CALLBACK] Extracted ${extractedProducts.length} products for job ${jobId}`
    );

    // Save products to database
    const timestamp = new Date();
    const savedProducts: Array<{
      id: string;
      organizationId: string;
      title: string;
      description: string;
      category: string | null;
      price: number | null;
      images: string[];
    }> = [];

    for (const product of extractedProducts) {
      const productId = crypto.randomUUID();
      await database.insert(schema.product).values({
        id: productId,
        organizationId: job.organizationId,
        externalId: product.id,
        title: product.title,
        description: product.description,
        images: JSON.stringify(product.images),
        price: product.price ? Math.round(product.price * 100) : null,
        category: null ?? null,
        metadata: JSON.stringify({
          brand: null,
          currency: product.currency,
          variants: null,
          inStock: null,
          sourceUrl: product.url,
        }),
        crawlerJobId: jobId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      savedProducts.push({
        id: productId,
        organizationId: job.organizationId,
        title: product.title,
        description: product.description,
        category: null ?? null,
        price: product.price ? Math.round(product.price * 100) : null,
        images: product.images,
      });
    }

    // Mark job as completed
    await database
      .update(schema.crawlerJob)
      .set({
        status: 'completed',
        productsFound: extractedProducts.length,
        productsProcessed: extractedProducts.length,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.crawlerJob.id, jobId));

    // Generate AI image descriptions
    console.warn(
      `[CALLBACK] Starting AI description generation for ${savedProducts.length} products`
    );
    for (const product of savedProducts) {
      if (product.images.length > 0) {
        try {
          await generateDescriptionsForProduct(context.env, {
            id: product.id,
            images: product.images.slice(0, 3),
          });
        } catch (descError) {
          console.error(
            `[CALLBACK] Failed to generate descriptions for product ${product.id}:`,
            descError
          );
        }
      }
    }
    console.warn(`[CALLBACK] AI description generation complete`);

    // Vectorize products for search
    try {
      await vectorizeProducts(context.env, savedProducts);
      console.warn(`[CALLBACK] Vectorized ${savedProducts.length} products`);
    } catch (err) {
      console.error('[CALLBACK] Failed to vectorize products:', err);
    }

    // Trigger organization context generation
    try {
      const orgContextUrl = context.env.ORGANIZATION_SERVICE_URL || '';
      if (orgContextUrl) {
        await fetch(
          `${orgContextUrl}/api/v1/organizations/${job.organizationId}/context/trigger?crawl_id=${jobId}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(context.env.INTERNAL_GATEWAY_KEY
                ? { 'X-Internal-Key': context.env.INTERNAL_GATEWAY_KEY }
                : {}),
            },
            body: JSON.stringify({}),
          }
        );
        console.warn(
          `[CALLBACK] Triggered org context generation for ${job.organizationId}`
        );
      }
    } catch (err) {
      console.error(
        '[CALLBACK] Failed to trigger org context generation:',
        err
      );
    }

    return context.json({
      success: true,
      message: `Processed ${extractedProducts.length} products`,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(
      `[CALLBACK] Failed to process callback for job ${jobId}:`,
      error
    );

    // Mark job as failed
    await database
      .update(schema.crawlerJob)
      .set({
        status: 'failed',
        errorMessage: `Callback processing failed: ${errorMsg}`,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.crawlerJob.id, jobId));

    return context.json({
      success: false,
      message: `Failed to process callback: ${errorMsg}`,
    });
  }
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
  async queue(batch, _env, _ctx) {
    for (const message of batch.messages) {
      console.warn('Processing message:', message.id);
      message.ack();
    }
  },
};
