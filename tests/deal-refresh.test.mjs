import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshDeals } from '../src/deal-refresh.mjs';

const day='2026-11-26T12:00:00.000Z', previous='2026-11-25T12:00:00.000Z';
const da='https://www.dierapotheker.nl/voer/1488/';
const med='https://www.medpets.nl/voer?sku=MP123';
const kit='https://petkit.co.nl/products/voorbeeld?variant=50933881995602';
const mk=(shop,url,extras={})=>({shop,url,units:1,unit_kg:4,price_eur:51,stock:'in_stock',checked_at:previous,...extras});
const item=(offers)=>({slug:'voer',offers});
const catalog=(...rows)=>({currency:'EUR',destination:'NL',food_products:rows,tech_products:[]});
const run=(c,p,load,options={})=>refreshDeals(c,p,{load,now:()=>new Date(day),...options});
const base=()=>mk('Dierapotheker',da,{sku:'1488',gtin:'3182550711012',shipping_eur:3.95,free_from_eur:59});
const oldTier=()=>({...base(),units:2,tier_min_units:2,tier_unit_price_eur:49,price_eur:98,shipping_eur:0});
const oldDeal=()=>({...oldTier(),slug:'voer',kind:'staffel',shop_sku:'1488',reference_eur:102});
const ldo=(offers)=>'<script type="application/ld+json">'+JSON.stringify({'@type':'Product',offers:offers.map(o=>({'@type':'Offer',priceCurrency:'EUR',availability:'InStock',...o}))})+'</script>';
function daPage({base=50,tiers=[[3,45.75]],size='4 kg',code='3182550711012',widget=true}={}) {
  const options=[[1,base],...tiers].map(([n,price])=>'<button class="js-tier-price-option" data-min-quantity="'+n+'" data-price-euro="'+Math.floor(price)+'" data-price-cents="'+(Math.round(price*100)%100)+'"><meta itemprop="priceCurrency" content="EUR"><meta itemprop="price" content="'+price+'">'+(n>1?'<span class="strix-tier-price-option-discount">8% korting</span>':'')+'</button>').join('');
  return '<div id="product-data" data-product-number="1488" data-sku="1488" data-url="'+da+'" data-currency="EUR" data-price="'+base+'" data-availability="https://schema.org/InStock"></div><meta itemprop="gtin13" content="'+code+'"><script>dataLayer.push('+JSON.stringify({event:'view_item',ecommerce:{currency:'EUR',items:[{item_id:'1488',price:base,item_variant:size}]}})+');</script>'+(widget?'<div data-strix-tier-price-selector="true">'+options+'</div>':'');
}
function medPage({price=18,regular=20,name='Voer 4 kg',code=null,ldPrice=price,stock=8,ldStock='InStock'}={}) {
  const v={sku:'MP123',name,active:true,stock,price,price_original:regular,promotionLabel:regular?{label:'10% korting',title:'10% korting',promotion_type:4,code}:null};
  return '<script>window.variants = '+JSON.stringify([v])+'\nwindow.productTitle = "Voer";</script>'+ldo([{url:med,price:ldPrice,availability:ldStock}]);
}

test('vervangt staffel vanaf twee door drie, met aparte stukprijs, winkelprijs en totale referentie',async()=>{
  const c=catalog(item([base(),oldTier()])), p=[oldDeal()];
  const report=await run(c,p,async()=>daPage());
  assert.equal(report.Dierapotheker.retired,1);assert.equal(c.food_products[0].offers[0].price_eur,50);
  const offer=c.food_products[0].offers[1];
  assert.deepEqual([offer.units,offer.tier_min_units,offer.tier_unit_price_eur,offer.price_eur,offer.shipping_eur],[3,3,45.75,137.25,0]);
  assert.deepEqual([p.length,p[0].reference_eur,p[0].units,p[0].price_eur],[1,150,3,137.25]);assert.match(p[0].conditions,/45,75/);
  await run(c,p,async()=>daPage());
  assert.equal(c.food_products[0].offers.length,2);assert.equal(p.length,1);
});

