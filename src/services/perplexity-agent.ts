// ── Perplexity Sonar — real-time grocery search ───────────────────────────
// Uses Perplexity's sonar model which searches the web live.
// Perfect for finding current Singapore grocery prices.

export interface PerplexityMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const SYSTEM_PROMPT = `You are ARIA, a Singapore grocery price comparison assistant powered by real-time web search.

When asked about grocery prices:
1. Search for current prices at Singapore stores: NTUC FairPrice, Sheng Siong, Cold Storage, RedMart, Watsons, Guardian, Don Don Donki
2. Show prices in this exact format:
   • **Product name Xg/ml/kg** — Store $X.XX ✅ (cheapest)
3. Always show at least 3-4 store comparisons
4. End with a savings tip like: 💰 Save $X.XX by choosing [Store]!
5. Use SGD ($) currency
6. Keep responses concise — mobile-friendly

Singapore context:
- GST 9% already included in shelf prices
- Common local items: xiao bai cai, kai lan, tau ge, bak kwa, char siew
- Singlish OK: "lah", "lor", "can or not"

If you cannot find exact prices, give estimated price ranges based on typical Singapore grocery prices.`;

export async function perplexitySearch(
  query: string,
  history: PerplexityMessage[] = [],
  apiKey: string
): Promise<{ reply: string; citations?: string[] }> {
  const messages: PerplexityMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-6), // last 6 messages for context
    { role: 'user', content: `Singapore grocery price search: ${query}` },
  ];

  const response = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar',
      messages,
      max_tokens: 1024,
      temperature: 0.2,
      search_recency_filter: 'week', // prefer fresh prices
      return_citations: true,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Perplexity API error ${response.status}: ${err}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    citations?: string[];
  };

  const reply = data.choices?.[0]?.message?.content || 'No results found.';
  const citations = data.citations || [];

  return { reply, citations };
}

export async function perplexityGrocerySearch(
  items: string[],
  apiKey: string
): Promise<{ results: Array<{ item: string; reply: string }> }> {
  const results: Array<{ item: string; reply: string }> = [];

  for (const item of items.slice(0, 5)) { // max 5 items per call
    try {
      const { reply } = await perplexitySearch(
        `What is the current price of "${item}" at NTUC FairPrice, Sheng Siong, Cold Storage and RedMart in Singapore? Show cheapest option.`,
        [],
        apiKey
      );
      results.push({ item, reply });
    } catch (err) {
      results.push({ item, reply: `Could not find price for "${item}"` });
    }
  }

  return { results };
}
