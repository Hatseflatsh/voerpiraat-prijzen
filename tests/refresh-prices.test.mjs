import test from 'node:test';
import assert from 'node:assert/strict';
import { readVariants, matchOffer, refreshCatalog, verifyCatalog } from '../src/refresh-prices.mjs';

const base = 'https://www.petsplace.nl/voorbeeld-m-3182550752404-pps';
const small = { gtin13:'3182550752404', sku:'140510', url:base+'?weight_calc=10519', '@type':'Offer', priceCurrency:'EUR', price:'17.19', availability:'https://schema.org/InStock' };
const large = { ...small, gtin13:'3182550799775', sku:'140641', url:base+'?weight_calc=10537', price:'28.59', availability:'https://schema.org/OutOfStock' };
const html = json => '<script type="application/ld+json">'+JSON.stringify(json)+'</script>';
const pets = (...offers) => html({'@type':'http://schema.org/Product',gtin13:small.gtin13,sku:'M-140510',offers});
const offered = (item, overrides={}) => ({shop:'Pets Place',url:item.url,gtin:item.gtin13,shop_sku:item.sku,units:1,price_eur:21,stock:'in_stock',checked_at:'2026-11-23T12:00:00Z',...overrides});
const fixture = offers => ({currency:'EUR',destination:'NL',food_products:[{slug:'voorbeeld',offers}],tech_products:[]});
const now = () => new Date('2026-11-26T12:00:00Z');

test('identificeert beide verpakkingen via hun eigen EAN, winkelsku en variant-URL',()=>{
  const rows = readVariants(pets(small,large));
  assert.equal(matchOffer(offered(large),rows).price,28.59);
  assert.equal(matchOffer(offered(large),rows).stock,'out_of_stock');
  for (const wrong of [{gtin:small.gtin13}, {shop_sku:small.sku}, {url:small.url}, {gtin:undefined}, {shop:'Intratuin'}]) {
    assert.equal(matchOffer(offered(large,wrong),rows),null);
  }
});

test('negeert groeps-EAN bij een onvolledige variant en slaat tegenstrijdige, ongeldige of onzekere prijzen over',()=>{
  const rows = readVariants(pets({...small,gtin13:undefined},large,{...large,price:250}));
  assert.equal(matchOffer(offered(small),rows),null);
  assert.equal(matchOffer(offered(large),rows),null);
  for (const change of [{price:0},{price:null},{priceCurrency:'USD'},{price:'1,99'},{availability:'BackOrder'},{'@type':'AggregateOffer'}]) {
    assert.equal(readVariants(pets({...small,...change})).length,0);
  }
});

test('leest de exacte fabrikantvariant binnen ProductGroup en de geselecteerde Intratuin-verpakking',()=>{
  for (const [shop,url,asGroup] of [
    ['Royal Canin Nederland','https://www.royalcanin.com/nl/dogs/pug?ean=1-3182550752404',true],
    ['Intratuin','https://www.intratuin.nl/pug-1-5-kg.html',false],
  ]) {
    const simple={'@type':'Product',gtin13:small.gtin13,sku:small.sku,offers:{'@type':'Offer',price:'18.39',priceCurrency:'EUR',availability:'https://schema.org/InStock',url}};
    const markup=html(asGroup?{'@type':'ProductGroup',hasVariant:[simple]}:{'@graph':[simple]});
    assert.equal(matchOffer(offered(small,{url,shop}),readVariants(markup)).price,18.39);
    assert.equal(readVariants(html({...simple,offers:{...simple.offers,sku:'andere'}})).length,0);
  }
});

