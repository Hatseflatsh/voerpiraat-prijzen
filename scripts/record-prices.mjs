import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {recordPrices,makePriceViews} from '../src/price-history.mjs';
const root=path.resolve(process.argv[2]||fileURLToPath(new URL('..',import.meta.url)));
const read=(name,initial)=>fs.existsSync(path.join(root,name))?JSON.parse(fs.readFileSync(path.join(root,name),'utf8')):initial;
function save(name,value){
  const dest=path.join(root,name),text=JSON.stringify(value)+'\n';
  if(fs.existsSync(dest)&&fs.readFileSync(dest,'utf8')===text)return;
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.writeFileSync(dest+'.tmp',text);fs.renameSync(dest+'.tmp',dest);
}
const catalog=read('data/products.json'),promos=read('data/promotions.json',[]);
const history=recordPrices(catalog,read('data/price-history.json',{}));
save('data/price-history.json',history);
const {feed,summary}=makePriceViews(catalog,history,promos);
if(!fs.existsSync(path.join(root,'package.json')) || process.argv.includes('--export')){
  for(const [slug,view] of Object.entries(feed))save('public/history/'+slug+'.json',view);
  save('public/history/overzicht.json',summary);
}
console.log(summary.series_count+' prijsreeksen, '+summary.measurement_days+' meetdagen, '+summary.promos.length+' actuele aanbiedingen.');
