import type { Environment } from '../types';
import { generateObject } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';

const ProductSchema = z.object({
  title: z.string().describe('Product name/title'),
  description: z.string().describe('Brief product description, 1-2 sentences'),
  imageUrls: z
    .array(z.string())
    .describe(
      'Product image URLs. Extract from <img> tag src, srcset, or data-src attributes. For Next.js images, extract the original URL from srcset (e.g., the unsplash/cloudinary/CDN URL, not the /_next/image proxy URL). Only include URLs that point to actual images.'
    ),
  price: z
    .number()
    .nullable()
    .describe('Numeric price value only, no currency symbols'),
  currency: z
    .string()
    .nullable()
    .describe('ISO currency code like USD, EUR, GBP'),
  additionalInfo: z
    .string()
    .nullable()
    .describe(
      'Any extra product details: brand, materials, sizes, colors, tags, or other notable attributes combined as a single string'
    ),
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
  url: string | null;
  metadata: string | null;
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
  baseDelay: number = 3000,
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
  const seenByTitle = new Map<string, ExtractedProduct>();
  const seenByUrl = new Set<string>();

  for (const product of products) {
    if (isGenericProductName(product.title)) continue;

    const titleKey = product.title.toLowerCase().trim();
    const urlKey = product.url?.toLowerCase().trim();

    if (urlKey && seenByUrl.has(urlKey) && seenByTitle.has(titleKey)) continue;

    if (!seenByTitle.has(titleKey)) {
      seenByTitle.set(titleKey, product);
      if (urlKey) seenByUrl.add(urlKey);
    }
  }

  return Array.from(seenByTitle.values());
};

export const extractProductsFromHtmlChunk = async (
  env: Environment,
  htmlChunk: string,
  chunkIndex: number,
  pageUrl: string
): Promise<ExtractedProduct[]> => {
  const workersai = createWorkersAI({
    binding: env.AI,
    gateway: { id: 'crow-ai-gateway', skipCache: false },
  });

  try {
    console.warn(
      `[AI] Extracting chunk ${chunkIndex + 1}, length: ${htmlChunk.length}`
    );

    const result = await withRetry(async () => {
      return generateObject({
        model: workersai(env.AI_MODEL as any),
        schema: ExtractionSchema,
        maxOutputTokens: 4096,
        prompt: `You are a product data extractor. Analyze this HTML and extract all products you find.

CRITICAL RULES:
- For imageUrls: Extract image URLs from <img> tags. Check src, srcset, and data-src attributes. For Next.js images (/_next/image?url=...), extract and decode the original image URL from the query parameter. Include CDN URLs (unsplash.com, cloudinary, etc). Do NOT include SVG icons, logos, or placeholder images.
- For price: Extract the numeric value only (e.g., 29.99 not "$29.99")
- For additionalInfo: Include any extra details like brand, materials, sizes, colors, tags, or notable attributes as a single string
- If no products are found in this content, return an empty products array

HTML Content:
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
      images: p.imageUrls.filter((img: string) => img && img.length > 0),
      price: p.price,
      currency: p.currency,
      url: pageUrl,
      metadata: p.additionalInfo,
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

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await delay(3000);
    const products = await extractProductsFromHtmlChunk(
      env,
      chunks[i],
      i,
      pageUrl
    );
    allProducts.push(...products);
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
  const workersai = createWorkersAI({
    binding: env.AI,
    gateway: { id: 'crow-ai-gateway', skipCache: false },
  });

  try {
    console.warn(
      `[AI] Extracting text chunk ${chunkIndex + 1}, words: ${chunk.word_count}`
    );

    const result = await withRetry(async () => {
      return generateObject({
        model: workersai(env.AI_MODEL as any),
        schema: ExtractionSchema,
        maxOutputTokens: 4096,
        prompt: `You are a product data extractor. Analyze this text content from a website and extract all products.

CRITICAL RULES:
- For imageUrls: Extract image URLs from <img> tags. Check src, srcset, and data-src attributes. For Next.js images (/_next/image?url=...), extract and decode the original image URL from the query parameter. Include CDN URLs (unsplash.com, cloudinary, etc). Do NOT include SVG icons, logos, or placeholder images.
- For price: Extract the numeric value only
- For additionalInfo: Include any extra details like brand, materials, sizes, colors, tags, or notable attributes as a single string

Page: ${chunk.title} (${chunk.url})

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
      images: p.imageUrls.filter((img: string) => img && img.length > 0),
      price: p.price,
      currency: p.currency,
      metadata: p.additionalInfo,
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
    `[AI] Processing ${chunks.length} text chunks from crawler service`
  );

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await delay(3000);
    const products = await extractProductsFromTextChunk(env, chunks[i], i);
    allProducts.push(...products);
  }

  const deduplicated = deduplicateProducts(allProducts);
  console.warn(`[AI] Total from chunks: ${deduplicated.length} products`);

  return deduplicated;
};
