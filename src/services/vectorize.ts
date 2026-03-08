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
    productDetailedDescription?: string | null;
  },
  aiDescriptions: { description: string }[] = []
): Promise<void> => {
  const combinedText = [
    product.title,
    product.description,
    product.productDetailedDescription,
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

const MAX_FTS_QUERY_LENGTH = 256;

/**
 * Sanitize a FTS5 query so that FTS5 special operators (AND, OR, NOT, NEAR, quotes,
 * carets, asterisks) cannot be injected. We wrap the user input in double-quotes
 * which forces FTS5 to treat the entire string as a phrase match and strip any
 * embedded double-quotes via doubling.
 */
const sanitizeFtsQuery = (raw: string): string => {
  const truncated = raw.slice(0, MAX_FTS_QUERY_LENGTH);
  // Escape embedded double-quotes by doubling them, then wrap in double-quotes
  return `"${truncated.replace(/"/g, '""')}"`;
};

export const ftsSearch = async (
  env: Environment,
  orgId: string,
  query: string,
  limit: number = 20
): Promise<unknown[]> => {
  const safeQuery = sanitizeFtsQuery(query);
  const stmt = env.DB.prepare(
    `SELECT p.* FROM product_fts fts JOIN product p ON p.id = fts.product_id WHERE fts MATCH ? AND p.organizationId = ? ORDER BY rank LIMIT ?`
  ).bind(safeQuery, orgId, limit);
  const result = await stmt.all();
  return result.results ?? [];
};
