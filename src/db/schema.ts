import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const crawlerJob = sqliteTable('crawler_job', {
  id: text('id').primaryKey(),
  organizationId: text('organizationId').notNull(),
  onboardingId: text('onboardingId'),
  sourceType: text('sourceType').notNull(),
  sourceValue: text('sourceValue').notNull(),
  status: text('status').notNull().default('pending'),
  productsFound: integer('productsFound').notNull().default(0),
  productsProcessed: integer('productsProcessed').notNull().default(0),
  errorMessage: text('errorMessage'),
  startedAt: integer('startedAt', { mode: 'timestamp' }),
  completedAt: integer('completedAt', { mode: 'timestamp' }),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
});

export const product = sqliteTable('product', {
  id: text('id').primaryKey(),
  organizationId: text('organizationId').notNull(),
  externalId: text('externalId').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  images: text('images').notNull(),
  price: integer('price'),
  category: text('category'),
  metadata: text('metadata'),
  crawlerJobId: text('crawlerJobId').references(() => crawlerJob.id, {
    onDelete: 'set null',
  }),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
});
