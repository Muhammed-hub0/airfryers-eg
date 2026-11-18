import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getItems, hasCredentials, normalizeItem, searchItems } from './amazon.mjs';
import {
  ACCESSORY_RE,
  FRYER_RE,
  MAX_PRICE,
  MAX_STALE_DAYS,
  MIN_PRICE,
  PARTNER_TAG,
  SEARCH_MAX_PRICE,
} from './config.mjs';
import { describeProduct, isExcludedBrand } from './naming.mjs';
import { DATA_DIR, writePublic } from './render.mjs';

const SEARCH_QUERIES = ['air fryer', 'airfryer', 'قلاية هوائية', 'air fryer digital'];
const SEARCH_PAGES = [1, 2, 3];
const MAX_NEW_PER_RUN = 25;
const MAX_STORED_OFFERS = 600;
const HISTORY_LIMIT = 200;

const IN_STOCK = new Set(['IN_STOCK', 'IN_STOCK_SCARCE', 'LEADTIME', 'PREORDER', 'AVAILABLE_DATE']);

const today = () => new Date().toISOString().slice(0, 10);

function daysBetween(a, b) {
  const start = Date.parse(a);
  const end = Date.parse(b);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.abs(end - start) / 86400000;
}

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function productUrl(asin) {
  return `https://www.amazon.eg/dp/${asin}?tag=${PARTNER_TAG}`;
}

function recordPrice(history, asin, price) {
  if (!Number.isFinite(price)) return false;
  const list = Array.isArray(history[asin]) ? history[asin] : [];
  const last = list[list.length - 1];
  if (last && Number(last.p) === price) return false;
  list.push({ t: new Date().toISOString(), p: price });
  history[asin] = list.slice(-HISTORY_LIMIT);
  return true;
}

// يطبق بيانات الـ API على منتج موجود
function applyApiItem(offer, api, history) {
  const date = today();
  let changed = false;

  if (api.title) {
    const info = describeProduct({ title: api.title, byLine: api.byLine });
    offer.title = api.title;
    if (!offer.brand) offer.brand = info.brand;
    if (!offer.cap && info.cap) offer.cap = info.cap;
    if (!offer.watt && info.watt) offer.watt = info.watt;
    if (!offer.variant && info.variant) offer.variant = info.variant;
    if (!offer.model && info.model) offer.model = info.model;
    if (!offer.name) offer.name = info.name;
  }

  if (api.image && api.image !== offer.img) {
    offer.img = api.image;
    changed = true;
  }

  const newCondition = api.condition ? String(api.condition).toLowerCase() : '';
  const usableCondition = !newCondition || newCondition === 'new' || newCondition === 'unknown';
  const hasPrice = Number.isFinite(api.price) && api.price >= MIN_PRICE && api.price <= MAX_PRICE;
  const inStock = usableCondition && hasPrice && (!api.availability || IN_STOCK.has(api.availability));

  if (inStock) {
    if (Number(offer.price) !== api.price) {
      offer.price = api.price;
      recordPrice(history, offer.asin, api.price);
      changed = true;
    }
    if (offer.active === false) {
      console.log(`  رجع متاح: ${offer.name || offer.asin}`);
      offer.active = true;
      changed = true;
    }
    offer.reason = null;
    offer.oosCount = 0;
    offer.missCount = 0;
    offer.lastGood = date;
    delete offer.outOfStockSince;
    return changed;
  }

  offer.oosCount = (offer.oosCount || 0) + 1;
  offer.outOfStockSince = offer.outOfStockSince || date;
  offer.lastSeenOut = date;

  const stale = offer.oosCount >= 2 || daysBetween(offer.outOfStockSince, date) >= MAX_STALE_DAYS;
  if (stale && offer.active !== false) {
    console.log(`  اتشال (خلص/مش متاح): ${offer.name || offer.asin} [${api.availability || 'no-price'}]`);
    offer.active = false;
    offer.reason = 'out-of-stock';
    changed = true;
  }
  return changed;
}

async function findNewItems(offers) {
  const known = new Set(offers.map((o) => o.asin));
  const families = new Set(
    offers
      .filter((o) => o.active !== false)
      .map((o) => [o.brand, o.cap, o.watt, o.variant, o.model].join('|')),
  );

  const found = new Map();

  for (const keywords of SEARCH_QUERIES) {
    for (const page of SEARCH_PAGES) {
      let items = [];
      try {
        items = await searchItems({
          keywords,
          itemPage: page,
          itemCount: 10,
          minPrice: MIN_PRICE,
          maxPrice: SEARCH_MAX_PRICE,
        });
      } catch (err) {
        console.warn(`بحث "${keywords}" صفحة ${page} فشل: ${err.message}`);
        continue;
      }

      for (const raw of items) {
        const api = normalizeItem(raw);
        if (!api.asin || known.has(api.asin)) continue;
        if (!api.title || !FRYER_RE.test(api.title)) continue;
        if (ACCESSORY_RE.test(api.title)) continue;
        if (!api.image) continue;
        if (!Number.isFinite(api.price) || api.price < MIN_PRICE || api.price > SEARCH_MAX_PRICE) continue;
        if (api.condition && !/^(new|unknown)$/i.test(api.condition)) continue;
        if (api.availability && !IN_STOCK.has(api.availability)) continue;

        const info = describeProduct({ title: api.title, byLine: api.byLine });
        if (isExcludedBrand(info.brand)) continue;
        if (!info.cap && !info.watt) continue;

        const family = [info.brand, info.cap, info.watt, info.variant, info.model].join('|');
        if (families.has(family)) continue;

        families.add(family);
        known.add(api.asin);
        found.set(api.asin, { api, info });
      }
    }
  }

  return [...found.values()];
}

