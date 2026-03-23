import type { ExtractedProduct } from '../services/ai-extraction';
import type { EnrichedProduct, ProductAgentResult } from './types';
import { buildFallbackAgentResult } from './types';
import { runCategorizationAgent } from './categorization-agent';
import { runMarketIntelligenceAgent } from './market-intelligence-agent';
import { runProductExtractorAgent } from './product-extractor-agent';
import { runProductSynthesisAgent } from './synthesis-agent';

interface CatalogProduct {
  title: string;
  description: string;
  price: number | null;
  category: string | null;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 3000;

export async function analyzeProducts(
  ai: Ai,
  gatewayId: string,
  rawProducts: ExtractedProduct[],
  existingCatalog: CatalogProduct[]
): Promise<EnrichedProduct[]> {
  const startTime = Date.now();
  const enrichedProducts: EnrichedProduct[] = [];

  // Collect existing categories from the catalog for consistency
  const existingCategories = [
    ...new Set(
      existingCatalog
        .map(p => p.category)
        .filter((c): c is string => c !== null && c.length > 0)
    ),
  ];

  console.warn(
    `[ProductAgents] Starting multi-agent analysis for ${rawProducts.length} products (batch size: ${BATCH_SIZE})`
  );

  // Process products in batches
  for (let i = 0; i < rawProducts.length; i += BATCH_SIZE) {
    const batch = rawProducts.slice(i, i + BATCH_SIZE);
    const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(rawProducts.length / BATCH_SIZE);

    console.warn(
      `[ProductAgents] Processing batch ${batchIndex}/${totalBatches} (${batch.length} products)`
    );

    // Rate limit between batches
    if (i > 0) {
      await delay(BATCH_DELAY_MS);
    }

    // Process each product in the batch concurrently
    const batchResults = await Promise.allSettled(
      batch.map(product =>
        analyzeOneProduct(ai, product, existingCatalog, existingCategories)
      )
    );

    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j];
      if (result.status === 'fulfilled') {
        enrichedProducts.push(result.value);
      } else {
        console.error(
          `[ProductAgents] Failed to analyze product "${batch[j].title}":`,
          result.reason
        );
        // Create a minimal enriched product from raw data as fallback
        enrichedProducts.push(buildFallbackEnrichedFromRaw(batch[j]));
      }
    }

    // Update existing categories with newly discovered ones for consistency
    // across batches
    for (const enriched of enrichedProducts.slice(-batch.length)) {
      if (
        enriched.category &&
        enriched.category !== 'Uncategorized' &&
        !existingCategories.includes(enriched.category)
      ) {
        existingCategories.push(enriched.category);
      }
    }
  }

  const elapsed = Date.now() - startTime;
  console.warn(
    `[ProductAgents] Completed analysis of ${enrichedProducts.length} products in ${elapsed}ms`
  );

  return enrichedProducts;
}

async function analyzeOneProduct(
  ai: Ai,
  product: ExtractedProduct,
  existingCatalog: CatalogProduct[],
  existingCategories: string[]
): Promise<EnrichedProduct> {
  // Step 1: Run the 3 analysis agents in parallel
  const parallelResults = await Promise.allSettled([
    runProductExtractorAgent(ai, product),
    runCategorizationAgent(
      ai,
      {
        title: product.title,
        description: product.description,
        price: product.price,
        currency: product.currency,
        imageUrls: product.images,
        variants: [],
      },
      existingCategories
    ),
    runMarketIntelligenceAgent(
      ai,
      {
        title: product.title,
        description: product.description,
        price: product.price,
        currency: product.currency,
        imageUrls: product.images,
        variants: [],
      },
      existingCatalog
    ),
  ]);

  // Extract results with fallbacks
  const extractorResult =
    parallelResults[0].status === 'fulfilled'
      ? parallelResults[0].value
      : {
          ...buildFallbackAgentResult('product-extractor-agent'),
          extraction: {
            title: product.title,
            description: product.description,
            price: product.price,
            currency: product.currency,
            imageUrls: product.images,
            variants: [],
          },
        };

  const categorizationResult =
    parallelResults[1].status === 'fulfilled'
      ? parallelResults[1].value
      : {
          ...buildFallbackAgentResult('categorization-agent'),
          categorization: {
            category: 'Uncategorized',
            subcategory: 'General',
            tags: [],
            attributes: {},
          },
        };

  const marketResult =
    parallelResults[2].status === 'fulfilled'
      ? parallelResults[2].value
      : {
          ...buildFallbackAgentResult('market-intelligence-agent'),
          marketIntelligence: {
            pricePositioning: 'unknown',
            targetAudience: 'general consumers',
            valueProposition: 'Not enough data to determine',
            competitivePosition: 'Not enough data to determine',
          },
        };

  // Log agent results
  const agentNames = [
    'product-extractor-agent',
    'categorization-agent',
    'market-intelligence-agent',
  ];
  for (let i = 0; i < parallelResults.length; i++) {
    if (parallelResults[i].status === 'rejected') {
      console.warn(
        `[ProductAgents] ${agentNames[i]} failed for "${product.title}", using fallback`
      );
    }
  }

  // Collect agent results for synthesis
  const agentResults: ProductAgentResult[] = [
    {
      agentName: extractorResult.agentName,
      findings: extractorResult.findings,
      confidence: extractorResult.confidence,
    },
    {
      agentName: categorizationResult.agentName,
      findings: categorizationResult.findings,
      confidence: categorizationResult.confidence,
    },
    {
      agentName: marketResult.agentName,
      findings: marketResult.findings,
      confidence: marketResult.confidence,
    },
  ];

  // Step 2: Run synthesis to merge all agent outputs
  const enriched = await runProductSynthesisAgent(
    ai,
    extractorResult.extraction,
    categorizationResult.categorization,
    marketResult.marketIntelligence,
    agentResults
  );

  return enriched;
}

function buildFallbackEnrichedFromRaw(
  product: ExtractedProduct
): EnrichedProduct {
  return {
    title: product.title,
    description: product.description,
    price: product.price,
    currency: product.currency,
    imageUrls: product.images,
    category: 'Uncategorized',
    subcategory: 'General',
    tags: [],
    attributes: {},
    targetAudience: 'general consumers',
    valueProposition: '',
    competitivePosition: '',
  };
}
