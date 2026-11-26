const shops = new Map([
  ['Pets Place', 'www.petsplace.nl'],
  ['Royal Canin Nederland', 'www.royalcanin.com'],
  ['Intratuin', 'www.intratuin.nl'],
]);

const amsterdamDay = new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Amsterdam',year:'numeric',month:'2-digit',day:'2-digit'});

function canonicalUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    url.hash = '';
    url.searchParams.sort();
    return url;
  } catch {
    return null;
  }
}

function schemaType(value) {
  return typeof value === 'string' ? value.split('/').at(-1) : '';
}

function stockState(value) {
  const state = schemaType(value);
  if (state === 'InStock') return 'in_stock';
  if (state === 'OutOfStock') return 'out_of_stock';
  return null;
}

function packSize(name) {
  const text = String(name || '').toLowerCase().replaceAll(',','.');
  const multi = text.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|g|gr(?:am)?)\b/);
  if (multi) return {units:Number(multi[1]),kg:Number(multi[2])/(multi[3]==='kg'?1:1000)};
  const weight = text.match(/(\d+(?:\.\d+)?)\s*(kg|g|gr(?:am)?)\b(?:\s*(\d+)\s*stuks?)?/);
  return weight ? {units:Number(weight[3] || 1),kg:Number(weight[1])/(weight[2]==='kg'?1:1000)} : null;
}

function variant(product, offer, useOfferId) {
  if (schemaType(offer?.['@type']) !== 'Offer' || offer.priceCurrency !== 'EUR') return null;
  const identity = useOfferId ? offer : product;
  if (!useOfferId && ((offer.gtin13 && offer.gtin13 !== product.gtin13) || (offer.sku && String(offer.sku) !== String(product.sku)))) return null;
  const gtin = String(identity.gtin13 || '');
  const sku = String(identity.sku || '');
  const url = canonicalUrl(offer.url);
  const priceText = String(offer.price);
  const stock = stockState(offer.availability);
  if (!/^\d{13}$/.test(gtin) || !sku || !url || !stock || !/^\d{1,8}(?:\.\d{1,2})?$/.test(priceText)) return null;
  const price = Number(priceText);
  return price > 0 ? { gtin, sku, url: url.href, price, stock, pack:packSize(identity.name) } : null;
}

export function readVariants(html) {
  const results = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/\btype\s*=\s*["']application\/ld\+json["']/i.test(match[1])) continue;
    let json;
    try { json = JSON.parse(match[2]); } catch { continue; }
    const queue = Array.isArray(json) ? [...json] : [json];
    while (queue.length) {
      const record = queue.pop();
      if (!record || typeof record !== 'object') continue;
      if (Array.isArray(record['@graph'])) queue.push(...record['@graph']);
      const type = schemaType(record['@type']);
      if (type === 'ProductGroup' && Array.isArray(record.hasVariant)) queue.push(...record.hasVariant);
      if (type !== 'Product') continue;
      if (Array.isArray(record.offers)) {
        // Pets Place identifies each pack on its own Offer. The surrounding Product also has a GTIN.
        for (const offer of record.offers) {
          const candidate = variant(record, offer, true);
          if (candidate) results.push(candidate);
        }
      } else {
        const candidate = variant(record, record.offers, false);
        if (candidate) results.push(candidate);
      }
    }
  }
  return results;
}

function petsPlaceDiscounts(html, baseUrl) {
  const discounts = [];
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/\btype\s*=\s*["']text\/x-magento-init["']/i.test(script[1])) continue;
    let init;
    try { init = JSON.parse(script[2]); } catch { continue; }
    for (const settings of Object.values(init || {})) {
      const config = settings?.['Magento_Swatches/js/swatch-renderer']?.jsonConfig;
      if (!config?.currencyFormat?.includes('€')) continue;
      for (const [id, pricing] of Object.entries(config.optionPrices || {})) {
        const details = config.additionalData?.[id];
        const selection = config.index?.[id];
        if (details?.isInStock !== true || !selection || !Object.keys(selection).length) continue;
        const url = new URL(baseUrl);
        if (Object.keys(selection).some(key => !config.attributes?.[key]?.code)) continue;
        for (const [key,value] of Object.entries(selection)) url.searchParams.set(config.attributes[key].code,value);
        if (String(pricing.promotionalText || '').trim()) continue;
        const price = pricing.finalPrice?.amount;
        const reference = pricing.oldPrice?.amount;
        const label = String(pricing.discount || '').trim();
        const percent = /^(\d{1,2})%$/.exec(label);
        if (!percent || !(Number.isFinite(price) && price > 0 && Number.isFinite(reference) && reference > price)) continue;
        if (Math.round(100 * (reference-price) / reference) !== Number(percent[1])) continue;
        discounts.push({gtin:details.additionalAttr?.ean?.value, sku:String(details.additionalAttr?.sku?.value || ''),
          url:canonicalUrl(url.href).href, price, reference, label});
      }
    }
  }
  return discounts;
}

