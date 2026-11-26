import {readFile,writeFile,rm,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

const targets=JSON.parse(await readFile(new URL('../data/feeder-refresh-targets.json',import.meta.url),'utf8'));
const unique=xs=>xs.length===1?xs[0]:null;
const barcode=x=>/^\d{8,14}$/.test(String(x??''))?String(x).padStart(14,'0'):null;
const attr=(tag,key)=>new RegExp('\\s'+key+'\\s*=\\s*(["\x27])([^"\x27]*)\\1','i').exec(tag)?.[2]?.replaceAll('&amp;','&');
const tags=(s,t)=>[...s.matchAll(new RegExp('<'+t+'\\b[^>]*>','gi'))].map(m=>m[0]);
const plain=s=>String(s||'').normalize('NFKC').toLowerCase();
const amount=v=>/^\d{1,7}(?:\.\d{1,2})?$/.test(String(v))&&Number(v)>0?Math.round(Number(v)*100):null;
const stock=v=>({InStock:'in_stock',OutOfStock:'out_of_stock'})[String(v??'').replace(/^https?:\/\/schema\.org\//,'')]||null;
function uri(raw,base) {
 if(!raw)return null;
 try{const url=new URL(raw,base);url.pathname=url.pathname.replace(/\/$/,'');url.hash='';return url.href;}catch{return null;}
}
function parse(raw){
 try{return JSON.parse(raw);}catch{}
 // A few storefront reviews contain unescaped control characters in JSON strings.
 const clean=raw.replace(/"(?:[^"\\]|\\[\s\S])*"/g,s=>s.replace(/[\u0000-\u001f]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')));
 try{return JSON.parse(clean);}catch{return null;}
}
function flatten(v){
 if(!v||typeof v!=='object')return[];
 if(Array.isArray(v))return v.flatMap(flatten);
 if(v['@graph'])return flatten(v['@graph']);
 const type=String(v['@type']||'').split('/').at(-1);
 if(type==='ProductGroup')return flatten(v.hasVariant);
 return type==='Product'?[v]:[];
}
function quote(o) {
 const value=amount(o?.price),state=stock(o?.availability);
 return value&&state&&o.priceCurrency==='EUR'?{price_eur:value/100,stock:state}:null;
}
function same(rows){const a=rows[0];return a&&rows.every(b=>b?.price_eur===a.price_eur&&b.stock===a.stock)?a:null;}
function dataProducts(html) {
 return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m=>attr(' '+m[1],'type')==='application/ld+json').flatMap(m=>flatten(parse(m[2])));
}
function schema(html,t){
 const rows=[];
 for(const p of dataProducts(html)) {
  if(!plain(p.name).includes(plain(t.label)))continue;
  if(t.barcode&&barcode(p.gtin13||p.gtin12||p.gtin)!==barcode(t.barcode))continue;
  let offers=[p.offers].flat().filter(Boolean);
  if(t.adapter==='bol'){
   if(!String(p.url||p['@id']).includes(t.sku) || !t.barcode)continue;
   offers=offers.filter(o=>o.seller?.name===t.seller);
  }else{
   if(String(p.sku)!==t.sku)continue;
   offers=offers.filter(o=>uri(o.url,t.url)===uri(t.url));
  }
  rows.push(...offers.filter(o=>o['@type']==='Offer').map(quote));
 }
 return same(rows);
}
function medpets(html,t){
 const variants=unique([...html.matchAll(/\bwindow\.variants\s*=\s*(\[[^\r\n]*\])\s*;?\s*(?:\r?\n|<\/script>)/g)].map(m=>parse(m[1])));
 if(!Array.isArray(variants) || new URL(t.url).searchParams.get('sku')!==t.sku)return null;
 const v=unique(variants.filter(v=>v.sku===t.sku && v.name===t.label && v.active===true));
 const rows=dataProducts(html).filter(p=>barcode(p.gtin13)===barcode(t.barcode)).flatMap(p=>[p.offers].flat().filter(o=>o?.url===t.url&&o['@type']==='Offer').map(quote));
 const found=same(rows);
 return v&&found&&Number.isFinite(v.stock)&&v.stock>=0&&amount(v.price)===amount(found.price_eur)&&(v.stock>0)===(found.stock==='in_stock')?found:null;
}
function microdata(html,t){
 const blocks=[...html.matchAll(/<div\s+itemscope\s+itemtype="https?:\/\/schema\.org\/Product"\s*>([\s\S]*?)<meta\s+itemprop="itemCondition"/gi)].map(m=>m[1]);
 const results=[];
 for(const s of blocks){const all=tags(s,'meta');const v=k=>unique(all.filter(t=>attr(t,'itemprop')===k).map(t=>attr(t,'content')));
  if(v('sku')===t.sku&&barcode(v('gtin13'))===barcode(t.barcode))results.push(quote({price:v('price'),priceCurrency:v('priceCurrency'),availability:v('availability')}));
 }
 return same(results);
}
function woocommerce(html,t){
 const info=unique([...html.matchAll(/window\.mcPixel\.data\s*=\s*(\{[^\n]+\})\s*;/g)].map(m=>parse(m[1])?.product));
 if(!info || String(info.sku)!==t.sku || String(info.id)!==t.post_id || uri(info.productUrl)!==uri(t.url)||info.title!==t.label||!html.includes(t.barcode))return null;
 const block=unique(tags(html,'div').filter(tag=>attr(tag,'data-elementor-type')==='product' && (attr(tag,'class')||'').split(/\s+/).includes('post-'+t.post_id)));
 if(!block)return null;
 const classes=(attr(block,'class')||'').split(/\s+/);
 const availability=classes.includes('instock')?'InStock':classes.includes('outofstock')?'OutOfStock':null;
 return quote({price:info.price,priceCurrency:info.currency,availability});
}
export function matchRound2Feeder(html,t) {
 const shop=url=>uri(url)?.split('?')[0];
 const canonical=unique(tags(html,'link').filter(tag=>attr(tag,'rel')==='canonical').map(tag=>attr(tag,'href')));
 if(!canonical || shop(canonical)!==shop(t.url))return null;
 if(t.adapter==='parts-medpets')return medpets(html,t);
 if(t.adapter==='woocommerce')return woocommerce(html,t);
 if(t.adapter==='microdata')return microdata(html,t);
 return schema(html,t);
}
export async function refreshRound2Feeders(catalog,{load,now=()=>new Date(),pins=targets}){
 if(catalog.currency!=='EUR'||catalog.destination!=='NL'||!Array.isArray(catalog.tech_products))throw Error('Ongeldige Nederlandse productcatalogus');
 const results=[];const blocked=new Set();
 for(const t of pins){
  const product=unique(catalog.tech_products.filter(p=>p.slug===t.slug));
  const list=product?.offers?.filter(o=>o.shop===t.shop&&o.url===t.url&&o.shop_sku===t.sku&&o.units===1&&o.unit_kg===null)??[];
  const o=unique(list),report={slug:t.slug,shop:t.shop,sku:t.sku,result:'geen match'};results.push(report);
  if(!o || (t.barcode&&[o.gtin,product.ean].filter(Boolean).some(v=>barcode(v)!==barcode(t.barcode))))continue;
  const host=new URL(t.url).hostname;
  if(blocked.has(host)){report.result='winkel tijdelijk niet beschikbaar';continue;}
  try{
   const row=matchRound2Feeder(await load(t.url),t);const at=now().toISOString();
   if(!row||!(Date.parse(at)>=Date.parse(o.checked_at)))continue;
   report.result=row.price_eur===o.price_eur&&row.stock===o.stock?'bevestigd':'gewijzigd';
   if(Number.isFinite(o.free_from_eur)&&o.shipping_eur!==null&&!o.shipping_tiers && (row.price_eur>=o.free_from_eur)!==(o.price_eur>=o.free_from_eur)){
     // Below-threshold fees need fresh evidence from the published delivery table.
     o.shipping_eur=row.price_eur>=o.free_from_eur?0:null;
     if('shipping_single_quote_eur'in o)o.shipping_single_quote_eur=o.shipping_eur;
   }
   Object.assign(o,row,{checked_at:at});Object.assign(report,row,{checked_at:at});
  }catch(error){report.result='bronfout';report.reason=error.message;if([403,429].includes(error.status))blocked.add(host);}
 }
 return results;
}
async function load(url){
 const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{'user-agent':'VoerpiraatPrijscontrole/1.0 (+https://voerpiraat.nl/methodologie)','accept':'text/html','accept-language':'nl-NL,nl;q=0.9'}});
 if(!r.ok||!/^text\/html\b/i.test(r.headers.get('content-type')||'')){await r.body?.cancel();throw Object.assign(Error('HTTP '+r.status),{status:r.status});}
 return r.text();
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--file'))throw Error('Gebruik: node scripts/refresh-round2-feeders.mjs [--file PAD]');
 const file=args.length?resolve(args[1]):fileURLToPath(new URL('../data/products.json',import.meta.url));const initial=await readFile(file,'utf8'),data=JSON.parse(initial);
 const report=await refreshRound2Feeders(data,{load});console.table(report);
 if(report.some(r=>r.checked_at)){
  const tmp=file+'.'+randomUUID()+'.tmp';try{await writeFile(tmp,JSON.stringify(data,null,2)+'\n',{flag:'wx'});if(await readFile(file,'utf8')!==initial)throw Error('Catalogus gewijzigd tijdens de meting');await rename(tmp,file);}finally{await rm(tmp,{force:true});}
 }else console.warn('Geen prijswaarneming bevestigd.');
}
