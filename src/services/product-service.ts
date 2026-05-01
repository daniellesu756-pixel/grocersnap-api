import { Product, StorePrice } from '../models/product';
import { PRODUCTS } from '../data/products';
import { STORES } from '../models/store';
import fs from 'fs';
import path from 'path';
import MiniSearch from 'minisearch';

export interface SimilarResult {
  group: string;
  matchScore: number;
  products: Product[];
  priceRange: { min: number; max: number; storeId: string };
}

const SYNONYMS: Record<string, string[]> = {
  'milk': ['fresh milk','full cream milk','low fat milk','skimmed milk','dairy milk','uht milk','pasteurized milk'],
  'eggs': ['egg','chicken egg','fresh egg','cage free','free range egg'],
  'chicken': ['chicken breast','chicken thigh','chicken drumstick','chicken wing','whole chicken'],
  'pork': ['pork belly','pork ribs','pork chop','minced pork','pork loin','sio bak'],
  'rice': ['jasmine rice','basmati rice','brown rice','white rice','grain rice','fragrant rice'],
  'bread': ['white bread','wholemeal bread','sandwich bread','toast bread'],
  'butter': ['salted butter','unsalted butter','dairy butter'],
  'yogurt': ['yoghurt','greek yogurt','low fat yogurt'],
  'oil': ['cooking oil','vegetable oil','sunflower oil','palm oil','canola oil'],
  'noodles': ['instant noodle','mee','pasta','vermicelli','bee hoon','kuay teow'],
  'tofu': ['tau kwa','tau pok','bean curd','silken tofu'],
  'water': ['mineral water','drinking water','distilled water'],
  'sugar': ['white sugar','brown sugar','caster sugar'],
  'detergent': ['laundry detergent','washing powder','fabric wash'],
};

const STORE_IDS = STORES.map(s => s.id);

// Price multipliers for estimating store prices from FairPrice base
const MULTIPLIERS: Record<string, number> = {
  fairprice: 1.00,
  shengsiong: 0.95,
  coldstorage: 1.08,
  redmart: 0.98,
  dondonki: 1.03,
  giant: 0.96,
  mustafa: 0.92,
  shopee: 1.05,
};

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function toProduct(raw: { name: string; img?: string; prices: Record<string, number>; unit: string }, category: string): Product {
  const prices: StorePrice[] = STORE_IDS.map(storeId => ({
    storeId,
    price: raw.prices[storeId] ?? +(raw.prices.fairprice * (MULTIPLIERS[storeId] ?? 1)).toFixed(2),
    currency: 'SGD',
    isEstimated: !(storeId in raw.prices),
  }));

  const cheapest = prices.reduce((min, p) => p.price < min.price ? p : min, prices[0]);

  return {
    id: slugify(raw.name),
    name: raw.name,
    category,
    unit: raw.unit,
    imageUrl: raw.img || null,
    prices,
    cheapestStoreId: cheapest.storeId,
    cheapestPrice: cheapest.price,
    source: 'curated',
  };
}

function normalizeScrapedCategory(cat: string): string {
  const c = (cat || '').toLowerCase().replace(/_/g, '-').trim();
  const map: Record<string, string> = {
    'fresh-milk': 'milk', milk: 'milk',
    eggs: 'eggs', egg: 'eggs',
    'fresh-chicken': 'chicken', chicken: 'chicken',
    'fresh-pork': 'pork', pork: 'pork',
    'fresh-beef-mutton': 'beef',
    'fresh-fish-seafood': 'fish', fish: 'fish',
    'bread-slice': 'bread', 'bread-rolls-buns': 'bread', bread: 'bread',
    'instant-noodles': 'noodles', 'noodles-pasta-rice': 'noodles',
    'cooking-oil': 'oil',
    yoghurt: 'yogurt', yogurt: 'yogurt',
    cheese: 'cheese',
    'fresh-vegetables': 'vegetable', 'fresh-fruits': 'fruit',
    'tofu-beancurd': 'tofu',
    rice: 'rice', water: 'water', coffee: 'coffee', tea: 'tea', sugar: 'sugar',
    'feminine-care': 'feminine-care',
    shampoo: 'shampoo', conditioner: 'conditioner',
    'body-wash-soap': 'body-wash', skincare: 'skincare',
    toothpaste: 'toothpaste', toothbrush: 'toothbrush', deodorant: 'deodorant',
    'hair-styling': 'hair', 'health-supplements': 'supplements',
    'laundry-detergent': 'laundry', 'fabric-softener': 'laundry',
    dishwashing: 'dishwashing', 'tissue-paper': 'tissue',
    'cleaning-tools': 'cleaning', 'air-freshener': 'air-freshener',
    'insect-repellent': 'insect', diapers: 'diapers',
    'baby-milk-formula': 'baby', 'baby-food': 'baby', 'baby-bath': 'baby',
    'cat-food': 'pet', 'dog-food': 'pet',
  };
  return map[c] || c;
}

