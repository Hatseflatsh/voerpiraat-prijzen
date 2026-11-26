import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const revision=process.argv[2];
if(!/^[0-9a-f]{40}$/.test(revision||''))throw Error('De basiscommit ontbreekt.');
const before=JSON.parse(execFileSync('git',['show',revision+':data/products.json'],{encoding:'utf8',maxBuffer:50_000_000}));
const after=JSON.parse(readFileSync(new URL('../data/products.json',import.meta.url),'utf8'));
function observations(dataset){
 const records=new Map();
 for(const p of [...dataset.food_products,...dataset.tech_products]){
  const page='/'+({hond:'hondenvoer',kat:'kattenvoer'}[p.species]||'dierentech')+'/'+p.slug;
  const rows=p.offers.map(o=>[o.shop,o.url,o.units,o.unit_kg,o.price_eur,o.shipping_eur,o.stock,o.tier_unit_price_eur]).map(row=>JSON.stringify(row)).sort();
  records.set(page,JSON.stringify(rows));
 }
 return records;
}
const old=observations(before),latest=observations(after);
const pages=[...new Set([...old.keys(),...latest.keys()])].filter(k=>old.get(k)!==latest.get(k));
if(pages.length){
 const script=fileURLToPath(new URL('indexnow.mjs',import.meta.url));
 execFileSync(process.execPath,[script,'/aanbiedingen','/prijzen',...pages],{stdio:'inherit'});
}else console.log('Alleen controlemomenten bijgewerkt. Geen gewijzigde productpagina’s om aan te melden.');
