export interface StorePrice {
  storeId: string;
  price: number;
  currency: string;
  isEstimated: boolean;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  unit: string;
  imageUrl: string | null;
  prices: StorePrice[];
  cheapestStoreId: string;
  cheapestPrice: number;
  source: 'curated' | 'scraped';
}

export interface Category {
  id: string;
  label: string;
  emoji: string;
}

export const CATEGORIES: Category[] = [
  { id: 'milk', label: 'Milk & Dairy', emoji: '\u{1F95B}' },
  { id: 'eggs', label: 'Eggs', emoji: '\u{1F95A}' },
  { id: 'chicken', label: 'Chicken & Meat', emoji: '\u{1F357}' },
  { id: 'rice', label: 'Rice & Grains', emoji: '\u{1F35A}' },
  { id: 'bread', label: 'Bread', emoji: '\u{1F35E}' },
  { id: 'butter', label: 'Butter & Spreads', emoji: '\u{1F9C8}' },
  { id: 'sugar', label: 'Sugar', emoji: '\u{1F36C}' },
  { id: 'water', label: 'Water', emoji: '\u{1F4A7}' },
  { id: 'milo', label: 'Milo & Beverages', emoji: '\u2615' },
  { id: 'noodles', label: 'Noodles', emoji: '\u{1F35C}' },
  { id: 'oil', label: 'Cooking Oil', emoji: '\u{1FAD9}' },
  { id: 'yogurt', label: 'Yogurt', emoji: '\u{1F366}' },
  { id: 'toothpaste', label: 'Oral Care', emoji: '\u{1FAA5}' },
  { id: 'detergent', label: 'Detergent & Laundry', emoji: '\u{1F9F4}' },
  { id: 'sauces', label: 'Sauces & Condiments', emoji: '\u{1FAD9}' },
  { id: 'drinks', label: 'Drinks', emoji: '\u{1F964}' },
  { id: 'snacks', label: 'Snacks', emoji: '\u{1F36A}' },
  { id: 'coffee', label: 'Coffee & Tea', emoji: '\u2615' },
  { id: 'canned', label: 'Canned Food', emoji: '\u{1F96B}' },
  { id: 'tofu', label: 'Tofu & Bean Curd', emoji: '\u{1F9C8}' },
  { id: 'vegetables', label: 'Vegetables', emoji: '\u{1F96C}' },
  { id: 'fruits', label: 'Fruits', emoji: '\u{1F34E}' },
  { id: 'seafood', label: 'Seafood & Fish', emoji: '\u{1F41F}' },
  { id: 'pork', label: 'Pork', emoji: '\u{1F969}' },
  { id: 'frozen', label: 'Frozen Food', emoji: '\u{1F9CA}' },
  { id: 'household', label: 'Household', emoji: '\u{1F9FB}' },
  { id: 'bodycare', label: 'Body Care', emoji: '\u{1F9F4}' },
  { id: 'baby', label: 'Baby', emoji: '\u{1F476}' },
];