function loadScrapedProducts(): Product[] {
  const combined = path.join(__dirname, '..', '..', '..', 'scraper', 'data', 'combined-products.json');
  const fairprice = path.join(__dirname, '..', '..', '..', 'scraper', 'data', 'fairprice-products.json');
  const scraperFile = fs.existsSync(combined) ? combined : fairprice;
  if (!fs.existsSync(scraperFile)) {
    console.info('[product-service] no scraped data found, using curated only');
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(scraperFile, 'utf8'));
    const items = Array.isArray(raw.products) ? raw.products : [];
    const seen = new Set<string>();
    const out: Product[] = [];
    for (const item of items) {
      if (!item?.name || typeof item.price !== 'number' || item.price <= 0) continue;
      const id = slugify(item.name);
      if (seen.has(id)) continue;
      seen.add(id);
      const category = normalizeScrapedCategory(item.category || '');
      const fairPrice = item.price;
      const prices: StorePrice[] = STORE_IDS.map((storeId) => ({
        storeId,
        price: storeId === 'fairprice' ? fairPrice : +(fairPrice * (MULTIPLIERS[storeId] ?? 1)).toFixed(2),
        currency: 'SGD',
        isEstimated: storeId !== 'fairprice',
      }));
      const cheapest = prices.reduce((min, p) => (p.price < min.price ? p : min), prices[0]);
      out.push({
        id,
        name: item.name,
        category,
        unit: item.size || '',
        imageUrl: item.image || null,
        prices,
        cheapestStoreId: cheapest.storeId,
        cheapestPrice: cheapest.price,
        source: 'scraped',
      });
    }
    console.info(`[product-service] loaded ${out.length} scraped products`);
    return out;
  } catch (err) {
    console.warn('[product-service] failed to load scraped data:', err instanceof Error ? err.message : 'unknown');
    return [];
  }
}

// Build flat product list — curated wins; scraped fills gaps for unlimited coverage
let _allProducts: Product[] | null = null;
function getAllProducts(): Product[] {
  if (_allProducts) return _allProducts;
  const curated: Product[] = [];
  for (const [category, items] of Object.entries(PRODUCTS)) {
    for (const item of items) {
      curated.push(toProduct(item, category));
    }
  }
  const curatedIds = new Set(curated.map((p) => p.id));
  const scraped = loadScrapedProducts().filter((p) => !curatedIds.has(p.id));
  _allProducts = [...curated, ...scraped];
  console.info(`[product-service] total ${_allProducts.length} products (${curated.length} curated + ${scraped.length} scraped)`);
  return _allProducts;
}

let _searchIndex: MiniSearch<Product> | null = null;
function getSearchIndex(): MiniSearch<Product> {
  if (_searchIndex) return _searchIndex;
  const all = getAllProducts();
  const index = new MiniSearch<Product>({
    idField: 'id',
    fields: ['name', 'category'],
    storeFields: ['id', 'name', 'category', 'unit', 'imageUrl', 'prices', 'cheapestStoreId', 'cheapestPrice', 'source'],
    searchOptions: {
      boost: { name: 2 },
      fuzzy: 0.2,
      prefix: true,
      combineWith: 'AND',
    },
  });
  const t0 = Date.now();
  index.addAll(all);
  console.info(`[product-service] indexed ${all.length} products in ${Date.now() - t0}ms`);
  _searchIndex = index;
  return _searchIndex;
}

const MIN_RELEVANCE_SCORE = 3.0;

function countLiteralHits(queryWords: string[], name: string): number {
  const lower = name.toLowerCase();
  return queryWords.reduce((n, w) => (w.length >= 3 && lower.includes(w) ? n + 1 : n), 0);
}

export function searchProducts(query: string, limit = 20): Product[] {
  const q = query.trim();
  if (!q) return [];
  const queryWords = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (queryWords.length === 0) return [];

  // For multi-word queries, require EVERY significant word to appear in the product name.
  // For single-word queries, one substring hit is enough.
  const required = queryWords.length >= 2 ? queryWords.length : 1;

  const index = getSearchIndex();
  const hits = index.search(q).filter((h) => h.score >= MIN_RELEVANCE_SCORE);
  const verified = hits.filter((h) => countLiteralHits(queryWords, (h as unknown as Product).name) >= required);
  if (verified.length > 0) return verified.slice(0, limit) as unknown as Product[];

  const looser = index.search(q, { combineWith: 'OR', fuzzy: 0.3 })
    .filter((h) => h.score >= MIN_RELEVANCE_SCORE)
    .filter((h) => countLiteralHits(queryWords, (h as unknown as Product).name) >= required);
  return looser.slice(0, limit) as unknown as Product[];
}

