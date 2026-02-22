import type { Environment } from '../types';

export const embedText = async (
  env: Environment,
  text: string
): Promise<number[]> => {
  const result = (await env.AI.run(
    '@cf/baai/bge-base-en-v1.5' as Parameters<typeof env.AI.run>[0],
    { text: [text] }
  )) as { data: number[][] };
  return result.data[0];
};

export const embedProduct = async (
  env: Environment,
  product: {
    id: string;
    organizationId: string;
    title: string;
    description: string;
  },
  aiDescriptions: { description: string }[] = []
): Promise<void> => {
  const combinedText = [
    product.title,
    product.description,
    ...aiDescriptions.map(d => d.description),
  ]
    .filter(Boolean)
    .join('. ');
  const values = await embedText(env, combinedText);
  await env.VECTORIZE.upsert([
    {
      id: product.id,
      values,
      metadata: {
        organizationId: product.organizationId,
        title: product.title,
      },
    },
  ]);
};

export const semanticSearch = async (
  env: Environment,
  orgId: string,
  query: string,
  limit: number = 20
): Promise<{ id: string; score: number }[]> => {
  const values = await embedText(env, query);
  const results = await env.VECTORIZE.query(values, {
    topK: limit,
    returnMetadata: 'indexed',
    filter: { organizationId: orgId },
  });
  return results.matches.map(m => ({ id: m.id, score: m.score }));
};

export const ftsSearch = async (
  env: Environment,
  orgId: string,
  query: string,
  limit: number = 20
): Promise<unknown[]> => {
  const stmt = env.DB.prepare(
    `SELECT p.* FROM product_fts fts JOIN product p ON p.id = fts.product_id WHERE fts MATCH ? AND p.organizationId = ? ORDER BY rank LIMIT ?`
  ).bind(query, orgId, limit);
  const result = await stmt.all();
  return result.results ?? [];
};
