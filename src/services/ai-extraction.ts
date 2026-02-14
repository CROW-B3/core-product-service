import type { Environment } from '../types';
import { generateObject } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';

const ProductSchema = z.object({
  title: z.string(),
  description: z.string(),
  images: z.array(z.string()),
  price: z.number().nullable(),
  currency: z.string().nullable(),
});

const ExtractionSchema = z.object({
  products: z.array(ProductSchema),
});

export interface ExtractedProduct {
  id: string;
  title: string;
  description: string;
  images: string[];
  price: number | null;
  currency: string | null;
  category: string | null;
  brand: string | null;
  variants: Array<{ name: string; value: string }> | null;
  inStock: boolean | null;
  url: string | null;
}

const cleanHtmlForExtraction = (html: string): string => {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const withRetry = async <T>(
  fn: () => Promise<T>,
  maxRetries: number = 5,
  baseDelay: number = 5000,
  attempt: number = 0
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const isRateLimit =
      err.message.includes('1031') || err.message.includes('rate');

    if (attempt >= maxRetries || !isRateLimit) throw err;

    const waitTime = baseDelay * 2 ** attempt;
    console.warn(
      `[AI] Rate limited, retrying in ${waitTime}ms (attempt ${attempt + 1}/${maxRetries})`
    );
    await delay(waitTime);

    return withRetry(fn, maxRetries, baseDelay, attempt + 1);
  }
};

const splitIntoChunks = (
  content: string,
  maxChunkSize: number = 10000
): string[] => {
  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkSize) {
      chunks.push(remaining);
      break;
    }

    let splitPoint = remaining.lastIndexOf('</div>', maxChunkSize);
    if (splitPoint === -1 || splitPoint < maxChunkSize * 0.5) {
      splitPoint = remaining.lastIndexOf(' ', maxChunkSize);
    }
    if (splitPoint === -1) {
      splitPoint = maxChunkSize;
    }

    chunks.push(remaining.slice(0, splitPoint));
    remaining = remaining.slice(splitPoint);
  }

  return chunks;
};

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 1000;

const isGenericProductName = (title: string): boolean => {
  const genericPatterns = [
    /^product\s*\d*$/i,
    /^item\s*\d*$/i,
    /^example/i,
    /^test/i,
    /^sample/i,
  ];
  return genericPatterns.some(p => p.test(title.trim()));
};

const deduplicateProducts = (
  products: ExtractedProduct[]
): ExtractedProduct[] => {
  const seen = new Map<string, ExtractedProduct>();

  for (const product of products) {
    const key = product.title.toLowerCase().trim();
    if (
      !seen.has(key) &&
      product.price !== null &&
      !isGenericProductName(product.title)
    ) {
      seen.set(key, product);
    }
  }

  return Array.from(seen.values());
};

export const extractProductsFromHtmlChunk = async (
  env: Environment,
  htmlChunk: string,
  chunkIndex: number,
  pageUrl: string
): Promise<ExtractedProduct[]> => {
  const workersai = createWorkersAI({ binding: env.AI });

  try {
    console.warn(
      `[AI] Extracting chunk ${chunkIndex + 1}, length: ${htmlChunk.length}`
    );

    const result = await withRetry(async () => {
      return generateObject({
        model: workersai(env.AI_MODEL),
        schema: ExtractionSchema,
        maxTokens: 4096,
        prompt: `Extract products from HTML. For each product find: title, description (brief), ALL image URLs (array), price (number only), currency code.

HTML:
${htmlChunk}`,
      });
    });

    console.warn(
      `[AI] Found ${result.object.products.length} products in chunk ${chunkIndex + 1}`
    );

    return result.object.products.map((p, i) => ({
      id: `prod-${chunkIndex}-${i + 1}`,
      title: p.title,
      description: p.description,
      images: p.images.filter(img => img && img.length > 0),
      price: p.price,
      currency: p.currency,
      category: null,
      brand: null,
      variants: null,
      inStock: null,
      url: pageUrl,
    }));
  } catch (error) {
    console.error(`[AI] Chunk ${chunkIndex} failed:`, error);
    return [];
  }
};

