import type { Database } from '../types';

/**
 * Store and retrieve crawler progress updates
 * Progress is stored in KV for fast retrieval by frontend polling
 */

export interface ProgressUpdate {
  jobId: string;
  status: 'pending' | 'discovering' | 'crawling' | 'extracting' | 'completed' | 'failed';
  message: string;
  progress?: {
    current: number;
    total: number;
    percentage: number;
  };
  productsFound?: number;
  pagesProcessed?: number;
  error?: string;
  timestamp: string;
}

export async function storeProgress(
  kv: KVNamespace,
  jobId: string,
  update: ProgressUpdate,
): Promise<void> {
  // Store in KV with 24 hour expiration
  await kv.put(`progress:${jobId}`, JSON.stringify(update), {
    expirationTtl: 86400,
  });
}

export async function getProgress(
  kv: KVNamespace,
  jobId: string,
): Promise<ProgressUpdate | null> {
  const data = await kv.get(`progress:${jobId}`);
  if (!data)
    return null;

  return JSON.parse(data) as ProgressUpdate;
}
