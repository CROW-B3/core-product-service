import type { Environment } from '../types';

const SUPPORTED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const FETCH_TIMEOUT_MS = 10_000;

const fetchImageWithTimeout = async (url: string): Promise<Response | null> => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CROWBot/1.0)' },
    });
    clearTimeout(timeoutId);
    if (!response.ok) return null;
    return response;
  } catch {
    return null;
  }
};

const buildR2ImageKey = (
  productId: string,
  index: number,
  contentType: string
): string => {
  const ext = contentType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg';
  return `products/${productId}/${index}.${ext}`;
};

const buildPublicImageUrl = (environment: string, key: string): string => {
  const base =
    environment === 'prod'
      ? 'https://api.crowai.dev'
      : environment === 'dev'
        ? 'https://dev.api.crowai.dev'
        : 'http://localhost:8000';
  return `${base}/api/v1/products/images/${encodeURIComponent(key)}`;
};

export const uploadProductImagesToR2 = async (
  env: Environment,
  productId: string,
  imageUrls: string[]
): Promise<string[]> => {
  const r2Urls: string[] = [];

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    const response = await fetchImageWithTimeout(url);

    if (!response) {
      r2Urls.push(url);
      continue;
    }

    const contentType =
      response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';

    if (!SUPPORTED_CONTENT_TYPES.has(contentType)) {
      r2Urls.push(url);
      continue;
    }

    const key = buildR2ImageKey(productId, i, contentType);

    try {
      const imageData = await response.arrayBuffer();
      await env.R2_BUCKET.put(key, imageData, {
        httpMetadata: { contentType },
      });
      r2Urls.push(buildPublicImageUrl(env.ENVIRONMENT, key));
    } catch {
      r2Urls.push(url);
    }
  }

  return r2Urls;
};

export const getImageFromR2 = async (
  env: Environment,
  key: string
): Promise<R2ObjectBody | null> => {
  return env.R2_BUCKET.get(key);
};
