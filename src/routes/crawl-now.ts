import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { CrawlerJobSchema, CreateCrawlerJobSchema } from '../types';

/**
 * Direct crawl endpoint - bypasses queue for immediate execution
 * Returns job ID immediately, frontend polls /progress endpoint for updates
 */
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
            progressUrl: z.string().describe('URL to poll for progress updates'),
          }),
        },
      },
      description: 'Crawler job created and started immediately',
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

/**
 * Get current progress for a crawler job (polled by frontend)
 */
export const GetCrawlerProgressRoute = createRoute({
  method: 'get',
  path: '/api/v1/crawler-jobs/{id}/progress',
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            jobId: z.string(),
            status: z.enum(['pending', 'discovering', 'crawling', 'extracting', 'completed', 'failed']),
            message: z.string(),
            progress: z
              .object({
                current: z.number(),
                total: z.number(),
                percentage: z.number(),
              })
              .optional(),
            productsFound: z.number().optional(),
            pagesProcessed: z.number().optional(),
            error: z.string().optional(),
            timestamp: z.string(),
          }),
        },
      },
      description: 'Current progress',
    },
  },
});

/**
 * Crawler pushes progress updates to this endpoint
 */
export const UpdateCrawlerProgressRoute = createRoute({
  method: 'post',
  path: '/api/v1/crawler-jobs/{id}/progress-update',
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            status: z.enum(['pending', 'discovering', 'crawling', 'extracting', 'completed', 'failed']),
            message: z.string(),
            progress: z
              .object({
                current: z.number(),
                total: z.number(),
                percentage: z.number(),
              })
              .optional(),
            productsFound: z.number().optional(),
            pagesProcessed: z.number().optional(),
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
      description: 'Progress updated',
    },
  },
});

/**
 * Crawler calls this when crawling is complete
 */
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
      description: 'Job completed',
    },
  },
});
