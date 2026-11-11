/* Little-Known Texas Markers — V1
   Marker & courthouse data: Texas Historical Commission, Texas Historic Sites Atlas (atlas.thc.texas.gov). */
'use strict';

const SUPABASE_URL = 'https://hrtuhexblsbdjfdbfblg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_3YxbUs181JkWsR9Xe5_tow_BAF9GsQS';
const BUCKET = 'lkt-photos';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- state ----------
const S = {
  user: null,
  counties: [], markers: [], byAtlas: new Map(),
  courts: [], courtById: new Map(), courtsByCounty: new Map(),
  logs: new Map(),            // key "kind:ref" -> log row
  textCache: new Map(),       // county slug -> {atlas: {...}}
  me: null,                   // {lat,lng}
  signed: new Map(),          // storage path -> signed url
  layers: {}, pinIndex: new Map(),
};
const F = { NOTEXT:1, CENT:2, MISSING:4, RTHL:8, NOPIN:16 };
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slug = c => (c||'unknown').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'unknown';
const key = (kind, ref) => kind + ':' + ref;
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset()*6e4).toISOString().slice(0,10); };
function toast(msg, ms=2600){ const t=$('#toast'); t.textContent=msg; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.add('hidden'),ms); }

// ---------- geo ----------
function dist(a,b,c,d){ const R=3958.8, r=Math.PI/180, x=(c-a)*r, y=(d-b)*r;
  const h=Math.sin(x/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin(y/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }
function bearing(a,b,c,d){ const r=Math.PI/180, y=Math.sin((d-b)*r)*Math.cos(c*r),
  x=Math.cos(a*r)*Math.sin(c*r)-Math.sin(a*r)*Math.cos(c*r)*Math.cos((d-b)*r); return (Math.atan2(y,x)/r+360)%360; }
function fmtMi(m){ return m<0.1 ? Math.round(m*5280)+' ft' : m<10 ? m.toFixed(1)+' mi' : Math.round(m)+' mi'; }
function locate(){ return new Promise((res,rej)=>{
  if(!navigator.geolocation) return rej(new Error('No GPS on this device'));
  navigator.geolocation.getCurrentPosition(p=>{ S.me={lat:p.coords.latitude,lng:p.coords.longitude,acc:p.coords.accuracy}; res(S.me); },
    e=>rej(e), {enableHighAccuracy:true, timeout:15000, maximumAge:30000}); }); }

// ---------- data ----------
async function loadData(){
  const [m, c] = await Promise.all([fetch('data/markers.json').then(r=>r.json()), fetch('data/courthouses.json').then(r=>r.json())]);
  S.counties = m.counties;
  S.markers = m.markers.map(a => ({ atlas:a[0], name:a[1], lat:a[2], lng:a[3], county:m.counties[a[4]]||'', city:a[5], year:a[6], flags:a[7], num:a[8],
    _s:(a[1]+' '+a[5]+' '+(m.counties[a[4]]||'')).toLowerCase() }));
  S.markers.forEach(x => S.byAtlas.set(x.atlas, x));
  S.courts = c; c.forEach(x => { S.courtById.set(x.id, x);
    if(!S.courtsByCounty.has(x.county)) S.courtsByCounty.set(x.county, []); S.courtsByCounty.get(x.county).push(x); });
  for (const L of S.courtsByCounty.values()) L.sort((a,b)=>(parseInt(a.built)||9999)-(parseInt(b.built)||9999));
  const sel = $('#qCounty'); S.counties.forEach(n => sel.insertAdjacentHTML('beforeend', `<option>${esc(n)}</option>`));
}
async function markerText(m){
  const s = slug(m.county);
  if(!S.textCache.has(s)) S.textCache.set(s, fetch(`data/text/${s}.json`).then(r=>r.ok?r.json():{}).catch(()=>({})));
  return (await S.textCache.get(s))[m.atlas] || null;
}

// ---------- logs (sync) ----------
const PENDING_KEY = 'lkt_pending', CACHE_KEY = 'lkt_logs_cache';
function getLog(kind, ref){ return S.logs.get(key(kind,ref)); }
function cacheLogs(){ try{ localStorage.setItem(CACHE_KEY, JSON.stringify([...S.logs.values()])); }catch{} }
function pending(){ try{ return JSON.parse(localStorage.getItem(PENDING_KEY)||'{}'); }catch{ return {}; } }
function setPending(p){ try{ localStorage.setItem(PENDING_KEY, JSON.stringify(p)); }catch{} updateSync(); }
async function loadLogs(){
  try{ JSON.parse(localStorage.getItem(CACHE_KEY)||'[]').forEach(r=>S.logs.set(key(r.kind,r.ref), r)); }catch{}
  Object.values(pending()).forEach(r=>S.logs.set(key(r.kind,r.ref), r));
  const { data, error } = await sb.from('lkt_logs').select('*');
  if(!error && data){ const p = pending(); S.logs.clear();
    data.forEach(r=>S.logs.set(key(r.kind,r.ref), r)); Object.values(p).forEach(r=>S.logs.set(key(r.kind,r.ref), r)); cacheLogs(); }
}
async function saveLog(kind, ref, patch){
  const cur = getLog(kind, ref) || { kind, ref, visited:false, want:false, story_lead:false, photos:[] };
  const row = { ...cur, ...patch, kind, ref, user_id:S.user.id, updated_at:new Date().toISOString() };
  delete row.id; delete row.created_at;
  S.logs.set(key(kind,ref), row); cacheLogs();
  const p = pending(); p[key(kind,ref)] = row; setPending(p);
  refreshPin(kind, ref);
  flush();
  return row;
}
let flushing = false;
async function pushPending(){
  const p = pending(); const rows = Object.values(p); if(!rows.length) return;
  const { error } = await sb.from('lkt_logs').upsert(rows, { onConflict:'user_id,kind,ref' });
  if(error){ console.warn(error); return; }
  const now = pending(); rows.forEach(r=>{ if(now[key(r.kind,r.ref)]?.updated_at === r.updated_at) delete now[key(r.kind,r.ref)]; }); setPending(now);
}
let flushAgain = false;
async function flush(){
  if(!navigator.onLine || !S.user) return;
  if(flushing){ flushAgain = true; return; }
  flushing = true;
  try{ do { flushAgain = false; await pushPending(); await flushPhotos(); await pushPending(); } while(flushAgain); }
  finally { flushing = false; updateSync(); }
}
function updateSync(){
  const n = Object.keys(pending()).length + (photoQueueCount||0);
  $('#syncState').textContent = !navigator.onLine ? '● offline — saved on phone' : n ? `↻ syncing ${n}…` : '✓ synced';
}
window.addEventListener('online', ()=>{ updateSync(); flush(); });
window.addEventListener('offline', updateSync);

// ---------- photos (queued in IndexedDB until uploaded) ----------
let photoQueueCount = 0;
function idb(){ return new Promise((res,rej)=>{ const r=indexedDB.open('lkt',1);
  r.onupgradeneeded=()=>r.result.createObjectStore('photos',{keyPath:'id'}); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function idbAll(){ const db=await idb(); return new Promise(res=>{ const q=db.transaction('photos').objectStore('photos').getAll(); q.onsuccess=()=>res(q.result||[]); q.onerror=()=>res([]); }); }
async function idbPut(v){ const db=await idb(); return new Promise(res=>{ const t=db.transaction('photos','readwrite'); t.objectStore('photos').put(v); t.oncomplete=res; }); }
async function idbDel(id){ const db=await idb(); return new Promise(res=>{ const t=db.transaction('photos','readwrite'); t.objectStore('photos').delete(id); t.oncomplete=res; }); }
async function shrink(file){
  const img = await createImageBitmap(file).catch(()=>null); if(!img) return file;
  const max = 1800, s = Math.min(1, max/Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width*s); c.height = Math.round(img.height*s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return await new Promise(r=>c.toBlob(b=>r(b||file), 'image/jpeg', 0.82));
}
async function addPhotos(kind, ref, files){
  for(const f of files){
    const blob = await shrink(f);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    await idbPut({ id, kind, ref, blob, path:`${S.user.id}/${kind}/${ref}/${id}.jpg` });
  }
  photoQueueCount = (await idbAll()).length; updateSync();
  toast(files.length>1 ? `${files.length} photos added` : 'Photo added');
  await flush();
}
async function flushPhotos(){
  const items = await idbAll(); photoQueueCount = items.length;
  for(const it of items){
    const { error } = await sb.storage.from(BUCKET).upload(it.path, it.blob, { contentType:'image/jpeg', upsert:true });
    if(error) { console.warn(error); break; }
    const cur = getLog(it.kind, it.ref);
    const photos = [...new Set([...(cur?.photos||[]), it.path])];
    await saveLog(it.kind, it.ref, { photos });
    await idbDel(it.id); photoQueueCount--;
    if(currentSheet && currentSheet.kind===it.kind && currentSheet.ref===it.ref) renderPhotos(it.kind, it.ref);
  }
}
async function signedUrls(paths){
  const need = paths.filter(p=>!S.signed.has(p));
  if(need.length){ const { data } = await sb.storage.from(BUCKET).createSignedUrls(need, 60*60*24);
    (data||[]).forEach(d=>{ if(d.signedUrl) S.signed.set(d.path, d.signedUrl); }); }
  return paths.map(p=>S.signed.get(p));
}
async function renderPhotos(kind, ref){
  const box = document.getElementById('photoGrid'); if(!box) return;
  const log = getLog(kind, ref); const paths = log?.photos || [];
  const queued = (await idbAll()).filter(i=>i.kind===kind && i.ref===ref);
  const urls = navigator.onLine ? await signedUrls(paths) : paths.map(p=>S.signed.get(p));
  box.innerHTML = urls.map((u,i)=> u ? `<img src="${esc(u)}" data-path="${esc(paths[i])}" loading="lazy" alt="">` : `<div class="ph">photo (online to view)</div>`).join('')
    + queued.map(q=>`<img src="${URL.createObjectURL(q.blob)}" style="opacity:.6" alt="uploading">`).join('')
    || '<div class="muted">No photos yet.</div>';
  box.querySelectorAll('img[data-path]').forEach(img=>img.onclick=()=>lightbox(img.src, img.dataset.path, kind, ref));
}
function lightbox(src, path, kind, ref){
  const d = document.createElement('div'); d.className='lightbox';
  d.innerHTML = `<img src="${esc(src)}"><div class="lb-actions"><button class="btn small" data-a="close">Close</button><button class="btn small" data-a="del">Delete photo</button></div>`;
  d.onclick = async e => {
    const a = e.target.dataset.a;
    if(a==='del'){ if(!confirm('Delete this photo?')) return;
      await sb.storage.from(BUCKET).remove([path]);
      await saveLog(kind, ref, { photos:(getLog(kind,ref)?.photos||[]).filter(p=>p!==path) });
      d.remove(); renderPhotos(kind, ref); }
    else if(a==='close' || e.target===d) d.remove();
  };
  document.body.appendChild(d);
}

// ---------- map ----------
let map, meMarker;
function pinClass(kind, ref){
  const l = getLog(kind, ref); let c = 'pin' + (kind==='courthouse' ? ' ch' : '');
  if(l?.story_lead) c += ' l'; else if(l?.visited) c += ' v'; else if(l?.want) c += ' w';
  return c;
}
function makeIcon(kind, ref){
  return L.divIcon({ className:'', html:`<div class="${pinClass(kind,ref)}">${kind==='courthouse'?'⚖':''}</div>`,
    iconSize: kind==='courthouse'?[20,20]:[16,16], iconAnchor: kind==='courthouse'?[10,10]:[8,8] });
}
function initMap(){
  map = L.map('map', { zoomControl:false, preferCanvas:true }).setView([31.2, -99.3], 6);
  L.control.zoom({ position:'topleft' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19,
    attribution:'© OpenStreetMap · Marker data: Texas Historical Commission' }).addTo(map);
  S.layers.markers = L.markerClusterGroup({ chunkedLoading:true, disableClusteringAtZoom:15, maxClusterRadius:55, showCoverageOnHover:false });
  S.layers.courts = L.layerGroup();
  buildMarkerLayer();
  S.courts.filter(c=>c.lat).forEach(c=>{
    const mk = L.marker([c.lat,c.lng], { icon:makeIcon('courthouse', c.id), zIndexOffset:500 }).on('click', ()=>openCourt(c.id));
    S.pinIndex.set(key('courthouse', c.id), mk); S.layers.courts.addLayer(mk);
  });
  map.addLayer(S.layers.markers);
  // Courthouse pins appear once you zoom in a bit, so the statewide view isn't buried in them.
  const syncCourts = ()=>{ const want = $('#lyrCourthouses').checked && map.getZoom() >= 8;
    if(want && !map.hasLayer(S.layers.courts)) map.addLayer(S.layers.courts);
    if(!want && map.hasLayer(S.layers.courts)) map.removeLayer(S.layers.courts); };
  map.on('zoomend', syncCourts); syncCourts();
  $('#btnLocate').onclick = async ()=>{ try{ const me = await locate(); showMe(); map.setView([me.lat,me.lng], 12); } catch(e){ toast('Could not get your location — check location permission.'); } };
  $('#btnLayers').onclick = ()=>$('#layerPanel').classList.toggle('hidden');
  $('#lyrMarkers').onchange = e => e.target.checked ? map.addLayer(S.layers.markers) : map.removeLayer(S.layers.markers);
  $('#lyrCourthouses').onchange = syncCourts;
  $('#lyrHideVisited').onchange = buildMarkerLayer;
  $('#lyrMystery').onchange = buildMarkerLayer;
}
function buildMarkerLayer(){
  const hide = $('#lyrHideVisited').checked, mys = $('#lyrMystery').checked;
  S.layers.markers.clearLayers(); [...S.pinIndex.keys()].filter(k=>k.startsWith('marker:')).forEach(k=>S.pinIndex.delete(k));
  const list = [];
  for(const m of S.markers){
    if(m.lat==null) continue;
    if(hide && getLog('marker', m.atlas)?.visited) continue;
    if(mys && !(m.flags & F.NOTEXT)) continue;
    const mk = L.marker([m.lat,m.lng], { icon:makeIcon('marker', m.atlas) }).on('click', ()=>openMarker(m.atlas));
    S.pinIndex.set(key('marker', m.atlas), mk); list.push(mk);
  }
  S.layers.markers.addLayers(list);
}
function refreshPin(kind, ref){ const mk = S.pinIndex.get(key(kind,ref)); if(mk) mk.setIcon(makeIcon(kind, ref)); }
function showMe(){ if(!S.me || !map) return;
  if(!meMarker) meMarker = L.marker([S.me.lat,S.me.lng], { icon:L.divIcon({className:'',html:'<div class="me"></div>',iconSize:[18,18],iconAnchor:[9,9]}), zIndexOffset:1000 }).addTo(map);
  else meMarker.setLatLng([S.me.lat,S.me.lng]); }

// ---------- lists ----------
const FILTERS = [
  ['all','All'], ['todo','Not visited'], ['mystery','Mystery (no text)'], ['cent','1936 Centennial'],
  ['missing','Missing'], ['nopin','No map pin'], ['rthl','Landmarks (RTHL)'], ['lead','My leads'], ['want','Want to visit'] ];
function chipBar(el, state, onChange, skip=[]){
  el.innerHTML = FILTERS.filter(f=>!skip.includes(f[0])).map(([k,l])=>`<button class="chip ${state.f===k?'on':''}" data-k="${k}">${l}</button>`).join('');
  el.onclick = e => { const k=e.target.dataset.k; if(!k) return; state.f=k; chipBar(el,state,onChange,skip); onChange(); };
}
function passes(m, f){
  const l = getLog('marker', m.atlas);
  switch(f){ case 'todo': return !l?.visited; case 'mystery': return m.flags&F.NOTEXT; case 'cent': return m.flags&F.CENT;
    case 'missing': return m.flags&F.MISSING; case 'nopin': return m.flags&F.NOPIN; case 'rthl': return m.flags&F.RTHL;
    case 'lead': return l?.story_lead; case 'want': return l?.want; default: return true; }
}
function badges(m){
  const l = getLog('marker', m.atlas); let b='';
  if(l?.visited) b+='<span class="badge b-v">✓ seen</span>';
  if(l?.story_lead) b+='<span class="badge b-l">lead</span>';
  if(l?.want) b+='<span class="badge b-w">want</span>';
  if(m.flags&F.NOTEXT) b+='<span class="badge b-x">mystery</span>';
  if(m.flags&F.CENT) b+='<span class="badge b-c">1936</span>';
  if(m.flags&F.MISSING) b+='<span class="badge b-m">missing</span>';
  return b;
}
function markerLi(m){
  let d='';
  if(S.me && m.lat!=null){ const mi=dist(S.me.lat,S.me.lng,m.lat,m.lng), br=bearing(S.me.lat,S.me.lng,m.lat,m.lng);
    d=`<div class="d"><span class="arrow" style="transform:rotate(${br}deg)">↑</span><br>${fmtMi(mi)}</div>`; }
  return `<li data-a="${esc(m.atlas)}"><div class="main"><div class="t">${esc(m.name)}</div>
    <div class="s">${badges(m)}${esc([m.city, m.county && m.county+' Co.'].filter(Boolean).join(' · '))}${m.year?' · '+m.year:''}</div></div>${d}</li>`;
}
function bindList(ul){ ul.onclick = e => { const li=e.target.closest('li'); if(li?.dataset.a) openMarker(li.dataset.a); else if(li?.dataset.c) openCourt(li.dataset.c); else if(li?.dataset.county) openCounty(li.dataset.county); }; }

const nearState = { f:'all' };
async function renderNear(useGps){
  const st=$('#nearStatus'), ul=$('#nearList');
  if(useGps || !S.me){ st.textContent='Finding you…';
    try{ await locate(); showMe(); } catch(e){ st.textContent='Turn on location to see what\'s near you.'; return; } }
  const res = [];
  for(const m of S.markers){ if(m.lat==null || !passes(m, nearState.f)) continue;
    res.push([dist(S.me.lat,S.me.lng,m.lat,m.lng), m]); }
  res.sort((a,b)=>a[0]-b[0]);
  const top = res.slice(0,60);
  const cts = S.courts.filter(c=>c.lat).map(c=>[dist(S.me.lat,S.me.lng,c.lat,c.lng),c]).sort((a,b)=>a[0]-b[0])[0];
  st.textContent = top.length ? `Closest ${top.length} markers` : 'Nothing matches that filter nearby.';
  ul.innerHTML = (cts && nearState.f==='all' ? courtLi(cts[1], cts[0]) : '') + top.map(([,m])=>markerLi(m)).join('');
}
function courtLi(c, mi){
  const l = getLog('courthouse', c.id);
  return `<li data-c="${esc(c.id)}"><div class="main"><div class="t">⚖ ${esc(c.title)}</div><div class="s">${l?.visited?'<span class="badge b-v">✓ seen</span>':''}${esc(c.city)}${c.use?' · '+esc(c.use):''}</div></div>${mi!=null?`<div class="d">${fmtMi(mi)}</div>`:''}</li>`;
}

const searchState = { f:'all' };
function renderSearch(){
  const q = $('#q').value.trim().toLowerCase(), cty = $('#qCounty').value, ul=$('#searchList');
  if(!q && !cty && searchState.f==='all'){ $('#searchStatus').textContent='Type a name, town, or marker number — or pick a county or filter.'; ul.innerHTML=''; return; }
  const words = q.split(/\s+/).filter(Boolean);
  const num = /^\d+$/.test(q) ? q : null;
  let res = S.markers.filter(m => (!cty || m.county===cty) && passes(m, searchState.f) &&
    (num ? (m.num===num || m.atlas===num) : words.every(w=>m._s.includes(w))));
  if(num) res.sort((a,b)=>(b.num===num)-(a.num===num));
  else if(S.me) res.sort((a,b)=>(a.lat==null)-(b.lat==null) || (a.lat!=null && dist(S.me.lat,S.me.lng,a.lat,a.lng)-dist(S.me.lat,S.me.lng,b.lat,b.lng)));
  else res.sort((a,b)=>a.name.localeCompare(b.name));
  $('#searchStatus').textContent = `${res.length.toLocaleString()} marker${res.length===1?'':'s'}${res.length>200?' — showing first 200':''}`;
  ul.innerHTML = res.slice(0,200).map(markerLi).join('');
}

// ---------- courthouses ----------
const courtState = { f:'all' };
function countyDone(cty){ return (S.courtsByCounty.get(cty)||[]).some(c=>c.current && getLog('courthouse',c.id)?.visited); }
function renderCourts(){
  const q = $('#courtQ').value.trim().toLowerCase();
  const counties = [...S.courtsByCounty.keys()].sort();
  const done = counties.filter(countyDone).length;
  $('#courtCount').textContent = `${done} / ${counties.length}`;
  $('#courtChips').innerHTML = [['all','All counties'],['todo','Still to see'],['done','Photographed']].map(([k,l])=>`<button class="chip ${courtState.f===k?'on':''}" data-k="${k}">${l}</button>`).join('');
  $('#courtChips').onclick = e=>{ if(e.target.dataset.k){ courtState.f=e.target.dataset.k; renderCourts(); } };
  $('#courtList').innerHTML = counties.filter(c=>(!q || c.toLowerCase().includes(q)) &&
      (courtState.f==='all' || (courtState.f==='done') === countyDone(c))).map(c=>{
    const L = S.courtsByCounty.get(c), cur = L.filter(x=>x.current), lost = L.filter(x=>!x.lat).length;
    let d = ''; if(S.me && cur[0]?.lat) d = `<div class="d">${fmtMi(dist(S.me.lat,S.me.lng,cur[0].lat,cur[0].lng))}</div>`;
    return `<li data-county="${esc(c)}"><div class="main"><div class="t">${countyDone(c)?'✅ ':''}${esc(c)} County</div>
      <div class="s">${cur.map(x=>esc(x.city)+' · built '+esc(x.built)).join('; ')} · ${L.length} courthouse${L.length>1?'s':''} in its history${lost?` (${lost} lost)`:''}</div></div>${d}</li>`; }).join('');
}
function openCounty(cty){
  const L = S.courtsByCounty.get(cty)||[];
  openSheet({ kind:'county', ref:cty }, `
    <h2>${esc(cty)} County courthouses</h2>
    <p class="muted">Every courthouse the county has had, oldest first. Tap one that still stands to log your visit.</p>
    <div class="timeline">${L.map(c=>{
      const gone = /gone|demolish|burn|razed/i.test(c.use) && !/active/i.test(c.use);
      const l = getLog('courthouse', c.id);
      return `<div class="ev ${c.current?'cur':''} ${gone?'gone':''}">
        <div><b>${esc(c.built||'?')}</b> — ${esc(c.title)} ${l?.visited?'<span class="badge b-v">✓ seen</span>':''}${l?.story_lead?'<span class="badge b-l">lead</span>':''}</div>
        <div class="kv">${esc(c.use||'(status not recorded)')}${c.architect?' · Architect: '+esc(c.architect):''}${c.style?' · '+esc(c.style):''}</div>
        <button class="btn small" data-open="${esc(c.id)}">Details${c.lat?' & log visit':''}</button></div>`; }).join('')}</div>`);
  $('#sheetBody').querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openCourt(b.dataset.open));
}

// ---------- detail sheets ----------
let currentSheet = null, sheetDepth = 0;
function openSheet(ctx, html){
  currentSheet = ctx; $('#sheetBody').innerHTML = html; $('#sheet').classList.remove('hidden');
  $('#sheet .sheet-inner').scrollTop = 0;
  const h = '#'+ctx.kind+'/'+encodeURIComponent(ctx.ref);
  if(location.hash !== h){ history.pushState({sheet:1}, '', h); sheetDepth++; }
}
function closeSheet(fromPop){
  $('#sheet').classList.add('hidden'); currentSheet=null;
  if(fromPop) return;
  if(sheetDepth>0){ const n=sheetDepth; sheetDepth=0; history.go(-n); }
  else if(location.hash) history.replaceState(null,'',location.pathname);
}
$('#sheetClose').onclick = ()=>closeSheet();
$('#sheet').onclick = e => { if(e.target.id==='sheet') closeSheet(); };
window.addEventListener('popstate', ()=>{ sheetDepth=Math.max(0,sheetDepth-1);
  if(!location.hash){ sheetDepth=0; if(currentSheet) closeSheet(true); } else routeHash(); });
function routeHash(){ // opens the sheet named in the URL
  const [k, r] = location.hash.slice(1).split('/'); if(!r) return;
  const ref = decodeURIComponent(r);
  if(k==='marker') openMarker(ref); else if(k==='courthouse') openCourt(ref); else if(k==='county') openCounty(ref);
}

function logControls(kind, ref, lat, lng){
  const l = getLog(kind, ref) || {};
  const nav = lat!=null ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` : null;
  return `
  <div class="actions">
    <button class="btn ${l.visited?'on':''}" data-act="visited">${l.visited?'✓ Visited':'Mark visited'}</button>
    <button class="btn lead ${l.story_lead?'on':''}" data-act="lead">✎ Story lead</button>
    <button class="btn want ${l.want?'on':''}" data-act="want">${l.want?'★ Want to visit':'☆ Want to visit'}</button>
    ${nav?`<a class="btn" href="${nav}" target="_blank" rel="noopener">➜ Navigate</a>`:''}
  </div><!--split-->
  <div class="card">
    <div class="row between wrap"><b>My visit</b><span class="muted">${l.gps_lat!=null?`My GPS spot: ${l.gps_lat.toFixed(5)}, ${l.gps_lng.toFixed(5)}`:''}</span></div>
    <label class="muted">Date visited</label><input type="date" id="fDate" value="${esc(l.visited_on||'')}">
    <label class="muted">Notes</label><textarea id="fNotes" placeholder="What did you notice? Who'd you talk to?">${esc(l.notes||'')}</textarea>
    <div id="leadBox" class="${l.story_lead?'':'hidden'}"><label class="muted">Why it could be a story</label>
      <textarea id="fLead" placeholder="The hook…">${esc(l.story_note||'')}</textarea></div>
    <div class="actions">
      <button class="btn primary" data-act="save">Save notes</button>
      <button class="btn" data-act="gps">📍 Save my GPS spot</button>
    </div>
    <div class="row between"><b>Photos</b><span><button class="btn small" data-act="cam">📷 Take</button> <button class="btn small" data-act="pick">🖼 Add</button></span></div>
    <div class="photos" id="photoGrid"></div>
  </div>`;
}
function bindLogControls(kind, ref){
  const body = $('#sheetBody');
  body.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
    const a = b.dataset.act, l = getLog(kind, ref) || {};
    if(a==='visited'){ const v=!l.visited; await saveLog(kind, ref, { visited:v, visited_on: v ? (l.visited_on || $('#fDate').value || today()) : l.visited_on });
      toast(v?'Checked off! 🎉':'Unchecked'); reopen(kind, ref); }
    if(a==='lead'){ await saveLog(kind, ref, { story_lead:!l.story_lead }); reopen(kind, ref); }
    if(a==='want'){ await saveLog(kind, ref, { want:!l.want }); reopen(kind, ref); }
    if(a==='save'){ await saveLog(kind, ref, { notes:$('#fNotes').value, visited_on:$('#fDate').value||null,
        story_note: $('#fLead') ? $('#fLead').value : l.story_note }); toast('Saved'); }
    if(a==='gps'){ try{ const me=await locate(); await saveLog(kind, ref, { gps_lat:me.lat, gps_lng:me.lng });
        toast(`GPS spot saved (±${Math.round(me.acc*3.28)} ft)`); reopen(kind, ref); } catch{ toast('Could not get GPS — check location permission.'); } }
    if(a==='cam' || a==='pick'){ const inp = a==='cam' ? $('#photoInput') : $('#photoPick');
      inp.value=''; inp.onchange = ()=>{ if(inp.files.length) addPhotos(kind, ref, [...inp.files]).then(()=>renderPhotos(kind, ref)); }; inp.click(); }
  });
  renderPhotos(kind, ref);
}
function reopen(kind, ref){
  const y = $('#sheet .sheet-inner').scrollTop;
  const draft = { notes:$('#fNotes')?.value, lead:$('#fLead')?.value, date:$('#fDate')?.value };
  kind==='marker' ? openMarker(ref, true) : openCourt(ref, true);
  if(draft.notes!=null) $('#fNotes').value = draft.notes;
  if(draft.lead!=null && $('#fLead')) $('#fLead').value = draft.lead;
  if(draft.date && !$('#fDate').value) $('#fDate').value = draft.date;
  requestAnimationFrame(()=>$('#sheet .sheet-inner').scrollTop = y);
}

function splitControls(kind, ref, lat, lng){ const [a,b] = logControls(kind, ref, lat, lng).split('<!--split-->'); return {actions:a, card:b}; }
async function openMarker(atlas, replace){
  const m = S.byAtlas.get(String(atlas)); if(!m) return;
  const head = `
    <h2>${esc(m.name)}</h2>
    <div class="kv">${badges(m)}</div>
    <div class="kv"><b>${esc([m.city, m.county && m.county+' County'].filter(Boolean).join(', '))}</b>${m.year?` · placed ${m.year}`:''}${m.num?` · Marker #${esc(m.num)}`:''}</div>
    ${S.me && m.lat!=null ? `<div class="kv">${fmtMi(dist(S.me.lat,S.me.lng,m.lat,m.lng))} from you</div>`:''}
    __ACTIONS__
    <div id="mText"><div class="plaque empty">Loading marker text…</div></div>__CARD__`;
  const ctl = splitControls('marker', m.atlas, m.lat, m.lng);
  const html = head.replace('__ACTIONS__', ctl.actions).replace('__CARD__', ctl.card);
  if(replace){ $('#sheetBody').innerHTML = html; currentSheet={kind:'marker',ref:m.atlas}; }
  else openSheet({ kind:'marker', ref:m.atlas }, html);
  bindLogControls('marker', m.atlas);
  const t = await markerText(m);
  if(currentSheet?.ref !== m.atlas) return;
  const extra = t ? [
    t.ld && `<div class="kv"><b>Location:</b> ${esc(t.ld)}</div>`,
    t.ad && `<div class="kv"><b>Address:</b> ${esc(t.ad)}</div>`,
    t.tp && `<div class="kv"><b>Topics:</b> ${esc(t.tp)}</div>`,
    (t.sz||t.cd) && `<div class="kv"><b>Marker:</b> ${esc([t.sz,t.cd].filter(Boolean).join(' · '))}${t.pp?' · on private property':''}</div>`
  ].filter(Boolean).join('') : '';
  const plaque = t?.t ? `<div class="plaque">${esc(t.t)}</div>`
    : `<div class="plaque empty"><b>No inscription on file.</b> THC's record has no text for this marker — a true Little-Known Texas mystery. Snap a photo of the plaque when you find it.</div>`;
  const nopin = m.lat==null ? `<div class="card"><b>No map pin.</b> THC doesn't have GPS for this one. If you find it, tap “Save my GPS spot.”</div>` : '';
  $('#mText').innerHTML = nopin + extra + plaque +
    `<div class="kv"><a href="https://atlas.thc.texas.gov/Details/${esc(m.atlas)}" target="_blank" rel="noopener">View on THC Atlas ↗</a></div>`;
}

function openCourt(id, replace){
  const c = S.courtById.get(String(id)); if(!c) return;
  const others = (S.courtsByCounty.get(c.county)||[]).length;
  const rows = [['Built',c.built],['In service',c.dates],['Status',c.use],['Architect',c.architect],['Builder',c.contractor],
    ['Style',c.style],['Address',c.address],['Changes',c.mods]].filter(r=>r[1]).map(r=>`<div class="kv"><b>${r[0]}:</b> ${esc(r[1])}</div>`).join('');
  const html = `
    <h2>⚖ ${esc(c.title)}</h2>
    <div class="kv">${c.current?'<span class="badge b-c">current courthouse</span>':''}${c.rthl?'<span class="badge b-c">Texas Landmark</span>':''}${c.nr?'<span class="badge b-c">National Register</span>':''}</div>
    ${S.me && c.lat ? `<div class="kv">${fmtMi(dist(S.me.lat,S.me.lng,c.lat,c.lng))} from you</div>`:''}
    ${rows}
    ${c.desc?`<div class="card">${esc(c.desc)}</div>`:''}
    <button class="btn small" id="toCounty">See all ${others} ${esc(c.county)} County courthouses</button>
    ${c.lat ? logControls('courthouse', c.id, c.lat, c.lng) : `<div class="card">This courthouse has no map pin${/gone|demolish|burn/i.test(c.use)?' — it\'s gone':''}. You can still flag it as a story lead:</div>
      <div class="actions"><button class="btn lead ${getLog('courthouse',c.id)?.story_lead?'on':''}" data-act="lead">✎ Story lead</button></div>
      <div id="leadBox" class="${getLog('courthouse',c.id)?.story_lead?'':'hidden'}"><textarea id="fLead" placeholder="The hook…">${esc(getLog('courthouse',c.id)?.story_note||'')}</textarea>
      <textarea id="fNotes" class="hidden"></textarea><input type="date" id="fDate" class="hidden"><button class="btn primary" data-act="save">Save</button></div><div id="photoGrid" class="hidden"></div>`}
    <div class="kv"><a href="https://atlas.thc.texas.gov/Details/${esc(c.id)}" target="_blank" rel="noopener">View on THC Atlas ↗</a></div>`;
  if(replace){ $('#sheetBody').innerHTML = html; currentSheet={kind:'courthouse',ref:c.id}; }
  else openSheet({ kind:'courthouse', ref:c.id }, html);
  $('#toCounty').onclick = ()=>openCounty(c.county);
  bindLogControls('courthouse', c.id);
}

// ---------- leads & stats ----------
function itemFor(l){
  if(l.kind==='marker'){ const m=S.byAtlas.get(l.ref); return m && { title:m.name, sub:[m.city, m.county&&m.county+' Co.'].filter(Boolean).join(' · '), attr:`data-a="${esc(m.atlas)}"`, m }; }
  const c=S.courtById.get(l.ref); return c && { title:'⚖ '+c.title, sub:c.city, attr:`data-c="${esc(c.id)}"` };
}
function renderLeads(){
  const logs=[...S.logs.values()];
  const leads = logs.filter(l=>l.story_lead).sort((a,b)=>(b.updated_at||'').localeCompare(a.updated_at||''));
  $('#leadList').innerHTML = leads.map(l=>{ const it=itemFor(l); if(!it) return '';
    return `<li ${it.attr}><div class="main"><div class="t">${esc(it.title)}</div><div class="s">${esc(it.sub)}</div>
      ${l.story_note?`<div class="s" style="color:var(--ink)">“${esc(l.story_note)}”</div>`:''}</div></li>`; }).join('')
    || '<li class="muted" style="cursor:default">No story leads yet. Tap ✎ on any marker or courthouse.</li>';
  const want = logs.filter(l=>l.want && !l.visited);
  $('#wantList').innerHTML = want.map(l=>{ const it=itemFor(l); return it ? (it.m ? markerLi(it.m) : `<li ${it.attr}><div class="main"><div class="t">${esc(it.title)}</div><div class="s">${esc(it.sub)}</div></div></li>`) : ''; }).join('')
    || '<li class="muted" style="cursor:default">Nothing on your list yet.</li>';
}
async function exportLeads(){
  const leads=[...S.logs.values()].filter(l=>l.story_lead);
  if(!leads.length) return toast('No story leads to export yet.');
  let md = `# Little-Known Texas — Story Leads\n_Exported ${new Date().toLocaleDateString()} · Marker data courtesy of the Texas Historical Commission_\n\n`;
  for(const l of leads){
    if(l.kind==='marker'){ const m=S.byAtlas.get(l.ref); if(!m) continue; const t=await markerText(m);
      md += `## ${m.name}\n**${[m.city, m.county&&m.county+' County'].filter(Boolean).join(', ')}** · Marker #${m.num}${m.year?' · placed '+m.year:''}\n\n`;
      if(l.story_note) md += `**Why it's a story:** ${l.story_note}\n\n`;
      if(l.notes) md += `**My notes:** ${l.notes}\n\n`;
      if(l.visited_on) md += `Visited ${l.visited_on}\n\n`;
      md += t?.t ? `> ${t.t.replace(/\n+/g,'\n> ')}\n\n` : `> _(No inscription on file with THC.)_\n\n`;
      md += `THC Atlas: https://atlas.thc.texas.gov/Details/${m.atlas}\n\n---\n\n`;
    } else { const c=S.courtById.get(l.ref); if(!c) continue;
      md += `## ${c.title}\n**${c.county} County**${c.use?' · '+c.use:''}\n\n`;
      if(l.story_note) md += `**Why it's a story:** ${l.story_note}\n\n`;
      if(l.notes) md += `**My notes:** ${l.notes}\n\n`;
      if(c.desc) md += `${c.desc}\n\n`; if(c.mods) md += `Changes: ${c.mods}\n\n`;
      md += `---\n\n`; }
  }
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([md],{type:'text/markdown'}));
  a.download=`little-known-texas-leads-${today()}.md`; a.click(); toast('Story leads exported');
}
function renderStats(){
  const logs=[...S.logs.values()];
  const vm = logs.filter(l=>l.kind==='marker' && l.visited).map(l=>S.byAtlas.get(l.ref)).filter(Boolean);
  const total = new Map(); S.markers.forEach(m=>{ if(m.county) total.set(m.county,(total.get(m.county)||0)+1); });
  const seen = new Map(); vm.forEach(m=>{ if(m.county) seen.set(m.county,(seen.get(m.county)||0)+1); });
  const courtsDone = [...S.courtsByCounty.keys()].filter(countyDone).length;
  const leads = logs.filter(l=>l.story_lead).length, photos = logs.reduce((n,l)=>n+(l.photos?.length||0),0);
  const mysteries = vm.filter(m=>m.flags&F.NOTEXT).length, cent = vm.filter(m=>m.flags&F.CENT).length;
  const rows = [...seen.keys()].map(c=>[c, seen.get(c), total.get(c)]).sort((a,b)=>b[1]/b[2]-a[1]/a[2]);
  const complete = rows.filter(r=>r[1]>=r[2]).map(r=>r[0]);
  $('#statsBody').innerHTML = `
    <h2>Your Texas</h2>
    <div class="statgrid">
      <div class="stat"><div class="n">${vm.length.toLocaleString()}</div><div class="l">markers seen of ${S.markers.length.toLocaleString()}</div></div>
      <div class="stat"><div class="n">${seen.size}</div><div class="l">counties with a marker seen (of 254)</div></div>
      <div class="stat"><div class="n">${courtsDone}</div><div class="l">county courthouses seen (of 254)</div></div>
      <div class="stat"><div class="n">${leads}</div><div class="l">story leads</div></div>
      <div class="stat"><div class="n">${mysteries}</div><div class="l">mystery markers found</div></div>
      <div class="stat"><div class="n">${photos}</div><div class="l">photos</div></div>
    </div>
    <h3>Badges</h3>
    <div class="card">${[
      courtsDone>=254 && '🏛 Courthouse Champion — all 254!',
      courtsDone>=100 && '⚖ 100 Courthouses',
      courtsDone>=25 && '⚖ 25 Courthouses',
      cent>=10 && '🎖 Centennial Hunter — 10 1936 markers',
      mysteries>=1 && '🔎 Mystery Solver',
      vm.length>=1000 && '🌟 1,000 markers', vm.length>=100 && '⭐ 100 markers', vm.length>=1 && '📍 First marker',
      ...complete.map(c=>`🏆 Every marker in ${c} County`)
    ].filter(Boolean).join('<br>') || '<span class="muted">Badges show up here as you go — like “Every marker in Mason County.”</span>'}</div>
    <h3>County progress</h3>
    ${rows.length ? rows.map(([c,s,t])=>`<div class="card" style="padding:8px 12px"><div class="row between"><b>${esc(c)}</b><span class="muted">${s} / ${t} · ${Math.round(s/t*100)}%</span></div><div class="bar"><i style="width:${Math.min(100,s/t*100)}%"></i></div></div>`).join('')
      : '<p class="muted">Check off your first marker to start filling in the map.</p>'}
    <div class="about">Marker and courthouse data courtesy of the <b>Texas Historical Commission</b>, Texas Historic Sites Atlas (atlas.thc.texas.gov). THC makes no guarantee of the data's accuracy — some pins may be off, so trust the location description. Map © OpenStreetMap contributors.<br><br>
      Signed in as ${esc(S.user?.email||'')} · <a href="#" id="signOut">Sign out</a></div>`;
  $('#signOut').onclick = async e => { e.preventDefault(); await sb.auth.signOut(); localStorage.removeItem(CACHE_KEY); location.reload(); };
}

// ---------- navigation ----------
function show(view){
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active', v.id==='view-'+view));
  document.querySelectorAll('.tabbar button').forEach(b=>b.classList.toggle('active', b.dataset.view===view));
  if(view==='map') setTimeout(()=>map.invalidateSize(), 50);
  if(view==='near') renderNear(false);
  if(view==='search') renderSearch();
  if(view==='court') renderCourts();
  if(view==='leads') renderLeads();
  if(view==='stats') renderStats();
}
document.querySelector('.tabbar').onclick = e => { const b=e.target.closest('button'); if(b) show(b.dataset.view); };

// ---------- startup ----------
async function startApp(){
  $('#login').classList.add('hidden');
  updateSync();
  await loadData();
  await loadLogs();
  initMap();
  chipBar($('#nearChips'), nearState, ()=>renderNear(false), ['nopin']);
  chipBar($('#searchChips'), searchState, renderSearch);
  bindList($('#nearList')); bindList($('#searchList')); bindList($('#courtList')); bindList($('#leadList')); bindList($('#wantList'));
  let t; $('#q').oninput = ()=>{ clearTimeout(t); t=setTimeout(renderSearch,180); };
  $('#qCounty').onchange = renderSearch;
  $('#courtQ').oninput = renderCourts;
  $('#btnRefreshNear').onclick = ()=>renderNear(true);
  $('#btnExport').onclick = exportLeads;
  locate().then(showMe).catch(()=>{});
  photoQueueCount = (await idbAll()).length;
  flush();
  if(location.hash) routeHash();
}
async function boot(){
  const { data:{ session } } = await sb.auth.getSession();
  if(session){ S.user = session.user; return startApp(); }
  $('#login').classList.remove('hidden');
  $('#loginBtn').onclick = async ()=>{
    $('#loginMsg').textContent='Signing in…';
    const { data, error } = await sb.auth.signInWithPassword({ email:$('#loginEmail').value.trim(), password:$('#loginPass').value });
    if(error){ $('#loginMsg').textContent = error.message; return; }
    S.user = data.user; startApp();
  };
}
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
boot();
