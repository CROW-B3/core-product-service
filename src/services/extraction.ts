import type { Environment } from '../types';
import type { ExtractedProduct } from './ai-extraction';
import {
  extractProductsFromMultiplePages,
  extractProductsFromPage,
} from './ai-extraction';
import { crawlPageWithBrowser, discoverProductPages } from './browser-crawler';
import {
  crawlWithServiceAsync,
  isCrawlerServiceAvailable,
} from './crawler-client';
import {
  canCrawl,
  discoverProductUrlsFromSitemap,
  getCrawlDelay,
} from './sitemap';

export type { ExtractedProduct };

export interface CrawlResult {
  products: ExtractedProduct[];
  pagesVisited: number;
  errors: string[];
  totalTime: number;
  asyncJobId?: string;
}

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

const normalizeUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(
      /\/$/,
      ''
    );
  } catch {
    return url;
  }
};

const crawlWithCrawlerService = async (
  env: Environment,
  sourceUrl: string,
  jobId: string,
  organizationId: string,
  options: {
    maxPages?: number;
    maxProducts?: number;
  }
): Promise<CrawlResult> => {
  const startTime = Date.now();
  const { maxPages = 30 } = options;

  console.warn(
    `[CRAWLER] Using async crawler service for ${sourceUrl}, jobId: ${jobId}`
  );

  try {
    const asyncResponse = await crawlWithServiceAsync(
      env,
      jobId,
      organizationId,
      sourceUrl,
      { maxPages }
    );

    console.warn(
      `[CRAWLER] Async crawl scheduled for jobId: ${jobId}, response: ${asyncResponse.message}`
    );

    return {
      products: [],
      pagesVisited: 0,
      errors: [],
      totalTime: Date.now() - startTime,
      asyncJobId: jobId,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[CRAWLER] Async crawler service failed:`, error);
    return {
      products: [],
      pagesVisited: 0,
      errors: [errorMsg],
      totalTime: Date.now() - startTime,
    };
  }
};

export const crawlAndExtractProducts = async (
  env: Environment,
  sourceUrl: string,
  options: {
    maxPages?: number;
    maxProducts?: number;
    useSitemap?: boolean;
    useBrowserDiscovery?: boolean;
    useCrawlerService?: boolean;
    jobId?: string;
    organizationId?: string;
  } = {}
): Promise<CrawlResult> => {
  const startTime = Date.now();
  const errors: string[] = [];
  const {
    maxPages = 20,
    maxProducts = 100,
    useSitemap = true,
    useBrowserDiscovery = true,
    useCrawlerService = true,
    jobId,
    organizationId,
  } = options;

  if (useCrawlerService && jobId && organizationId) {
    const crawlerAvailable = await isCrawlerServiceAvailable(env);
    if (crawlerAvailable) {
      return crawlWithCrawlerService(env, sourceUrl, jobId, organizationId, {
        maxPages,
        maxProducts,
      });
    }
    console.warn(
      `[CRAWLER] Crawler service not available, falling back to browser crawling`
    );
  }

  const isAllowed = await canCrawl(sourceUrl, sourceUrl);
  if (!isAllowed) {
    console.warn(`[CRAWLER] Blocked by robots.txt: ${sourceUrl}`);
    return {
      products: [],
      pagesVisited: 0,
      errors: ['Blocked by robots.txt'],
      totalTime: Date.now() - startTime,
    };
  }

  const crawlDelayMs = await getCrawlDelay(sourceUrl);

  let productUrls: string[] = [];

  if (useSitemap) {
    const sitemapUrls = await discoverProductUrlsFromSitemap(
      sourceUrl,
      maxPages
    );
    productUrls.push(...sitemapUrls);
  }

  if (useBrowserDiscovery && productUrls.length < maxPages) {
    const browserUrls = await discoverProductPages(
      env,
      sourceUrl,
      2,
      maxPages - productUrls.length
    );
    productUrls.push(...browserUrls);
  }

  if (productUrls.length === 0) {
    productUrls = [sourceUrl];
  }

  productUrls = [...new Set(productUrls.map(normalizeUrl))].slice(0, maxPages);

  const allProducts: ExtractedProduct[] = [];
  const pages: Array<{ url: string; html: string }> = [];
  let pagesVisited = 0;

  for (const url of productUrls) {
    if (allProducts.length >= maxProducts) {
      break;
    }

    try {
      const pageContent = await crawlPageWithBrowser(env, url);
      pages.push({ url, html: pageContent.html });
      pagesVisited++;

      if (pages.length >= 5 || pagesVisited === productUrls.length) {
        const products = await extractProductsFromMultiplePages(env, pages);
        allProducts.push(...products);
        pages.length = 0;
      }

      if (pagesVisited < productUrls.length) {
        await delay(crawlDelayMs);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`Failed to crawl ${url}: ${errorMsg}`);
      console.error(`[CRAWLER] Error crawling ${url}:`, error);
    }
  }

  if (pages.length > 0) {
    const products = await extractProductsFromMultiplePages(env, pages);
    allProducts.push(...products);
  }

  const totalTime = Date.now() - startTime;

  return {
    products: allProducts.slice(0, maxProducts),
    pagesVisited,
    errors,
    totalTime,
  };
};

export const extractProductsFromHtml = async (
  env: Environment,
  html: string,
  pageUrl: string = 'unknown'
): Promise<ExtractedProduct[]> => {
  return extractProductsFromPage(env, html, pageUrl);
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
      price: typeof p.price === 'number' ? p.price : null,
      currency: typeof p.currency === 'string' ? p.currency : null,
      category: typeof p.category === 'string' ? p.category : null,
      brand: typeof p.brand === 'string' ? p.brand : null,
      variants: null,
      inStock: typeof p.inStock === 'boolean' ? p.inStock : null,
      url: typeof p.url === 'string' ? p.url : null,
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
  const brandIndex = headers.findIndex(h => h === 'brand');
  const urlIndex = headers.findIndex(h => h === 'url');

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
        priceIndex >= 0 ? Number.parseFloat(values[priceIndex]) || null : null,
      currency: null,
      category: categoryIndex >= 0 ? values[categoryIndex] || null : null,
      brand: brandIndex >= 0 ? values[brandIndex] || null : null,
      variants: null,
      inStock: null,
      url: urlIndex >= 0 ? values[urlIndex] || null : null,
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
