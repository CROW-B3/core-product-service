import type { Environment } from '../types';

const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const BATCH_SIZE = 100;

interface ProductForVectorize {
  id: string;
  organizationId: string;
  title: string;
  description: string;
  category: string | null;
  price: number | null;
}

function buildProductText(product: ProductForVectorize): string {
  const parts = [product.title];
  if (product.description) {
    parts.push(product.description);
  }
  if (product.category) {
    parts.push(`Category: ${product.category}`);
  }
  if (product.price != null) {
    parts.push(`Price: ${product.price}`);
  }
  return parts.join(' - ');
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function generateEmbeddingsBatch(
  env: Environment,
  texts: string[]
): Promise<number[][]> {
  const result = (await env.AI.run(
    EMBEDDING_MODEL,
    { text: texts },
    {
      gateway: {
        id: env.AI_GATEWAY_ID,
      },
    }
  )) as { data: number[][] };
  return result.data;
}

async function generateEmbedding(
  env: Environment,
  text: string
): Promise<number[]> {
  const result = (await env.AI.run(
    EMBEDDING_MODEL,
    { text: [text] },
    {
      gateway: {
        id: env.AI_GATEWAY_ID,
      },
    }
  )) as { data: number[][] };
  return result.data[0];
}

export async function vectorizeProducts(
  env: Environment,
  products: ProductForVectorize[]
): Promise<void> {
  if (products.length === 0) return;

  const batches = chunk(products, BATCH_SIZE);

  for (const batch of batches) {
    const texts = batch.map(buildProductText);
    const embeddings = await generateEmbeddingsBatch(env, texts);

    const vectors = batch.map((product, idx) => ({
      id: product.id,
      values: embeddings[idx],
      metadata: {
        organizationId: product.organizationId,
        name: product.title,
        category: product.category ?? '',
        price: product.price ?? 0,
      },
    }));

    await env.PRODUCT_VECTORIZE.upsert(vectors);
  }
}

export async function searchProducts(
  env: Environment,
  query: string,
  organizationId: string,
  topK = 10
): Promise<{ id: string; score: number }[]> {
  const queryEmbedding = await generateEmbedding(env, query);

  const results = await env.PRODUCT_VECTORIZE.query(queryEmbedding, {
    topK,
    filter: { organizationId },
    returnMetadata: 'all',
  });

  return results.matches.map(match => ({
    id: match.id,
    score: match.score,
  }));
}
