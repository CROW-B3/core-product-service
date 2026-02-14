import type { TextChunk } from '../services/ai-extraction';
import type { ExtractedProduct } from '../services/extraction';
import type { CrawlJobMessage, Environment } from '../types';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { sign } from 'hono/jwt';
import * as schema from '../db/schema';
import { extractProductsFromChunks } from '../services/ai-extraction';
import { fetchCrawlResults } from '../services/crawler-client';
import {
  crawlAndExtractProducts,
  extractProductsFromCsv,
  extractProductsFromJson,
} from '../services/extraction';
import { generateDescriptionsForProduct } from '../services/image-description';

const markJobAsInProgress = async (
  database: ReturnType<typeof drizzle>,
  jobId: string
) => {
  await database
    .update(schema.crawlerJob)
    .set({
      status: 'in_progress',
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.crawlerJob.id, jobId));
};

const markJobAsCompleted = async (
  database: ReturnType<typeof drizzle>,
  jobId: string,
  productsCount: number,
  crawlId?: string
) => {
  await database
    .update(schema.crawlerJob)
    .set({
      status: 'completed',
      crawlId: crawlId ?? null,
      productsFound: productsCount,
      productsProcessed: productsCount,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.crawlerJob.id, jobId));
};

const markJobAsFailed = async (
  database: ReturnType<typeof drizzle>,
  jobId: string,
  errorMessage: string
) => {
  await database
    .update(schema.crawlerJob)
    .set({
      status: 'failed',
      errorMessage,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.crawlerJob.id, jobId));
};

const fetchCrawlerJobFromDatabase = async (
  database: ReturnType<typeof drizzle>,
  jobId: string
) => {
  const results = await database
    .select()
    .from(schema.crawlerJob)
    .where(eq(schema.crawlerJob.id, jobId))
    .limit(1);
  if (!results[0]) throw new Error('Job not found');
  return results[0];
};

interface SavedProduct {
  id: string;
  images: string[];
}

const saveProductsToDatabase = async (
  database: ReturnType<typeof drizzle>,
  organizationId: string,
  jobId: string,
  products: ExtractedProduct[]
): Promise<SavedProduct[]> => {
  const timestamp = new Date();
  const savedProducts: SavedProduct[] = [];

  for (const product of products) {
    const productId = crypto.randomUUID();
    await database.insert(schema.product).values({
      id: productId,
      organizationId,
      externalId: product.id,
      title: product.title,
      description: product.description,
      images: JSON.stringify(product.images),
      price: product.price ? Math.round(product.price * 100) : null,
      category: product.category ?? null,
      metadata: JSON.stringify({
        brand: product.brand,
        currency: product.currency,
        variants: product.variants,
        inStock: product.inStock,
        sourceUrl: product.url,
      }),
      crawlerJobId: jobId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    savedProducts.push({ id: productId, images: product.images });
  }

  return savedProducts;
};

const extractErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : 'Unknown error';
};

const getOrganizationServiceUrl = (environment: string): string => {
  switch (environment) {
    case 'prod':
      return 'https://internal.orgs.crowai.dev';
    case 'dev':
      return 'https://dev.internal.orgs.crowai.dev';
    default:
      return 'http://localhost:8004';
  }
};

const createSystemHeaders = async (
  secret: string
): Promise<Record<string, string>> => {
  const token = await sign(
    {
      sub: 'system',
      type: 'system',
      service: 'product-service',
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret,
    'HS256'
  );
  return {
    'X-System-Token': 'true',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
};

const triggerOrganizationContext = async (
  environment: Environment,
  organizationId: string,
  crawlId: string
) => {
  try {
    const orgServiceUrl = getOrganizationServiceUrl(environment.ENVIRONMENT);
    const headers = await createSystemHeaders(environment.BETTER_AUTH_SECRET);
    const response = await fetch(
      `${orgServiceUrl}/api/v1/organizations/${organizationId}/context/trigger`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ crawl_id: crawlId }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[QUEUE] Failed to trigger organization context: ${response.status} ${errorText}`
      );
    } else {
      console.warn(
        `[QUEUE] Organization context generation triggered for ${organizationId}`
      );
    }
  } catch (error) {
    console.error('[QUEUE] Error triggering organization context:', error);
  }
};

export const processProductCrawlJob = async (
  environment: Environment,
  message: CrawlJobMessage
) => {
  const database = drizzle(environment.DB, { schema });
  const { jobId, organizationId, crawlId: messageCrawlId } = message;

  await markJobAsInProgress(database, jobId);

  try {
    const job = await fetchCrawlerJobFromDatabase(database, jobId);
    let extractedProducts: ExtractedProduct[] = [];
    let crawlId: string | undefined = messageCrawlId;

    if (job.sourceType === 'url') {
      if (messageCrawlId) {
        // Crawl already done by infra-crawl-service — fetch results and extract products
        console.warn(
          `[QUEUE] Fetching pre-crawled data for crawlId: ${messageCrawlId}`
        );
        const crawlData = await fetchCrawlResults(environment, messageCrawlId);
        extractedProducts = await extractProductsFromChunks(
          environment,
          crawlData.chunks as TextChunk[]
        );
      } else {
        // Legacy path: no pre-crawled data, crawl directly
        const result = await crawlAndExtractProducts(
          environment,
          job.sourceValue,
          {
            maxPages: 30,
            maxProducts: 100,
            useSitemap: true,
            useBrowserDiscovery: true,
          }
        );

        extractedProducts = result.products;
        crawlId = result.crawlId;

        if (result.errors.length > 0) {
          console.warn(
            `[QUEUE] Crawl completed with ${result.errors.length} errors:`,
            result.errors
          );
        }
      }
    } else if (job.sourceType === 'json') {
      extractedProducts = extractProductsFromJson(job.sourceValue);
    } else if (job.sourceType === 'csv') {
      extractedProducts = extractProductsFromCsv(job.sourceValue);
    } else {
      throw new Error(`Unsupported source type: ${job.sourceType}`);
    }

    console.warn(
      `[QUEUE] Extracted ${extractedProducts.length} products, saving to DB`
    );

    const savedProducts = await saveProductsToDatabase(
      database,
      organizationId,
      jobId,
      extractedProducts
    );
    await markJobAsCompleted(
      database,
      jobId,
      extractedProducts.length,
      crawlId
    );

    console.warn(`[QUEUE] Saved ${savedProducts.length} products to DB`);

    // Trigger organization context generation if we have a crawl_id
    if (crawlId && job.sourceType === 'url') {
      await triggerOrganizationContext(environment, organizationId, crawlId);
    }

    // Generate AI image descriptions (best-effort, don't fail the job)
    const productsWithImages = savedProducts.filter(p => p.images.length > 0);
    if (productsWithImages.length > 0) {
      console.warn(
        `[QUEUE] Generating AI descriptions for ${productsWithImages.length} products (best-effort)`
      );
      for (const product of productsWithImages) {
        try {
          await generateDescriptionsForProduct(environment, {
            id: product.id,
            images: product.images.slice(0, 3),
          });
        } catch (descError) {
          console.error(
            `[QUEUE] Failed to generate descriptions for product ${product.id}:`,
            descError
          );
          // Continue — don't let image description failures block the pipeline
        }
      }
      console.warn(`[QUEUE] AI description generation complete`);
    }
  } catch (error) {
    console.error(`[QUEUE] Job ${jobId} failed:`, error);
    await markJobAsFailed(database, jobId, extractErrorMessage(error));
    throw error;
  }
};
