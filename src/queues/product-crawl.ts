import type { ExtractedProduct } from '../services/extraction';
import type { CrawlJobMessage, Environment } from '../types';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import {
  crawlAndExtractProducts,
  extractProductsFromCsv,
  extractProductsFromJson,
} from '../services/extraction';
import { generateDescriptionsForProduct } from '../services/image-description';
import { vectorizeProducts } from '../services/product-vectorize';

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
  productsCount: number
) => {
  await database
    .update(schema.crawlerJob)
    .set({
      status: 'completed',
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
  organizationId: string;
  title: string;
  description: string;
  category: string | null;
  price: number | null;
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
      organizationId,
      title: product.title,
      description: product.description,
      category: null ?? null,
      price: product.price ? Math.round(product.price * 100) : null,
      images: product.images,
    });
  }

  return savedProducts;
};

const extractErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : 'Unknown error';
};

export const processProductCrawlJob = async (
  environment: Environment,
  message: CrawlJobMessage
) => {
  const database = drizzle(environment.DB, { schema });
  const { jobId, organizationId } = message;

  await markJobAsInProgress(database, jobId);

  try {
    const job = await fetchCrawlerJobFromDatabase(database, jobId);
    let extractedProducts: ExtractedProduct[] = [];

    if (job.sourceType === 'url') {
      const result = await crawlAndExtractProducts(
        environment,
        job.sourceValue,
        {
          maxPages: 20,
          maxProducts: 50,
          useSitemap: true,
          useBrowserDiscovery: false,
          useCrawlerService: !!environment.CRAWLER_SERVICE_URL,
          jobId,
          organizationId,
        }
      );

      // If an async job was scheduled, the callback will handle product
      // extraction and job completion. Return early and leave the job
      // in "in_progress" status.
      if (result.asyncJobId) {
        console.warn(
          `[QUEUE] Async crawl scheduled for job ${jobId}, waiting for callback`
        );
        return;
      }

      extractedProducts = result.products;

      if (result.errors.length > 0) {
        console.warn(
          `[QUEUE] Crawl completed with ${result.errors.length} errors:`,
          result.errors
        );
      }
    } else if (job.sourceType === 'json') {
      extractedProducts = extractProductsFromJson(job.sourceValue);
    } else if (job.sourceType === 'csv') {
      extractedProducts = extractProductsFromCsv(job.sourceValue);
    } else {
      throw new Error(`Unsupported source type: ${job.sourceType}`);
    }

    const savedProducts = await saveProductsToDatabase(
      database,
      organizationId,
      jobId,
      extractedProducts
    );
    await markJobAsCompleted(database, jobId, extractedProducts.length);

    console.warn(
      `[QUEUE] Starting AI description generation for ${savedProducts.length} products`
    );
    for (const product of savedProducts) {
      if (product.images.length > 0) {
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
        }
      }
    }
    console.warn(`[QUEUE] AI description generation complete`);

    // Vectorize products for search (include AI image descriptions)
    try {
      const productsWithDescriptions = await Promise.all(
        savedProducts.map(async product => {
          const descriptions = await database
            .select({ description: schema.productAiDescription.description })
            .from(schema.productAiDescription)
            .where(eq(schema.productAiDescription.productId, product.id));
          return {
            ...product,
            imageDescriptions: descriptions.map(d => d.description),
          };
        })
      );
      await vectorizeProducts(environment, productsWithDescriptions);
      console.warn(
        `[crawl] Vectorized ${savedProducts.length} products with image descriptions`
      );
    } catch (err) {
      console.error('[crawl] Failed to vectorize products:', err);
      // Don't fail the job - vectorization can be retried
    }

    // Trigger organization context generation
    try {
      const orgContextUrl = environment.ORGANIZATION_SERVICE_URL || '';
      if (orgContextUrl) {
        await fetch(
          `${orgContextUrl}/api/v1/organizations/${organizationId}/context/trigger?crawl_id=${jobId}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(environment.INTERNAL_GATEWAY_KEY
                ? { 'X-Internal-Key': environment.INTERNAL_GATEWAY_KEY }
                : {}),
            },
            body: JSON.stringify({}),
          }
        );
        console.warn(
          `[crawl] Triggered org context generation for ${organizationId}`
        );
      }
    } catch (err) {
      console.error('[crawl] Failed to trigger org context generation:', err);
    }
  } catch (error) {
    console.error(`[QUEUE] Job ${jobId} failed:`, error);
    await markJobAsFailed(database, jobId, extractErrorMessage(error));
    throw error;
  }
};
