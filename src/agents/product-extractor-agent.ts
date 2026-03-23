import type { ExtractedProduct } from '../services/ai-extraction';
import type { ExtractionAgentResult, ProductAgentResult } from './types';
import {
  buildFallbackAgentResult,
  parseJsonFromLlm,
  runAiPrompt,
  withRetry,
} from './types';

const AGENT_NAME = 'product-extractor-agent';

export async function runProductExtractorAgent(
  ai: Ai,
  product: ExtractedProduct
): Promise<ProductAgentResult & { extraction: ExtractionAgentResult }> {
  const productSummary = `Title: ${product.title}
Description: ${product.description}
Price: ${product.price ?? 'unknown'}
Currency: ${product.currency ?? 'unknown'}
Images: ${product.images.length} image(s)
URL: ${product.url ?? 'unknown'}
Additional Info: ${product.metadata ?? 'none'}`;

  const prompt = `You are a product data extraction specialist. Analyze this product and provide a structured, enhanced extraction with better descriptions and additional detail.

Product Data:
${productSummary}

Your task:
1. Clean and improve the title (remove HTML artifacts, fix casing)
2. Write a clear, compelling product description (1-3 sentences)
3. Validate and normalize the price
4. Identify any variants mentioned (sizes, colors, materials)
5. Note observations about data quality

Respond ONLY with valid JSON:
{
  "extraction": {
    "title": "string - cleaned product title",
    "description": "string - improved 1-3 sentence description",
    "price": null or number,
    "currency": null or "string ISO code",
    "imageUrls": ["string"],
    "variants": [{"name": "string", "value": "string"}]
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
      extraction: {
        title: product.title,
        description: product.description,
        price: product.price,
        currency: product.currency,
        imageUrls: product.images,
        variants: [],
      },
    };
  }

  const parsed = parseJsonFromLlm<{
    extraction?: {
      title?: string;
      description?: string;
      price?: number | null;
      currency?: string | null;
      imageUrls?: string[];
      variants?: { name: string; value: string }[];
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
      extraction: {
        title: product.title,
        description: product.description,
        price: product.price,
        currency: product.currency,
        imageUrls: product.images,
        variants: [],
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
    extraction: {
      title: parsed.extraction?.title || product.title,
      description: parsed.extraction?.description || product.description,
      price: parsed.extraction?.price ?? product.price,
      currency: parsed.extraction?.currency ?? product.currency,
      imageUrls: parsed.extraction?.imageUrls ?? product.images,
      variants: parsed.extraction?.variants ?? [],
    },
  };
}
