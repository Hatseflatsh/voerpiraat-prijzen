import {readFile,writeFile,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';

const shops={'Medpets':'www.medpets.nl','Pets Place':'www.petsplace.nl','PETKIT Nederland':'petkit.co.nl','PETKIT Europe':'www.petkit-eu.com','Proshop':'www.proshop.nl','SB Supply':'www.sbsupply.nl','CATLINK EU':'catlinkeu.com','Kattenluiken.nl':'www.kattenluiken.nl'};
const identifier=v=>String(v??'');
const numeric=v=>typeof v==='number' || typeof v==='string' && /^\d+(?:\.\d{1,2})?$/.test(v);
const price=v=>numeric(v)&&Number.isFinite(Number(v))&&Number(v)>0 ? Math.round(Number(v)*100) : null;
const stock=v=>({InStock:'in_stock',OutOfStock:'out_of_stock'})[String(v||'').split('/').at(-1)] || null;
const same=(a,b)=>String(a).trim().toLowerCase().includes(String(b).trim().toLowerCase());
const uniq=rows=>rows.length===1?rows[0]:null;
const base=u=>u.split('?')[0];
function parsed(script) {
  try { return JSON.parse(script); } catch {}
  // Some Lightspeed review strings contain raw controls. Escape only control
  // characters inside quoted strings and let JSON.parse validate the entire tree.
  const clean=script.replace(/"(?:[^"\\]|\\[\s\S])*"/g,s=>s.replace(/[\u0000-\u001f]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')));
  try {return JSON.parse(clean);} catch {return null;}
}
function productsIn(value) {
  if(!value || typeof value!=='object')return [];
  if(Array.isArray(value))return value.flatMap(productsIn);
  if(value['@graph'])return productsIn(value['@graph']);
  if(String(value['@type']).split('/').at(-1)==='ProductGroup')return productsIn(value.hasVariant);
  return String(value['@type']).split('/').at(-1)==='Product'?[value]:[];
}
function attribute(tag,key) {
  return new RegExp('\\s'+key+'\\s*=\\s*(["\x27])([^"\x27]+)\\1','i').exec(tag)?.[2].replaceAll('&amp;','&');
}
function inspect(html) {
  const records=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(m=>attribute(' '+m[1],'type')==='application/ld+json').flatMap(m=>productsIn(parsed(m[2])));
  const canonical=uniq([...html.matchAll(/<link\b[^>]*>/gi)].map(m=>m[0]).filter(t=>attribute(t,'rel')==='canonical').map(t=>attribute(t,'href')));
  const med=html.match(/\bwindow\.variants\s*=\s*(\[[^\r\n]*\])\s*;?\s*(?:\r?\n|<\/script>)/);
  return {records,canonical,variants:med?parsed(med[1]):null};
}
function quote(record) {
  const value=price(record?.price),status=stock(record?.availability);
  return value&&status&&record.priceCurrency==='EUR'?{value,stock:status}:null;
}
function agreements(rows) {
  if(!rows.length || rows.some(r=>!r||r.value!==rows[0].value||r.stock!==rows[0].stock))return null;
  return rows[0];
}

export function matchPartOffer(offer,html,storefront=null) {
  const url=new URL(offer.url);
  if(url.protocol!=='https:'||url.hostname!==shops[offer.shop]||url.port||url.username||url.password)return null;
  const page=inspect(html),id=offer.match;
  if(!page.canonical||base(page.canonical)!==base(offer.url))return null;
  const pairs=page.records.flatMap(p=>[p.offers].flat().filter(Boolean).map(o=>[p,o]));
  if(id.adapter==='single' || id.adapter==='petsplace'){
    if(!id.gtin||!id.sku)return null;
    const hits=pairs.filter(([p,o])=>{
      const identity=id.adapter==='petsplace'?o:p;
      const barcode=identity.gtin13 || identity.gtin12 || identity.gtin;
      return identifier(barcode)===id.gtin && identifier(identity.sku)===id.sku &&
        same(identity.name,id.label) && (o.url===offer.url || (!o.url&&id.adapter==='single'&&page.canonical===offer.url));
    });
    return agreements(hits.map(([,o])=>quote(o)));
  }
  const hits=pairs.filter(([,o])=>o.url===offer.url);
  const result=agreements(hits.map(([,o])=>quote(o)));
  if(!result)return null;
  if(id.adapter==='medpets'){
    if(url.searchParams.get('sku')!==id.sku || !Array.isArray(page.variants))return null;
    const v=uniq(page.variants.filter(x=>x.sku===id.sku));
    if(!v||v.active!==true||v.name!==id.label||!Number.isFinite(v.stock)||price(v.price)!==result.value || (v.stock>0)!==(result.stock==='in_stock'))return null;
    if(id.gtin && hits.some(([p])=>identifier(p.gtin13)!==id.gtin))return null;
    return result;
  }
  if(id.adapter!=='shopify'||url.searchParams.get('variant')!==id.variant || !storefront ||
      storefront.handle!==url.pathname.split('/').at(-1) || !Array.isArray(storefront.variants))return null;
  const v=uniq(storefront.variants.filter(x=>String(x.id)===id.variant));
  return v && v.title===id.label && Number.isSafeInteger(v.price) && v.price===result.value && typeof v.available==='boolean' &&
    v.available===(result.stock==='in_stock') && (!id.gtin||v.barcode===id.gtin) ? result:null;
}

