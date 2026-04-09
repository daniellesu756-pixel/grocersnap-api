import Anthropic from '@anthropic-ai/sdk';
import { searchProducts, getProductsByCategory } from './product-service';
import { STORES } from '../models/store';
import { CATEGORIES } from '../models/product';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Tool definitions ────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_products',
    description: 'Search for grocery products and get prices across all connected stores. Use this when the user mentions any grocery item.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'The product name or description to search for (e.g. "fresh milk", "eggs", "chicken breast")',
        },
        connected_stores: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of store IDs the user is connected to (e.g. ["fairprice", "shengsiong"])',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'compare_stores',
    description: 'Compare total basket cost across stores for multiple items. Call this after searching for all items to give a final recommendation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              best_store: { type: 'string' },
              best_price: { type: 'number' },
            },
          },
          description: 'List of items with their cheapest store and price',
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'get_category_deals',
    description: 'Get all products in a category to find the best deals.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          enum: CATEGORIES,
          description: 'Product category to browse',
        },
        connected_stores: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of store IDs to filter prices for',
        },
      },
      required: ['category'],
    },
  },
  {
    name: 'add_to_basket',
    description: 'Add an item to the user\'s shopping basket at the specified store.',
    input_schema: {
      type: 'object' as const,
      properties: {
        product_id: { type: 'string', description: 'The product ID' },
        product_name: { type: 'string', description: 'Human-readable product name' },
        store_id: { type: 'string', description: 'Store to buy from' },
        price: { type: 'number', description: 'Price in SGD' },
        quantity: { type: 'number', description: 'Quantity to add', default: 1 },
      },
      required: ['product_id', 'product_name', 'store_id', 'price'],
    },
  },
];

// ── Tool execution ──────────────────────────────────────────────────────────

function executeTool(name: string, input: Record<string, unknown>, connectedStores: string[]): unknown {
  const stores = (input.connected_stores as string[]) || connectedStores;

  if (name === 'search_products') {
    const query = input.query as string;
    const results = searchProducts(query, 5);

    if (results.length === 0) {
      return { found: false, query, message: 'No products found for this query.' };
    }

    return results.map(p => {
      const filteredPrices = p.prices.filter(pr => stores.includes(pr.storeId));
      const pricesToShow = filteredPrices.length > 0 ? filteredPrices : p.prices;
      const cheapest = pricesToShow.reduce((a, b) => a.price < b.price ? a : b);
      const storeName = STORES.find(s => s.id === cheapest.storeId)?.label || cheapest.storeId;

      return {
        id: p.id,
        name: p.name,
        unit: p.unit,
        category: p.category,
        best_store: cheapest.storeId,
        best_store_name: storeName,
        best_price: cheapest.price,
        all_prices: pricesToShow.map(pr => ({
          store: STORES.find(s => s.id === pr.storeId)?.label || pr.storeId,
          store_id: pr.storeId,
          price: pr.price,
          is_estimated: pr.isEstimated,
        })).sort((a, b) => a.price - b.price),
      };
    });
  }

  if (name === 'get_category_deals') {
    const category = input.category as string;
    const products = getProductsByCategory(category).slice(0, 8);

    return products.map(p => {
      const filteredPrices = p.prices.filter(pr => stores.includes(pr.storeId));
      const pricesToShow = filteredPrices.length > 0 ? filteredPrices : p.prices;
      const cheapest = pricesToShow.reduce((a, b) => a.price < b.price ? a : b);

      return {
        id: p.id,
        name: p.name,
        unit: p.unit,
        best_store: STORES.find(s => s.id === cheapest.storeId)?.label || cheapest.storeId,
        best_price: cheapest.price,
      };
    });
  }

  if (name === 'compare_stores') {
    const items = input.items as { name: string; best_store: string; best_price: number }[];
    const storeMap: Record<string, { count: number; total: number }> = {};

    for (const item of items) {
      if (!storeMap[item.best_store]) storeMap[item.best_store] = { count: 0, total: 0 };
      storeMap[item.best_store].count++;
      storeMap[item.best_store].total += item.best_price;
    }

    const total = items.reduce((sum, i) => sum + i.best_price, 0);
    return {
      grand_total: +total.toFixed(2),
      by_store: Object.entries(storeMap).map(([store, data]) => ({
        store,
        items: data.count,
        subtotal: +data.total.toFixed(2),
      })).sort((a, b) => b.items - a.items),
    };
  }

  if (name === 'add_to_basket') {
    // This returns a signal to the frontend to add to basket
    return {
      added: true,
      product_id: input.product_id,
      product_name: input.product_name,
      store_id: input.store_id,
      price: input.price,
      quantity: input.quantity || 1,
    };
  }

  return { error: 'Unknown tool' };
}

