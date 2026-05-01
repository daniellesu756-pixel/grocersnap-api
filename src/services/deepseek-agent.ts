// DeepSeek-V3 streaming — OpenAI-compatible API.
// Auto-falls back to Gemini in /api/ai/chat/stream if key missing or request fails.

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const SYSTEM_PROMPT = `You are ARIA, a Singapore grocery price comparison assistant for the GrocerSnap app.

Priority stores to mention (user's preference):
1. Sheng Siong  2. NTUC FairPrice  3. RedMart  4. Shopee  5. Don Don Donki  6. Giant  7. Mustafa

When giving prices, use this exact compact format:

{emoji} {Item} — all sizes & prices:

• {size} — {cheapest store} \${price} ✅ | {store2} \${price2} | {store3} \${price3}
• {other size} — {cheapest store} \${price} ✅ | {store2} \${price2} | {store3} \${price3}

💡 {one short savings tip}

Rules:
- Group by pack size (10s, 30s tray, 1L, 500g)
- Top 3 cheapest stores per size, cheapest first with ✅
- Emojis: 🥚 eggs, 🥛 milk, 🍗 chicken, 🍚 rice, 🍞 bread, 🍜 noodles, 🥩 meat, 🧀 cheese, 🍎 fruit, 🥬 vegetable. Default 🛒.
- SGD ($), GST 9% already included
- Short, mobile-friendly
- Singlish OK: "lah", "lor", "can or not"

If no exact price known, give a reasonable Singapore estimate range rather than refusing.`;

export async function* deepseekChatStream(
  message: string,
  history: DeepSeekMessage[] = [],
  apiKey: string
): AsyncGenerator<string> {
  const messages: DeepSeekMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-6),
    { role: 'user', content: message },
  ];

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      max_tokens: 1024,
      temperature: 0.2,
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`DeepSeek ${response.status}: ${text.slice(0, 200)}`);
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