export async function refreshParts(data,{load,now=()=>new Date(),pause=0}){
  const queues=new Map(),report={};
  for(const p of data){
    if(!p.slug||!Array.isArray(p.offers))throw new Error('Ongeldig onderdelendossier');
    for(const o of p.offers){
      const shop=o.shop,url=new URL(o.url);
      if(shops[shop]!==url.hostname||url.protocol!=='https:'||url.username||url.password||url.port)throw new Error('Onverwachte winkelbron');
      if(!queues.has(shop))queues.set(shop,new Map());
      const urls=queues.get(shop);const page=base(o.url);
      if(!urls.has(page))urls.set(page,[]);urls.get(page).push(o);
      const stats=report[shop]??={candidates:0,confirmed:0,changed:0,unmatched:0,errors:0};stats.candidates++;
    }
  }
  const jobs=queues.entries();
  async function worker(){
    for(const [shop,urls] of jobs){
      const stats=report[shop];
      for(const [url,offers] of urls){
        try {
          const html=await load(url,'html');
          const storefront=offers.some(o=>o.match.adapter==='shopify')?JSON.parse(await load(url+'.js','json')):null;
          const at=now().toISOString();
          for(const o of offers){
            const row=matchPartOffer(o,html,storefront);
            if(!row || Date.parse(at)<Date.parse(o.checked_at)){stats.unmatched++;continue;}
            if(o.price_eur!==row.value/100 || o.stock!==row.stock)stats.changed++;
            o.price_eur=row.value/100;o.stock=row.stock;o.checked_at=at;stats.confirmed++;
          }
        }catch(err){stats.errors+=offers.length;if([403,429].includes(err?.status)){stats.blocked=err.status;break;}}
        if(pause)await wait(pause);
      }
    }
  }
  await Promise.all(Array.from({length:3},worker));
  return report;
}

async function load(url,type) {
  const res=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{'user-agent':'VoerpiraatPrijscontrole/1.0 (+https://voerpiraat.nl/methodologie)','accept-language':'nl-NL,nl;q=0.9','accept':type==='html'?'text/html':'application/json, text/javascript'}});
  if(!res.ok||!(type==='html'?/html/i:/json|javascript/i).test(res.headers.get('content-type')||'')){
    await res.body?.cancel();throw Object.assign(new Error('Winkelbron niet beschikbaar'),{status:res.status});
  }
  return res.text();
}

const dayInNL=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Amsterdam',year:'numeric',month:'2-digit',day:'2-digit'});
const identity=(shop,code,pack,measure,unit)=>JSON.stringify([shop,code,pack,measure,unit]);

function singleDelivery(o) {
  if(o.min_order_eur>o.price_eur || o.shipping_unknown_at_eur===o.price_eur)return null;
  if(o.free_from_eur!=null && o.price_eur>=o.free_from_eur)return o.price_eur;
  if(!Number.isFinite(o.shipping_eur) || o.shipping_floor)return null;
  return (Math.round(100*o.price_eur)+Math.round(100*o.shipping_eur))/100;
}

