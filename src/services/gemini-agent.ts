import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { searchProducts, getProductsByCategory } from './product-service';
import { STORES } from '../models/store';

export interface GeminiMessage {
  role: 'user' | 'model';
  parts: { text: string }[];
}

const SYSTEM_PROMPT = `You are ARIA, a smart Singapore grocery shopping assistant for the GrocerSnap app.

You help users find the cheapest prices across Singapore's major grocery stores:
- NTUC FairPrice (largest chain, good for everyday items)
- Sheng Siong (often cheapest for fresh produce and staples)
- Cold Storage (premium products, imported goods)
- RedMart (online, good for bulk and branded)
- Don Don Donki (Japanese imports, unique products)
- Giant (hypermarket, good for bulk)

Singapore context:
- Currency is SGD ($)
- Common local terms: xiao bai cai, kai lan, tau ge, tau kwa, bak kwa, char siew, lup cheong
- Singlish is fine: "lah", "lor", "can or not", "where got"
- GST is 9% (already included in prices shown)

Your job:
1. Find the cheapest store for any product
2. Compare prices across stores
3. Suggest best value options
4. Handle Singapore brand names: FairPrice brand, Meiji, Yakult, Milo, Pokka, etc.
5. Know that Regaine/Pregaine are hair loss treatments (NOT "reading"/"freaking")

Keep responses concise and use this format for prices:
• **Product name** — Store $X.XX ✅ (cheapest)

Always end with a savings tip.`;

export async function geminiChat(
  message: string,
  history: GeminiMessage[] = [],
  apiKey: string
): Promise<{ reply: string; tokensUsed?: number }> {
  const genAI = new GoogleGenerativeAI(apiKey);

  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: SYSTEM_PROMPT,
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    ],
  });

  // Search for relevant products to give Gemini real data
  const productContext = await getProductContext(message);

  const chat = model.startChat({
    history: history.slice(-10), // last 10 messages for context
  });

  const fullMessage = productContext
    ? `${message}\n\n[Product data from GrocerSnap database: ${productContext}]`
    : message;

  const result = await chat.sendMessage(fullMessage);
  const reply = result.response.text();

  return {
    reply,
    tokensUsed: result.response.usageMetadata?.totalTokenCount,
  };
}

export async function geminiVision(
  imageBase64: string,
  mimeType: string,
  source: string,
  apiKey: string
): Promise<{ items: Array<{ name: string; qty: string; unit: string }>; summary: string }> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const prompt = source === 'camera'
    ? 'This photo shows a grocery list, receipt, or food products. Extract ALL grocery items and quantities. Return ONLY valid JSON array: [{"name":"eggs","qty":"30","unit":""},{"name":"milk","qty":"2","unit":"L"}]. Return [] if no grocery items found.'
    : 'This document shows a grocery list or receipt. Extract ALL grocery items and quantities. Return ONLY valid JSON array: [{"name":"eggs","qty":"30","unit":""},{"name":"milk","qty":"2","unit":"L"}]. Return [] if no grocery items found.';

  const result = await model.generateContent([
    { inlineData: { data: imageBase64, mimeType } },
    prompt,
  ]);

  const text = result.response.text();
  const jsonMatch = text.match(/\[[\s\S]*?\]/);
  const items = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  const summary = items.length > 0
    ? items.slice(0, 4).map((i: any) => `${i.qty ? i.qty + ' ' : ''}${i.name}`).join(', ')
    : 'No items detected';

  return { items, summary };
}

async function getProductContext(query: string): Promise<string> {
  try {
    const results = searchProducts(query, 6);
    if (results.length === 0) return '';

    return results.map(p => {
      const prices = p.prices.sort((a, b) => a.price - b.price);
      const cheapest = prices[0];
      const storeName = STORES.find(s => s.id === cheapest.storeId)?.label || cheapest.storeId;
      return `${p.name} (${p.unit}): cheapest at ${storeName} $${cheapest.price.toFixed(2)}`;
    }).join('; ');
  } catch {
    return '';
  }
}
