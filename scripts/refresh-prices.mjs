import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { refreshCatalog, verifyCatalog } from '../src/refresh-prices.mjs';

const args = process.argv.slice(2);
const verify = args[0] === '--verify';
if (verify) args.shift();
if (args.length && !(args.length === 2 && args[0] === '--file')) throw new Error('Gebruik: node scripts/refresh-prices.mjs [--verify] [--file PAD]');
const target = args.length ? resolve(args[1]) : fileURLToPath(new URL('../data/products.json', import.meta.url));
const before = await readFile(target, 'utf8');
const catalog = JSON.parse(before);
verifyCatalog(catalog);
if (verify) {
  console.log('Catalogus bevat geldige product-ID’s, winkelprijzen, meetdatums en voorraadstatussen.');
} else {
  async function load(url) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(url, {
        redirect: 'error',
        headers: { 'user-agent': 'VoerpiraatPrijscontrole/1.0 (+https://voerpiraat.nl/methodologie)', 'accept': 'text/html', 'accept-language': 'nl-NL,nl;q=0.9' },
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok && response.headers.get('content-type')?.toLowerCase().includes('text/html')) return response.text();
      await response.body?.cancel();
      if (attempt || ![502, 503, 504].includes(response.status) || response.headers.has('retry-after')) throw new Error('HTTP '+response.status);
      await delay(1000);
    }
  }
  const promotionPath = join(dirname(target),'promotions.json');
  let promotionBefore;
  try { promotionBefore = await readFile(promotionPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const promotions = promotionBefore ? JSON.parse(promotionBefore) : [];
  if (!Array.isArray(promotions)) throw new Error('Promotiebestand bevat geen lijst.');
  const report = await refreshCatalog(catalog, { load, promotions });
  console.table(report);
  const observed = Object.values(report).reduce((sum, shop) => sum + shop.observed, 0);
  if (!observed) throw new Error('Geen bevestigde variantprijzen. De catalogus is niet bijgewerkt.');
  for (const [shop, result] of Object.entries(report)) {
    if (!result.observed) console.warn('Geen bevestigde prijzen bij '+shop);
  }
  const writes = [{path:target,before,after:JSON.stringify(catalog,null,2)+'\n'}];
  if (Object.values(report).some(shop=>shop.promotions)) {
    writes.push({path:promotionPath,before:promotionBefore,after:JSON.stringify(promotions,null,2)+'\n'});
  }
  for (const entry of writes) entry.temporary=entry.path+'.'+randomUUID()+'.tmp';
  try {
    for (const entry of writes) await writeFile(entry.temporary,entry.after,{flag:'wx'});
    for (const entry of writes) {
      if (await readFile(entry.path,'utf8') !== entry.before) throw new Error('Bronbestand veranderde tijdens de prijsmeting. Probeer opnieuw.');
    }
    for (const entry of writes) await rename(entry.temporary,entry.path);
  } finally {
    for (const entry of writes) await rm(entry.temporary,{force:true});
  }
}
