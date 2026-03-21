import type { Environment } from '../types';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';

const VISION_MODEL = '@cf/llava-hf/llava-1.5-7b-hf';

export interface ImageDescription {
  imageUrl: string;
  description: string;
  features: string[];
  colors: string[];
  materials: string[];
  style: string;
}

const fetchImageAsBytes = async (
  imageUrl: string
): Promise<number[] | null> => {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) return null;

    const arrayBuffer = await response.arrayBuffer();
    return [...new Uint8Array(arrayBuffer)];
  } catch (error) {
    console.error(`[Vision] Failed to fetch image: ${imageUrl}`, error);
    return null;
  }
};

const _parseDescriptionResponse = (
  text: string
): Omit<ImageDescription, 'imageUrl'> => {
  const lines = text.split('\n').filter(l => l.trim());
  let description = '';
  let features: string[] = [];
  let colors: string[] = [];
  let materials: string[] = [];
  let style = '';

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith('description:')) {
      description = line.slice(12).trim();
    } else if (lower.startsWith('features:')) {
      features = line
        .slice(9)
        .split(',')
        .map(f => f.trim())
        .filter(Boolean);
    } else if (lower.startsWith('colors:')) {
      colors = line
        .slice(7)
        .split(',')
        .map(c => c.trim())
        .filter(Boolean);
    } else if (lower.startsWith('materials:')) {
      materials = line
        .slice(10)
        .split(',')
        .map(m => m.trim())
        .filter(Boolean);
    } else if (lower.startsWith('style:')) {
      style = line.slice(6).trim();
    } else if (!description) {
      description = line.trim();
    }
  }

  return {
    description: description || text,
    features,
    colors,
    materials,
    style,
  };
};

export const generateImageDescription = async (
  env: Environment,
  imageUrl: string
): Promise<ImageDescription | null> => {
  const imageBytes = await fetchImageAsBytes(imageUrl);
  if (!imageBytes) return null;

  try {
    const response = (await env.AI.run(
      VISION_MODEL,
      {
        image: imageBytes,
        prompt: `Describe this product for an e-commerce store. Include the item type, colors, style, and any visible features. Be detailed and helpful for online shoppers.`,
        max_tokens: 256,
      },
      { gateway: { id: 'crow-ai-gateway', skipCache: false } }
    )) as { description: string };

    return {
      imageUrl,
      description: response.description,
      features: [],
      colors: [],
      materials: [],
      style: '',
    };
  } catch (error) {
    console.error(
      `[Vision] Failed to generate description for: ${imageUrl}`,
      error
    );
    return null;
  }
};

export const generateAndStoreDescriptions = async (
  env: Environment,
  productId: string,
  imageUrls: string[]
): Promise<ImageDescription[]> => {
  const database = drizzle(env.DB, { schema });
  const descriptions: ImageDescription[] = [];

  for (const imageUrl of imageUrls) {
    const result = await generateImageDescription(env, imageUrl);
    if (!result) continue;

    const id = crypto.randomUUID();
    const now = new Date();

    await database.insert(schema.productAiDescription).values({
      id,
      productId,
      imageUrl: result.imageUrl,
      description: result.description,
      features: JSON.stringify(result.features),
      colors: JSON.stringify(result.colors),
      materials: JSON.stringify(result.materials),
      style: result.style,
      modelUsed: VISION_MODEL,
      createdAt: now,
    });

    descriptions.push(result);
    console.warn(
      `[Vision] Generated description for image: ${imageUrl.slice(0, 50)}...`
    );
  }

  return descriptions;
};

export const generateDescriptionsForProduct = async (
  env: Environment,
  product: { id: string; images: string[] }
): Promise<ImageDescription[]> => {
  console.warn(
    `[Vision] Processing ${product.images.length} images for product ${product.id}`
  );
  return generateAndStoreDescriptions(env, product.id, product.images);
};
