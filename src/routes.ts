import { createRoute, z } from '@hono/zod-openapi';
import {
  CrawlerJobSchema,
  CreateCrawlerJobSchema,
  HelloWorldSchema,
  ProductListSchema,
  ProductSchema,
} from './types';

export const CreateProductRoute = createRoute({
  method: 'post',
  path: '/api/v1/products',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            organizationId: z.string(),
            name: z.string(),
            description: z.string().optional().default(''),
            price: z.number().optional().nullable(),
            currency: z.string().optional().nullable(),
            category: z.string().optional().nullable(),
            url: z.string().optional().nullable(),
            imageUrl: z.string().optional().nullable(),
            sku: z.string().optional().nullable(),
            inStock: z.boolean().optional().nullable(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: ProductSchema } },
      description: 'Product created',
    },
  },
});

export const UpdateProductRoute = createRoute({
  method: 'patch',
  path: '/api/v1/products/{id}',
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().optional(),
            description: z.string().optional(),
            price: z.number().optional().nullable(),
            currency: z.string().optional().nullable(),
            category: z.string().optional().nullable(),
            url: z.string().optional().nullable(),
            imageUrl: z.string().optional().nullable(),
            sku: z.string().optional().nullable(),
            inStock: z.boolean().optional().nullable(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ProductSchema } },
      description: 'Product updated',
    },
    404: {
      description: 'Product not found',
    },
  },
});

export const SearchProductsRoute = createRoute({
  method: 'get',
  path: '/api/v1/products/search',
  request: {
    query: z.object({
      q: z.string(),
      organizationId: z.string(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ProductListSchema } },
      description: 'Search results',
    },
  },
});

export const GetProductCategoriesRoute = createRoute({
  method: 'get',
  path: '/api/v1/products/categories',
  request: {
    query: z.object({
      organizationId: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            categories: z.array(
              z.object({
                name: z.string(),
                count: z.number(),
              })
            ),
          }),
        },
      },
      description: 'Product categories',
    },
  },
});

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

export const HealthRoute = createRoute({
  method: 'get',
  path: '/health',
  request: {},
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            status: z.string(),
            service: z.string(),
          }),
        },
      },
      description: 'Health check',
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

export const CrawlCallbackRoute = createRoute({
  method: 'post',
  path: '/api/v1/crawler-jobs/{id}/crawl-callback',
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            crawlId: z.string().optional(),
            productsFound: z.number().optional(),
            error: z.string().optional(),
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
            success: z.boolean(),
            message: z.string(),
          }),
        },
      },
      description: 'Callback processed',
    },
    401: {
      description: 'Unauthorized',
    },
    404: {
      description: 'Job not found',
    },
    409: {
      description: 'Job already processed',
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
