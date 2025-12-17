import type { Environment } from './types';
import { OpenAPIHono } from '@hono/zod-openapi';
import { logger } from 'hono/logger';
import { poweredBy } from 'hono/powered-by';
import { HelloWorldRoute } from './routes';

const app = new OpenAPIHono<{ Bindings: Environment }>();
app.use(poweredBy());
app.use(logger());
app.openapi(HelloWorldRoute, c => {
  return c.json({ text: 'Hello Hono!' });
});

app.doc('/docs', {
  openapi: '3.0.0',
  info: {
    version: '1.0.0',
    title: 'My API',
  },
});
export default app;