function confirmsDiscount(promotion, discounts, offer, checked) {
  const cutoff = promotion.valid_until;
  if (cutoff && (/^\d{4}-\d{2}-\d{2}$/.test(cutoff) ? cutoff < amsterdamDay.format(new Date(checked)) : !(Date.parse(cutoff) >= Date.parse(checked)))) return false;
  if (promotion.kind !== 'actie' || offer.stock !== 'in_stock' || promotion.price_eur !== offer.price_eur ||
      !Number.isFinite(promotion.reference_eur) || promotion.reference_label !== 'Reguliere verkoopprijs volgens Pets Place') return false;
  const url = canonicalUrl(promotion.url);
  const label = String(promotion.label || '').match(/^(\d{1,2})%\s+korting$/i);
  if (!url || !label) return false;
  const rows = discounts.filter(row => row.gtin === promotion.gtin && row.sku === String(promotion.shop_sku) && row.url === url.href);
  return rows.length > 0 && rows.every(row => row.label === label[1]+'%' && row.price === offer.price_eur && row.reference === promotion.reference_eur);
}

export function matchOffer(offer, candidates) {
  const url = canonicalUrl(offer.url);
  const sku = offer.shop_sku || offer.sku;
  if (!url || url.hostname !== shops.get(offer.shop) || !/^\d{13}$/.test(offer.gtin || '') || !sku) return null;
  const matches = candidates.filter(row => row.gtin === offer.gtin && row.sku === String(sku) && row.url === url.href);
  if (matches.some(row => {
    if (!row.pack) return offer.units > 1;
    return row.pack.units !== offer.units || (offer.unit_kg != null && Math.abs(row.pack.kg-offer.unit_kg) > 1e-6);
  })) return null;
  if (!matches.length || matches.some(row => row.price !== matches[0].price || row.stock !== matches[0].stock)) return null;
  return matches[0];
}

export function verifyCatalog(catalog) {
  if (catalog.currency !== 'EUR' || catalog.destination !== 'NL' || !Array.isArray(catalog.food_products) || !Array.isArray(catalog.tech_products)) {
    throw new Error('Verwacht een Nederlandse catalogus met prijzen in euro.');
  }
  const slugs = new Set();
  for (const product of [...catalog.food_products, ...catalog.tech_products]) {
    if (!product.slug || slugs.has(product.slug) || !Array.isArray(product.offers)) throw new Error('Dubbele of ongeldige productregel: '+product.slug);
    slugs.add(product.slug);
    for (const offer of product.offers) {
      if (!(Number.isFinite(offer.price_eur) && offer.price_eur > 0 && Number.isInteger(offer.units) && offer.units > 0 &&
          ['in_stock', 'out_of_stock', 'unknown'].includes(offer.stock) && Number.isFinite(Date.parse(offer.checked_at)))) {
        throw new Error('Ongeldige prijswaarneming: '+product.slug+' / '+offer.shop);
      }
    }
  }
}

export async function refreshCatalog(catalog, { load, now = () => new Date(), concurrency = 3, promotions = [] }) {
  verifyCatalog(catalog);
  const groups = new Map();
  const bundleKey = (slug, entry) => JSON.stringify([slug, entry.shop, entry.url, entry.units, entry.unit_kg]);
  const promotionFor = new Map();
  for (const promo of promotions) {
    if (promo.shop !== 'Pets Place' || promo.kind !== 'actie') continue;
    const key = bundleKey(promo.slug, promo);
    // Ignore ambiguous campaign rows on the same SKU.
    promotionFor.set(key, promotionFor.has(key) ? null : promo);
  }
  const report = {};
  for (const product of [...catalog.food_products, ...catalog.tech_products]) {
    for (const offer of product.offers) {
      if (!shops.has(offer.shop)) continue;
      const stats = report[offer.shop] ??= { total: 0, observed: 0, unmatched: 0, failed: 0 };
      stats.total++;
      const promo = promotionFor.get(bundleKey(product.slug,offer));
      const identity = {...offer, gtin:offer.gtin || promo?.gtin, shop_sku:offer.shop_sku || offer.sku || promo?.shop_sku};
      const url = canonicalUrl(offer.url);
      if (!url || url.hostname !== shops.get(offer.shop) || !/^\d{13}$/.test(identity.gtin || '') || !identity.shop_sku) {
        stats.unmatched++;
        continue;
      }
      // One page contains all pack options. A match still requires the full original variant URL.
      url.search = '';
      if (!groups.has(url.href)) groups.set(url.href, []);
      groups.get(url.href).push({offer,identity,promo});
    }
  }
  const jobs = groups.entries();
  async function worker() {
    for (const [url, offers] of jobs) {
      const stats = report[offers[0].offer.shop];
      let candidates, discounts = [];
      try {
        const html = await load(url);
        candidates = readVariants(html);
        if (offers.some(entry => entry.promo)) discounts = petsPlaceDiscounts(html,url);
      }
      catch { stats.failed += offers.length; continue; }
      const checked = now().toISOString();
      for (const {offer,identity,promo} of offers) {
        const row = matchOffer(identity, candidates);
        if (!row) { stats.unmatched++; continue; }
        if (Date.parse(checked) < Date.parse(offer.checked_at)) { stats.unmatched++; continue; }
        offer.price_eur = row.price;
        offer.stock = row.stock;
        offer.checked_at = checked;
        stats.observed++;
        if (promo && Date.parse(checked) >= Date.parse(promo.checked_at) && confirmsDiscount(promo, discounts, offer, checked)) {
          promo.checked_at = checked;
          stats.promotions = (stats.promotions || 0) + 1;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  verifyCatalog(catalog);
  return report;
}
