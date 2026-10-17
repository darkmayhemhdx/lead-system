// Lead System Mobil – Offline-Speicher für die App-Dateien (keine Kundendaten)
const CACHE='leads-v5';
const FILES=['./','index.html','ls-sync.js','plz-latlon.json','vendor/leaflet.js','vendor/leaflet.css','vendor/leaflet.markercluster.js','vendor/MarkerCluster.css','manifest.webmanifest','apple-touch-icon.png','icon-192.png','icon-512.png','favicon.png','monitor.html','monitor-icon.png','monitor.webmanifest'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))));self.clients.claim();});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.endsWith('sync-config.json')) return;
  e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(x=>x.put(e.request,c));return r;}).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match('index.html'))));
});
