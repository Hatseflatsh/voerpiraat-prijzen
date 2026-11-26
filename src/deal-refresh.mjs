import { verifyCatalog } from './refresh-prices.mjs';

const shops = new Map([
  ['Dierapotheker', 'www.dierapotheker.nl'], ['Medpets', 'www.medpets.nl'],
  ['PETKIT Nederland', 'petkit.co.nl'], ['CATLINK EU', 'catlinkeu.com'], ['Neakasa EU', 'eu.neakasa.com'],
]);
// Permanent ID and barcode from each audited official variant and product JSON.
const shopifyPins=new Map([
  ['https://petkit.co.nl/products/petkit-dubbele-automatische-voerbak-kat-met-camera-yumshare-dual-hopper',['51021990920530','6975069302713']],
  ['https://petkit.co.nl/products/petkit-eversweet-max-draadloze-drinkfontein-voor-katten-3l-capaciteit-uvc',['53826994438482','6975069307091']],
]);
const euros = cents => cents / 100;
const money = cents => euros(cents).toFixed(2).replace('.', ',');
const cents = value => /^\d{1,7}(?:\.\d{1,2})?$/.test(String(value)) && Number(value) > 0 ? Math.round(Number(value)*100) : null;
const gtin = value => /^\d{8,14}$/.test(String(value)) ? String(value).padStart(14,'0') : null;
const unique = rows => rows.length === 1 ? rows[0] : null;
const amsterdamDay=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Amsterdam',year:'numeric',month:'2-digit',day:'2-digit'});
const parse = value => { try { return JSON.parse(value); } catch { return null; } };

function checkedUrl(raw, shop) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' && !u.port && !u.username && !u.password && !u.hash && u.hostname === shops.get(shop)) return u;
  } catch { /* Invalid offer URL. */ }
  return null;
}

function stock(value) {
  return ({InStock:'in_stock', OutOfStock:'out_of_stock'})[String(value).split('/').at(-1)] || null;
}

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1],(m[2] ?? m[3]).replaceAll('&amp;', '&')]));
}

function structuredOffers(html) {
  const children = record => {
    if (!record || typeof record !== 'object') return [];
    if (Array.isArray(record)) return record.flatMap(children);
    if (record['@graph']) return children(record['@graph']);
    if (record['@type'] === 'ProductGroup') return children(record.hasVariant);
    if (record['@type'] !== 'Product') return [];
    return [record.offers].flat().filter(o => o?.['@type']==='Offer');
  };
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(m=>attributes(' '+m[1]).type==='application/ld+json').flatMap(m=>children(parse(m[2])));
}