function makeOffer({ api, info }, date) {
  return {
    asin: api.asin,
    brand: info.brand,
    name: info.name,
    cap: info.cap,
    watt: info.watt,
    variant: info.variant,
    model: info.model,
    title: api.title,
    warranty: '',
    ship: '',
    price: api.price,
    img: api.image,
    url: productUrl(api.asin),
    active: true,
    firstSeen: date,
    lastGood: date,
    source: 'search',
    missCount: 0,
    oosCount: 0,
  };
}

function prune(offers) {
  if (offers.length <= MAX_STORED_OFFERS) return offers;
  const active = offers.filter((o) => o.active !== false);
  const inactive = offers
    .filter((o) => o.active === false)
    .sort((a, b) => String(b.lastGood || '').localeCompare(String(a.lastGood || '')));
  return [...active, ...inactive.slice(0, Math.max(0, MAX_STORED_OFFERS - active.length))];
}

async function main() {
  const offersPath = join(DATA_DIR, 'offers.json');
  const historyPath = join(DATA_DIR, 'history.json');

  const offers = await loadJson(offersPath, null);
  if (!Array.isArray(offers) || offers.length === 0) {
    throw new Error('data/offers.json مش موجود أو فاضي');
  }
  const history = (await loadJson(historyPath, {})) || {};

  // كل الروابط لازم تشيل تاج الأفلييت
  for (const offer of offers) {
    if (offer.asin) offer.url = productUrl(offer.asin);
  }

  const renderOnly = process.argv.includes('--render-only') || !hasCredentials();
  let changes = 0;
  let added = 0;

  if (renderOnly) {
    console.log(
      '⚠️ مفاتيح Creators API مش موجودة (CREATORS_CLIENT_ID / CREATORS_CLIENT_SECRET) — تم تخطي تحديث الأسعار.',
    );
    console.log('   الصفحة هتتبني بآخر بيانات محفوظة في data/offers.json.');
  } else {
    const asins = offers.map((o) => o.asin).filter(Boolean);
    console.log(`بنحدّث ${asins.length} منتج من Creators API...`);

    const { items, errors } = await getItems(asins);
    console.log(`رد الـ API: ${items.size} منتج${errors.length ? ` · ${errors.length} تحذير` : ''}`);

    if (errors.length) {
      const unique = [...new Set(errors.map((e) => (e.message || e.code || 'error').slice(0, 240)))].slice(0, 4);
      console.log(`  تحذيرات: ${unique.join(' · ')}`);
    }

    for (const offer of offers) {
      const item = items.get(offer.asin);
      if (!item) continue;
      const api = normalizeItem(item);
      if (applyApiItem(offer, api, history)) changes++;
    }

    // المنتجات اللي مش راجعة من الـ API
    if (items.size > 0) {
      for (const offer of offers) {
        if (items.has(offer.asin)) continue;
        offer.missCount = (offer.missCount || 0) + 1;
        if (offer.missCount >= 3 && offer.active !== false) {
          console.log(`  اتشال (مبقاش موجود): ${offer.name || offer.asin}`);
          offer.active = false;
          offer.reason = 'not-found';
          changes++;
        }
      }
    } else {
      console.log('⚠️ الـ API مرجّعش أي منتج — تم تخطي الحذف في هذه الدورة.');
    }

    // إضافة منتجات جديدة
    try {
      const fresh = await findNewItems(offers);
      for (const candidate of fresh.slice(0, MAX_NEW_PER_RUN)) {
        const offer = makeOffer(candidate, today());
        recordPrice(history, offer.asin, offer.price);
        offers.push(offer);
        added++;
        console.log(`  جديد: ${offer.name} — ${offer.price} ج.م`);
      }
      if (!fresh.length) console.log('  مفيش منتجات جديدة.');
    } catch (err) {
      console.warn(`البحث عن منتجات جديدة فشل: ${err.message}`);
    }
  }

  history._meta = {
    lastRun: new Date().toISOString(),
    apiUsed: !renderOnly,
    activeCount: offers.filter((o) => o.active !== false).length,
    totalCount: offers.length,
  };

  const finalOffers = prune(offers);
  const count = await writePublic(finalOffers, { updatedAt: new Date().toISOString() });

  await writeFile(offersPath, `${JSON.stringify(finalOffers, null, 2)}\n`, 'utf8');
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');

  console.log(
    `✅ خلص: ${count} منتج في الصفحة · ${finalOffers.filter((o) => o.active !== false).length} نشِط · ${added} جديد · ${changes} تغيير`,
  );
}

main().catch((err) => {
  console.error('❌ فشل التحديث:', err);
  process.exit(1);
});
