import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const crawlerJob = sqliteTable('crawler_job', {
  id: text('id').primaryKey(),
  organizationId: text('organizationId').notNull(),
  onboardingId: text('onboardingId'),
  sourceType: text('sourceType').notNull(),
  sourceValue: text('sourceValue').notNull(),
  status: text('status').notNull().default('pending'),
  crawlId: text('crawlId'),
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

export const productAiDescription = sqliteTable('product_ai_description', {
  id: text('id').primaryKey(),
  productId: text('productId')
    .notNull()
    .references(() => product.id, { onDelete: 'cascade' }),
  imageUrl: text('imageUrl').notNull(),
  description: text('description').notNull(),
  features: text('features'),
  colors: text('colors'),
  materials: text('materials'),
  style: text('style'),
  modelUsed: text('modelUsed').notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
});
