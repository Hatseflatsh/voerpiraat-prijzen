import {delivered} from './calculate.mjs';

const amsterdam = new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Amsterdam', year:'numeric',month:'2-digit',day:'2-digit'});
export function measurementDay(timestamp){
  if(typeof timestamp !== 'string')return null;
  if(/^\d{4}-\d{2}-\d{2}$/.test(timestamp))return timestamp;
  const instant=new Date(timestamp);
  return Number.isNaN(instant.valueOf())?null:amsterdam.format(instant);
}
function key(offer){
  return JSON.stringify([offer.shop,offer.gtin||offer.shop_sku||offer.sku||offer.url,offer.units,offer.unit_kg??null,offer.tier_min_units||null]);
}
export function recordPrices(catalog,previous={}){
  const result=structuredClone(previous);
  for(const product of [...catalog.food_products,...catalog.tech_products]){
    const list=result[product.slug]??=[];
    const map=new Map(list.map(s=>[key(s),s]));
    for(const o of product.offers){
      const day=measurementDay(o.checked_at);
      if(!day||!Number.isFinite(o.price_eur)||o.price_eur<=0||!o.url)continue;
      const id=key(o);
      let s=map.get(id);
      if(!s){
        s={shop:o.shop,url:o.url,units:o.units,unit_kg:o.unit_kg??null};
        for(const field of ['gtin','shop_sku','sku','tier_min_units'])if(o[field])s[field]=o[field];
        s.points=[];list.push(s);map.set(id,s);
      }
      const current=s.points.findIndex(x=>x.day===day);
      if(current>=0 && Date.parse(s.points[current].checked_at)>Date.parse(o.checked_at))continue;
      const point={day,checked_at:o.checked_at,price_eur:o.price_eur,delivered_eur:delivered(o),stock:o.stock};
      if(current<0)s.points.push(point);else s.points[current]=point;
      s.points.sort((a,b)=>a.day.localeCompare(b.day));
      if(s.points.at(-1).checked_at===o.checked_at)s.url=o.url;
    }
  }
  return result;
}
export function recentPromotion(p,now=new Date()){
  const checked=Date.parse(p.checked_at),time=now.valueOf();
  if(!Number.isFinite(checked)||checked>time+300000||time-checked>48*3600000)return false;
  if(!p.valid_until)return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(p.valid_until)?measurementDay(now.toISOString())<=p.valid_until:time<=Date.parse(p.valid_until);
}
export function makePriceViews(catalog,history,promos=[],now=new Date()){
  const products=[...catalog.food_products,...catalog.tech_products],feed={},changes=[],currentPromos=[];
  for(const p of products){
    const offers=history[p.slug]||[],page='/'+({kat:'kattenvoer',hond:'hondenvoer'}[p.species]||'dierentech')+'/'+p.slug;
    const info={slug:p.slug,name:p.brand+' '+p.model+(p.species?' · '+p.species:''),page,species:p.species||'tech'};
    const active=promos.filter(v=>v.slug===p.slug&&recentPromotion(v,now)&&p.offers.some(o=>o.shop===v.shop&&o.url===v.url&&o.units===v.units&&(o.unit_kg??null)===(v.unit_kg??null)&&o.stock==='in_stock'&&o.price_eur===v.price_eur));
    currentPromos.push(...active.map(v=>({...info,...v})));
    feed[p.slug]={series:offers,promos:active};
    for(const s of offers){
      const pts=s.points,latest=pts.at(-1),prior=pts.at(-2);
      if(!prior||!latest||latest.stock!=='in_stock'||prior.stock!=='in_stock')continue;
      const delta=Math.round((latest.price_eur-prior.price_eur)*100)/100;
      if(!delta)continue;
      changes.push({...info,shop:s.shop,url:s.url,units:s.units,unit_kg:s.unit_kg,price_eur:latest.price_eur,before_eur:prior.price_eur,delta,day:latest.day,prior_day:prior.day});
    }
  }
  changes.sort((a,b)=>b.day.localeCompare(a.day)||Math.abs(b.delta)-Math.abs(a.delta));
  const all=Object.values(history).flat();
  const days=[...new Set(all.flatMap(s=>s.points.map(x=>x.day)))].sort();
  return {feed,summary:{promos:currentPromos,changes,series_count:all.length,measurement_days:days.length,first_day:days[0]??null,last_day:days.at(-1)??null}};
}
