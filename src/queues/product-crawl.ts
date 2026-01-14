import type { CrawlJobMessage, Environment } from '../types';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import {
  extractProductsFromCsv,
  extractProductsFromHtml,
  extractProductsFromJson,
  fetchUrlContent,
} from '../services/extraction';

const markJobInProgress = async (
  db: ReturnType<typeof drizzle>,
  jobId: string
) => {
  await db
    .update(schema.crawlerJob)
    .set({
      status: 'in_progress',
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.crawlerJob.id, jobId));
};

const markJobCompleted = async (
  db: ReturnType<typeof drizzle>,
  jobId: string,
  productsCount: number
) => {
  await db
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

const markJobFailed = async (
  db: ReturnType<typeof drizzle>,
  jobId: string,
  errorMessage: string
) => {
  await db
    .update(schema.crawlerJob)
    .set({
      status: 'failed',
      errorMessage,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.crawlerJob.id, jobId));
};

const extractProductsBySourceType = async (
  env: Environment,
  sourceType: string,
  sourceValue: string
) => {
  if (sourceType === 'url') {
    const htmlContent = await fetchUrlContent(sourceValue);
    return extractProductsFromHtml(env, htmlContent);
  }
  if (sourceType === 'json') return extractProductsFromJson(sourceValue);
  if (sourceType === 'csv') return extractProductsFromCsv(sourceValue);
  throw new Error(`Unsupported source type: ${sourceType}`);
};

const saveExtractedProducts = async (
  db: ReturnType<typeof drizzle>,
  organizationId: string,
  jobId: string,
  products: Awaited<ReturnType<typeof extractProductsBySourceType>>
) => {
  const now = new Date();

  for (const product of products) {
    await db.insert(schema.product).values({
      id: crypto.randomUUID(),
      organizationId,
      externalId: product.id,
      title: product.title,
      description: product.description,
      images: JSON.stringify(product.images),
      price: product.price ? Math.round(product.price * 100) : null,
      category: product.category ?? null,
      crawlerJobId: jobId,
      createdAt: now,
      updatedAt: now,
    });
  }
};

export const processProductCrawlJob = async (
  env: Environment,
  message: CrawlJobMessage
) => {
  const db = drizzle(env.DB, { schema });
  const { jobId, organizationId } = message;

  await markJobInProgress(db, jobId);

  try {
    const jobResult = await db
      .select()
      .from(schema.crawlerJob)
      .where(eq(schema.crawlerJob.id, jobId))
      .limit(1);

    if (!jobResult[0]) throw new Error('Job not found');

    const job = jobResult[0];
    const extractedProducts = await extractProductsBySourceType(
      env,
      job.sourceType,
      job.sourceValue
    );

    await saveExtractedProducts(db, organizationId, jobId, extractedProducts);
    await markJobCompleted(db, jobId, extractedProducts.length);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await markJobFailed(db, jobId, errorMessage);
    throw error;
  }
};