export function getProductsByCategory(category: string): Product[] {
  return getAllProducts().filter(p => p.category === category);
}

export function getProductById(id: string): Product | undefined {
  return getAllProducts().find(p => p.id === id);
}

export function findSimilarProducts(query: string): SimilarResult[] {
  const q = query.toLowerCase().trim();
  const all = getAllProducts();

  // Get synonyms for this query
  const synonymList: string[] = [...(SYNONYMS[q] || [])];
  // Also check if query matches any synonym key partially
  for (const [key, syns] of Object.entries(SYNONYMS)) {
    if (key !== q && (key.includes(q) || q.includes(key))) {
      for (const syn of syns) {
        if (!synonymList.includes(syn)) synonymList.push(syn);
      }
    }
  }

  // Score each product
  const scored: { product: Product; score: number }[] = [];

  for (const product of all) {
    const nameLower = product.name.toLowerCase();
    const catLower = product.category.toLowerCase();
    let score = 0;

    // Name contains query word: +40
    if (nameLower.includes(q)) score += 40;

    // Name contains synonym: +25
    for (const syn of synonymList) {
      if (nameLower.includes(syn)) { score += 25; break; }
    }

    // Category matches query: +20
    if (catLower === q || catLower.includes(q) || q.includes(catLower)) score += 20;

    // Partial word match: +10
    if (score === 0) {
      const queryWords = q.split(/\s+/).filter(w => w.length > 2);
      for (const word of queryWords) {
        if (nameLower.includes(word)) { score += 10; break; }
      }
    }

    // Brand match (first word of name): +5
    const brand = nameLower.split(/\s+/)[0];
    if (brand && q.startsWith(brand) && brand.length > 3) score += 5;

    if (score > 15) {
      scored.push({ product, score });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Group by score bands and build results
  const groups = new Map<number, Product[]>();
  for (const { product, score } of scored) {
    const existing = groups.get(score) || [];
    existing.push(product);
    groups.set(score, existing);
  }

  const results: SimilarResult[] = [];
  for (const [score, products] of Array.from(groups.entries()).sort((a, b) => b[0] - a[0])) {
    // Compute price range across all products in this group
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    let cheapestStoreId = '';

    for (const p of products) {
      if (p.cheapestPrice < minPrice) {
        minPrice = p.cheapestPrice;
        cheapestStoreId = p.cheapestStoreId;
      }
      if (p.cheapestPrice > maxPrice) {
        maxPrice = p.cheapestPrice;
      }
    }

    // Build group name from query + score hint
    const groupLabel = score >= 40
      ? query.charAt(0).toUpperCase() + query.slice(1) + ' (Exact Match)'
      : score >= 25
      ? query.charAt(0).toUpperCase() + query.slice(1) + ' (Related)'
      : query.charAt(0).toUpperCase() + query.slice(1) + ' (Partial Match)';

    results.push({
      group: groupLabel,
      matchScore: score,
      products,
      priceRange: {
        min: +minPrice.toFixed(2),
        max: +maxPrice.toFixed(2),
        storeId: cheapestStoreId,
      },
    });
  }

  return results;
}

export function optimizeBasket(items: { productId: string; quantity: number }[]): {
  optimized: { product: Product; storeId: string; price: number; quantity: number }[];
  totalCost: number;
  savings: number;
  byStore: { storeId: string; items: number; subtotal: number }[];
} {
  const optimized: { product: Product; storeId: string; price: number; quantity: number }[] = [];
  let totalCost = 0;
  let worstCost = 0;

  for (const item of items) {
    const product = getProductById(item.productId);
    if (!product) continue;
    const cheapest = product.prices.reduce((min, p) => p.price < min.price ? p : min, product.prices[0]);
    const most = product.prices.reduce((max, p) => p.price > max.price ? p : max, product.prices[0]);
    optimized.push({ product, storeId: cheapest.storeId, price: cheapest.price, quantity: item.quantity });
    totalCost += cheapest.price * item.quantity;
    worstCost += most.price * item.quantity;
  }

  const storeMap = new Map<string, { items: number; subtotal: number }>();
  for (const o of optimized) {
    const existing = storeMap.get(o.storeId) || { items: 0, subtotal: 0 };
    existing.items += o.quantity;
    existing.subtotal += o.price * o.quantity;
    storeMap.set(o.storeId, existing);
  }

  return {
    optimized,
    totalCost: +totalCost.toFixed(2),
    savings: +(worstCost - totalCost).toFixed(2),
    byStore: Array.from(storeMap.entries()).map(([storeId, data]) => ({ storeId, ...data })),
  };
}
