import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recordPartsHistory,refreshPartFiles} from '../scripts/refresh-parts.mjs';

const url='https://www.proshop.nl/Katten/Voorbeeld/3519540';
const offer={shop:'Proshop',url,measure:3,pack:3,pack_label:'3 cubes',price_eur:39.85,shipping_eur:4.99,shipping_floor:true,
  stock:'in_stock',checked_at:'2026-11-26T12:00:00Z',match:{adapter:'single',label:'3 stuks',sku:'3519540',gtin:'6975069309071'}};
const data=(o=offer)=>[{slug:'cube',unit:'cube',offers:[o]}];
const html=price=>'<link rel="canonical" href="'+url+'"><script type="application/ld+json">'+JSON.stringify({'@type':'Product',name:'Fountain Cube 3 stuks',sku:offer.match.sku,gtin13:offer.match.gtin,offers:{'@type':'Offer',url,price,priceCurrency:'EUR',availability:'https://schema.org/InStock'}})+'</script>';

test('houdt meerdere echte controles per kalenderdag, vermijdt dubbeltelling en onbewezen bezorgdprijs',()=>{
  let h=recordPartsHistory(data());
  h=recordPartsHistory(data({...offer,checked_at:'2026-11-26T13:01:00+01:00',price_eur:38}),h);
  h=recordPartsHistory(data(),h);
  assert.deepEqual(h.cube[0].points.map(p=>p.price_eur),[39.85,38]);
  assert.ok(h.cube[0].points.every(p=>p.day==='2026-11-26'&&p.delivered_eur===null));
  assert.throws(()=>recordPartsHistory(data({...offer,stock:'out_of_stock'}),h),/hetzelfde meetmoment/);
  const separate=recordPartsHistory(data({...offer,measure:6,pack:6,pack_label:'6 cubes'}),h);
  assert.equal(separate.cube.length,2);
});

test('registreert alleen bevestigde winkelbedragen, bewaart vorige datum bij fout en schrijft beide geldige bestanden',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'vp-onderdelen-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'parts-expansion.json'),history=join(dir,'parts-history.json');
  const original=JSON.stringify(data());await writeFile(file,original);
  const denied=async()=>{throw Object.assign(new Error(),{status:403});};
  const skipped=await refreshPartFiles(file,history,{load:denied});
  assert.equal(skipped.Proshop.blocked,403);assert.equal(await readFile(file,'utf8'),original);
  await assert.rejects(readFile(history),{code:'ENOENT'});
  const now=()=>new Date('2026-11-26T23:30:00Z');
  const report=await refreshPartFiles(file,history,{load:async()=>html(38),now});
  assert.equal(report.Proshop.confirmed,1);assert.equal(JSON.parse(await readFile(file))[0].offers[0].price_eur,38);
  const h=await readFile(history,'utf8');
  assert.deepEqual(JSON.parse(h).cube[0].points.map(p=>p.day),['2026-11-26','2026-11-27']);
  await refreshPartFiles(file,history,{load:async()=>html(38),now});assert.equal(await readFile(history,'utf8'),h);
  const saved=await readFile(file,'utf8');
  await writeFile(history,'broken');await assert.rejects(refreshPartFiles(file,history,{load:async()=>html(1),now}));
  assert.equal(await readFile(file,'utf8'),saved);assert.equal(await readFile(history,'utf8'),'broken');
});

test('een onderminimum of onbekende verzending levert geen exact bezorgd bedrag',()=>{
  const under={...offer,shipping_floor:false,min_order_eur:50};
  const exact={...offer,shipping_floor:false};
  assert.equal(recordPartsHistory(data(under)).cube[0].points[0].delivered_eur,null);
  assert.equal(recordPartsHistory(data(exact)).cube[0].points[0].delivered_eur,44.84);
  assert.equal(recordPartsHistory(data({...exact,shipping_eur:null,free_from_eur:30})).cube[0].points[0].delivered_eur,39.85);
});