// ── Message types ───────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  message: string;
  history: ChatMessage[];
  connectedStores?: string[];
  country?: string;
}

export interface ChatResponse {
  reply: string;
  basketItems?: {
    product_id: string;
    product_name: string;
    store_id: string;
    price: number;
    quantity: number;
  }[];
  searchResults?: unknown[];
  toolsUsed?: string[];
}

// ── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(connectedStores: string[], country: string): string {
  const storeNames = connectedStores
    .map(id => STORES.find(s => s.id === id)?.label || id)
    .join(', ');

  return `You are GrocerSnap AI, a friendly and smart grocery shopping assistant for ${country === 'SG' ? 'Singapore' : country === 'MY' ? 'Malaysia' : country === 'AU' ? 'Australia' : country === 'JP' ? 'Japan' : 'Singapore'}.

Your personality:
- Warm, helpful, and direct — like a knowledgeable friend at the grocery store
- Use casual Singapore English (Singlish is OK): "can lah", "very shiok deal", "best one already"
- Be concise — don't over-explain, just help them shop
- Always show prices with $ symbol and 2 decimal places

The user is connected to these stores: ${storeNames || 'FairPrice, Sheng Siong'}
Only show prices from connected stores unless they ask about all stores.

Your capabilities (use tools for these):
1. Search for any grocery product and compare prices across connected stores
2. Find the cheapest option and recommend it clearly
3. Browse product categories for deals
4. Add items to the user's basket at the best store
5. Summarize total basket cost

When the user mentions grocery items:
- Search for each item using the search_products tool
- Show the best price and which store
- Offer to add it to their basket
- If they mention multiple items, search for all of them

When adding to basket:
- Always use add_to_basket tool after confirming the item
- Tell them which store the item will come from

Format your price comparisons like:
🥛 Meiji Fresh Milk 1L
🏆 Best: $3.20 at FairPrice
📊 Sheng Siong: $3.10 | FairPrice: $3.20

Keep responses short and actionable. End with a question or next step to keep the conversation moving.`;
}

// ── Main chat function ───────────────────────────────────────────────────────

export async function chat(req: ChatRequest): Promise<ChatResponse> {
  const connectedStores = req.connectedStores || ['fairprice', 'shengsiong'];
  const country = req.country || 'SG';

  // Build message history for Claude
  const messages: Anthropic.MessageParam[] = req.history.map(m => ({
    role: m.role,
    content: m.content,
  }));

  messages.push({ role: 'user', content: req.message });

  const basketItems: ChatResponse['basketItems'] = [];
  const searchResults: unknown[] = [];
  const toolsUsed: string[] = [];

  // Agentic loop — keep calling until no more tool use
  let currentMessages = [...messages];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: buildSystemPrompt(connectedStores, country),
      tools: TOOLS,
      messages: currentMessages,
    });

    // Collect tool uses and text
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const textBlocks = response.content.filter(b => b.type === 'text');

    if (toolUseBlocks.length === 0) {
      // No more tools — return final text response
      const replyText = textBlocks.map(b => (b as Anthropic.TextBlock).text).join('\n');
      return {
        reply: replyText,
        basketItems: basketItems.length > 0 ? basketItems : undefined,
        searchResults: searchResults.length > 0 ? searchResults : undefined,
        toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
      };
    }

    // Execute all tool calls
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      if (block.type !== 'tool_use') continue;
      toolsUsed.push(block.name);
      const result = executeTool(block.name, block.input as Record<string, unknown>, connectedStores);

      // Capture basket additions
      if (block.name === 'add_to_basket' && (result as { added: boolean }).added) {
        basketItems.push(result as NonNullable<ChatResponse['basketItems']>[0]);
      }
      // Capture search results for frontend
      if (block.name === 'search_products') {
        searchResults.push(result);
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    // Continue the loop with tool results
    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults },
    ];

    // Stop loop if done
    if (response.stop_reason === 'end_turn' && toolUseBlocks.length === 0) break;
  }

  return { reply: 'Something went wrong. Please try again.' };
}
