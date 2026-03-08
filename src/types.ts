import type { BrowserWorker } from '@cloudflare/puppeteer';
import { z } from '@hono/zod-openapi';

export interface Environment {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  AI: Ai;
  BROWSER: BrowserWorker;
  PRODUCT_CRAWL_QUEUE: Queue;
  VECTORIZE: VectorizeIndex;
  ENVIRONMENT: 'local' | 'dev' | 'prod';
  AI_GATEWAY_ID: string;
  AI_MODEL: string;
  CLOUDFLARE_D1_ACCOUNT_ID: string;
  CLOUDFLARE_D1_API_TOKEN: string;
  CRAWLER_SERVICE_URL: string;
  CRAWLER_SERVICE_SECRET: string;
  AUTH_SERVICE_URL: string;
  BETTER_AUTH_SECRET: string;
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
  crawlId?: string;
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
    organizationId: z.string().uuid(),
    onboardingId: z.string().optional(),
    sourceType: z.enum(['url', 'csv', 'json']),
    sourceValue: z.string().max(2048),
  })
  .refine(
    data => {
      if (data.sourceType !== 'url') return true;
      if (!URL.canParse(data.sourceValue)) return false;
      const u = new URL(data.sourceValue);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      // Block private/loopback/link-local hosts (SSRF protection)
      const host = u.hostname.toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1')
        return false;
      if (/^10\./.test(host)) return false;
      if (/^192\.168\./.test(host)) return false;
      if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return false;
      if (/^169\.254\./.test(host)) return false;
      // Block internal CROW service hostnames (SSRF via internal subdomain bypass)
      if (host.endsWith('.crowai.dev')) return false;
      if (/\.internal\./i.test(host)) return false;
      if (
        host.endsWith('.internal') ||
        host.endsWith('.local') ||
        host.endsWith('.localhost')
      )
        return false;
      return true;
    },
    {
      message: 'Invalid URL format. Please provide a valid HTTP/HTTPS URL.',
      path: ['sourceValue'],
    }
  )
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
    metadata: z.record(z.string(), z.unknown()).nullable(),
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
