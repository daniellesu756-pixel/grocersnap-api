import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { searchProducts } from './product-service';
import { STORES } from '../models/store';

export interface GeminiMessage {
  role: 'user' | 'model';
  parts: { text: string }[];
}

// ── Singleton client — created ONCE at startup, reused for every request ────
// FIX #3: was "new GoogleGenerativeAI(apiKey)" inside every function call
let _genAI: GoogleGenerativeAI | null = null;
function getClient(apiKey: string): GoogleGenerativeAI {
  if (!_genAI) _genAI = new GoogleGenerativeAI(apiKey);
  return _genAI;
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
- GST is 9% (already included in prices shown)
- Common local terms: xiao bai cai, kai lan, tau ge, tau kwa, bak kwa, char siew, lup cheong
- Singlish is fine: "lah", "lor", "can or not", "where got", "leh", "meh", "sia", "hor"
- Malay terms: sedap (delicious), murah (cheap), mahal (expensive), boleh (can), cincai (anything)
- Hokkien food: tau pok, hae bee, bak kut, lor mee, chai tow kueh, chwee kueh
- Cantonese: yong tau foo, char siu bao, hor fun, cheong fun
- Local brands: FairPrice brand, Meiji, Yakult, Milo, Pokka, Ayam Brand, Tiger beer
- Regaine/Pregaine are hair loss treatments (NOT "reading"/"freaking")

When user speaks Singlish, respond naturally with mild Singlish:
  "Can lah! Cheapest at NTUC $2.50 ✅"
  "Wah, good deal sia — save $1.20!"
  "Aiyah, Cold Storage more expensive lor"

Keep responses concise. When showing prices, use this exact compact format:

{emoji} {Item} — all sizes & prices:

• {size} — {cheapest store} \${price} ✅ | {store2} \${price2} | {store3} \${price3}
• {other size} — {cheapest store} \${price} ✅ | {store2} \${price2} | {store3} \${price3}

💡 {one short savings tip}

Group by size (10s / 30s tray / 1L / 500g). Show top 3 cheapest stores per size. Mark cheapest with ✅. Use emojis: 🥚 eggs, 🥛 milk, 🍗 chicken, 🍚 rice, 🍞 bread, 🍜 noodles. Default 🛒.`;

const SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

// ── Full response (non-streaming) ───────────────────────────────────────────
export async function geminiChat(
  message: string,
  history: GeminiMessage[] = [],
  apiKey: string
): Promise<{ reply: string; tokensUsed?: number }> {
  const genAI = getClient(apiKey);

  // FIX #1: gemini-2.0-flash — no thinking mode, 3× faster than 2.5-flash
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: SYSTEM_PROMPT,
    safetySettings: SAFETY,
  });

  // FIX #4: product context + chat start run in parallel (not sequential)
  const [productContext, chat] = await Promise.all([
    getProductContext(message),
    Promise.resolve(model.startChat({
      // FIX #5: 6 messages max (was 10) — 30% less tokens → faster
      history: history.slice(-6),
    })),
  ]);

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

// ── Streaming response — yields text chunks as they arrive ──────────────────
// FIX #2: instead of waiting for full reply, words stream live to the app
export async function* geminiChatStream(
  message: string,
  history: GeminiMessage[] = [],
  apiKey: string
): AsyncGenerator<string> {
  const genAI = getClient(apiKey);

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: SYSTEM_PROMPT,
    safetySettings: SAFETY,
  });

  // Run product context lookup in parallel with model setup
  const [productContext, chat] = await Promise.all([
    getProductContext(message),
    Promise.resolve(model.startChat({
      history: history.slice(-6),
    })),
  ]);

  const fullMessage = productContext
    ? `${message}\n\n[Product data from GrocerSnap database: ${productContext}]`
    : message;

  const streamResult = await chat.sendMessageStream(fullMessage);

  for await (const chunk of streamResult.stream) {
    const text = chunk.text();
    if (text) yield text;
  }
}

// ── Vision (receipt / camera scan) ──────────────────────────────────────────
export async function geminiTranscribeAudio(
  audioBase64: string,
  mimeType: string,
  apiKey: string
): Promise<{ transcript: string }> {
  const genAI = getClient(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const result = await model.generateContent([
    { inlineData: { data: audioBase64, mimeType } },
    'Transcribe this short grocery shopping voice note. Return only the plain user transcript text with no extra explanation. Keep product names, store names, and quantities accurate.',
  ]);

  const transcript = result.response.text().trim().replace(/^['"\s]+|['"\s]+$/g, '');
  return { transcript };
}

export async function geminiVision(
  imageBase64: string,
  mimeType: string,
  source: string,
  apiKey: string
): Promise<{ items: Array<{ name: string; qty: string; unit: string }>; summary: string }> {
  const genAI = getClient(apiKey);
  // Vision stays on 2.0-flash (fast + accurate for structured extraction)
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  // Single flexible prompt — handles any grocery attachment regardless of source.
  // Lazada/RedMart/FairPrice/Sheng Siong/Cold Storage/Shopee/Giant order pages,
  // printed receipts, handwritten lists, fridge/shelf photos, screenshots, etc.
  const prompt = `You are extracting grocery items from a user's attachment. The image or PDF could be ANY of:
- An online supermarket order page or cart (Lazada/RedMart, FairPrice, Sheng Siong, Cold Storage, Shopee, Giant, Don Don Donki, Mustafa, Lotus's, AEON, Mydin, 99 Speedmart, Econsave, etc.)
- A photo or scan of a printed receipt or invoice
- A screenshot of a shopping cart or order confirmation email
- A handwritten or typed shopping list
- A photo of grocery items on a shelf, in a basket, or in a fridge

Task: list EVERY distinct grocery, food, beverage, household, personal-care, or pharmacy item visible. For each:
- name: clean product name. Remove store/seller prefixes ("RedMart", "FairPrice", "Sheng Siong", etc.). Keep brand + descriptor. Trim trailing flavour/variant codes if irrelevant.
- qty: integer quantity as string ("1", "2", "3"...). Default to "1" if not stated.
- unit: pack/size as visible (e.g. "1L", "550g", "12x330ml", "10pcs"). Use "" if unclear.

Skip obvious noise: shipping fees, vouchers, taxes, refund-processing badges, "show all" links, footer items.

Return ONLY a valid JSON array, no commentary. Example:
[{"name":"Meiji Fresh Milk","qty":"2","unit":"1L"},{"name":"Dasoon Kampong Eggs","qty":"3","unit":"550g"}]

If the attachment is clearly NOT grocery-related (e.g. a selfie, a contract, a screenshot of an unrelated app), return [].`;

  const result = await model.generateContent([
    { inlineData: { data: imageBase64, mimeType } },
    prompt,
  ]);

  const text = result.response.text();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  let items: any[] = [];
  if (jsonMatch) {
    try { items = JSON.parse(jsonMatch[0]); } catch {
      try { items = JSON.parse(jsonMatch[0] + ']'); } catch { items = []; }
    }
  }

  const summary = items.length > 0
    ? items.slice(0, 5).map((i: any) => `${i.qty ? i.qty + ' ' : ''}${i.name}`).join(', ') + (items.length > 5 ? ` +${items.length - 5} more` : '')
    : 'No items detected';

  return { items, summary };
}

// ── Product context lookup ───────────────────────────────────────────────────
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