function pack(text) {
  const m = String(text || '').match(/(?:(\d+)\s*[x×]\s*\(\s*)?(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(kg|gram|gr|g)\b/i);
  if (!m) return null;
  return {units:Number(m[1] || 1)*Number(m[2] || 1), kg:Number(m[3].replace(',', '.'))/(m[4].toLowerCase()==='kg'?1:1000)};
}
const samePack = (a,b) => a && a.units===b.units && Math.abs(a.kg-b.unit_kg)<1e-6;

// Match the primary product block, its measurement and its SKU-specific view_item event.
// A complete tier widget can retire an old threshold. Missing or inconsistent markup cannot.
export function dierapothekerPage(html, url) {
  const product = unique([...html.matchAll(/<div\b[^>]*\bid=["']product-data["'][^>]*>/gi)].map(m=>attributes(m[0])));
  if (!product || product['data-url']!==url || product['data-currency']!=='EUR' || !stock(product['data-availability'])) return null;
  const sku = product['data-sku'];
  if (!sku || sku!==product['data-product-number'] || new URL(url).pathname.split('/').filter(Boolean).at(-1)!==sku) return null;
  const observedGtins = new Set([...html.matchAll(/<meta\b[^>]*>/gi)].map(m=>attributes(m[0])).filter(a=>a.itemprop==='gtin13').map(a=>gtin(a.content)));
  const id = unique([...observedGtins]);
  const events = [...html.matchAll(/dataLayer\.push\((\{"event":"view_item"[^\n]*?)\);/g)].map(m=>parse(m[1])?.ecommerce)
    .filter(e=>e?.currency==='EUR' && e.items?.length===1 && String(e.items[0].item_id)===sku);
  const event=unique(events); const base=cents(product['data-price']);
  if (!event || !id || !base || cents(event.items[0].price)!==base) return null;
  const shape=pack(event.items[0].item_variant || event.items[0].item_name);
  const result={sku,gtin:id,pack:shape,price:base,stock:stock(product['data-availability']),tiers:null};
  const widgets=[...html.matchAll(/data-strix-tier-price-selector=["']true["']/g)];
  if (widgets.length!==1) return result;
  const options=[...html.matchAll(/<button\b([^>]*\bdata-min-quantity\s*=[^>]*)>([\s\S]*?)<\/button\s*>/gi)];
  const tiers=new Map();
  for (const m of options) {
    const a=attributes(' '+m[1]), body=m[2];
    if (!a.class?.split(/\s+/).includes('js-tier-price-option') || !/^\d{1,3}$/.test(a['data-min-quantity'])
        || !/^\d{1,7}$/.test(a['data-price-euro']) || !/^\d{1,2}$/.test(a['data-price-cents'])) return result;
    const n=Number(a['data-min-quantity']), price=100*Number(a['data-price-euro'])+Number(a['data-price-cents']);
    const meta=[...body.matchAll(/<meta\b[^>]*>/gi)].map(t=>attributes(t[0]));
    if (!(n>=1 && price>0) || tiers.has(n) || !meta.some(v=>v.itemprop==='price' && cents(v.content)===price) ||
       !meta.some(v=>v.itemprop==='priceCurrency' && v.content==='EUR')) return result;
    if (n>1 && (!(price<base) || !/class=["']strix-tier-price-option-discount["'][^>]*>\s*\d+(?:[.,]\d+)?%\s*korting\s*</i.test(body))) return result;
    tiers.set(n,price);
  }
  if (tiers.get(1)===base) { tiers.delete(1); result.tiers=tiers; }
  return result;
}

function verifiedOffer(offers, url) {
  const rows=offers.filter(o=>o.url===url);
  if (!rows.length || rows.some(o=>o.priceCurrency!=='EUR' || !cents(o.price) || !stock(o.availability)
        || cents(o.price)!==cents(rows[0].price) || stock(o.availability)!==stock(rows[0].availability))) return null;
  return {price:cents(rows[0].price),stock:stock(rows[0].availability)};
}

export function medpetsPage(html) {
  const blocks=[...html.matchAll(/\bwindow\.variants\s*=\s*(\[[^\r\n]*\])\s*;?\s*(?:\r?\n|<\/script>)/g)];
  const variants=blocks.length===1 ? parse(blocks[0][1]) : null;
  return Array.isArray(variants) ? {variants,offers:structuredOffers(html)} : null;
}

function medpetsMatch(page, offer) {
  if (!page || !offer.unit_kg) return null;
  const sku=new URL(offer.url).searchParams.get('sku');
  if (!/^MP\d+$/.test(sku || '') || [offer.sku,offer.shop_sku].filter(Boolean).some(s=>s!==sku)) return null;
  const v=unique(page.variants.filter(v=>v.sku===sku));
  const ld=verifiedOffer(page.offers,offer.url);
  if (!ld || v?.active!==true || !samePack(pack(v.name),offer) || cents(v.price)!==ld.price || !Number.isFinite(v.stock) ||
       (ld.stock==='in_stock')!==(v.stock>0)) return null;
  const promo=v.promotionLabel;
  const percent=/^(\d{1,2})% korting$/i.exec(promo?.label || '');
  const ref=cents(v.price_original);
  const proven=percent && promo.promotion_type===4 && !promo.code && !promo.description && promo.title===promo.label &&
     ref>ld.price && Math.round(100*(ref-ld.price)/ref)===Number(percent[1]);
  // Codes, subscriptions and multipack-only reference prices never become direct discounts.
  const deal=proven ? {label:promo.label,reference_eur:euros(ref),reference_label:'Door Medpets vermelde oorspronkelijke verkoopprijs',
    conditions:'Eenmalige aankoop van de geselecteerde variant. De actieprijs is al verwerkt.'} : null;
  return {...ld,sku,deal};
}

function shopifyMatch(page, offer, savedId, savedGtin) {
  if (!page || offer.units!==1 || offer.unit_kg!=null) return null;
  const url=new URL(offer.url), byUrl=url.searchParams.get('variant');
  // These two canonical storefront URLs lack the variant query. Each mapping was
  // independently verified on the exact variant page and is pinned to its barcode.
  const pinned=shopifyPins.get(offer.url);
  const id=byUrl || offer.shopify_variant_id || savedId || pinned?.[0];
  if (!/^\d{10,16}$/.test(id || '') || [byUrl,offer.shopify_variant_id,savedId,pinned?.[0]].filter(Boolean).some(v=>String(v)!==String(id))) return null;
  const v=unique(page.variants.filter(v=>String(v.id)===String(id)));
  if (!v || !Number.isSafeInteger(v.price) || v.price<=0 || typeof v.available!=='boolean') return null;
  const identifiers=[offer.gtin,savedGtin,pinned?.[1],gtin(offer.shop_sku) ? offer.shop_sku : null].filter(Boolean);
  if (identifiers.some(value=>gtin(value)!==gtin(v.barcode))) return null;
  url.search='';url.searchParams.set('variant',id);
  const ld=verifiedOffer(page.offers,url.href);
  if (!ld || ld.price!==v.price || (ld.stock==='in_stock')!==v.available) return null;
  const reference=v.compare_at_price;
  if (reference!=null && !(Number.isSafeInteger(reference) && reference>=0)) return null;
  const deal=reference>v.price ? {label:'Actieprijs bij '+offer.shop,reference_eur:euros(reference),
    reference_label:'Vergelijkingsprijs zoals getoond door de merkshop',
    conditions:'Eenmalige aankoop van de vermelde modeluitvoering. De merkshop toont de actieprijs rechtstreeks.'} : null;
  return {...ld,sku:String(id),gtin:gtin(v.barcode) ? String(v.barcode):null,deal};
}

function updateOffer(offer,row,at,delivery) {
  const next=euros(row.price);
  if (Number.isFinite(offer.free_from_eur) && !offer.shipping_tiers) {
    if (next>=offer.free_from_eur) offer.shipping_eur=0;
    else if (delivery?.free_from_eur===offer.free_from_eur && Number.isFinite(delivery.shipping_eur)) offer.shipping_eur=delivery.shipping_eur;
    else if (offer.price_eur>=offer.free_from_eur) offer.shipping_eur=null;
  }
  Object.assign(offer,{price_eur:next, stock:row.stock, checked_at:at});
}

function updateDeal(promotions,product,offer,row,kind,at,oldDeal) {
  const same=oldDeal && row.deal && oldDeal.label===row.deal.label && oldDeal.reference_eur===row.deal.reference_eur && oldDeal.price_eur===offer.price_eur;
  const until=same ? oldDeal.valid_until : null;
  const withinDate=!until || (/^\d{4}-\d{2}-\d{2}$/.test(until) ? until>=amsterdamDay.format(new Date(at)) : Date.parse(until)>=Date.parse(at));
  const active=row.deal && row.stock==='in_stock' && withinDate;
  if (!active) { if (oldDeal) promotions.splice(promotions.indexOf(oldDeal),1); return; }
  const next={slug:product.slug,shop:offer.shop,url:offer.url,units:offer.units,unit_kg:offer.unit_kg,price_eur:offer.price_eur,
    kind,...row.deal,checked_at:at,valid_until:until || null,source_url:offer.url,shop_sku:row.sku};
  if (row.gtin || offer.gtin) next.gtin=row.gtin || offer.gtin;
  if (oldDeal) Object.assign(oldDeal,next);
  else promotions.push(next);
}

function sameIdentity(a,b) {
  return a.shop===b.shop && a.url===b.url && a.units===b.units && a.unit_kg===b.unit_kg;
}

function refreshTiers(page, entries, product, promotions, old, stats, at, delivery) {
  const entry=unique(entries.filter(e=>!e.tier_min_units));
  if (!entry || !page || !samePack(page.pack,entry) || String(entry.sku || entry.shop_sku)!==page.sku || gtin(entry.gtin)!==page.gtin) return;
  if (entries.some(e=>e.unit_kg!==entry.unit_kg || gtin(e.gtin)!==page.gtin || String(e.sku || e.shop_sku)!==page.sku)) return;
  const related=old.filter(p=>p.kind==='staffel' && p.unit_kg===entry.unit_kg);
  if (related.some(p=>p.shop_sku!==page.sku || (p.gtin && gtin(p.gtin)!==page.gtin))) return;
  updateOffer(entry,page,at,delivery);
  stats.observed++;
  if (page.stock==='out_of_stock' && page.tiers===null) {
    for (const tier of entries.filter(e=>e.tier_min_units)) tier.stock='out_of_stock';
    for (const promo of related) promotions.splice(promotions.indexOf(promo),1);
  }
  if (page.tiers===null || entry.units!==1) return;
  // Keep the linked normal offer for every tier, including when the threshold is replaced.
  for (const existing of entries.filter(e=>e.tier_min_units)) {
    if (page.tiers.has(existing.tier_min_units)) continue;
    product.offers.splice(product.offers.indexOf(existing),1);
    stats.retired++;
  }
  for (const promo of related.filter(p=>!page.tiers.has(p.units))) promotions.splice(promotions.indexOf(promo),1);
  for (const [n,per] of page.tiers) {
    const matches=product.offers.filter(o=>o.url===entry.url && o.shop===entry.shop && o.units===n && o.unit_kg===entry.unit_kg);
    if (matches.length>1 || (matches.length===1 && matches[0].tier_min_units!==n)) continue;
    const item=matches[0] || {...entry,units:n};
    if (!matches.length) product.offers.push(item);
    Object.assign(item,{tier_min_units:n,tier_unit_price_eur:euros(per),note:'Vanaf '+n+' stuks kost elk exemplaar €'+money(per)+'.'});
    const row={...page,price:n*per,gtin:entry.gtin,deal:{label:'Staffel vanaf '+n+' stuks',reference_eur:euros(n*page.price),
      reference_label:n+' exemplaren tegen de gewone stukprijs',
      conditions:'Bestel minimaal '+n+' van deze verpakking. De winkel berekent dan €'+money(per)+' per stuk.'}};
    updateOffer(item,row,at,delivery);
    updateDeal(promotions,product,item,row,'staffel',at,related.find(p=>p.units===n));
    stats.observed++; if (row.stock==='in_stock') stats.promotions++;
  }
}

export async function refreshDeals(catalog,promotions,{load, now=()=>new Date(),workers=3,delivery={}}) {
  verifyCatalog(catalog);
  if (!Array.isArray(promotions)) throw new Error('Promoties moeten een lijst zijn.');
  const report={}, jobs=new Map();
  for (const product of [...catalog.food_products,...catalog.tech_products]) {
    for (const offer of product.offers) {
      if (!shops.has(offer.shop)) continue;
      const shop=offer.shop;
      const stats=report[shop]??={candidates:0,observed:0,promotions:0,retired:0,failed:0};
      stats.candidates++;
      const url=checkedUrl(offer.url,shop);
      if (!url || (shop==='Dierapotheker' && url.search)) continue;
      if (shop!=='Dierapotheker') url.search='';
      if (!jobs.has(url.href)) jobs.set(url.href,{shop,byProduct:new Map()});
      const batch=jobs.get(url.href).byProduct;
      if (!batch.has(product)) batch.set(product,[]);
      batch.get(product).push(offer);
    }
  }
  // One worker per storefront. A block or limit at one origin ends its own queue.
  const grouped=new Map();
  for (const entry of jobs) {
    const shop=entry[1].shop;
    if (!grouped.has(shop)) grouped.set(shop,[]);
    grouped.get(shop).push(entry);
  }
  const age=job=>Math.min(...[...job[1].byProduct.values()].flat().map(e=>Date.parse(e.checked_at)));
  // Equal-time batches rotate daily, so a storefront limit also advances across ties.
  for (const queue of grouped.values()) {
    const offset=Math.floor(now().valueOf()/86400000)%queue.length;
    queue.push(...queue.splice(0,offset));
    queue.sort((a,b)=>age(a)-age(b));
  }
  const iterator=grouped.values();
  async function worker() {
    for (const queue of iterator) for (const [url,{shop,byProduct}] of queue) {
      const stats=report[shop];
      if (stats.blocked) continue;
      let page;
      try {
        const html=await load(url,'html');
        if (shop==='Dierapotheker') page=dierapothekerPage(html,url);
        else if (shop==='Medpets') page=medpetsPage(html);
        else {
          const product=parse(await load(url.replace(/\/$/,'')+'.js','json'));
          if (!Array.isArray(product?.variants) || new URL(url).pathname.split('/').filter(Boolean).at(-1)!==product.handle) continue;
          page={variants:product.variants,offers:structuredOffers(html)};
        }
      } catch (error) {
        stats.failed+=[...byProduct.values()].reduce((n,rows)=>n+rows.length,0);
        if ([403,429].includes(error?.status)) stats.blocked=error.status;
        continue;
      }
      const at=now().toISOString();
      for (const [product,entries] of byProduct) {
        const old=promotions.filter(p=>p.slug===product.slug && p.shop===shop && entries.some(e=>e.url===p.url));
        if (entries.some(e=>Date.parse(e.checked_at)>Date.parse(at)) || old.some(p=>Date.parse(p.checked_at)>Date.parse(at))) continue;
        if (shop==='Dierapotheker') { refreshTiers(page,entries,product,promotions,old,stats,at,delivery[shop]); continue; }
        for (const offer of entries) {
          const matching=old.filter(p=>p.kind==='actie' && sameIdentity(p,offer));
          if (matching.length>1) continue;
          const prev=matching[0];
          const row=shop==='Medpets' ? medpetsMatch(page,offer) : shopifyMatch(page,offer,prev?.shop_sku,prev?.gtin);
          if (!row) continue;
          if (shop!=='Medpets') offer.shopify_variant_id=row.sku;
          updateOffer(offer,row,at,delivery[shop]);
          updateDeal(promotions,product,offer,row,'actie',at,prev);
          stats.observed++; if (row.deal && row.stock==='in_stock') stats.promotions++;
        }
      }
    }
  }
  await Promise.all(Array.from({length:Math.max(1,Math.min(5,workers))},worker));
  verifyCatalog(catalog);
  return report;
}
