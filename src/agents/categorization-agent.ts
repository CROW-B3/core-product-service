import type {
  CategorizationResult,
  ExtractionAgentResult,
  ProductAgentResult,
} from './types';
import {
  buildFallbackAgentResult,
  parseJsonFromLlm,
  runAiPrompt,
  withRetry,
} from './types';

const AGENT_NAME = 'categorization-agent';

export async function runCategorizationAgent(
  ai: Ai,
  extraction: ExtractionAgentResult,
  existingCategories: string[]
): Promise<ProductAgentResult & { categorization: CategorizationResult }> {
  const categoryContext =
    existingCategories.length > 0
      ? `Existing categories in the catalog (prefer reusing these for consistency):\n${existingCategories.join(', ')}`
      : 'No existing categories in the catalog yet. Create appropriate ones.';

  const variantsSummary =
    extraction.variants.length > 0
      ? `Variants: ${extraction.variants.map(v => `${v.name}: ${v.value}`).join(', ')}`
      : 'No variants identified';

  const prompt = `You are a product categorization specialist. Analyze this product and assign appropriate categories, tags, and attributes.

Product:
Title: ${extraction.title}
Description: ${extraction.description}
Price: ${extraction.price ?? 'unknown'} ${extraction.currency ?? ''}
${variantsSummary}

${categoryContext}

Your task:
1. Assign a primary category (e.g., "Electronics", "Clothing", "Home & Garden", "Beauty", "Sports")
2. Assign a subcategory (e.g., "Smartphones", "T-Shirts", "Kitchen Appliances")
3. Generate relevant tags for search and filtering (5-10 tags)
4. Extract key product attributes as key-value pairs (brand, material, color, size, weight, etc.)

IMPORTANT:
- Use existing categories when the product fits them
- Keep categories broad enough to group similar products
- Tags should be specific and useful for filtering
- Attributes should capture measurable or filterable product properties

Respond ONLY with valid JSON:
{
  "categorization": {
    "category": "string",
    "subcategory": "string",
    "tags": ["string"],
    "attributes": {"key": "value"}
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
      categorization: {
        category: 'Uncategorized',
        subcategory: 'General',
        tags: [],
        attributes: {},
      },
    };
  }

  const parsed = parseJsonFromLlm<{
    categorization?: {
      category?: string;
      subcategory?: string;
      tags?: string[];
      attributes?: Record<string, string>;
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
      categorization: {
        category: 'Uncategorized',
        subcategory: 'General',
        tags: [],
        attributes: {},
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
    categorization: {
      category: parsed.categorization?.category || 'Uncategorized',
      subcategory: parsed.categorization?.subcategory || 'General',
      tags: Array.isArray(parsed.categorization?.tags)
        ? parsed.categorization.tags
        : [],
      attributes:
        typeof parsed.categorization?.attributes === 'object' &&
        parsed.categorization.attributes !== null
          ? parsed.categorization.attributes
          : {},
    },
  };
}
