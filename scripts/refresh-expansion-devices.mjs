import {readFile, writeFile, rename, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {matchPartOffer} from './refresh-parts.mjs';

const targets = [
  {slug:'catit-pixi-smart-6-meal',shop:'Medpets',sku:'MP36940',gtin:'0022517437544',adapter:'medpets',
    label:'Catit PIXI Smart 6-meal Feeder - 6 x 170 ml - 37 x 34,5 x 9,5 cm - Wit',
    url:'https://www.medpets.nl/catit-pixi-smart-6-meal-feeder?sku=MP36940'},
  {slug:'catit-pixi-smart-6-meal',shop:'Zooplus',sku:'1388962.0',gtin:'022517437544',adapter:'zooplus',
    url:'https://www.zooplus.nl/shop/katten/voerbak/voerautomaten/andere/1388962?activeVariant=1388962.0'},
  {slug:'cat-mate-c500-wit',shop:'Zooplus',sku:'601499.2',gtin:'035368003653',adapter:'zooplus',
    url:'https://www.zooplus.nl/shop/katten/voerbak/voerautomaten/pet_mate/601499?activeVariant=601499.2'},
  {slug:'cat-mate-c500-wit',shop:'Pets Place',sku:'40543859',gtin:'035368003653',adapter:'single',
    label:'Cat Mate Voerbak Voor 5 Maaltijden',url:'https://www.petsplace.nl/cat-mate-voerbak-voor-5-maaltijden-kattenvoerbak-035368003653-pps'},
  {slug:'pets-on-demand-gps-pro-mini',shop:'Pets on Demand',sku:'21920308',adapter:'jouwweb',
    url:'https://www.petsondemand.nl/product/21920308/gps-pro-mini'}
];

const attr = (tag,key) => new RegExp('\\s'+key+'\\s*=\\s*(["\x27])([^"\x27]*)\\1','i').exec(tag)?.[2];
const uniquely = values => values.length===1 ? values[0] : null;
const tags = (html,tag) => [...html.matchAll(new RegExp('<'+tag+'\\b[^>]*>','gi'))].map(m=>m[0]);
const barcode = value => /^\d{12,14}$/.test(String(value??'')) ? String(value).padStart(14,'0') : null;

function quote(price,currency,state) {
  if(currency!=='EUR' || !/^\d{1,7}(?:\.\d{1,2})?$/.test(String(price))) return null;
  const value=Math.round(Number(price)*100);
  const stock=({InStock:'in_stock',OutOfStock:'out_of_stock'})[String(state||'').replace(/^https?:\/\/schema\.org\//,'')];
  return value>0 && stock ? {value,stock} : null;
}

function sameQuotes(rows) {
  const first=rows[0];
  return first && rows.every(row=>row && row.value===first.value && row.stock===first.stock) ? first : null;
}

function zooplus(spec,html) {
  const url=new URL(spec.url);
  const canonical=uniquely(tags(html,'link').filter(t=>attr(t,'rel')==='canonical').map(t=>attr(t,'href')));
  if(canonical!==url.origin+url.pathname || url.searchParams.get('activeVariant')!==spec.sku) return null;
  const matches=[];
  for(const block of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if(attr(' '+block[1],'type')!=='application/ld+json') continue;
    let json;
    try{json=JSON.parse(block[2]);}catch{continue;}
    const graphs=[json].flat().flatMap(j=>j?.['@graph']??j??[]);
    for(const group of graphs) {
      if(group['@type']!=='ProductGroup' || group.url!==canonical || !Array.isArray(group.hasVariant)) continue;
      for(const p of group.hasVariant.filter(v=>v?.sku===spec.sku)) {
        if(p['@type']!=='Product' || barcode(p.gtin13??p.gtin12??p.gtin)!==barcode(spec.gtin)) return null;
        const offers=[p.offers].flat().filter(o=>o?.['@type']==='Offer' && o.url===spec.url);
        if(!offers.length) return null;
        matches.push(...offers.map(o=>quote(o.price,o.priceCurrency,o.availability)));
      }
    }
  }
  return sameQuotes(matches);
}

function petsOnDemand(spec,html) {
  const body=uniquely(tags(html,'body'));
  if(!body || attr(body,'itemtype')!=='https://schema.org/Product' || attr(body,'data-jouwweb-segment-type')!=='product' ||
     attr(body,'data-jouwweb-segment-id')!==spec.sku) return null;
  const canonical=uniquely(tags(html,'link').filter(t=>attr(t,'rel')==='canonical').map(t=>attr(t,'href')));
  if(canonical!==spec.url) return null;
  const productUrls=tags(html,'meta').filter(t=>attr(t,'itemprop')==='url').map(t=>attr(t,'content'));
  if(uniquely(productUrls)!==spec.url) return null;
  const names=[...html.matchAll(/(<h1\b[^>]*>)([^<]*)<\/h1>/gi)].filter(m=>attr(m[1],'itemprop')==='name');
  if(names.length!==1 || names[0][2].trim()!=='GPS PRO Mini') return null;

  // The primary quote is for the tracker without a collar. A separately priced
  // Rogz collar is another option and must never be included in this measurement.
  const fields=[...html.matchAll(/(<select\b[^>]*>)([\s\S]*?)<\/select>/gi)]
    .filter(m=>attr(m[1],'data-field-type')==='select');
  if(fields.length!==1 || attr(fields[0][1],'data-field-id')!=='2693635') return null;
  const options=[...fields[0][2].matchAll(/(<option\b[^>]*>)([^<]*)<\/option>/gi)];
  const selected=options.filter(m=>/\sselected(?:\s|=|>)/i.test(m[1]));
  const base=selected.length?uniquely(selected):options[0];
  if(!base || attr(base[1],'data-surcharge')!=='0' || !/^Zonder halsband\b/i.test(base[2].trim())) return null;
  const wrappers=tags(html,'div').filter(t=>attr(t,'itemprop')==='offers' && attr(t,'itemtype')==='https://schema.org/Offer');
  if(wrappers.length!==1) return null;
  const start=html.indexOf(wrappers[0])+wrappers[0].length;
  const head=/^((?:\s*<meta\b[^>]*>)+)/i.exec(html.slice(start))?.[1];
  if(!head) return null;
  const properties=tags(head,'meta');
  const value=key=>uniquely(properties.filter(t=>attr(t,'itemprop')===key).map(t=>attr(t,'content')));
  return quote(value('price'),value('priceCurrency'),value('availability'));
}

export function matchExpansionDevice(product,offer,html) {
  const spec=targets.find(t=>t.slug===product.slug && t.shop===offer.shop && t.url===offer.url && t.sku===String(offer.shop_sku));
  if(!spec || offer.units!==1 || offer.unit_kg!==null ||
     (spec.gtin && [product.ean,offer.gtin].filter(v=>v!=null).some(v=>barcode(v)!==barcode(spec.gtin)))) return null;
  if(spec.adapter==='zooplus') return zooplus(spec,html);
  if(spec.adapter==='jouwweb') return petsOnDemand(spec,html);
  return matchPartOffer({...offer,match:spec},html);
}

export async function refreshExpansionDevices(catalog,{load,now=()=>new Date()}) {
  if(catalog.currency!=='EUR' || catalog.destination!=='NL' || !Array.isArray(catalog.tech_products)) throw Error('Ongeldige Nederlandse apparaatcatalogus');
  const report=[];
  for(const spec of targets) {
    const product=uniquely(catalog.tech_products.filter(p=>p.slug===spec.slug));
    const offer=product && uniquely(product.offers.filter(o=>o.shop===spec.shop && o.url===spec.url && String(o.shop_sku)===spec.sku));
    const row={slug:spec.slug,shop:spec.shop,sku:spec.sku,status:'geen match'};
    report.push(row);
    if(!offer) continue;
    try {
      const html=await load(spec.url);
      const observed=matchExpansionDevice(product,offer,html);
      const at=now().toISOString();
      if(!observed || !(Date.parse(at)>=Date.parse(offer.checked_at))) continue;
      const next=observed.value/100;
      row.status=next!==offer.price_eur || observed.stock!==offer.stock?'gewijzigd':'bevestigd';
      Object.assign(offer,{price_eur:next,stock:observed.stock,checked_at:at});
      Object.assign(row,{price_eur:next,stock:observed.stock,checked_at:at});
    } catch(error) {row.status='bronfout';row.reason=error.message;}
  }
  return report;
}

async function load(url) {
  const res=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{
    'user-agent':'VoerpiraatPrijscontrole/1.0 (+https://voerpiraat.nl/methodologie)','accept':'text/html','accept-language':'nl-NL,nl;q=0.9'
  }});
  if(!res.ok || !/^text\/html\b/i.test(res.headers.get('content-type')||'')) {
    await res.body?.cancel();
    throw Error('Geen productpagina, HTTP '+res.status);
  }
  return res.text();
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const args=process.argv.slice(2);
  if(args.length && !(args.length===2 && args[0]==='--file')) throw Error('Gebruik: node scripts/refresh-expansion-devices.mjs [--file PAD/NAAR/products.json]');
  const file=args.length?resolve(args[1]):fileURLToPath(new URL('../data/products.json',import.meta.url));
  const previous=await readFile(file,'utf8'), catalog=JSON.parse(previous);
  const report=await refreshExpansionDevices(catalog,{load});
  console.table(report);
  if(report.some(row=>row.checked_at)) {
    const tmp=file+'.'+randomUUID()+'.tmp';
    try{
      await writeFile(tmp,JSON.stringify(catalog,null,2)+'\n',{flag:'wx'});
      if(await readFile(file,'utf8')!==previous) throw Error('De bron is tijdens de meting gewijzigd. Voer de meting opnieuw uit.');
      await rename(tmp,file);
    }finally{await rm(tmp,{force:true});}
  }else console.warn('Geen bevestigde prijsmeting bij deze vijf winkelvarianten.');
}
