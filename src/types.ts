import { z } from '@hono/zod-openapi';
export interface Environment {
  AXIOM_API_TOKEN: string;
  AXIOM_DATASET: string;
}

export const HelloWorldSchema = z
  .object({
    text: z.string(),
  })
  .openapi('User');
