export const LLAMA_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export interface ProductFinding {
  observation: string;
  evidence: string;
  significance: 'high' | 'medium' | 'low';
}

export interface ProductAgentResult {
  agentName: string;
  findings: ProductFinding[];
  confidence: number;
}

export interface EnrichedProduct {
  // Original fields from extraction
  title: string;
  description: string;
  price: number | null;
  currency: string | null;
  imageUrls: string[];
  // New enriched fields
  category: string;
  subcategory: string;
  tags: string[];
  attributes: Record<string, string>;
  targetAudience: string;
  valueProposition: string;
  competitivePosition: string;
}

export interface CategorizationResult {
  category: string;
  subcategory: string;
  tags: string[];
  attributes: Record<string, string>;
}

export interface MarketIntelligenceResult {
  pricePositioning: string;
  targetAudience: string;
  valueProposition: string;
  competitivePosition: string;
}

export interface ExtractionAgentResult {
  title: string;
  description: string;
  price: number | null;
  currency: string | null;
  imageUrls: string[];
  variants: { name: string; value: string }[];
}

export function parseJsonFromLlm<T>(responseText: string): T | null {
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as T;
  } catch {
    return null;
  }
}

export async function runAiPrompt(
  ai: Ai,
  prompt: string,
  maxTokens: number = 512
): Promise<string> {
  try {
    const result = await ai.run(LLAMA_MODEL as any, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
    });
    const output = result as { response?: string } | string;
    return typeof output === 'string' ? output : (output?.response ?? '');
  } catch (err) {
    console.error('[ProductAgent] AI prompt failed:', err);
    return '';
  }
}

export function buildFallbackAgentResult(
  agentName: string
): ProductAgentResult {
  return {
    agentName,
    findings: [],
    confidence: 0.1,
  };
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const withRetry = async <T>(
  fn: () => Promise<T>,
  maxRetries: number = 5,
  baseDelay: number = 3000,
  attempt: number = 0
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const isRateLimit =
      err.message.includes('1031') || err.message.includes('rate');

    if (attempt >= maxRetries || !isRateLimit) throw err;

    const waitTime = baseDelay * 2 ** attempt;
    console.warn(
      `[ProductAgent] Rate limited, retrying in ${waitTime}ms (attempt ${attempt + 1}/${maxRetries})`
    );
    await delay(waitTime);

    return withRetry(fn, maxRetries, baseDelay, attempt + 1);
  }
};
