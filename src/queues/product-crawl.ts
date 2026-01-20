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

const extractProductsBasedOnSourceType = async (
  environment: Environment,
  sourceType: string,
  sourceValue: string
) => {
  if (sourceType === 'url') {
    const htmlContent = await fetchUrlContent(sourceValue);
    return extractProductsFromHtml(environment, htmlContent);
  }
  if (sourceType === 'json') return extractProductsFromJson(sourceValue);
  if (sourceType === 'csv') return extractProductsFromCsv(sourceValue);
  throw new Error(`Unsupported source type: ${sourceType}`);
};

const saveProductsToDatabase = async (
  database: ReturnType<typeof drizzle>,
  organizationId: string,
  jobId: string,
  products: Awaited<ReturnType<typeof extractProductsBasedOnSourceType>>
) => {
  const timestamp = new Date();

  for (const product of products) {
    await database.insert(schema.product).values({
      id: crypto.randomUUID(),
      organizationId,
      externalId: product.id,
      title: product.title,
      description: product.description,
      images: JSON.stringify(product.images),
      price: product.price ? Math.round(product.price * 100) : null,
      category: product.category ?? null,
      crawlerJobId: jobId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
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
    const extractedProducts = await extractProductsBasedOnSourceType(
      environment,
      job.sourceType,
      job.sourceValue
    );

    await saveProductsToDatabase(
      database,
      organizationId,
      jobId,
      extractedProducts
    );
    await markJobAsCompleted(database, jobId, extractedProducts.length);
  } catch (error) {
    await markJobAsFailed(database, jobId, extractErrorMessage(error));
    throw error;
  }
};
