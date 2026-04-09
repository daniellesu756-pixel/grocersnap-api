import { Product, StorePrice } from '../models/product';
import { PRODUCTS } from '../data/products';
import { STORES } from '../models/store';

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

// Build flat product list
let _allProducts: Product[] | null = null;
function getAllProducts(): Product[] {
  if (_allProducts) return _allProducts;
  _allProducts = [];
  for (const [category, items] of Object.entries(PRODUCTS)) {
    for (const item of items) {
      _allProducts.push(toProduct(item, category));
    }
  }
  return _allProducts;
}

export function searchProducts(query: string, limit = 20): Product[] {
  const q = query.toLowerCase().trim();
  const all = getAllProducts();

  // 1. Exact phrase match (highest priority)
  const exact = all.filter(p => p.name.toLowerCase().includes(q));
  if (exact.length > 0) return exact.slice(0, limit);

  // 2. Exact category match
  const categoryMatch = all.filter(p => p.category === q);
  if (categoryMatch.length > 0) return categoryMatch.slice(0, limit);

  // 3. All words present (in any order)
  const words = q.split(/\s+/).filter(w => w.length > 1);
  const allWords = all.filter(p => {
    const name = p.name.toLowerCase();
    return words.every(w => name.includes(w));
  });
  if (allWords.length > 0) return allWords.slice(0, limit);

  // 4. Fuzzy: any significant word match (skip short stop words)
  const stopWords = new Set(['the','a','an','of','in','for','and','or','to','with']);
  const sigWords = words.filter(w => !stopWords.has(w) && w.length > 2);
  const fuzzy = all.filter(p => {
    const name = p.name.toLowerCase();
    return sigWords.some(w => name.includes(w));
  });

  return fuzzy.slice(0, limit);
}

export function getProductsByCategory(category: string): Product[] {
  return getAllProducts().filter(p => p.category === category);
}

export function getProductById(id: string): Product | undefined {
  return getAllProducts().find(p => p.id === id);
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