test('expliciet verdwenen staffel wordt verwijderd; ontbrekende widget herdateert de korting niet',async()=>{
  const c=catalog(item([base(),oldTier()])), p=[oldDeal()];
  await run(c,p,async()=>daPage({widget:false}));
  assert.equal(p[0].checked_at,previous);assert.equal(c.food_products[0].offers[1].checked_at,previous);
  await run(c,p,async()=>daPage({tiers:[]}));
  assert.equal(p.length,0);assert.equal(c.food_products[0].offers.length,1);
});

test('andere inhoud of GTIN laat Dierapotheker ongemoeid',async()=>{
  for (const changes of [{size:'5 kg'},{code:'3182550711999'}]) {
    const c=catalog(item([base(),oldTier()])),p=[oldDeal()];
    await run(c,p,async()=>daPage(changes)); assert.equal(c.food_products[0].offers[0].checked_at,previous);
    assert.equal(p[0].checked_at,previous);
  }
});

test('Medpets dubbelbevestigde variant en directe korting, codes geen prijs',async()=>{
  const c=catalog(item([mk('Medpets',med,{shop_sku:'MP123'})])),p=[];
  await run(c,p,async()=>medPage());
  assert.equal(p[0].reference_eur,20);assert.equal(p[0].price_eur,18);
  await run(c,p,async()=>medPage({code:'LEDEN'}));
  assert.equal(p.length,0);assert.equal(c.food_products[0].offers[0].price_eur,18);
  await run(c,p,async()=>medPage({price:17,regular:null,stock:0,ldStock:'OutOfStock'}));
  assert.equal(c.food_products[0].offers[0].stock,'out_of_stock');assert.equal(c.food_products[0].offers[0].price_eur,17);
});

test('Medpets weigert conflicterende verkoopprijs, SKU en verpakking en kan geneste multipacks controleren',async()=>{
  for (const changes of [{ldPrice:19},{name:'Voer 8 kg'},{stock:0}]) {
    const c=catalog(item([mk('Medpets',med,{shop_sku:'MP123'})]));
    await run(c,[],async()=>medPage(changes));assert.equal(c.food_products[0].offers[0].checked_at,previous);
  }
  const c=catalog(item([mk('Medpets',med,{units:28,unit_kg:0.1})]));
  await run(c,[],async()=>medPage({name:'FCW 4 x (7 x 100 g)'}));
  assert.equal(c.food_products[0].offers[0].checked_at,day);
});

test('Shopify kruist vaste variant-ID, valuta, barcode, voorraad en eurocenten met de openbare Offer',async()=>{
  const c=catalog(item([mk('PETKIT Nederland',kit,{unit_kg:null,shop_sku:'6975069305028'})])), p=[];
  let currency='GBP',reference=60000,barcode='6975069305028';
  const load=async(url,kind)=>kind==='html' ? ldo([{url:kit,price:499,priceCurrency:currency}]) :
    JSON.stringify({handle:'voorbeeld',variants:[{id:99999999999999,price:1,available:true},{id:50933881995602,price:49900,compare_at_price:reference,available:true,barcode}]});
  await run(c,p,load);assert.equal(p.length,0);assert.equal(c.food_products[0].offers[0].checked_at,previous);
  currency='EUR';barcode='6975069309999';await run(c,p,load);assert.equal(c.food_products[0].offers[0].checked_at,previous);
  barcode='6975069305028'; await run(c,p,load);assert.equal(c.food_products[0].offers[0].price_eur,499);
  assert.equal(p[0].reference_eur,600);assert.equal(p[0].shop_sku,'50933881995602');
  reference=null;await run(c,p,load);assert.equal(p.length,0);
});

test('403 of 429 stopt alleen die winkel, zonder retries; eerst de oudste meting',async()=>{
  for (const status of [403,429]) {
    const stale=mk('Dierapotheker','https://www.dierapotheker.nl/voer/4/',{checked_at:'2026-11-01T00:00:00Z'});
    const c=catalog(item([base(),stale,mk('Medpets',med)]));const calls=[];
    const report=await run(c,[],async url=>{
      calls.push(url);if (url.includes('dierapotheker')) throw Object.assign(new Error(),{status});return medPage();
    });
    assert.equal(report.Dierapotheker.blocked,status);assert.equal(report.Medpets.observed,1);
    assert.deepEqual(calls.filter(v=>v.includes('dierapotheker')),[stale.url]);
  }
});
