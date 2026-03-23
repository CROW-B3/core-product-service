import type {
  CategorizationResult,
  EnrichedProduct,
  ExtractionAgentResult,
  MarketIntelligenceResult,
  ProductAgentResult,
} from './types';
import { parseJsonFromLlm, runAiPrompt, withRetry } from './types';

const AGENT_NAME = 'product-synthesis-agent';

export async function runProductSynthesisAgent(
  ai: Ai,
  extraction: ExtractionAgentResult,
  categorization: CategorizationResult,
  marketIntelligence: MarketIntelligenceResult,
  agentResults: ProductAgentResult[]
): Promise<EnrichedProduct> {
  const agentFindings = agentResults
    .map(r => {
      const findings = r.findings
        .map(
          f =>
            `  - [${f.significance}] ${f.observation} (Evidence: ${f.evidence})`
        )
        .join('\n');
      return `${r.agentName} (confidence: ${r.confidence}):\n${findings || '  No findings'}`;
    })
    .join('\n\n');

  const prompt = `You are a product data synthesis specialist. Your job is to merge the outputs from multiple analysis agents into a single, polished enriched product record.

Product Extraction:
Title: ${extraction.title}
Description: ${extraction.description}
Price: ${extraction.price ?? 'unknown'} ${extraction.currency ?? ''}
Images: ${extraction.imageUrls.length} image(s)
Variants: ${extraction.variants.length > 0 ? extraction.variants.map(v => `${v.name}: ${v.value}`).join(', ') : 'none'}

Categorization:
Category: ${categorization.category}
Subcategory: ${categorization.subcategory}
Tags: ${categorization.tags.join(', ') || 'none'}
Attributes: ${Object.entries(categorization.attributes).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}

Market Intelligence:
Price Positioning: ${marketIntelligence.pricePositioning}
Target Audience: ${marketIntelligence.targetAudience}
Value Proposition: ${marketIntelligence.valueProposition}
Competitive Position: ${marketIntelligence.competitivePosition}

Agent Findings:
${agentFindings}

Your task:
1. Produce the final enriched product with all fields reconciled
2. Ensure the description is polished and compelling
3. Validate that category, tags, and attributes are consistent
4. Refine the market intelligence fields into clear, actionable statements
5. Resolve any conflicts between agent outputs (prefer higher-confidence agents)

Respond ONLY with valid JSON:
{
  "title": "string",
  "description": "string - polished 1-3 sentence product description",
  "price": null or number,
  "currency": null or "string ISO code",
  "category": "string",
  "subcategory": "string",
  "tags": ["string"],
  "attributes": {"key": "value"},
  "targetAudience": "string",
  "valueProposition": "string",
  "competitivePosition": "string"
}`;

  const response = await withRetry(() => runAiPrompt(ai, prompt, 4000));
  if (!response) {
    return buildFallbackEnrichedProduct(
      extraction,
      categorization,
      marketIntelligence
    );
  }

  const parsed = parseJsonFromLlm<{
    title?: string;
    description?: string;
    price?: number | null;
    currency?: string | null;
    category?: string;
    subcategory?: string;
    tags?: string[];
    attributes?: Record<string, string>;
    targetAudience?: string;
    valueProposition?: string;
    competitivePosition?: string;
  }>(response);

  if (!parsed) {
    return buildFallbackEnrichedProduct(
      extraction,
      categorization,
      marketIntelligence
    );
  }

  return {
    title: parsed.title || extraction.title,
    description: parsed.description || extraction.description,
    price: parsed.price ?? extraction.price,
    currency: parsed.currency ?? extraction.currency,
    imageUrls: extraction.imageUrls,
    category: parsed.category || categorization.category,
    subcategory: parsed.subcategory || categorization.subcategory,
    tags: Array.isArray(parsed.tags) ? parsed.tags : categorization.tags,
    attributes:
      typeof parsed.attributes === 'object' && parsed.attributes !== null
        ? parsed.attributes
        : categorization.attributes,
    targetAudience:
      parsed.targetAudience || marketIntelligence.targetAudience,
    valueProposition:
      parsed.valueProposition || marketIntelligence.valueProposition,
    competitivePosition:
      parsed.competitivePosition || marketIntelligence.competitivePosition,
  };
}

function buildFallbackEnrichedProduct(
  extraction: ExtractionAgentResult,
  categorization: CategorizationResult,
  marketIntelligence: MarketIntelligenceResult
): EnrichedProduct {
  return {
    title: extraction.title,
    description: extraction.description,
    price: extraction.price,
    currency: extraction.currency,
    imageUrls: extraction.imageUrls,
    category: categorization.category,
    subcategory: categorization.subcategory,
    tags: categorization.tags,
    attributes: categorization.attributes,
    targetAudience: marketIntelligence.targetAudience,
    valueProposition: marketIntelligence.valueProposition,
    competitivePosition: marketIntelligence.competitivePosition,
  };
}
