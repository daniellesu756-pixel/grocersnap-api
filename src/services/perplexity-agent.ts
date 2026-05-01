// ── Perplexity Sonar — real-time grocery search ───────────────────────────
// Uses Perplexity's sonar model which searches the web live.
// Perfect for finding current Singapore grocery prices.

export interface PerplexityMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const SYSTEM_PROMPT = `You are ARIA, a Singapore grocery price comparison assistant powered by real-time web search.

Priority stores to search in this order (user's preference):
1. Sheng Siong (shengsiong.com.sg)
2. NTUC FairPrice (fairprice.com.sg)
3. RedMart (redmart.lazada.sg)
4. Shopee Singapore (shopee.sg) — grocery listings
5. Don Don Donki (mpglobal.donki.com)
6. Giant (giant.sg)
7. Mustafa (mustafaonline.com.sg)

When asked about grocery prices, always return this exact compact format:

{emoji} {Item} — all sizes & prices:

• {size} — {cheapest store} \${price} ✅ | {store2} \${price2} | {store3} \${price3}
• {other size} — {cheapest store} \${price} ✅ | {store2} \${price2} | {store3} \${price3}

💡 {one short savings tip}

Rules:
- Group by pack size (10s, 30s tray, 1L, 500g, etc.)
- Top 3 cheapest stores per size, cheapest first with ✅
- Use emoji: 🥚 eggs, 🥛 milk, 🍗 chicken, 🍚 rice, 🍞 bread, 🍜 noodles, 🥩 beef/pork, 🧀 cheese, 🍎 fruit, 🥬 vegetable. Default 🛒.
- Use SGD ($). GST 9% already included.
- Keep responses concise — mobile-friendly
- Singlish OK: "lah", "lor", "can or not"

If a store has no price for that size, skip it — never invent prices. If fewer than 3 stores carry the item, show fewer.`;

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

export async function* perplexitySearchStream(
  query: string,
  history: PerplexityMessage[] = [],
  apiKey: string
): AsyncGenerator<string> {
  const messages: PerplexityMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-6),
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
      search_recency_filter: 'week',
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Perplexity stream error ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch { /* skip malformed chunks */ }
    }
  }
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
