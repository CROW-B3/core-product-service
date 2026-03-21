import type { Environment } from '../types';

export interface TextChunk {
  url: string;
  title: string;
  chunk_index: number;
  total_chunks_for_page: number;
  text: string;
  word_count: number;
  crawled_at: string;
}

export interface CrawlMetadata {
  url: string;
  total_pages: number;
  total_chunks: number;
  crawl_duration_seconds: number;
}

export interface CrawlResponse {
  success: boolean;
  metadata: CrawlMetadata;
  chunks: TextChunk[];
  errors: string[];
}

export interface CrawlRequest {
  url: string;
  max_pages?: number;
  depth_limit?: number;
  use_playwright?: 'auto' | 'always' | 'never';
  chunk_size_tokens?: number;
}

export interface AsyncCrawlResponse {
  success: boolean;
  jobId: string;
  message: string;
}

export interface CrawlResultsResponse {
  metadata: {
    total_pages: number;
    total_chunks: number;
    crawl_duration_seconds: number;
    start_url: string;
    timestamp: string;
  };
  chunks: Array<{
    url: string;
    title: string;
    text: string;
    word_count: number;
    token_count: number;
    chunk_index: number;
  }>;
}

export const crawlWithService = async (
  env: Environment,
  request: CrawlRequest
): Promise<CrawlResponse> => {
  const crawlerUrl = env.CRAWLER_SERVICE_URL;
  const crawlerSecret = env.CRAWLER_SERVICE_SECRET;

  if (!crawlerUrl) {
    throw new Error('CRAWLER_SERVICE_URL not configured');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (crawlerSecret) {
    headers.Authorization = `Bearer ${crawlerSecret}`;
  }

  const response = await fetch(`${crawlerUrl}/crawl`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      url: request.url,
      max_pages: request.max_pages ?? 50,
      depth_limit: request.depth_limit ?? 10,
      use_playwright: request.use_playwright ?? 'auto',
      chunk_size_tokens: request.chunk_size_tokens ?? 500,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Crawler service error: ${response.status} - ${errorText}`);
  }

  return response.json() as Promise<CrawlResponse>;
};

export const crawlWithServiceAsync = async (
  env: Environment,
  jobId: string,
  organizationId: string,
  url: string,
  options: { maxPages?: number }
): Promise<AsyncCrawlResponse> => {
  const crawlerUrl = env.CRAWLER_SERVICE_URL;
  const crawlerSecret = env.CRAWLER_SERVICE_SECRET;
  const productServiceUrl = env.PRODUCT_SERVICE_URL;

  if (!crawlerUrl) {
    throw new Error('CRAWLER_SERVICE_URL not configured');
  }

  if (!productServiceUrl) {
    throw new Error('PRODUCT_SERVICE_URL not configured');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (crawlerSecret) {
    headers.Authorization = `Bearer ${crawlerSecret}`;
  }

  const response = await fetch(`${crawlerUrl}/api/v1/crawl`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jobId,
      organizationId,
      url,
      options: { maxPages: options.maxPages ?? 30 },
      callbacks: {
        completion: `${productServiceUrl}/api/v1/crawler-jobs/${jobId}/crawl-callback`,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Crawler service async error: ${response.status} - ${errorText}`
    );
  }

  return response.json() as Promise<AsyncCrawlResponse>;
};

export const fetchCrawlResults = async (
  env: Environment,
  crawlId: string
): Promise<CrawlResultsResponse> => {
  const crawlerUrl = env.CRAWLER_SERVICE_URL;
  const crawlerSecret = env.CRAWLER_SERVICE_SECRET;

  if (!crawlerUrl) {
    throw new Error('CRAWLER_SERVICE_URL not configured');
  }

  const headers: Record<string, string> = {};

  if (crawlerSecret) {
    headers.Authorization = `Bearer ${crawlerSecret}`;
  }

  const response = await fetch(`${crawlerUrl}/crawls/${crawlId}`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch crawl results: ${response.status} - ${errorText}`
    );
  }

  return response.json() as Promise<CrawlResultsResponse>;
};

export const isCrawlerServiceAvailable = async (
  env: Environment
): Promise<boolean> => {
  const crawlerUrl = env.CRAWLER_SERVICE_URL;
  const crawlerSecret = env.CRAWLER_SERVICE_SECRET;

  if (!crawlerUrl) {
    return false;
  }

  try {
    const headers: Record<string, string> = {};
    if (crawlerSecret) {
      headers.Authorization = `Bearer ${crawlerSecret}`;
    }

    const response = await fetch(`${crawlerUrl}/health`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
};