// Keep all observed times, including separate checks on one day. The chart selects
// the most recent check per Amsterdam calendar day but the public source retains both.
export function recordPartsHistory(data,prior={}) {
  if(!prior || Array.isArray(prior) || typeof prior!=='object')throw new Error('Ongeldig historieformaat.');
  const result=structuredClone(prior);
  for(const [slug,series] of Object.entries(result)){
    if(!Array.isArray(series)||series.some(s=>!s.key||!s.shop||!Array.isArray(s.points)||s.points.some(p=>p.price_eur<=0||!Number.isFinite(p.price_eur)||!Number.isFinite(Date.parse(p.checked_at)))))throw new Error('Ongeldige meetreeks bij '+slug);
  }
  for(const p of data){
    if(!p.slug||!Array.isArray(p.offers)||!p.unit)throw new Error('Onvolledig onderdelendossier.');
    const rows=result[p.slug]??=[];
    for(const o of p.offers){
      const observed=new Date(o.checked_at);
      if(!Number.isFinite(observed.valueOf())||!(o.price_eur>0)||!Number.isFinite(o.price_eur)||!(o.pack>0)||!(o.measure>0)||!['in_stock','out_of_stock','unknown'].includes(o.stock))throw new Error('Ongeldige meting bij '+p.slug);
      const at=observed.toISOString(),id=o.match?.variant || o.match?.sku || o.match?.gtin || o.url;
      const key=identity(o.shop,id,o.pack,o.measure,p.unit);
      let row=rows.find(s=>s.key===key);
      if(!row){
        row={key,shop:o.shop,url:o.url,units:o.pack,measure:o.measure,unit:p.unit,pack_label:o.pack_label,points:[]};
        if(o.match?.gtin)row.gtin=o.match.gtin;
        if(o.match?.sku || o.match?.variant)row.shop_sku=o.match.sku || o.match.variant;
        rows.push(row);
      }
      const point={day:dayInNL.format(observed),checked_at:at,price_eur:o.price_eur,delivered_eur:singleDelivery(o),stock:o.stock};
      const previous=row.points.find(x=>x.checked_at===at);
      if(previous){
        if(previous.price_eur!==point.price_eur || previous.stock!==point.stock)throw new Error('Twee verkoopprijzen of voorraadstatussen op hetzelfde meetmoment: '+key);
        continue;
      }
      row.points.push(point);
      row.points.sort((a,b)=>Date.parse(a.checked_at)-Date.parse(b.checked_at));
      if(row.points.at(-1)===point)row.url=o.url;
    }
  }
  return result;
}

async function readOptional(file) {
  try{return await readFile(file,'utf8');}catch(err){if(err.code==='ENOENT')return null;throw err;}
}

export async function refreshPartFiles(target,historyFile,{load:loader,now,pause=0}){
  const originals=await Promise.all([readFile(target,'utf8'),readOptional(historyFile)]);
  const data=JSON.parse(originals[0]);
  const prior=originals[1]===null?{}:JSON.parse(originals[1]);
  // Validate prior records and the current input before making any requests or writes.
  const baseline=recordPartsHistory(data,prior);
  const report=await refreshParts(data,{load:loader,now,pause});
  if(!Object.values(report).some(x=>x.confirmed))return report;
  const observed=recordPartsHistory(data,baseline);
  const changes=[[historyFile,originals[1],observed],[target,originals[0],data]].map(([file,before,after])=>({
    file,before,after:JSON.stringify(after,null,2)+'\n',tmp:file+'.'+randomUUID()+'.tmp',
  })).filter(x=>x.after!==x.before);
  const committed=[];
  try{
    for(const c of changes)await writeFile(c.tmp,c.after,{flag:'wx'});
    if((await readFile(target,'utf8'))!==originals[0] || (await readOptional(historyFile))!==originals[1])throw new Error('De bron is tijdens de meting gewijzigd.');
    for(const c of changes){await rename(c.tmp,c.file);committed.push(c);}
  }catch(error){
    // Recover a failed second rename only if the installed first file is still ours.
    for(const c of committed.reverse())if(await readOptional(c.file)===c.after){
      if(c.before===null)await rm(c.file);
      else{await writeFile(c.tmp,c.before,{flag:'wx'});await rename(c.tmp,c.file);}
    }
    throw error;
  }finally{for(const c of changes)await rm(c.tmp,{force:true});}
  return report;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2);
  if(args.length && !(args.length===2 && args[0]==='--file'))throw new Error('Gebruik: node scripts/refresh-parts.mjs [--file PAD]');
  const target=args.length?resolve(args[1]):fileURLToPath(new URL('../data/parts-expansion.json',import.meta.url));
  const report=await refreshPartFiles(target,join(dirname(target),'parts-history.json'),{load,pause:450});
  console.table(report);
  if(!Object.values(report).some(x=>x.confirmed))console.warn('Geen actuele winkeloptie bevestigd; eerdere metingen en historie behouden.');
}
