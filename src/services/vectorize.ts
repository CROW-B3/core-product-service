import type { Environment } from '../types';

interface ProductForEmbedding {
  id: string;
  organizationId: string;
  title: string;
  description: string | null;
  price: number | null;
  category: string | null;
}

interface AiDescription {
  description: string;
}

async function embedText(env: Environment, text: string): Promise<number[]> {
  const result = (await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: [text],
  })) as { data: number[][] };
  return result.data[0];
}

export async function embedProduct(
  env: Environment,
  product: ProductForEmbedding,
  aiDescriptions: AiDescription[] = []
): Promise<void> {
  const parts = [product.title];
  if (product.description) parts.push(product.description);
  if (aiDescriptions.length)
    parts.push(...aiDescriptions.map(d => d.description));

  const combinedText = parts.join('. ');
  const values = await embedText(env, combinedText);

  await env.VECTORIZE.upsert([
    {
      id: product.id,
      values,
      metadata: {
        organizationId: product.organizationId,
        title: product.title,
        price: product.price ? String(product.price) : '',
        category: product.category || '',
      },
    },
  ]);
}

export async function semanticSearch(
  env: Environment,
  orgId: string,
  query: string,
  limit = 20
): Promise<
  Array<{ id: string; score: number; metadata: Record<string, string> }>
> {
  const values = await embedText(env, query);
  const results = await env.VECTORIZE.query(values, {
    topK: limit,
    returnMetadata: 'indexed',
    filter: { organizationId: orgId },
  });

  return (results.matches || []).map(m => ({
    id: m.id,
    score: m.score,
    metadata: (m.metadata || {}) as Record<string, string>,
  }));
}

export async function ftsSearch(
  db: {
    prepare: (sql: string) => {
      bind: (...args: unknown[]) => {
        all: () => Promise<{ results: unknown[] }>;
      };
    };
  },
  orgId: string,
  query: string,
  limit = 20
): Promise<unknown[]> {
  const stmt = db
    .prepare(
      `
    SELECT p.* FROM product_fts fts
    JOIN product p ON p.id = fts.product_id
    WHERE fts MATCH ? AND p.organization_id = ?
    ORDER BY rank LIMIT ?
  `
    )
    .bind(query, orgId, limit);

  const result = await stmt.all();
  return result.results;
}
