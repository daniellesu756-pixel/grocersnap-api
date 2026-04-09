export interface DeliveryInfo {
  fee: number;
  freeAbove: number;
  slots: string[];
  sameDay: string;
  note: string | null;
  thirdParty: boolean;
}

export interface Store {
  id: string;
  label: string;
  abbreviation: string;
  websiteUrl: string;
  searchUrlTemplate: string;
  color: string;
  delivery: DeliveryInfo;
}

export const STORES: Store[] = [
  {
    id: 'fairprice', label: 'FairPrice', abbreviation: 'FP',
    websiteUrl: 'https://www.fairprice.com.sg',
    searchUrlTemplate: 'https://www.fairprice.com.sg/search?query={q}',
    color: '#e53e3e',
    delivery: { fee: 3.99, freeAbove: 60, slots: ['9am-11am','11am-1pm','1pm-3pm','3pm-5pm','5pm-7pm','7pm-9pm'], sameDay: 'Order by 12pm', note: 'Express 2-hr delivery available', thirdParty: false },
  },
  {
    id: 'shengsiong', label: 'Sheng Siong', abbreviation: 'SS',
    websiteUrl: 'https://shengsiong.com.sg',
    searchUrlTemplate: 'https://shengsiong.com.sg/search/{q}',
    color: '#dd6b20',
    delivery: { fee: 3.99, freeAbove: 49, slots: ['9am-12pm','12pm-3pm','3pm-6pm','6pm-9pm'], sameDay: 'Order by 10am', note: 'Delivery via Sheng Siong app & website', thirdParty: false },
  },
  {
    id: 'coldstorage', label: 'Cold Storage', abbreviation: 'CS',
    websiteUrl: 'https://coldstorage.com.sg',
    searchUrlTemplate: 'https://coldstorage.com.sg/search?q={q}',
    color: '#2b6cb0',
    delivery: { fee: 6.90, freeAbove: 80, slots: ['9am-11am','11am-1pm','1pm-3pm','3pm-5pm','5pm-7pm','7pm-9pm'], sameDay: 'Order by 2pm', note: null, thirdParty: false },
  },
  {
    id: 'redmart', label: 'RedMart', abbreviation: 'RM',
    websiteUrl: 'https://redmart.lazada.sg',
    searchUrlTemplate: 'https://www.lazada.sg/catalog/?q={q}&m=redmart&from=input',
    color: '#276749',
    delivery: { fee: 3.99, freeAbove: 59, slots: ['8am-11am','11am-2pm','2pm-5pm','5pm-8pm','8pm-10pm'], sameDay: 'Next-day standard', note: '3-hour delivery windows', thirdParty: false },
  },
  {
    id: 'dondonki', label: 'Don Don Donki', abbreviation: 'DDK',
    websiteUrl: 'https://mpglobal.donki.com',
    searchUrlTemplate: 'https://mpglobal.donki.com/search?q={q}',
    color: '#c41e3a',
    delivery: { fee: 5.99, freeAbove: 80, slots: ['10am-2pm','2pm-6pm','6pm-10pm'], sameDay: 'Next-day delivery', note: 'Delivery via DON DON DONKI online store', thirdParty: false },
  },
  {
    id: 'giant', label: 'Giant', abbreviation: 'GNT',
    websiteUrl: 'https://giant.sg',
    searchUrlTemplate: 'https://giant.sg/',
    color: '#f6821f',
    delivery: { fee: 4.99, freeAbove: 60, slots: ['9am-11am','11am-1pm','1pm-3pm','3pm-5pm','5pm-7pm','7pm-9pm'], sameDay: 'Order by 1pm', note: null, thirdParty: false },
  },
  {
    id: 'mustafa', label: 'Mustafa', abbreviation: 'MUS',
    websiteUrl: 'https://mustafa.com.sg',
    searchUrlTemplate: 'https://www.mustafaonline.com.sg/',
    color: '#6b46c1',
    delivery: { fee: 10, freeAbove: 100, slots: ['10am-1pm','1pm-5pm','5pm-9pm'], sameDay: 'Next-day only', note: 'Wide range of Indian & South Asian products', thirdParty: false },
  },
  {
    id: 'watsons', label: 'Watsons', abbreviation: 'WAT',
    websiteUrl: 'https://www.watsons.com.sg',
    searchUrlTemplate: 'https://www.watsons.com.sg/search?text={q}',
    color: '#0072bc',
    delivery: { fee: 3.99, freeAbove: 38, slots: ['9am-1pm','1pm-5pm','5pm-9pm'], sameDay: 'Next-day standard', note: 'Health, beauty & personal care products', thirdParty: false },
  },
  {
    id: 'guardian', label: 'Guardian', abbreviation: 'GRD',
    websiteUrl: 'https://www.guardian.com.sg',
    searchUrlTemplate: 'https://www.guardian.com.sg/search?q={q}',
    color: '#00a651',
    delivery: { fee: 4.99, freeAbove: 40, slots: ['9am-1pm','1pm-5pm','5pm-9pm'], sameDay: 'Next-day standard', note: 'Pharmacy, health & beauty essentials', thirdParty: false },
  },
];

export function getStoreSearchUrl(storeId: string, productName: string): string {
  const store = STORES.find(s => s.id === storeId);
  if (!store) return '';
  return store.searchUrlTemplate.replace('{q}', encodeURIComponent(productName));
}
