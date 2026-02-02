import { createRoute, z } from '@hono/zod-openapi';
import {
  CrawlerJobSchema,
  CreateCrawlerJobSchema,
  HelloWorldSchema,
  ProductListSchema,
  ProductSchema,
} from './types';

export {
  CrawlNowRoute,
  GetCrawlerProgressRoute,
  UpdateCrawlerProgressRoute,
  CompleteCrawlerJobRoute,
} from './routes/crawl-now';

export const HelloWorldRoute = createRoute({
  method: 'get',
  path: '/',
  request: {},
  responses: {
    200: {
      content: { 'application/json': { schema: HelloWorldSchema } },
      description: 'Hello World',
    },
  },
});

export const CreateCrawlerJobRoute = createRoute({
  method: 'post',
  path: '/api/v1/crawler-jobs',
  request: {
    body: {
      content: { 'application/json': { schema: CreateCrawlerJobSchema } },
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: CrawlerJobSchema } },
      description: 'Crawler job created',
    },
  },
});

export const GetCrawlerJobRoute = createRoute({
  method: 'get',
  path: '/api/v1/crawler-jobs/{id}',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: CrawlerJobSchema } },
      description: 'Crawler job found',
    },
    404: {
      description: 'Crawler job not found',
    },
  },
});

export const GetCrawlerJobsByOrgRoute = createRoute({
  method: 'get',
  path: '/api/v1/crawler-jobs/organization/{organizationId}',
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ jobs: z.array(CrawlerJobSchema) }),
        },
      },
      description: 'Crawler jobs for organization',
    },
  },
});

export const GetProductRoute = createRoute({
  method: 'get',
  path: '/api/v1/products/{id}',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ProductSchema } },
      description: 'Product found',
    },
    404: {
      description: 'Product not found',
    },
  },
});

export const GetProductsByOrgRoute = createRoute({
  method: 'get',
  path: '/api/v1/products/organization/{organizationId}',
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      page: z.string().optional(),
      pageSize: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ProductListSchema } },
      description: 'Products for organization',
    },
  },
});

export const TriggerCrawlerJobRoute = createRoute({
  method: 'post',
  path: '/api/v1/crawler-jobs/{id}/trigger',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: CrawlerJobSchema } },
      description: 'Crawler job triggered',
    },
    404: {
      description: 'Crawler job not found',
    },
  },
});

export const DebugExtractRoute = createRoute({
  method: 'post',
  path: '/api/v1/debug/extract',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            url: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            html: z.string(),
            htmlLength: z.number(),
            products: z.array(z.unknown()),
            error: z.string().nullable(),
          }),
        },
      },
      description: 'Debug extraction result',
    },
  },
});

const AiDescriptionSchema = z.object({
  id: z.string(),
  productId: z.string(),
  imageUrl: z.string(),
  description: z.string(),
  features: z.array(z.string()).nullable(),
  colors: z.array(z.string()).nullable(),
  materials: z.array(z.string()).nullable(),
  style: z.string().nullable(),
  modelUsed: z.string(),
  createdAt: z.string(),
});

export const GetProductAiDescriptionsRoute = createRoute({
  method: 'get',
  path: '/api/v1/products/{id}/ai-descriptions',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            descriptions: z.array(AiDescriptionSchema),
          }),
        },
      },
      description: 'AI descriptions for product',
    },
    404: {
      description: 'Product not found',
    },
  },
});

export const DebugImageDescriptionRoute = createRoute({
  method: 'post',
  path: '/api/v1/debug/image-description',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            imageUrl: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            imageUrl: z.string(),
            description: z.string(),
            features: z.array(z.string()),
            colors: z.array(z.string()),
            materials: z.array(z.string()),
            style: z.string(),
            error: z.string().nullable(),
          }),
        },
      },
      description: 'Debug image description result',
    },
  },
});