export const extractProductsFromPage = async (
  env: Environment,
  html: string,
  pageUrl: string
): Promise<ExtractedProduct[]> => {
  const cleanedHtml = cleanHtmlForExtraction(html);
  console.warn(`[AI] Cleaned HTML: ${cleanedHtml.length} chars`);

  const chunks = splitIntoChunks(cleanedHtml);
  console.warn(`[AI] Split into ${chunks.length} chunks`);

  const allProducts: ExtractedProduct[] = [];

  for (
    let batchStart = 0;
    batchStart < chunks.length;
    batchStart += BATCH_SIZE
  ) {
    if (batchStart > 0) await delay(BATCH_DELAY_MS);
    const batch = chunks.slice(batchStart, batchStart + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map((chunk, i) =>
        extractProductsFromHtmlChunk(env, chunk, batchStart + i, pageUrl)
      )
    );
    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        allProducts.push(...result.value);
      }
    }
  }

  const deduplicated = deduplicateProducts(allProducts);
  console.warn(`[AI] Total: ${deduplicated.length} products`);

  return deduplicated;
};

export const extractProductsFromMultiplePages = async (
  env: Environment,
  pages: Array<{ url: string; html: string }>
): Promise<ExtractedProduct[]> => {
  const allProducts: ExtractedProduct[] = [];

  for (const page of pages) {
    const products = await extractProductsFromPage(env, page.html, page.url);
    allProducts.push(...products);
  }

  return deduplicateProducts(allProducts);
};

export interface TextChunk {
  url: string;
  title: string;
  chunk_index: number;
  total_chunks_for_page: number;
  text: string;
  word_count: number;
  crawled_at: string;
}

const extractProductsFromTextChunk = async (
  env: Environment,
  chunk: TextChunk,
  chunkIndex: number
): Promise<ExtractedProduct[]> => {
  const workersai = createWorkersAI({ binding: env.AI });

  try {
    console.warn(
      `[AI] Extracting text chunk ${chunkIndex + 1}, words: ${chunk.word_count}`
    );

    const result = await withRetry(async () => {
      return generateObject({
        model: workersai(env.AI_MODEL),
        schema: ExtractionSchema,
        maxTokens: 4096,
        prompt: `Extract products from the following text content from a website. For each product find: title, description (brief), ALL image URLs (array), price (number only), currency code.

Page URL: ${chunk.url}
Page Title: ${chunk.title}

Content:
${chunk.text}`,
      });
    });

    console.warn(
      `[AI] Found ${result.object.products.length} products in text chunk ${chunkIndex + 1}`
    );

    return result.object.products.map((p, i) => ({
      id: `prod-${chunkIndex}-${i + 1}`,
      title: p.title,
      description: p.description,
      images: p.images.filter(img => img && img.length > 0),
      price: p.price,
      currency: p.currency,
      category: null,
      brand: null,
      variants: null,
      inStock: null,
      url: chunk.url,
    }));
  } catch (error) {
    console.error(`[AI] Text chunk ${chunkIndex} failed:`, error);
    return [];
  }
};

export const extractProductsFromChunks = async (
  env: Environment,
  chunks: TextChunk[]
): Promise<ExtractedProduct[]> => {
  const allProducts: ExtractedProduct[] = [];

  console.warn(
    `[AI] Processing ${chunks.length} text chunks in batches of ${BATCH_SIZE}`
  );

  for (
    let batchStart = 0;
    batchStart < chunks.length;
    batchStart += BATCH_SIZE
  ) {
    if (batchStart > 0) await delay(BATCH_DELAY_MS);

    const batch = chunks.slice(batchStart, batchStart + BATCH_SIZE);
    console.warn(
      `[AI] Processing batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(chunks.length / BATCH_SIZE)} (chunks ${batchStart + 1}-${batchStart + batch.length})`
    );

    const batchResults = await Promise.allSettled(
      batch.map((chunk, i) =>
        extractProductsFromTextChunk(env, chunk, batchStart + i)
      )
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        allProducts.push(...result.value);
      } else {
        console.error(`[AI] Batch chunk failed:`, result.reason);
      }
    }
  }

  const deduplicated = deduplicateProducts(allProducts);
  console.warn(`[AI] Total from chunks: ${deduplicated.length} products`);

  return deduplicated;
};
