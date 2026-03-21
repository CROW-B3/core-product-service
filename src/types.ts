import type { BrowserWorker } from '@cloudflare/puppeteer';
import { z } from '@hono/zod-openapi';

export interface Environment {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  AI: Ai;
  BROWSER: BrowserWorker;
  CRAWLER_KV: KVNamespace;
  PRODUCT_CRAWL_QUEUE: Queue;
  PRODUCT_VECTORIZE: VectorizeIndex;
  ENVIRONMENT: 'local' | 'dev' | 'prod';
  AI_GATEWAY_ID: string;
  AI_MODEL: string;
  CLOUDFLARE_D1_ACCOUNT_ID: string;
  CLOUDFLARE_D1_API_TOKEN: string;
  CRAWLER_SERVICE_URL: string;
  CRAWLER_SERVICE_SECRET: string;
  PRODUCT_SERVICE_URL: string;
  ORGANIZATION_SERVICE_URL: string;
  INTERNAL_GATEWAY_KEY: string;
}

export interface CrawlState {
  jobId: string;
  baseUrl: string;
  visitedUrls: string[];
  pendingUrls: string[];
  productsFound: number;
  errors: string[];
  startedAt: string;
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
  price: z.number().nullable(),
  currency: z.string().nullable(),
  category: z.string().nullable(),
  brand: z.string().nullable(),
  variants: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
      })
    )
    .nullable(),
  inStock: z.boolean().nullable(),
  url: z.string().nullable(),
});

export const ProductBatchExtractionSchema = z.object({
  products: z.array(ExtractedProductSchema),
  contextForNextChunk: z.string(),
  hasMoreContent: z.boolean(),
  confidence: z.number().min(0).max(1),
});
