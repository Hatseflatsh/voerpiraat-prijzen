import assert from 'node:assert/strict';
import test from 'node:test';
import {matchExpansionDevice,refreshExpansionDevices} from '../scripts/refresh-expansion-devices.mjs';

const time='2026-11-26T15:00:00Z';
const sample=(slug,shop,sku,url,ean)=>({slug,ean,offers:[{shop,shop_sku:sku,url,units:1,unit_kg:null,checked_at:time,price_eur:50,stock:'in_stock'}]});
const c500=sample('cat-mate-c500-wit','Zooplus','601499.2','https://www.zooplus.nl/shop/katten/voerbak/voerautomaten/pet_mate/601499?activeVariant=601499.2','035368003653');
const tracker=sample('pets-on-demand-gps-pro-mini','Pets on Demand','21920308','https://www.petsondemand.nl/product/21920308/gps-pro-mini');
const match=(p,html)=>matchExpansionDevice(p,p.offers[0],html);
const url=c500.offers[0].url,canonical=url.split('?')[0];
const makeVariant=(sku,gtin,price)=>({'@type':'Product',sku,gtin13:gtin,offers:{'@type':'Offer',url:canonical+'?activeVariant='+sku,priceCurrency:'EUR',price,availability:'https://schema.org/InStock'}});
const feeder=makeVariant('601499.2','035368003653',35.19);
const spare=makeVariant('601499.3','035368900181',27.99);
const zoo=(variants)=>'<link rel="canonical" href="'+canonical+'"><script type="application/ld+json">'+JSON.stringify({'@type':'ProductGroup',url:canonical,hasVariant:variants})+'</script>';
const trackerUrl=tracker.offers[0].url;
const gps='<link rel="canonical" href="'+trackerUrl+'"><body data-jouwweb-segment-type="product" data-jouwweb-segment-id="21920308" itemtype="https://schema.org/Product">'+
  '<meta itemprop="url" content="'+trackerUrl+'"><h1 itemprop="name">GPS PRO Mini</h1><div itemprop="offers" itemtype="https://schema.org/Offer">'+
  '<meta itemprop="availability" content="https://schema.org/InStock"><meta itemprop="price" content="127.00"><meta itemprop="priceCurrency" content="EUR"><div>prijs</div></div>'+
  '<select data-field-type="select" data-field-id="2693635"><option data-surcharge="0">Zonder halsband — €0</option><option data-surcharge="7.35">Standaard Rogz</option></select></body>';

test('Zooplus gebruikt de geselecteerde witte C500 en negeert het goedkopere accessoire',()=>{
  assert.deepEqual(match(c500,zoo([spare,feeder])),{value:3519,stock:'in_stock'});
  assert.equal(match(c500,zoo([spare])),null);
  assert.equal(match(c500,zoo([feeder]).replace('035368003653','035368900181')),null);
  assert.equal(match(c500,zoo([feeder]).replace('"priceCurrency":"EUR"','"priceCurrency":"GBP"')),null);
  assert.equal(match(c500,zoo([feeder,{...feeder,offers:{...feeder.offers,price:20}}])),null);
  assert.equal(match(c500,zoo([feeder]).replace('schema.org/InStock','schema.org/PreOrder')),null);
  assert.deepEqual(match(c500,zoo([feeder]).replace('schema.org/InStock','schema.org/OutOfStock')),{value:3519,stock:'out_of_stock'});
});

test('Pets on Demand koppelt het basisbedrag aan het apparaat en de optie zonder halsband',()=>{
  assert.deepEqual(match(tracker,gps),{value:12700,stock:'in_stock'});
  assert.equal(match(tracker,gps.replace('data-jouwweb-segment-id="21920308"','data-jouwweb-segment-id="9"')),null);
  assert.equal(match(tracker,gps.replace('data-surcharge="7.35"','selected data-surcharge="7.35"')),null);
  assert.equal(match(tracker,gps.replace('content="EUR"','content="USD"')),null);
  assert.equal(match(tracker,gps.replace('schema.org/InStock','schema.org/LimitedAvailability')),null);
  assert.equal(match(tracker,gps.replace('itemprop="price" content="127.00"','itemprop="priceSpecification" content="127.00"')),null);
  assert.deepEqual(match(tracker,gps.replace('schema.org/InStock','schema.org/OutOfStock')),{value:12700,stock:'out_of_stock'});
});

test('Bij netwerkproblemen, onbekende prijs en een oudere controle blijven alle gegevens intact',async()=>{
  const catalog={currency:'EUR',destination:'NL',tech_products:[structuredClone(c500),structuredClone(tracker)]};
  const original=structuredClone(catalog);
  const call=load=>refreshExpansionDevices(catalog,{load,now:()=>new Date('2026-11-25T01:00:00Z')});
  await call(async u=>u===url?zoo([feeder]):gps);
  assert.deepEqual(catalog,original);
  const report=await call(async u=>{if(u===url)throw Error('HTTP 429');return '<html></html>';});
  assert.ok(report.some(r=>r.status==='bronfout'));
  assert.deepEqual(catalog,original);
  await refreshExpansionDevices(catalog,{load:async u=>u===url?zoo([spare]):gps,now:()=>new Date('2026-11-27T01:00:00Z')});
  assert.deepEqual(catalog.tech_products[0],original.tech_products[0]);
  assert.equal(catalog.tech_products[1].offers[0].price_eur,127);
});
