import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { refreshDeals } from '../src/deal-refresh.mjs';

const args=process.argv.slice(2);
if (args.length && !(args.length===2 && args[0]==='--file')) throw new Error('Gebruik: node scripts/refresh-deals.mjs [--file PAD/NAAR/products.json]');
const productsPath=args.length ? resolve(args[1]) : fileURLToPath(new URL('../data/products.json',import.meta.url));
const promoPath=join(dirname(productsPath),'promotions.json');
const catalogText=await readFile(productsPath,'utf8');
const promoText=await readFile(promoPath,'utf8');
const catalog=JSON.parse(catalogText), promotions=JSON.parse(promoText);
let delivery={};
try { delivery=JSON.parse(await readFile(new URL('../data/winkels.json',import.meta.url),'utf8')); }
catch (error) { if (error.code!=='ENOENT') throw error; }
const lastRequest=new Map();

async function load(url,type) {
  const host=new URL(url).hostname;
  const gap=host==='www.dierapotheker.nl' ? 2700 : 400;
  const wait=gap-(Date.now()-(lastRequest.get(host) || 0));
  if (wait>0) await sleep(wait);
  lastRequest.set(host,Date.now());
  const response=await fetch(url,{
    redirect:'error',signal:AbortSignal.timeout(14000),
    headers:{'user-agent':'VoerpiraatPrijscontrole/1.0 (+https://voerpiraat.nl/methodologie)',
      'accept':type==='json'?'application/json, text/javascript':'text/html','accept-language':'nl-NL,nl;q=0.9'},
  });
  const contentType=response.headers.get('content-type') || '';
  if (!response.ok || !(type==='html' ? /text\/html/i : /(?:json|javascript)/i).test(contentType)) {
    await response.body?.cancel();
    throw Object.assign(new Error('Winkelpagina niet beschikbaar, HTTP '+response.status),{status:response.status});
  }
  return response.text();
}

const report=await refreshDeals(catalog,promotions,{load,delivery});
console.table(report);
const observed=Object.values(report).reduce((sum,r)=>sum+r.observed,0);
if (observed===0) {
  console.warn('Geen aanvullende winkelvariant bevestigd. Bestaande metingen behouden.');
} else {
  // The GitHub Actions job publishes both files from one commit. A parse failure,
  // interrupted write or concurrent edit must not overwrite the source snapshots.
  const writes=[
    {path:productsPath,old:catalogText,next:JSON.stringify(catalog,null,2)+'\n'},
    {path:promoPath,old:promoText,next:JSON.stringify(promotions,null,2)+'\n'},
  ].filter(w=>w.next!==w.old);
  for (const w of writes) w.tmp=w.path+'.'+randomUUID()+'.tmp';
  try {
    for (const w of writes) await writeFile(w.tmp,w.next,{flag:'wx'});
    for (const [path,before] of [[productsPath,catalogText],[promoPath,promoText]]) {
      if (await readFile(path,'utf8')!==before) throw new Error('Brondata gewijzigd tijdens de controle. Voer de controle opnieuw uit.');
    }
    for (const w of writes) await rename(w.tmp,w.path);
  } finally {
    for (const w of writes) await rm(w.tmp,{force:true});
  }
}
