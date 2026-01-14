import { createRoute, z } from '@hono/zod-openapi';
import {
  CrawlerJobSchema,
  CreateCrawlerJobSchema,
  HelloWorldSchema,
  ProductListSchema,
  ProductSchema,
} from './types';

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
