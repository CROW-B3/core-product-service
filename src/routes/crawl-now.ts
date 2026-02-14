import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { CrawlerJobSchema, CreateCrawlerJobSchema } from '../types';

export const CrawlNowRoute = createRoute({
  method: 'post',
  path: '/api/v1/crawler-jobs/crawl-now',
  request: {
    body: {
      content: { 'application/json': { schema: CreateCrawlerJobSchema } },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            job: CrawlerJobSchema,
          }),
        },
      },
      description: 'Crawler job created and started in background',
    },
    400: {
      content: {
        'application/json': {
          schema: z.object({ error: z.string() }),
        },
      },
      description: 'Invalid request',
    },
  },
});

export const CompleteCrawlerJobRoute = createRoute({
  method: 'post',
  path: '/api/v1/crawler-jobs/{id}/complete',
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            productsFound: z.number(),
            crawlId: z.string().optional(),
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
          schema: z.object({ success: z.boolean() }),
        },
      },
      description: 'Job completed and product extraction queued',
    },
  },
});
