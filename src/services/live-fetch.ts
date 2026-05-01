// Live on-demand product search across store APIs that respond without auth.
// Only one reliable source right now: Lazada (includes RedMart as a seller).
// Shopee/Sheng Siong/Cold Storage all sit behind bot protection.

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface LiveProduct {
  name: string;
  price: number;
  imageUrl: string | null;
  storeId: string;
  sourceUrl: string;
}

interface LazadaItem {
  name?: string;
  price?: number | string;
  priceShow?: string;
  image?: string;
  productUrl?: string;
  itemId?: string | number;
}

export async function fetchLazadaLive(query: string, redmartOnly = true): Promise<LiveProduct[]> {
  const base = 'https://www.lazada.sg/catalog/';
  const params = new URLSearchParams({
    q: query,
    ajax: 'true',
    ...(redmartOnly ? { m: 'redmart' } : {}),
  });

  const resp = await fetch(`${base}?${params.toString()}`, {
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) throw new Error(`Lazada ${resp.status}`);

  const json = (await resp.json()) as { mods?: { listItems?: LazadaItem[] } };
  const items = json.mods?.listItems ?? [];

  return items
    .map((item) => {
      const priceNum = typeof item.price === 'number' ? item.price : parseFloat(String(item.price ?? ''));
      if (!item.name || !Number.isFinite(priceNum) || priceNum <= 0) return null;
      return {
        name: item.name.trim(),
        price: priceNum,
        imageUrl: item.image ?? null,
        storeId: redmartOnly ? 'redmart' : 'lazada',
        sourceUrl: item.productUrl ? (item.productUrl.startsWith('//') ? `https:${item.productUrl}` : item.productUrl) : '',
      } as LiveProduct;
    })
    .filter((p): p is LiveProduct => p !== null);
}
