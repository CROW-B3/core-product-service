import type { Environment } from '../types';
import { z } from 'zod';
import { productExtractionPrompt } from '../prompts/product-extraction';

const ExtractedProductSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  images: z.array(z.string()),
  price: z.number().optional(),
  category: z.string().optional(),
});

const ProductBatchSchema = z.object({
  products: z.array(ExtractedProductSchema),
  unprocessedContent: z.string().optional(),
});

export type ExtractedProduct = z.infer<typeof ExtractedProductSchema>;

const splitHtmlIntoChunks = (
  html: string,
  maxChunkSize: number = 80000
): string[] => {
  const chunks: string[] = [];
  let currentChunk = '';
  const lines = html.split('\n');

  for (const line of lines) {
    if (currentChunk.length + line.length > maxChunkSize) {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = line;
    } else {
      currentChunk += (currentChunk ? '\n' : '') + line;
    }
  }

  if (currentChunk) chunks.push(currentChunk);
  return chunks;
};

const parseAiJsonResponse = (
  response: string
): z.infer<typeof ProductBatchSchema> => {
  const codeBlockStart = response.indexOf('```json');
  const codeBlockEnd = response.lastIndexOf('```');

  let jsonStr = response;

  if (codeBlockStart !== -1 && codeBlockEnd > codeBlockStart) {
    jsonStr = response.slice(codeBlockStart + 7, codeBlockEnd).trim();
  } else {
    const braceStart = response.indexOf('{');
    const braceEnd = response.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      jsonStr = response.slice(braceStart, braceEnd + 1);
    }
  }

  try {
    const parsed = JSON.parse(jsonStr.trim());
    return ProductBatchSchema.parse(parsed);
  } catch {
    return { products: [], unprocessedContent: '' };
  }
};

export const extractProductsFromHtml = async (
  env: Environment,
  html: string
): Promise<ExtractedProduct[]> => {
  const chunks = splitHtmlIntoChunks(html);
  const allProducts: ExtractedProduct[] = [];
  let carryForward = '';

  for (const chunk of chunks) {
    const inputContent = carryForward + chunk;

    try {
      const response = await env.AI.run(
        env.AI_MODEL as Parameters<typeof env.AI.run>[0],
        { prompt: productExtractionPrompt(inputContent) },
        { gateway: { id: env.AI_GATEWAY_ID } }
      );

      const responseText =
        typeof response === 'string'
          ? response
          : (response as { response?: string }).response ||
            JSON.stringify(response);

      const parsed = parseAiJsonResponse(responseText);
      allProducts.push(...parsed.products);
      carryForward = parsed.unprocessedContent || '';
    } catch (error) {
      console.error('AI extraction error:', error);
      carryForward = '';
    }
  }

  return allProducts;
};

export const extractProductsFromJson = (
  jsonContent: string
): ExtractedProduct[] => {
  try {
    const data = JSON.parse(jsonContent);
    const products = Array.isArray(data) ? data : data.products || [];

    return products.map((p: Record<string, unknown>, index: number) => ({
      id: String(p.id || `product-${index}`),
      title: String(p.title || p.name || ''),
      description: String(p.description || ''),
      images: Array.isArray(p.images) ? p.images.map(String) : [],
      price: typeof p.price === 'number' ? p.price : undefined,
      category: typeof p.category === 'string' ? p.category : undefined,
    }));
  } catch {
    return [];
  }
};

export const extractProductsFromCsv = (
  csvContent: string
): ExtractedProduct[] => {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idIndex = headers.findIndex(h => h === 'id');
  const titleIndex = headers.findIndex(h => h === 'title' || h === 'name');
  const descIndex = headers.findIndex(h => h === 'description');
  const imagesIndex = headers.findIndex(h => h === 'images' || h === 'image');
  const priceIndex = headers.findIndex(h => h === 'price');
  const categoryIndex = headers.findIndex(h => h === 'category');

  return lines.slice(1).map((line, index) => {
    const values = line.split(',').map(v => v.trim());

    const imagesRaw = imagesIndex >= 0 ? values[imagesIndex] : '';
    const images = imagesRaw
      ? imagesRaw
          .split(';')
          .map(img => img.trim())
          .filter(Boolean)
      : [];

    return {
      id: idIndex >= 0 ? values[idIndex] : `product-${index}`,
      title: titleIndex >= 0 ? values[titleIndex] : '',
      description: descIndex >= 0 ? values[descIndex] : '',
      images,
      price:
        priceIndex >= 0
          ? Number.parseFloat(values[priceIndex]) || undefined
          : undefined,
      category:
        categoryIndex >= 0 ? values[categoryIndex] || undefined : undefined,
    };
  });
};

export const fetchUrlContent = async (url: string): Promise<string> => {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'CROW-ProductCrawler/1.0',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch URL: ${response.status} ${response.statusText}`
    );
  }

  return response.text();
};
