import test from 'node:test';
import assert from 'node:assert/strict';
import {matchFountain,refreshFountains} from '../scripts/refresh-fountains.mjs';

const slug='cat-mate-drinkfontein-2l-wit',gtin='035368083358';
const root='https://closerpets.eu/products/three-level-pet-fountain-white-335-petmate',url=root+'?variant=47401103196492';
const target={slug,shop:'Closer Pets',mode:'ld',sku:'335E',gtin,url};
const make=()=>({slug,ean:gtin,offers:[{shop:target.shop,url,shop_sku:target.sku,gtin,units:1,unit_kg:null,price_eur:29,shipping_eur:null,stock:'in_stock',checked_at:'2026-11-25T10:00:00Z'}]});
function html({ref=new URL(url).pathname+new URL(url).search,code=gtin,sku='335E',currency='EUR',state='InStock',base=root}={}){
  return '<link rel="canonical" href="'+base+'"><script type="application/ld+json">'+JSON.stringify({'@type':'Product',sku,gtin12:code,offers:[{'@type':'Offer',url:ref,price:31.29,priceCurrency:currency,availability:'https://schema.org/'+state}]})+'</script>';
}
test('Shopify-link blijft op de vaste winkeldomeinnaam met dezelfde EAN, variant en SKU',()=>{
 const p=make(),o=p.offers[0],q=h=>matchFountain(target,o,p,h);
 assert.deepEqual(q(html()),{value:3129,stock:'in_stock'});
 assert.deepEqual(q(html({state:'OutOfStock'})),{value:3129,stock:'out_of_stock'});
 for(const bad of [{ref:'https://www.example.com'+new URL(url).pathname+new URL(url).search},{ref:new URL(url).pathname+'?variant=99'},{sku:'335E-G'},{code:'035368003899'},{currency:'GBP'},{base:root+'-grey'},{state:'LimitedAvailability'}])assert.equal(q(html(bad)),null);
 assert.equal(matchFountain(target,{...o,units:2},p,html()),null);
});
test('Zooplus-fontein kan niet worden herbevestigd via een goedkopere filter op dezelfde pagina',()=>{
 const uri='https://www.zooplus.nl/shop/katten/voerbak/kattendrenkplaats/145972?activeVariant=145972.9',base=uri.split('?')[0];
 const t={...target,shop:'Zooplus',sku:'145972.9',url:uri,mode:'zooplus'};
 const p=make(),o={...p.offers[0],shop:t.shop,shop_sku:t.sku,url:uri};
 const page=(ref,sku,code)=>html({ref,sku,code,base});
 assert.deepEqual(matchFountain(t,o,p,page(uri,t.sku,gtin)),{value:3129,stock:'in_stock'});
 assert.equal(matchFountain(t,o,p,page(base+'?activeVariant=145972.6','145972.6','035368003899')),null);
});
test('Bij een bronfout of oudere waarneming blijven prijs en tijd behouden',async()=>{
 const p=make(),catalog={currency:'EUR',destination:'NL',tech_products:[p]},before=structuredClone(p);
 await refreshFountains(catalog,[target],{load:async()=>{throw Object.assign(Error(),{status:429});}});
 assert.deepEqual(p,before);
 await refreshFountains(catalog,[target],{load:async()=>html(),now:()=>new Date('2026-11-24T13:00:00Z')});
 assert.deepEqual(p,before);
 await refreshFountains(catalog,[target],{load:async()=>html(),now:()=>new Date('2026-11-26T10:00:00Z')});
 assert.equal(p.offers[0].price_eur,31.29);assert.equal(p.offers[0].shipping_eur,null);assert.equal(p.offers[0].checked_at,'2026-11-26T10:00:00.000Z');
});
