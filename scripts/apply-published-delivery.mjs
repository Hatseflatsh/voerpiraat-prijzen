import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { orderShipping } from '../src/calculate.mjs';

const tiers = (...entries) => entries.map(([from_eur, shipping_eur]) => ({ from_eur, shipping_eur }));

const policies = {
  'Pets Place': {
    shipping_source: 'https://www.petsplace.nl/bezorgen', free_from_eur: 39, shipping_tiers: tiers([0, 4.99], [39, 0]),
  },
  'Royal Canin Nederland': {
    shipping_source: 'https://www.royalcanin.com/nl/about-us/faqs/verzenden', free_from_eur: 29, shipping_tiers: tiers([0, 3.99], [29, 0]),
  },
  Intratuin: {
    shipping_source: 'https://www.intratuin.nl/klantenservice/faq-bezorging',
    min_order_eur: 15,
    free_from_eur: 40,
    shipping_tiers: tiers([15, 4.95], [40, 0]),
  },
  Medpets: {
    shipping_source: 'https://www.medpets.nl/klantenservice/verzending-bezorging?option=verzendkosten',
    min_order_eur: 14.95,
    free_from_eur: 69,
    shipping_tiers: tiers([14.95, 4.95], [69, 0]),
  },
  Zooplus: {
    shipping_source: 'https://www.zooplus.nl/info/about/shippingcosts',
    min_order_eur: 9,
    // The carrier table charges €2.99 at exactly €29.00; postage is free above that.
    free_from_eur: 29.01,
    shipping_tiers: tiers([9, 4.99], [19, 2.99], [29.01, 0]),
    shipping_weight_limit_kg: 31,
    shipping_overweight_eur: null,
  },
  'Dierapotheek.com': {
    shipping_source: 'https://dierapotheek.com/verzending',
    free_from_eur: 65,
    shipping_tiers: tiers([0, 4.25], [65, 0]),
    shipping_weight_limit_kg: 25,
    shipping_overweight_eur: 6.95,
  },
};

// Each selected hardware variant publishes its own NL shippingRate in OfferShippingDetails.
// This evidence applies to one advertised offer, never to an unknown-weight multi-item order.
const quotedZooVariants = new Set(['1388962.0', '601499.2', '2071539.1', '2460021.1', '479582.0', '781982.0', '2135043.0', '1102103.0', '633845.0', '633918.2', '626578.0', '145974.6']);

export function applyPublishedDelivery(catalog) {
  let changed = 0;
  for (const product of [...(catalog.food_products ?? []), ...(catalog.tech_products ?? [])]) {
    for (const offer of product.offers ?? []) {
      const policy = policies[offer.shop];
      if (!policy) continue;
      // Intratuin publishes separate fees for JKS and direct suppliers. Apply the PostNL table
      // only to the ordinary food offers in this catalogue, not future freight products.
      if (offer.shop === 'Intratuin' && (!product.species || (offer.shipping_method && offer.shipping_method !== 'PostNL'))) continue;
      const previous = JSON.stringify(offer);
      Object.assign(offer, policy);
      if (offer.shop === 'Zooplus' && !product.species) {
        const url = new URL(offer.url);
        const variant = url.searchParams.get('activeVariant');
        if (url.protocol === 'https:' && url.hostname === 'www.zooplus.nl' && quotedZooVariants.has(variant) && url.pathname.endsWith('/' + variant.split('.')[0]) && offer.units === 1 && offer.price_eur >= 29.01) {
          offer.shipping_single_quote_eur = 0;
          offer.shipping_quote_source = offer.url;
        } else {
          delete offer.shipping_single_quote_eur;
          delete offer.shipping_quote_source;
        }
      }
      const kg = offer.shipping_weight_kg ?? (offer.unit_kg > 0 && offer.units > 0 ? offer.units * offer.unit_kg : null);
      offer.shipping_eur = orderShipping(offer, offer.price_eur, kg);
      if (previous !== JSON.stringify(offer)) changed++;
    }
  }
  return changed;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const target = process.argv[2] ?? fileURLToPath(new URL('../data/products.json', import.meta.url));
  const original = fs.readFileSync(target, 'utf8');
  const catalog = JSON.parse(original);
  const changes = applyPublishedDelivery(catalog);
  if (changes) {
    const temporary = target + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(catalog, null, 2) + '\n', {flag:'wx', mode:fs.statSync(target).mode});
      if (fs.readFileSync(target, 'utf8') !== original) throw new Error('De catalogus is ondertussen gewijzigd. Voer de toepassing opnieuw uit.');
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, {force:true});
    }
  }
  console.log(changes + ' winkelopties bijgewerkt.');
}
