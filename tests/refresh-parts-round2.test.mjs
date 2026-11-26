import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchPartOffer,recordPartsHistory} from '../scripts/refresh-parts.mjs';

const canonical='https://www.bitiba.nl/shop/katten/voerbak/kattendrenkplaats/637933';
const tracking={adapter:'bitiba',sku:'637933.2',gtin:'4053032005594',label:'Vital Flow vervangfilter 6 stuks'};
const selected=canonical+'?activeVariant=637933.2';
const offer={shop:'Bitiba',url:selected,match:tracking};
const product={'@type':'Product',sku:tracking.sku,gtin13:tracking.gtin,name:tracking.label,
  offers:{'@type':'Offer',url:selected,price:3.75,priceCurrency:'EUR',availability:'https://schema.org/InStock'}};
const variant={sku:tracking.sku,variant_price:3.75,out_stock:false,sellerType:'1P',isPersonalizedArticleBasedDiscount:false};
function documentFor(p=product,v=variant){
  return '<link rel="canonical" href="'+canonical+'"><script type="application/ld+json">'+
    JSON.stringify({'@type':'ProductGroup',hasVariant:[p]})+'</script><script id="productDataLayer" type="application/json">'+
    JSON.stringify({currency:'EUR',page_URL:new URL(canonical).pathname,variants:[v]})+'</script>';
}
test('Bitiba bevestigt prijs en voorraad op één gekozen variant en twee winkelbronnen',()=>{
  assert.deepEqual(matchPartOffer(offer,documentFor()),{value:375,stock:'in_stock'});
  for(const wrong of [{gtin13:'4053032005595'},{sku:'637933.1'},{name:'Vital Flow fontein'}]){
    assert.equal(matchPartOffer(offer,documentFor({...product,...wrong})),null);
  }
  for(const wrong of [{sku:'637933.1'},{variant_price:47.99},{out_stock:true},{sellerType:'3P'},{isPersonalizedArticleBasedDiscount:true}]){
    assert.equal(matchPartOffer(offer,documentFor(product,{...variant,...wrong})),null);
  }
});
test('verzendstaffels en onzekere grensbedragen blijven zichtbaar in de prijshistorie',()=>{
  const stored={...offer,stock:'in_stock',pack:6,measure:6,pack_label:'6 filters',checked_at:'2026-11-26T19:00:00Z',
    min_order_eur:9,shipping_eur:4.99,free_from_eur:29.01,shipping_unknown_amounts_eur:[19,29],
    shipping_tiers:[{from_eur:9,shipping_eur:4.99},{from_eur:19,shipping_eur:2.99}]};
  function delivered(price_eur) {
    return recordPartsHistory([{slug:'filter',unit:'filter',offers:[{...stored,price_eur}]}]).filter[0].points[0].delivered_eur;
  }
  assert.deepEqual([3.75,9,19,20,29,29.01].map(delivered),[null,13.99,null,22.99,null,29.01]);
});
test('Junai gebruikt de verkochte verpakking met eigen artikelcode, barcode en prijs',()=>{
  const url='https://www.junai.nl/voorbeeld.html';
  const offer={shop:'Junai',url,match:{adapter:'junai',sku:'33/43724',gtin:'022517437247',label:'Dry pad 3 stuks'}};
  const fields={sku:'33/43724',gtin13:'22517437247',name:'Dry pad 3 stuks',priceCurrency:'EUR',price:'2.02',availability:'https://schema.org/InStock'};
  const html='<link rel="canonical" href="'+url+'">'+Object.entries(fields).map(([k,v])=>'<meta itemprop="'+k+'" content="'+v+'">').join('');
  assert.deepEqual(matchPartOffer(offer,html),{value:202,stock:'in_stock'});
  assert.equal(matchPartOffer(offer,html.replace('3 stuks','30 stuks')),null);
  assert.equal(matchPartOffer(offer,html+'<meta itemprop="price" content="9.95">'),null);
});
test('Closer Pets accepteert eigen relatieve winkel-URL uitsluitend bij een gelijkluidende Shopify-variant',()=>{
  const base='https://closerpets.eu/products/ice',url=base+'?variant=123';
  const offer={shop:'Closer Pets EU',url,match:{adapter:'shopify',sku:'958',gtin:'035368009587',variant:'123',label:'Pack of 2'}};
  const p={'@type':'Product',offers:{url:'/products/ice?variant=123',sku:'958',price:21.99,priceCurrency:'EUR',availability:'https://schema.org/InStock'}};
  const html='<link rel="canonical" href="'+base+'"><script type="application/ld+json">'+JSON.stringify(p)+'</script>';
  const v={id:123,sku:'958',barcode:'035368009587',title:'Pack of 2',price:2199,available:true};
  const match=v=>matchPartOffer(offer,html,{handle:'ice',variants:[v]});
  assert.deepEqual(match(v),{value:2199,stock:'in_stock'});
  for(const wrong of [{price:1099},{id:124},{sku:'945'},{available:false},{barcode:'035368009457'},{title:'Pack of 1'}])assert.equal(match({...v,...wrong}),null);
});
