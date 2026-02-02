import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

const HealthResponseSchema = z.object({
  status: z.literal('healthy'),
  timestamp: z.string(),
  service: z.string(),
  version: z.string(),
  environment: z.string(),
});

const ReadinessResponseSchema = z.object({
  ready: z.boolean(),
  checks: z.object({
    database: z.boolean(),
  }),
});

export const HealthCheckRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['Health'],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: HealthResponseSchema,
        },
      },
      description: 'Service is healthy',
    },
  },
});

export const ReadinessCheckRoute = createRoute({
  method: 'get',
  path: '/health/ready',
  tags: ['Health'],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ReadinessResponseSchema,
        },
      },
      description: 'Service is ready',
    },
    503: {
      content: {
        'application/json': {
          schema: ReadinessResponseSchema,
        },
      },
      description: 'Service is not ready',
    },
  },
});
