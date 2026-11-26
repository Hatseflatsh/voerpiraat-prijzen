import {readFile,writeFile,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

const hosts={'Zooplus':'www.zooplus.nl','Bitiba':'www.bitiba.nl','Pets Place':'www.petsplace.nl','Hano':'www.hano.nl','PharmaPets':'www.pharmapets.nl','AvonturiaShop':'www.avonturiashop.nl','Catsclusive':'www.catsclusive.nl','Closer Pets':'closerpets.eu','bol (Closer Pets)':'www.bol.com','Petsonline':'www.petsonline.nl','Pips':'www.pips.nl','PetSafe Nederland':'www.petsafe.com','De Huisdiersuper':'www.dehuisdiersuper.nl','Medpets':'www.medpets.nl','Staywell':'www.staywell.nl'};
const encodeGtin = v => /^\d{8}$|^\d{12,14}$/.test(String(v ?? '')) ? String(v).padStart(14,'0') : null;
const attr = (tag,key) => new RegExp('\\s'+key+'\\s*=\\s*(["\x27])([^"\x27]*)\\1','i').exec(tag)?.[2]?.replaceAll('&amp;','&');
const tags = (html,tag) => [...html.matchAll(new RegExp('<'+tag+'\\b[^>]*>','gi'))].map(m=>m[0]);
const plain = s => s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;|\u00a0/g,' ').replace(/\s+/g,' ').trim();
const pathBase = s => {try {const u=new URL(s);return u.origin+u.pathname.replace(/\/$/,'');}catch{return null;}};
const same = values => values.length && values.every(v=>v===values[0]) ? values[0] : null;
const one = values=>values.length===1?values[0]:null;
const meta = (html,key) => same(tags(html,'meta').filter(t=>attr(t,'property')===key).map(t=>attr(t,'content')));
const cents = value => /^\d{1,7}(\.\d{1,2})?$/.test(String(value)) ? Math.round(Number(value)*100) : null;
function quote(price,currency,availability){
  const value=cents(price);
  const stock=({instock:'in_stock',outofstock:'out_of_stock',preorder:'unknown'})[String(availability).split('/').at(-1).toLowerCase()];
  return currency==='EUR' && value>0 && stock ? {value,stock} : null;
}
function linkedProducts(html){
  const results=[];
  function walk(v){if(Array.isArray(v)){v.forEach(walk);return;} if(!v||typeof v!=='object')return;if(v['@type']==='Product')results.push(v);for(const k of ['@graph','mainEntity','hasVariant','itemListElement'])if(v[k])walk(v[k]);}
  for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(attr(' '+m[1],'type')==='application/ld+json')try{walk(JSON.parse(m[2]));}catch{}
  return results;
}
function ldQuote(t,html){
  const rows=[];
  for(const p of linkedProducts(html)){
    if(String(p.sku)!==String(t.sku))continue;
    const barcode=p.gtin||p.gtin13||p.gtin12||p.gtin14||(t.shop==='Hano'?p.sku:null);
    if(t.gtin && encodeGtin(t.gtin)!==encodeGtin(barcode))continue;
    for(const o of [].concat(p.offers||[]))if((o.url && new URL(o.url,t.url).href===t.url) || (t.shop==='PetSafe Nederland' && pathBase(o.url)===pathBase(t.url))){
      const q=quote(o.price,o.priceCurrency,o.availability);if(!q)return null;rows.push(q);
    }
  }
  return rows.length && rows.every(r=>r.stock===rows[0].stock&&r.value===rows[0].value)?rows[0]:null;
}
function itemMeta(html,key) {return same([...tags(html,'meta'),...tags(html,'link'),...tags(html,'td')].filter(t=>attr(t,'itemprop')===key).map(t=>attr(t,'content')||attr(t,'href')));}
function specific(t,html) {
  if(t.mode==='ld'||t.mode==='zooplus')return ldQuote(t,html);
  if(t.mode==='petsplace'){
    const skus=[...html.matchAll(/<[^>]+itemprop=["']sku["'][^>]*>([^<]+)</gi)].map(m=>m[1].trim());
    const badges=[...html.matchAll(/<span\b([^>]*class=["'][^"']*\bin-stock-text\b[^"']*["'][^>]*)>([^<]+)</gi)].map(m=>[m[1],plain(m[2])]);
    if(same(skus)!==t.sku || !t.url.includes(String(t.gtin)) || !badges.length)return null;
    const state=same(badges.map(([cls,text])=>cls.includes('out-of-stock')&&/niet te bestellen/i.test(text)?'OutOfStock':text==='Op voorraad'?'InStock':null));
    return quote(meta(html,'product:price:amount'),meta(html,'product:price:currency'),state);
  }
  if(t.mode==='micro'||t.mode==='staywell'){
    if(encodeGtin(itemMeta(html,'gtin13'))!==encodeGtin(t.gtin) || (t.sku && !plain(html).includes(t.sku)))return null;
    return quote(itemMeta(html,'price'),itemMeta(html,'priceCurrency'),itemMeta(html,'availability'));
  }
  if(t.mode==='petsafe'){
    if(!new URL(t.url).pathname.endsWith('/'+t.sku+'/'))return null;
    const ld=ldQuote(t,html);if(ld)return ld;
    const prices=[...html.matchAll(/<span\b([^>]*\bclass=["'][^"']*text-2xl[^"']*["'][^>]*)>([^<]*)<\/span>/gi)].map(m=>plain(m[2])).filter(s=>/^€\s*\d+[,.]\d{2}$/.test(s)).map(s=>s.replace(/[€\s]/g,'').replace(',','.'));
    const buttons=tags(html,'button').filter(b=>attr(b,'title')==='Add to Basket' && attr(b,'aria-label')?.startsWith('Add to Basket Drinkwell'));
    return buttons.length && buttons.every(b=>!(/\sdisabled(?:\s|=|>)/i.test(b))) ? quote(same(prices),'EUR','InStock'):null;
  }
  if(t.mode==='medpets'){
    const m=/window\.variants\s*=\s*(\[[^;\n]*\])/.exec(html);if(!m)return null;
    let v;try {v=one(JSON.parse(m[1]).filter(v=>v.active===true && v.sku===t.sku && v.name==='Catit PIXI Drinkfontein - Wit - 2,5 liter'));}catch{return null;}
    if(!v||!Number.isFinite(v.stock))return null;
    const pairs=linkedProducts(html).filter(p=>encodeGtin(p.gtin13)===encodeGtin(t.gtin)).flatMap(p=>[].concat(p.offers||[])).filter(o=>o.url===t.url);
    const o=one(pairs),q=o&&quote(o.price,o.priceCurrency,o.availability);
    return q && q.value===cents(v.price) && q.stock===(v.stock>0?'in_stock':'out_of_stock')?q:null;
  }
  if(t.mode==='bol'){
    const text=plain(html);
    if(!text.includes('EAN '+t.gtin) || !/Verkoop door (?:Verkoop door )?Closer Pets beoordeeld/.test(text) || !/Op voorraad.{0,130}Verkoop door (?:Verkoop door )?Closer Pets/.test(text) || !/Inclusief verzendkosten/.test(text))return null;
    const prices=[...text.matchAll(/De prijs van dit product is (\d+) euro(?: en (\d+) cent)?\./g)].map(m=>(Number(m[1])+Number(m[2]||0)/100).toFixed(2));
    return quote(same(prices),'EUR','InStock');
  }
  return null;
}
export function matchFountain(t,offer,product,html){
  let url;try{url=new URL(t.url);}catch{return null;}
  if(url.protocol!=='https:'||url.hostname!==hosts[t.shop]||url.username||url.password||url.port||offer.shop!==t.shop||offer.url!==t.url||product.slug!==t.slug||offer.units!==1||offer.unit_kg!==null)return null;
  if((t.sku||null)!==(offer.shop_sku||null)||t.gtin&&[product.ean,offer.gtin].some(v=>encodeGtin(v)!==encodeGtin(t.gtin)))return null;
  const canonical=tags(html,'link').find(l=>attr(l,'rel')==='canonical');const base=pathBase(canonical?attr(canonical,'href'):meta(html,'og:url'));
  if(base!==pathBase(t.url))return null;
  return specific(t,html);
}
function updateShipping(offer,price) {
  const fees={'Pets Place':[39,4.99],'Hano':[75,4.95],'PharmaPets':[39,3.99],'AvonturiaShop':[59,4.95],'Petsonline':[59,5.95],'PetSafe Nederland':[90,7.99],'De Huisdiersuper':[69,5.95],'Medpets':[69,4.95]};
  if(['Zooplus','Bitiba'].includes(offer.shop))return price<9?null:price<19?4.99:price<29?2.99:price===29?null:0;
  if(offer.shop==='Pips')return price<20?9.95:price<59?6.95:0;
  if(offer.shop==='bol (Closer Pets)')return 0;
  if(offer.shop==='Staywell')return price>=40?0:null;
  if(offer.shop==='AvonturiaShop'&&price<14.95)return null;
  const r=fees[offer.shop];return r ? (price>=r[0]?0:r[1]) : null;
}
export async function refreshFountains(catalog,targets,{load,now=()=>new Date()}){
  if(catalog.currency!=='EUR'||catalog.destination!=='NL'||!Array.isArray(catalog.tech_products)||!Array.isArray(targets))throw Error('Ongeldige Nederlandse catalogus of meetlijst');
  const groups=new Map();for(const t of targets){if(!hosts[t.shop]||new URL(t.url).hostname!==hosts[t.shop]||new URL(t.url).protocol!=='https:')throw Error('Onverwachte winkelbron');const group=groups.get(t.shop)||[];group.push(t);groups.set(t.shop,group);}
  const report=[];const entries=groups.values();
  async function worker(){for(const group of entries){let blocked=null;for(const t of group){
    const p=one(catalog.tech_products.filter(p=>p.slug===t.slug));const o=p&&one(p.offers.filter(o=>o.shop===t.shop&&o.url===t.url));const row={slug:t.slug,shop:t.shop,status:'geen match'};report.push(row);
    if(!o)continue;if(blocked){row.status='winkel geblokkeerd';continue;}
    try{const html=await load(t.url),q=matchFountain(t,o,p,html);const checked=now().toISOString();
      if(!q||!(Date.parse(checked)>=Date.parse(o.checked_at)))continue;
      const price=q.value/100;row.status=price!==o.price_eur||q.stock!==o.stock?'gewijzigd':'bevestigd';
      Object.assign(o,{price_eur:price,shipping_eur:updateShipping(o,price),stock:q.stock,checked_at:checked});
    }catch(e){row.status='bronfout';if([403,429].includes(e.status))blocked=e.status;}
  }}}
  await Promise.all(Array.from({length:3},worker));return report;
}
async function get(url){
 const response=await fetch(url,{signal:AbortSignal.timeout(16000),redirect:'follow',headers:{'user-agent':'VoerpiraatPrijscontrole/1.0 (+https://voerpiraat.nl/methodologie)','accept-language':'nl-NL,nl;q=0.9','accept':'text/html'}});
 if(!response.ok||pathBase(response.url)!==pathBase(url)||!/(text\/html|application\/xhtml\+xml)/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();throw Object.assign(Error('Geen bruikbare winkelpagina'),{status:response.status});}
 return response.text();
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const argv=process.argv.slice(2);if(argv.length && (argv.length!==4||argv[0]!=='--file'||argv[2]!=='--targets'))throw Error('Gebruik: node scripts/refresh-fountains.mjs [--file FILE --targets FILE]');
 const file=argv[1]||fileURLToPath(new URL('../data/products.json',import.meta.url)),list=argv[3]||fileURLToPath(new URL('../data/fountain-refresh-targets.json',import.meta.url));
 const original=await readFile(file,'utf8'),catalog=JSON.parse(original),targets=JSON.parse(await readFile(list,'utf8'));const report=await refreshFountains(catalog,targets,{load:get});console.table(report);
 if(report.some(x=>x.status==='gewijzigd'||x.status==='bevestigd')){const tmp=file+'.'+randomUUID()+'.tmp';try{await writeFile(tmp,JSON.stringify(catalog,null,2)+'\n',{flag:'wx'});if(await readFile(file,'utf8')!==original)throw Error('De catalogus veranderde tijdens de meting');await rename(tmp,file);}finally{await rm(tmp,{force:true});}}
}
