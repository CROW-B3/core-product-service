export const productExtractionPrompt = (htmlContent: string) => `Extract all product information from this HTML content and return as JSON.

Return a JSON object with this structure:
{
  "products": [
    {
      "id": "string (generate if not found)",
      "title": "string",
      "description": "string",
      "images": ["array of image URLs"],
      "price": number or null,
      "category": "string or null"
    }
  ],
  "unprocessedContent": "any incomplete product HTML at the end"
}

HTML Content:
${htmlContent}`;
