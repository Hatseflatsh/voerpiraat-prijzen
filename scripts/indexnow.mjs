import {readdirSync,readFileSync} from 'node:fs';
const root=new URL('../public/',import.meta.url),site=new URL('https://voerpiraat.nl');
const headers={'user-agent':'Voerpiraat indexatie/1.0'};
const keys=readdirSync(root).filter(name=>/^[a-f0-9]{32}\.txt$/.test(name));
if(keys.length!==1)throw Error('Er moet één IndexNow-eigendomsbestand zijn.');
const key=readFileSync(new URL(keys[0],root),'utf8').trim();
const keyLocation=new URL('/'+keys[0],site).href;
async function readLive(url){
  const resp=await fetch(url,{headers,signal:AbortSignal.timeout(15000)});
  if(!resp.ok)throw Error('Ophalen mislukt: '+resp.status+' '+url);
  return resp.text();
}
if((await readLive(keyLocation)).trim()!==key)throw Error('Het eigendomsbestand staat nog niet op de productiehost.');
const paths=process.argv.slice(2);
const locations=xml=>[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match=>match[1].replaceAll('&amp;','&'));
let urls;
if(paths.length===1&&paths[0]==='--lancering'){
  const maps=locations(await readLive(new URL('/sitemap.xml',site)));
  const views=await Promise.all(maps.map(async map=>locations(await readLive(map))));
  urls=views.flat();
}else{
  if(!paths.length)throw Error('Geef de gewijzigde paden door, of --lancering voor de oorspronkelijke openbare lancering.');
  urls=paths.map(p=>new URL(p,site).href);
}
if(!urls.length||urls.some(u=>new URL(u).origin!==site.origin))throw Error('Ongeldige URL-lijst.');
const list=[...new Set(urls)];
const r=await fetch('https://api.indexnow.org/indexnow',{method:'POST',headers:{...headers,'content-type':'application/json; charset=utf-8'},body:JSON.stringify({host:site.hostname,key,keyLocation,urlList:list}),signal:AbortSignal.timeout(25000)});
if(![200,202].includes(r.status))throw Error('IndexNow gaf '+r.status+' '+(await r.text()).slice(0,400));
console.log(JSON.stringify({ontvangen_http:r.status,aantal_urls:list.length,host:site.hostname}));