test('gebruikt één webshopverzoek per model en behoudt onbekende of mislukte waarnemingen en bezorgvelden',async()=>{
  const bad=offered(large,{shop_sku:'verkeerd'});
  const failed=offered(large,{url:'https://www.petsplace.nl/uitgevallen'});
  const good=offered(small,{shipping_eur:3.95});
  const unsupported=offered(small,{shop:'Andere winkel'});
  const existing=[structuredClone(bad),structuredClone(failed),structuredClone(unsupported)];
  const catalog=fixture([good,bad,failed,unsupported]);
  const calls=[];
  const result=await refreshCatalog(catalog,{now,load:async url=>{calls.push(url);if(url!==base)throw Error('503');return pets(small,large);}});
  assert.equal(calls.length,2);
  assert.deepEqual([bad,failed,unsupported],existing);
  assert.equal(good.price_eur,17.19); assert.equal(good.shipping_eur,3.95); assert.equal(good.checked_at,now().toISOString());
  assert.deepEqual(result['Pets Place'],{total:3,observed:1,unmatched:1,failed:1});
});

test('behoudt een nieuwere waarneming en weigert ongeldige catalogi',async()=>{
  const o=offered(small,{checked_at:'2026-11-27T12:00:00Z'}),before={...o};
  await refreshCatalog(fixture([o]),{now,load:async()=>pets(small)});
  assert.deepEqual(o,before);
  assert.throws(()=>verifyCatalog(fixture([offered(small,{stock:'mogelijk'})])));
});

test('verlengt een Pets Place-actie uitsluitend met exacte oude prijs, actieprijs, apart percentage en variantidentiteit',async()=>{
  const promotion = {slug:'voorbeeld',shop:'Pets Place',url:small.url,gtin:small.gtin13,shop_sku:small.sku,units:1,unit_kg:1.5,kind:'actie',
    label:'15% korting',reference_label:'Reguliere verkoopprijs volgens Pets Place',reference_eur:20,price_eur:17,checked_at:'2026-11-23T12:00:00Z',valid_until:null};
  const config = {currencyFormat:'€ %s',attributes:{243:{code:'weight_calc'}},index:{112:{243:'10519'}},
    additionalData:{112:{isInStock:true,additionalAttr:{ean:{value:small.gtin13},sku:{value:small.sku}}}},
    optionPrices:{112:{oldPrice:{amount:20},finalPrice:{amount:17},discount:'15%'}}};
  for (const [description,edit,expectUpdate] of [
    ['volledig bevestigd',()=>{},true],
    ['gelijkblijvende prijs zonder actiepercentage',c=>{c.optionPrices[112].discount=null;},false],
    ['adviesprijs zonder reguliere referentie',c=>{c.optionPrices[112].advisedPrice=20; c.optionPrices[112].oldPrice.amount=17;},false],
    ['nieuwe voorwaarden voor deze prijs',c=>{c.optionPrices[112].promotionalText='Alleen bij extra activering';},false],
    ['andere zichtbare referentieprijs',c=>{c.optionPrices[112].oldPrice.amount=22;},false],
    ['andere variant',c=>{c.index[112][243]='10537';},false],
    ['andere winkel-SKU',c=>{c.additionalData[112].additionalAttr.sku.value='123';},false],
  ]) {
    const c=structuredClone(config);edit(c);
    const extra='<script type="text/x-magento-init">'+JSON.stringify({'[data-role=swatch-options]':{'Magento_Swatches/js/swatch-renderer':{jsonConfig:c}}})+'</script>';
    const p=structuredClone(promotion); const o=offered(small,{gtin:undefined,shop_sku:undefined,unit_kg:1.5});
    await refreshCatalog(fixture([o]),{promotions:[p],now,load:async()=>pets({...small,price:17})+extra});
    assert.equal(p.checked_at,expectUpdate?now().toISOString():promotion.checked_at,description);
  }
});

test('onderscheidt een fabrieksmultipack van een zelf samengestelde meervoudige bestelling met dezelfde winkel-ID',()=>{
  const row=offered(small,{units:12,unit_kg:0.085});
  assert.equal(matchOffer(row,readVariants(pets({...small,name:'Zakjes 12×85 g'}))).price,17.19);
  assert.equal(matchOffer(row,readVariants(pets({...small,name:'Los zakje 85 g'}))),null);
  assert.equal(matchOffer(row,readVariants(pets(small))),null);
  assert.equal(matchOffer({...row,unit_kg:0.1},readVariants(pets({...small,name:'Zakjes 12×85 g'}))),null);
});
