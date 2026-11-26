import test from 'node:test';
import assert from 'node:assert/strict';
import {matchRound2Feeder,refreshRound2Feeders} from '../scripts/refresh-round2-feeders.mjs';
const target={slug:'cat-mate-c300-wit',shop:'Bitiba',sku:'637095.2',barcode:'035368003660',label:'Cat Mate Voerautomaat C300',adapter:'schema',
 url:'https://www.bitiba.nl/shop/katten/voerbak/voerautomaten/637095?activeVariant=637095.2'};
const canonical=target.url.split('?')[0];
const device={'@type':'Product',name:'Cat Mate Voerautomaat C300 wit',sku:target.sku,gtin13:target.barcode,offers:{'@type':'Offer',url:target.url,priceCurrency:'EUR',availability:'https://schema.org/InStock',price:38.49}};
const accessory={'@type':'Product',name:'Cat Mate Voerautomaat C300 reservebak',sku:'637095.3',gtin13:'035368900181',offers:{...device.offers,url:canonical+'?activeVariant=637095.3',price:14.99}};
const page=(items,url=canonical)=>'<link rel="canonical" href="'+url+'"/><script type="application/ld+json">'+JSON.stringify({'@type':'ProductGroup',hasVariant:items})+'</script>';
test('Alleen de geselecteerde apparaatvariant en ean bevestigen de eenstuksprijs',()=>{
 assert.deepEqual(matchRound2Feeder(page([accessory,device]),target),{price_eur:38.49,stock:'in_stock'});
 for(const key of ['sku','gtin13'])assert.equal(matchRound2Feeder(page([accessory,{...device,[key]:'anders'}]),target),null);
 assert.equal(matchRound2Feeder(page([accessory]),target),null);
 assert.equal(matchRound2Feeder(page([device],canonical+'1'),target),null);
 assert.equal(matchRound2Feeder(page([device,{...device,offers:{...device.offers,price:17}}]),target),null);
 assert.equal(matchRound2Feeder(page([{...device,offers:{...device.offers,priceCurrency:'USD'}}]),target),null);
 assert.equal(matchRound2Feeder(page([{...device,offers:{...device.offers,availability:'PreOrder'}}]),target),null);
});
test('Bij bol moeten ook de product-id en verkoper overeenkomen',()=>{
 const t={...target,shop:'bol (Closer Pets)',label:'Cat Mate',sku:'9300000007889102',url:'https://www.bol.com/nl/nl/p/test/9300000007889102/',adapter:'bol',seller:'Closer Pets'};
 const p={...device,'@id':'https://www.bol.com/#9300000007889102',offers:{...device.offers,seller:{name:t.seller}}};
 assert.ok(matchRound2Feeder(page([p],t.url),t));
 assert.equal(matchRound2Feeder(page([{...p,offers:{...p.offers,seller:{name:'Andere verkoper'}}}],t.url),t),null);
 assert.equal(matchRound2Feeder(page([{...p,'@id':'https://www.bol.com/#1'}],t.url),t),null);
});
test('Fout, onbekende variant, klokterugloop of verpakking met twee stuks bewaart de volledige oudere waarneming',async()=>{
 const base={currency:'EUR',destination:'NL',tech_products:[{slug:target.slug,ean:target.barcode,offers:[{url:target.url,shop:target.shop,shop_sku:target.sku,units:1,unit_kg:null,price_eur:50,stock:'in_stock',checked_at:'2026-11-26T18:00:00Z'}]}]};
 for(const [load,at,units] of [[async()=>{throw Error('HTTP 503')},'2026-11-27',1],[async()=>page([accessory]),'2026-11-27',1],[async()=>page([device]),'2026-11-25',1],[async()=>page([device]),'2026-11-27',2]]){
  const catalog=structuredClone(base);catalog.tech_products[0].offers[0].units=units;const previous=structuredClone(catalog);
  await refreshRound2Feeders(catalog,{load,now:()=>new Date(at),pins:[target]});assert.deepEqual(catalog,previous);
 }
 const result=structuredClone(base);
 await refreshRound2Feeders(result,{load:async()=>page([{...device,offers:{...device.offers,availability:'OutOfStock'}}]),now:()=>new Date('2026-11-27'),pins:[target]});
 assert.equal(result.tech_products[0].offers[0].stock,'out_of_stock');
 assert.equal(result.tech_products[0].offers[0].price_eur,38.49);
});
