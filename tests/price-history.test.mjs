import test from 'node:test';
import assert from 'node:assert/strict';
import {recordPrices,makePriceViews,measurementDay,recentPromotion} from '../src/price-history.mjs';
const date='2026-11-26T11:00:00Z',offer={shop:'Winkel',url:'https://example.test/zak',units:1,unit_kg:2,gtin:'001',price_eur:11,shipping_eur:2,stock:'in_stock',checked_at:date};
const catalog=(...offers)=>({food_products:[{slug:'voer',brand:'Merk',model:'Recept',species:'kat',offers}],tech_products:[]});
test('Dezelfde variant en lokale meetdag zijn idempotent; oude controles verplaatsen het laatste meetpunt niet',()=>{
 const a=recordPrices(catalog(offer)),b=recordPrices(catalog({...offer,price_eur:12,checked_at:'2026-11-26T12:00:00Z'}),a);
 assert.equal(b.voer[0].points.length,1);assert.equal(b.voer[0].points[0].price_eur,12);assert.deepEqual(recordPrices(catalog(offer),b),b);assert.equal(a.voer[0].points[0].price_eur,11);
 assert.equal(measurementDay('2026-11-26T23:30:00Z'),'2026-11-27');
});
test('Varianten en winkelstaffels blijven gescheiden; alleen opeenvolgende beschikbare prijsmetingen geven een verandering',()=>{
 const a=recordPrices(catalog(offer,{...offer,units:2},{...offer,tier_min_units:2},{...offer,shop:'Ander'}));
 const next={...offer,price_eur:9,checked_at:'2026-11-28T12:00:00Z'};
 const b=recordPrices(catalog(next),a);
 assert.equal(b.voer.length,4);const summary=makePriceViews(catalog(next),b).summary;
 assert.equal(summary.changes[0].delta,-2);assert.equal(summary.changes[0].prior_day,'2026-11-26');
 const unavailable={...next,stock:'out_of_stock'};assert.equal(makePriceViews(catalog(unavailable),recordPrices(catalog(unavailable),b)).summary.changes.length,0);
});
test('Alleen beschikbare actuele winkelacties met gelijk bedrag en verpakking tellen',()=>{
 const p={...offer,slug:'voer',valid_until:'2026-11-26'},a=recordPrices(catalog(offer));
 const now=new Date('2026-11-26T21:30:00Z');
 assert(recentPromotion(p,now));assert(!recentPromotion(p,new Date('2026-11-26T23:10:00Z')));
 assert.equal(makePriceViews(catalog(offer),a,[p,{...p,price_eur:7}],now).summary.promos.length,1);
 assert(!recentPromotion({...p,valid_until:null},new Date('2026-11-29')));
});
