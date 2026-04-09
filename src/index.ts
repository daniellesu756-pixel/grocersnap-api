import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import compression from 'compression';
import { STORES, getStoreSearchUrl } from './models/store';
import { CATEGORIES } from './models/product';
import { searchProducts, getProductsByCategory, getProductById, optimizeBasket } from './services/product-service';
import { chat } from './services/ai-agent';
import { geminiChat, geminiVision, GeminiMessage } from './services/gemini-agent';

dotenv.config();

const app = express();
// Gzip compress all responses — speeds up load by 60-70%
app.use(compression());
app.use(cors());
app.use(express.json());
// Cache static files for 1 hour on phone browser
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '1h',
  etag: true,
  lastModified: true,
}));

const PORT = process.env.PORT || 4000;

// ── Store endpoints ────────────────────────────────────────
app.get('/api/stores', (_req, res) => {
  res.json({ stores: STORES });
});

app.get('/api/stores/:id/deeplink', (req, res) => {
  const { id } = req.params;
  const product = req.query.product as string || '';
  const url = getStoreSearchUrl(id, product);
  if (!url) return res.status(404).json({ error: 'Store not found' });
  res.json({ storeId: id, product, url });
});

// ── Product endpoints ──────────────────────────────────────
app.get('/api/products/search', (req, res) => {
  const q = req.query.q as string || '';
  if (!q) return res.status(400).json({ error: 'Query parameter q is required' });
  const limit = parseInt(req.query.limit as string) || 20;
  const results = searchProducts(q, limit);
  res.json({ query: q, count: results.length, results });
});

app.get('/api/products/categories', (_req, res) => {
  res.json({ categories: CATEGORIES });
});

app.get('/api/products/category/:cat', (req, res) => {
  const { cat } = req.params;
  const products = getProductsByCategory(cat);
  res.json({ category: cat, count: products.length, products });
});

app.get('/api/products/:id', (req, res) => {
  const product = getProductById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json({ product });
});

// ── Basket endpoints ───────────────────────────────────────
app.post('/api/basket/optimize', (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });
  const result = optimizeBasket(items);
  res.json(result);
});

// Shared basket store (in-memory, synced from frontend)
let sharedBasket: string[] = [];

// Chrome extension reads this to get the shopping list
app.get('/api/basket/list', (_req, res) => {
  res.json({ items: sharedBasket, count: sharedBasket.length });
});

// Frontend posts the list here whenever it changes
app.post('/api/basket/sync', (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });
  sharedBasket = items.map(String);
  res.json({ ok: true, count: sharedBasket.length });
});

// ── Country map paths ──────────────────────────────────────
app.get('/api/country-paths', (_req, res) => {
  try {
    const fs = require('fs');
    const data = fs.readFileSync(path.join(__dirname, '..', 'country-paths.json'), 'utf8');
    res.json(JSON.parse(data));
  } catch { res.json({}); }
});

// ── AI Agent chat — tries Gemini (free) first, then Claude ────
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, history, connectedStores, country } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const geminiKey = process.env.GEMINI_API_KEY;
    const claudeKey = process.env.ANTHROPIC_API_KEY;

    // Prefer Gemini (free), fall back to Claude if available
    if (geminiKey) {
      const geminiHistory: GeminiMessage[] = (history || []).map((h: any) => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content }],
      }));
      const result = await geminiChat(message, geminiHistory, geminiKey);
      return res.json({ reply: result.reply, provider: 'gemini' });
    }

    if (claudeKey) {
      const result = await chat({ message, history: history || [], connectedStores, country });
      return res.json({ ...result, provider: 'claude' });
    }

    return res.status(503).json({ error: 'No AI key configured. Add GEMINI_API_KEY to .env file.' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('AI chat error:', msg);
    res.status(500).json({ error: 'AI error: ' + msg });
  }
});

// ── Vision / Image scan ────────────────────────────────────
// Reads a grocery list, receipt or shelf photo using Claude Vision
app.post('/api/ai/vision', async (req, res) => {
  try {
    const { image, mimeType, source } = req.body;
    if (!image) return res.status(400).json({ error: 'image (base64) is required' });
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI not configured — add ANTHROPIC_API_KEY' });
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = source === 'camera'
      ? 'This is a photo taken by a phone camera. It may show a handwritten grocery list, a printed shopping list, a supermarket receipt, or products on a shelf. Extract ALL grocery items and their quantities. Return ONLY a JSON array like: [{"name":"eggs","qty":"30","unit":""},{"name":"milk","qty":"2","unit":"L"}]. If no grocery items found, return [].'
      : 'This is an attached document or image. It may be a grocery list, receipt, invoice or shopping note. Extract ALL grocery items and their quantities. Return ONLY a JSON array like: [{"name":"eggs","qty":"30","unit":""},{"name":"milk","qty":"2","unit":"L"}]. If no grocery items found, return [].';

    // Try Gemini Vision first (free), fall back to Claude Vision
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      const result = await geminiVision(image, mimeType || 'image/jpeg', source || 'camera', geminiKey);
      return res.json(result);
    }

    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: image } },
          { type: 'text', text: prompt }
        ]
      }]
    });

    // Parse the JSON response from Claude
    const text = response.content[0].type === 'text' ? response.content[0].text : '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const items = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    const summary = items.length > 0
      ? items.slice(0, 4).map((i: any) => `${i.qty ? i.qty + ' ' : ''}${i.name}`).join(', ') + (items.length > 4 ? ` +${items.length - 4} more` : '')
      : 'No items found';

    res.json({ items, summary, count: items.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('Vision scan error:', msg);
    res.status(500).json({ error: 'Vision error: ' + msg });
  }
});

// ── Health check ───────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  const hasAI = !!process.env.ANTHROPIC_API_KEY;
  res.json({ status: 'ok', version: '1.0.0', stores: STORES.length, categories: CATEGORIES.length, ai: hasAI });
});

app.listen(PORT, () => {
  console.log(`GrocerSnap API running at http://localhost:${PORT}`);
});
