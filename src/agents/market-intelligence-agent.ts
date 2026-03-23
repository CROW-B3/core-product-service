import type {
  ExtractionAgentResult,
  MarketIntelligenceResult,
  ProductAgentResult,
} from './types';
import {
  buildFallbackAgentResult,
  parseJsonFromLlm,
  runAiPrompt,
  withRetry,
} from './types';

const AGENT_NAME = 'market-intelligence-agent';

interface CatalogProduct {
  title: string;
  description: string;
  price: number | null;
  category: string | null;
}

export async function runMarketIntelligenceAgent(
  ai: Ai,
  extraction: ExtractionAgentResult,
  existingCatalog: CatalogProduct[]
): Promise<
  ProductAgentResult & { marketIntelligence: MarketIntelligenceResult }
> {
  const catalogSummary =
    existingCatalog.length > 0
      ? buildCatalogSummary(existingCatalog)
      : 'No existing products in the catalog for comparison.';

  const variantsSummary =
    extraction.variants.length > 0
      ? `Variants: ${extraction.variants.map(v => `${v.name}: ${v.value}`).join(', ')}`
      : 'No variants identified';

  const prompt = `You are a market intelligence analyst for e-commerce products. Analyze this product in context of the existing product catalog.

Product Being Analyzed:
Title: ${extraction.title}
Description: ${extraction.description}
Price: ${extraction.price ?? 'unknown'} ${extraction.currency ?? ''}
${variantsSummary}

Existing Catalog Context:
${catalogSummary}

Your task:
1. Determine price positioning relative to similar products (e.g., "budget", "mid-range", "premium", "luxury")
2. Identify the target audience (e.g., "budget-conscious shoppers", "professionals", "tech enthusiasts")
3. Articulate the value proposition (what makes this product worth buying)
4. Assess competitive position (how it compares to similar products in the catalog)

IMPORTANT:
- Be specific and evidence-based
- Reference actual price comparisons when catalog data is available
- If no similar products exist in the catalog, base analysis on general market knowledge
- Keep each field to 1-2 sentences

Respond ONLY with valid JSON:
{
  "marketIntelligence": {
    "pricePositioning": "string - budget|mid-range|premium|luxury with brief explanation",
    "targetAudience": "string - specific audience description",
    "valueProposition": "string - why a customer should buy this",
    "competitivePosition": "string - how it stands against alternatives"
  },
  "findings": [
    {"observation": "string", "evidence": "string", "significance": "high|medium|low"}
  ],
  "confidence": 0.0-1.0
}`;

  const response = await withRetry(() => runAiPrompt(ai, prompt, 3000));
  if (!response) {
    return {
      ...buildFallbackAgentResult(AGENT_NAME),
      marketIntelligence: {
        pricePositioning: 'unknown',
        targetAudience: 'general consumers',
        valueProposition: 'Not enough data to determine',
        competitivePosition: 'Not enough data to determine',
      },
    };
  }

  const parsed = parseJsonFromLlm<{
    marketIntelligence?: {
      pricePositioning?: string;
      targetAudience?: string;
      valueProposition?: string;
      competitivePosition?: string;
    };
    findings?: {
      observation: string;
      evidence: string;
      significance: string;
    }[];
    confidence?: number;
  }>(response);

  if (!parsed) {
    return {
      ...buildFallbackAgentResult(AGENT_NAME),
      marketIntelligence: {
        pricePositioning: 'unknown',
        targetAudience: 'general consumers',
        valueProposition: 'Not enough data to determine',
        competitivePosition: 'Not enough data to determine',
      },
    };
  }

  return {
    agentName: AGENT_NAME,
    findings: (parsed.findings ?? []).map(f => ({
      observation: f.observation,
      evidence: f.evidence,
      significance:
        f.significance === 'high' ||
        f.significance === 'medium' ||
        f.significance === 'low'
          ? f.significance
          : 'medium',
    })),
    confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
    marketIntelligence: {
      pricePositioning:
        parsed.marketIntelligence?.pricePositioning || 'unknown',
      targetAudience:
        parsed.marketIntelligence?.targetAudience || 'general consumers',
      valueProposition:
        parsed.marketIntelligence?.valueProposition ||
        'Not enough data to determine',
      competitivePosition:
        parsed.marketIntelligence?.competitivePosition ||
        'Not enough data to determine',
    },
  };
}

function buildCatalogSummary(catalog: CatalogProduct[]): string {
  // Group products by category for a compact summary
  const byCategory = new Map<string, CatalogProduct[]>();
  for (const product of catalog) {
    const cat = product.category || 'Uncategorized';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(product);
  }

  const lines: string[] = [];
  lines.push(`Total products in catalog: ${catalog.length}`);

  for (const [category, products] of byCategory) {
    const prices = products
      .map(p => p.price)
      .filter((p): p is number => p !== null);
    const priceRange =
      prices.length > 0
        ? `$${(Math.min(...prices) / 100).toFixed(2)} - $${(Math.max(...prices) / 100).toFixed(2)}`
        : 'no pricing data';

    // Limit to 5 product names per category to keep prompt size manageable
    const sampleNames = products
      .slice(0, 5)
      .map(p => p.title)
      .join(', ');
    const moreCount = products.length > 5 ? ` (+${products.length - 5} more)` : '';

    lines.push(
      `  ${category} (${products.length} products, ${priceRange}): ${sampleNames}${moreCount}`
    );
  }

  // Cap the summary to avoid exceeding token limits
  return lines.join('\n').slice(0, 2000);
}
