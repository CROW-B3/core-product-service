import robotsParser from 'robots-parser';

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  priority?: number;
}

const fetchWithTimeout = async (
  url: string,
  timeout: number = 10000
): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'CROW-Crawler/1.0',
        Accept: 'text/xml,application/xml,text/plain',
      },
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
};

const parseXmlSitemap = (xml: string): SitemapUrl[] => {
  const urls: SitemapUrl[] = [];
  const urlMatches = xml.matchAll(/<url[^>]*>([\s\S]*?)<\/url>/gi);

  for (const match of urlMatches) {
    const urlContent = match[1];
    const locMatch = urlContent.match(/<loc[^>]*>([^<]+)<\/loc>/i);
    if (!locMatch) continue;

    const lastmodMatch = urlContent.match(/<lastmod[^>]*>([^<]+)<\/lastmod>/i);
    const priorityMatch = urlContent.match(
      /<priority[^>]*>([^<]+)<\/priority>/i
    );

    urls.push({
      loc: locMatch[1].trim(),
      lastmod: lastmodMatch?.[1]?.trim(),
      priority: priorityMatch ? Number.parseFloat(priorityMatch[1]) : undefined,
    });
  }

  return urls;
};

const parseSitemapIndex = (xml: string): string[] => {
  const sitemaps: string[] = [];
  const sitemapMatches = xml.matchAll(/<sitemap[^>]*>([\s\S]*?)<\/sitemap>/gi);

  for (const match of sitemapMatches) {
    const locMatch = match[1].match(/<loc[^>]*>([^<]+)<\/loc>/i);
    if (locMatch) sitemaps.push(locMatch[1].trim());
  }

  return sitemaps;
};

const isProductUrl = (url: string): boolean => {
  const productPatterns = [
    /\/products?\//i,
    /\/items?\//i,
    /\/p\//i,
    /\/dp\//i,
    /\/shop\/.+/i,
    /\/collections?\/.+/i,
    /\/catalog\/.+/i,
  ];

  return productPatterns.some(pattern => pattern.test(url));
};

export const fetchRobotsTxt = async (
  baseUrl: string
): Promise<ReturnType<typeof robotsParser> | null> => {
  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).toString();
    const response = await fetchWithTimeout(robotsUrl);
    if (!response.ok) return null;

    const robotsTxt = await response.text();
    return robotsParser(robotsUrl, robotsTxt);
  } catch {
    return null;
  }
};

export const canCrawl = async (
  baseUrl: string,
  targetUrl: string
): Promise<boolean> => {
  const robots = await fetchRobotsTxt(baseUrl);
  if (!robots) return true;
  return robots.isAllowed(targetUrl, 'CROW-Crawler') ?? true;
};

export const discoverSitemaps = async (baseUrl: string): Promise<string[]> => {
  const sitemaps: string[] = [];

  const robots = await fetchRobotsTxt(baseUrl);
  if (robots) {
    const robotsSitemaps = robots.getSitemaps();
    sitemaps.push(...robotsSitemaps);
  }

  const commonSitemapPaths = [
    '/sitemap.xml',
    '/sitemap_index.xml',
    '/sitemap-index.xml',
    '/sitemaps/sitemap.xml',
    '/product-sitemap.xml',
    '/products-sitemap.xml',
  ];

  for (const path of commonSitemapPaths) {
    try {
      const sitemapUrl = new URL(path, baseUrl).toString();
      if (!sitemaps.includes(sitemapUrl)) {
        const response = await fetchWithTimeout(sitemapUrl);
        if (response.ok) sitemaps.push(sitemapUrl);
      }
    } catch {
      continue;
    }
  }

  return sitemaps;
};

export const fetchSitemapUrls = async (
  sitemapUrl: string,
  maxUrls: number = 500
): Promise<SitemapUrl[]> => {
  const allUrls: SitemapUrl[] = [];

  try {
    const response = await fetchWithTimeout(sitemapUrl);
    if (!response.ok) return [];

    const xml = await response.text();

    if (xml.includes('<sitemapindex')) {
      const nestedSitemaps = parseSitemapIndex(xml);

      for (const nestedUrl of nestedSitemaps.slice(0, 5)) {
        const nestedUrls = await fetchSitemapUrls(
          nestedUrl,
          maxUrls - allUrls.length
        );
        allUrls.push(...nestedUrls);
        if (allUrls.length >= maxUrls) break;
      }
    } else {
      allUrls.push(...parseXmlSitemap(xml));
    }
  } catch (error) {
    console.error(`[SITEMAP] Failed to fetch ${sitemapUrl}:`, error);
  }

  return allUrls.slice(0, maxUrls);
};

export const discoverProductUrlsFromSitemap = async (
  baseUrl: string,
  maxUrls: number = 100
): Promise<string[]> => {
  const sitemaps = await discoverSitemaps(baseUrl);
  const productUrls: Set<string> = new Set();

  for (const sitemapUrl of sitemaps) {
    if (productUrls.size >= maxUrls) break;

    const urls = await fetchSitemapUrls(sitemapUrl, maxUrls);

    for (const url of urls) {
      if (isProductUrl(url.loc)) {
        productUrls.add(url.loc);
      }
    }
  }

  return Array.from(productUrls).slice(0, maxUrls);
};

export const getCrawlDelay = async (baseUrl: string): Promise<number> => {
  const robots = await fetchRobotsTxt(baseUrl);
  if (!robots) return 1000;

  const delay = robots.getCrawlDelay('CROW-Crawler');
  return delay ? delay * 1000 : 1000;
};
