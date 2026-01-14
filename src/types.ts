import { z } from '@hono/zod-openapi';

export interface Environment {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  AI: Ai;
  ENVIRONMENT: 'local' | 'dev' | 'prod';
}

export interface CrawlJobMessage {
  jobId: string;
  organizationId: string;
  url: string;
}

export const HelloWorldSchema = z
  .object({
    text: z.string(),
  })
  .openapi('HelloWorld');

export const CrawlerJobSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    onboardingId: z.string().nullable(),
    sourceType: z.enum(['url', 'csv', 'json']),
    sourceValue: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
    productsFound: z.number(),
    productsProcessed: z.number(),
    errorMessage: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('CrawlerJob');

export const CreateCrawlerJobSchema = z
  .object({
    organizationId: z.string(),
    onboardingId: z.string().optional(),
    sourceType: z.enum(['url', 'csv', 'json']),
    sourceValue: z.string(),
  })
  .openapi('CreateCrawlerJob');

export const ProductSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    externalId: z.string(),
    title: z.string(),
    description: z.string(),
    images: z.array(z.string()),
    price: z.number().nullable(),
    category: z.string().nullable(),
    metadata: z.record(z.unknown()).nullable(),
    crawlerJobId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Product');

export const ProductListSchema = z
  .object({
    products: z.array(ProductSchema),
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
  })
  .openapi('ProductList');

export const ExtractedProductSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  images: z.array(z.string()),
  price: z.number().optional(),
  category: z.string().optional(),
});

export const ProductBatchExtractionSchema = z.object({
  products: z.array(ExtractedProductSchema),
  unprocessedContent: z.string().optional(),
});
