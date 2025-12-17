import { z } from '@hono/zod-openapi';
export interface Environment {}

export const HelloWorldSchema = z
  .object({
    text: z.string(),
  })
  .openapi('User');
