import type { Environment } from '../types';
import puppeteer from '@cloudflare/puppeteer';

export interface PageContent {
  url: string;
  html: string;
  title: string;
  links: string[];
  loadTime: number;
}

const fetchPageWithHttp = async (url: string): Promise<PageContent> => {
  const startTime = Date.now();

  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 CROW-Crawler/1.0',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const html = await response.text();
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1] : '';

  const linkRegex = /href=["']([^"']+)["']/gi;
  const links: string[] = [];
  const matches = html.matchAll(linkRegex);

  for (const match of matches) {
    try {
      const href = match[1];
      if (href.startsWith('http')) {
        links.push(href);
      } else if (href.startsWith('/')) {
        const base = new URL(url);
        links.push(`${base.protocol}//${base.host}${href}`);
      }
    } catch {
      continue;
    }
  }

  const loadTime = Date.now() - startTime;
  return { url, html, title, links: [...new Set(links)], loadTime };
};

const extractLinksFromPage = async (
  page: Awaited<
    ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>['newPage']>
  >
): Promise<string[]> => {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    return anchors
      .map(a => (a as HTMLAnchorElement).href)
      .filter(href => href.startsWith('http'));
  });
};

const filterProductUrls = (links: string[], baseUrl: string): string[] => {
  const productPatterns = [
    /\/products?\//i,
    /\/items?\//i,
    /\/p\//i,
    /\/dp\//i,
    /\/shop\//i,
    /\/collections?\//i,
    /\/catalog\//i,
    /\?.*product/i,
  ];

  const baseHost = new URL(baseUrl).host;

  return links.filter(link => {
    try {
      const url = new URL(link);
      const isSameHost = url.host === baseHost;
      const matchesPattern = productPatterns.some(p =>
        p.test(url.pathname + url.search)
      );
      return isSameHost && matchesPattern;
    } catch {
      return false;
    }
  });
};

const waitForPageLoad = async (
  page: Awaited<
    ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>['newPage']>
  >,
  timeout: number = 10000
): Promise<void> => {
  await page.waitForNetworkIdle({ timeout, idleTime: 500 }).catch(() => {});
};

const crawlWithPuppeteer = async (
  env: Environment,
  url: string
): Promise<PageContent> => {
  const startTime = Date.now();
  const browser = await puppeteer.launch(env.BROWSER);

  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 CROW-Crawler/1.0'
    );

    await page.setViewport({ width: 1920, height: 1080 });

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await waitForPageLoad(page);

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight / 2);
    });
    await new Promise(r => setTimeout(r, 1000));

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await new Promise(r => setTimeout(r, 1000));

    const html = await page.content();
    const title = await page.title();
    const links = await extractLinksFromPage(page);
    const loadTime = Date.now() - startTime;

    return { url, html, title, links, loadTime };
  } finally {
    await browser.close();
  }
};

export const crawlPageWithBrowser = async (
  env: Environment,
  url: string
): Promise<PageContent> => {
  if (env.ENVIRONMENT === 'local' || !env.BROWSER) {
    return fetchPageWithHttp(url);
  }

  try {
    return await crawlWithPuppeteer(env, url);
  } catch (error) {
    console.warn(
      `[BROWSER] Puppeteer failed, falling back to HTTP fetch:`,
      error
    );
    return fetchPageWithHttp(url);
  }
};

export const crawlMultiplePagesWithBrowser = async (
  env: Environment,
  urls: string[],
  maxConcurrent: number = 2
): Promise<PageContent[]> => {
  const results: PageContent[] = [];

  for (let i = 0; i < urls.length; i += maxConcurrent) {
    const batch = urls.slice(i, i + maxConcurrent);
    const batchResults = await Promise.all(
      batch.map(url =>
        crawlPageWithBrowser(env, url).catch(error => ({
          url,
          html: '',
          title: '',
          links: [],
          loadTime: 0,
          error: error instanceof Error ? error.message : 'Unknown error',
        }))
      )
    );
    results.push(
      ...(batchResults.filter(r => !('error' in r)) as PageContent[])
    );
  }

  return results;
};

export const discoverProductPages = async (
  env: Environment,
  baseUrl: string,
  maxDepth: number = 2,
  maxPages: number = 50
): Promise<string[]> => {
  const visited = new Set<string>();
  const productUrls = new Set<string>();
  const toVisit: Array<{ url: string; depth: number }> = [
    { url: baseUrl, depth: 0 },
  ];

  while (toVisit.length > 0 && visited.size < maxPages) {
    const current = toVisit.shift();
    if (!current || visited.has(current.url)) continue;

    visited.add(current.url);

    try {
      const pageContent = await crawlPageWithBrowser(env, current.url);
      const productLinks = filterProductUrls(pageContent.links, baseUrl);
      productLinks.forEach(link => productUrls.add(link));

      if (current.depth < maxDepth) {
        const newLinks = pageContent.links
          .filter(link => !visited.has(link))
          .filter(link => {
            try {
              return new URL(link).host === new URL(baseUrl).host;
            } catch {
              return false;
            }
          })
          .slice(0, 10);

        newLinks.forEach(link => {
          if (!visited.has(link)) {
            toVisit.push({ url: link, depth: current.depth + 1 });
          }
        });
      }
    } catch (error) {
      console.error(`[BROWSER] Failed to crawl ${current.url}:`, error);
    }
  }

  return Array.from(productUrls).slice(0, maxPages);
};
