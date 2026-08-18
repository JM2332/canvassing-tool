/* KML Foodservice - Canvassing Planner
   Pure client-side app. Data sources: postcodes.io (UK geocoding) + Overpass API (OpenStreetMap).
   Rep's edits (status/notes/route selection) sync via Firebase (Firestore + Auth) across devices,
   with a localStorage copy kept as an offline/instant-load cache. */

const firebaseConfig = {
  apiKey: "AIzaSyDAwAD42x5KhPK3lKdEHIizR5rAFR134M4",
  authDomain: "canvassing-tool.firebaseapp.com",
  projectId: "canvassing-tool",
  storageBucket: "canvassing-tool.firebasestorage.app",
  messagingSenderId: "66824555279",
  appId: "1:66824555279:web:5229bbf2f200396cf28c7a"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const SHARED_LOGIN_EMAIL = 'jacob@kmlfoodservice.internal';

const CATEGORIES = {
  restaurant: { label: 'Restaurant',  color: '#e63946', tags: [['amenity', 'restaurant']] },
  fast_food:  { label: 'Fast Food',   color: '#f77f00', tags: [['amenity', 'fast_food']] },
  cafe:       { label: 'Cafe',        color: '#f4a261', tags: [['amenity', 'cafe']] },
  bar_pub:    { label: 'Bar / Pub',   color: '#8338ec', tags: [['amenity', 'bar'], ['amenity', 'pub'], ['amenity', 'nightclub']] },
  hotel:      { label: 'Hotel / B&B', color: '#2a9d8f', tags: [['tourism', 'hotel'], ['tourism', 'guest_house'], ['tourism', 'motel']] },
};

// Substrings matched against a venue's name/brand/operator (lowercased) to flag it as a
// national chain/group. Chains typically buy via centralized supply contracts rather than
// a local rep's pitch, so they're hidden by default (toggle-able in the UI).
const CHAIN_MATCHERS = [
  // fast food / QSR
  'mcdonald', 'burger king', 'kfc', 'kentucky fried chicken', 'subway', 'greggs', 'taco bell',
  'five guys', 'domino', 'pizza hut', 'papa john', 'chicken cottage',
  // coffee / cafe chains
  'costa coffee', 'costa ', 'starbucks', 'caffe nero', 'caffè nero', 'pret a manger', 'pret ',
  'coffee#1', 'coffee republic',
  // casual dining chains
  "nando's", 'nandos', 'tgi friday', 'harvester', 'toby carvery', 'beefeater', 'brewers fayre',
  'frankie & benny', 'frankie and benny', 'pizza express', 'pizzaexpress', 'zizzi', 'bella italia',
  'wagamama', 'chiquito', 'la tasca', 'prezzo', 'ask italian', 'côte brasserie', 'cote brasserie',
  'gourmet burger kitchen', ' gbk', 'byron', 'wahaca', 'yo! sushi', 'yo sushi', 'leon ', 'itsu',
  'wildwood', "ed's diner", 'hard rock cafe', 'planet hollywood',
  // pub / bar operator groups (often only in brand/operator tag, not the venue name)
  'j d wetherspoon', 'jd wetherspoon', 'wetherspoon', 'greene king', 'chef & brewer', 'chef and brewer',
  'hungry horse', 'farmhouse inn', 'flaming grill', 'sizzling pubs', "marston's", 'marstons',
  'mitchells & butlers', 'mitchells and butlers', 'all bar one', "o'neill", 'miller & carter',
  'miller and carter', 'vintage inn', 'stonegate', 'slug and lettuce', 'be at one', 'revolution bars',
  'ember inns', 'crown carveries', 'brewdog',
  // hotel groups
  'premier inn', 'travelodge', 'holiday inn', 'intercontinental', 'marriott', 'hilton', 'ibis ',
  'accor', 'best western', 'novotel', 'mercure', 'whitbread', 'jurys inn', 'doubletree',
  'crowne plaza', 'ramada', 'days inn', 'park inn', 'radisson', 'campanile', 'village hotel',
  'macdonald hotels',
];

function isChain(v) {
  const haystack = `${v.name} ${v.brand} ${v.operator}`.toLowerCase();
  return CHAIN_MATCHERS.some(m => haystack.includes(m));
}

const STATUS_OPTIONS = ['Not contacted', 'Contacted', 'Interested', 'Not interested', 'Customer'];
const STATUS_COLORS = {
  'Not contacted': '#95a5a6',
  'Contacted': '#3498db',
  'Interested': '#e9c46a',
  'Not interested': '#7f8c8d',
  'Customer': '#1e8449',
};

const CACHE_KEY = 'canvass_cache_v1';
const OVERRIDES_KEY = 'canvass_overrides_v1';
const SAVED_ROUTES_KEY = 'canvass_saved_routes_v1';
const LAST_ROUTE_KEY = 'canvass_last_route_v1';
const MANUAL_VENUES_KEY = 'canvass_manual_venues_v1';

let venues = [];          // raw venue objects from last load
let overrides = loadOverrides();
let map, markerCluster;
let markerById = new Map();
let selectedRoute = new Set();
let activeTypes = new Set(Object.keys(CATEGORIES));
let searchTerm = '';
let statusFilter = '';
let hideNotInterested = false;
let showChains = false;
let priorityOnly = false;
let needsFollowup = false;
let visitedFilter = '';
let centerPoint = null;
let lastRouteOrder = [];
let visitedToday = new Set();
loadLastRouteCache();
let savedRoutes = loadSavedRoutesCache();
let manualVenues = loadManualVenuesCache();

const FOLLOWUP_DAYS = 14;

// ---------- persistence ----------

function loadOverrides() {
  try { return JSON.parse(localStorage.getItem(OVERRIDES_KEY)) || {}; }
  catch (e) { return {}; }
}
function saveOverrides() {
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
}
function getOverride(id) {
  return overrides[id] || { status: 'Not contacted', notes: '', lastVisited: '', priority: false };
}
function setOverride(id, patch) {
  overrides[id] = Object.assign({}, getOverride(id), patch);
  saveOverrides();
  syncOverrideToCloud(id, overrides[id]);
}

// ---------- cloud sync (Firestore) ----------

function firestoreDocId(venueId) {
  return venueId.replace('/', '_');
}

function syncOverrideToCloud(id, data) {
  if (!auth.currentUser) return;
  db.collection('overrides').doc(firestoreDocId(id)).set(
    Object.assign({}, data, { venueId: id, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
  ).catch(err => console.error('Cloud sync failed for', id, err));
}

let unsubscribeOverrides = null;

function subscribeOverrides() {
  if (unsubscribeOverrides) unsubscribeOverrides();
  unsubscribeOverrides = db.collection('overrides').onSnapshot(snapshot => {
    /* updatedAt (serverTimestamp()) resolves from a pending local value to
       the real one moments after every write — a genuine field change, so
       this fires a second time for data that's otherwise identical. A full
       renderAll() on that spurious echo is disruptive for no reason, so
       only re-render when something actually shown changed. */
    let changed = false;
    snapshot.docChanges().forEach(change => {
      const data = change.doc.data();
      if (!data.venueId) return;
      if (change.type === 'removed') {
        if (overrides[data.venueId]) { delete overrides[data.venueId]; changed = true; }
        return;
      }
      const next = {
        status: data.status || 'Not contacted',
        notes: data.notes || '',
        lastVisited: data.lastVisited || '',
        priority: !!data.priority,
      };
      const prev = overrides[data.venueId];
      if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
      overrides[data.venueId] = next;
      changed = true;
    });
    if (!changed) return;
    saveOverrides();
    renderAll();
  }, err => console.error('Overrides subscription failed', err));
}

function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)); }
  catch (e) { return null; }
}
function saveCache(payload) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
}

function loadLastRouteCache() {
  try {
    const data = JSON.parse(localStorage.getItem(LAST_ROUTE_KEY));
    if (!data) return;
    lastRouteOrder = data.order || [];
    visitedToday = new Set(data.visited || []);
  } catch (e) { /* ignore */ }
}
function saveLastRouteCache() {
  localStorage.setItem(LAST_ROUTE_KEY, JSON.stringify({ order: lastRouteOrder, visited: Array.from(visitedToday) }));
}

// ---------- saved routes (Firestore) ----------

function loadSavedRoutesCache() {
  try { return JSON.parse(localStorage.getItem(SAVED_ROUTES_KEY)) || []; }
  catch (e) { return []; }
}
function saveSavedRoutesCache() {
  localStorage.setItem(SAVED_ROUTES_KEY, JSON.stringify(savedRoutes));
}

let unsubscribeSavedRoutes = null;

function subscribeSavedRoutes() {
  if (unsubscribeSavedRoutes) unsubscribeSavedRoutes();
  unsubscribeSavedRoutes = db.collection('routes').orderBy('createdAt', 'desc').onSnapshot(snapshot => {
    const next = snapshot.docs.map(doc => Object.assign({ id: doc.id }, doc.data()));
    /* Same createdAt-resolution echo as subscribeOverrides above — compare
       only the fields the list actually renders, excluding createdAt
       itself (the one field guaranteed to differ on the echo), so that
       spurious second fire doesn't re-render the list for nothing. */
    const strip = r => JSON.stringify({ id: r.id, name: r.name, stops: r.stops });
    const same = savedRoutes.length === next.length &&
      savedRoutes.every((r, i) => strip(r) === strip(next[i]));
    savedRoutes = next;
    saveSavedRoutesCache();
    if (same) return;
    renderSavedRoutesList();
  }, err => console.error('Saved routes subscription failed', err));
}

async function saveCurrentSelectionAsRoute(name) {
  if (!auth.currentUser) return;
  const stops = venues.filter(v => selectedRoute.has(v.id));
  await db.collection('routes').add({
    name,
    stops,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

async function deleteSavedRoute(routeId) {
  if (!auth.currentUser) return;
  await db.collection('routes').doc(routeId).delete();
}

// ---------- manual venues (Firestore) ----------

function loadManualVenuesCache() {
  try { return JSON.parse(localStorage.getItem(MANUAL_VENUES_KEY)) || []; }
  catch (e) { return []; }
}
function saveManualVenuesCache() {
  localStorage.setItem(MANUAL_VENUES_KEY, JSON.stringify(manualVenues));
}

let unsubscribeManualVenues = null;

function subscribeManualVenues() {
  if (unsubscribeManualVenues) unsubscribeManualVenues();
  unsubscribeManualVenues = db.collection('manualVenues').onSnapshot(snapshot => {
    manualVenues = snapshot.docs.map(doc => doc.data());
    saveManualVenuesCache();
    venues = mergeManualVenues(venues.filter(v => !v.id.startsWith('manual/')));
    renderAll();
  }, err => console.error('Manual venues subscription failed', err));
}

function mergeManualVenues(baseVenues) {
  const baseIds = new Set(baseVenues.map(v => v.id));
  const extra = manualVenues
    .filter(v => !baseIds.has(v.id))
    .map(v => Object.assign({}, v, {
      distance: centerPoint ? haversineMiles(centerPoint.lat, centerPoint.lon, v.lat, v.lon) : (v.distance || 0),
    }));
  return baseVenues.concat(extra);
}

async function addManualVenue({ name, category, address, lat, lon }) {
  if (!auth.currentUser) return;
  const id = `manual/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const venue = {
    id, name, category, lat, lon,
    address: address || '', brand: '', operator: '', phone: '', website: '', opening_hours: '',
  };
  await db.collection('manualVenues').doc(firestoreDocId(id)).set(venue);
  return venue;
}

async function deleteManualVenue(id) {
  if (!auth.currentUser) return;
  await db.collection('manualVenues').doc(firestoreDocId(id)).delete();
}

// ---------- geo helpers ----------

function milesToMeters(mi) { return mi * 1609.34; }

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bboxFromCenter(lat, lon, radiusMiles) {
  const radiusM = milesToMeters(radiusMiles);
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  return { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon };
}

// ---------- geocoding ----------

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${new URL(url).hostname}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function geocodePostcode(query) {
  const clean = query.trim().replace(/\s+/g, '');
  const res = await fetchWithTimeout(`https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`, {}, 15000);
  if (res.ok) {
    const data = await res.json();
    if (data.result) return { lat: data.result.latitude, lon: data.result.longitude, label: data.result.postcode };
  }
  // fall back to a general place-name search (Nominatim) if it wasn't a valid postcode
  const nomRes = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb&q=${encodeURIComponent(query)}`, {}, 15000);
  const nomData = await nomRes.json();
  if (nomData && nomData[0]) {
    return { lat: parseFloat(nomData[0].lat), lon: parseFloat(nomData[0].lon), label: nomData[0].display_name };
  }
  throw new Error('Could not find that postcode or place.');
}

// ---------- overpass ----------

function buildOverpassQuery(bbox) {
  const lines = [];
  for (const key in CATEGORIES) {
    for (const [k, v] of CATEGORIES[key].tags) {
      lines.push(`  node["${k}"="${v}"];`);
      lines.push(`  way["${k}"="${v}"];`);
    }
  }
  return `[out:json][timeout:90][bbox:${bbox.south},${bbox.west},${bbox.north},${bbox.east}];\n(\n${lines.join('\n')}\n);\nout center tags;`;
}

function categoryFor(tags) {
  for (const key in CATEGORIES) {
    for (const [k, v] of CATEGORIES[key].tags) {
      if (tags[k] === v) return key;
    }
  }
  return null;
}

function elementToVenue(el, center) {
  const tags = el.tags || {};
  const lat = el.lat !== undefined ? el.lat : (el.center ? el.center.lat : null);
  const lon = el.lon !== undefined ? el.lon : (el.center ? el.center.lon : null);
  if (lat === null || lon === null) return null;
  const category = categoryFor(tags);
  if (!category) return null;

  const addrParts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:city'] || tags['addr:town'],
    tags['addr:postcode'],
  ].filter(Boolean);

  return {
    id: `${el.type}/${el.id}`,
    name: tags.name || tags.brand || 'Unnamed venue',
    brand: tags.brand || '',
    operator: tags.operator || '',
    category,
    lat, lon,
    address: addrParts.join(', '),
    phone: tags.phone || tags['contact:phone'] || '',
    website: tags.website || tags['contact:website'] || '',
    opening_hours: tags.opening_hours || '',
    distance: haversineMiles(center.lat, center.lon, lat, lon),
  };
}

async function fetchVenues(center, radiusMiles) {
  const bbox = bboxFromCenter(center.lat, center.lon, radiusMiles);
  const query = buildOverpassQuery(bbox);
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  let lastErr;
  for (const url of endpoints) {
    try {
      setStatus(`Querying ${new URL(url).hostname}… (this can take up to a minute for large radii)`);
      const res = await fetchWithTimeout(url, { method: 'POST', body: 'data=' + encodeURIComponent(query) }, 75000);
      if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
      const data = await res.json();
      const out = [];
      const seen = new Set();
      for (const el of data.elements) {
        const v = elementToVenue(el, center);
        if (!v) continue;
        if (v.distance > radiusMiles) continue;
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        out.push(v);
      }
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Could not reach Overpass API');
}

// ---------- map ----------

function initMap() {
  map = L.map('map').setView([53.55, -1.48], 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  markerCluster = L.markerClusterGroup();
  map.addLayer(markerCluster);
}

function iconFor(venue) {
  const ov = getOverride(venue.id);
  const color = CATEGORIES[venue.category].color;
  let cls = 'venue-marker';
  if (ov.status === 'Not interested') cls += ' not-interested';
  if (ov.status === 'Customer') cls += ' customer';
  if (ov.priority) cls += ' priority';
  return L.divIcon({
    className: '',
    html: `<div class="${cls}" style="background:${color};width:16px;height:16px;"></div>`,
    iconSize: [16, 16],
  });
}

function rebuildMarkers(list) {
  markerCluster.clearLayers();
  markerById.clear();
  list.forEach(v => {
    const m = L.marker([v.lat, v.lon], { icon: iconFor(v) });
    m.on('click', () => openDetail(v.id));
    markerById.set(v.id, m);
    markerCluster.addLayer(m);
  });
}

// ---------- filtering ----------

function filteredVenues() {
  const term = searchTerm.trim().toLowerCase();
  return venues.filter(v => {
    if (!activeTypes.has(v.category)) return false;
    if (!showChains && isChain(v)) return false;
    const ov = getOverride(v.id);
    if (statusFilter && ov.status !== statusFilter) return false;
    if (hideNotInterested && ov.status === 'Not interested') return false;
    if (priorityOnly && !ov.priority) return false;
    if (visitedFilter) {
      const days = ov.lastVisited ? (Date.now() - new Date(ov.lastVisited).getTime()) / 86400000 : Infinity;
      if (visitedFilter === 'last7' && !(days <= 7)) return false;
      if (visitedFilter === 'last30' && !(days <= 30)) return false;
      if (visitedFilter === 'stale30' && !(ov.lastVisited && days > 30)) return false;
    }
    if (needsFollowup) {
      if (ov.status !== 'Interested') return false;
      const days = ov.lastVisited ? (Date.now() - new Date(ov.lastVisited).getTime()) / 86400000 : Infinity;
      if (days < FOLLOWUP_DAYS) return false;
    }
    if (term && !(v.name.toLowerCase().includes(term) || v.address.toLowerCase().includes(term))) return false;
    return true;
  }).sort((a, b) => a.distance - b.distance);
}

// ---------- rendering ----------

function renderTypeFilters() {
  const container = document.getElementById('type-filters');
  container.innerHTML = '';
  Object.entries(CATEGORIES).forEach(([key, cfg]) => {
    const chip = document.createElement('div');
    chip.className = 'type-chip' + (activeTypes.has(key) ? '' : ' off');
    chip.innerHTML = `<span class="dot" style="background:${cfg.color}"></span>${cfg.label}`;
    chip.onclick = () => {
      if (activeTypes.has(key)) activeTypes.delete(key); else activeTypes.add(key);
      chip.classList.toggle('off');
      renderAll();
    };
    container.appendChild(chip);
  });
}

function renderStatusFilterOptions() {
  const sel = document.getElementById('status-filter');
  sel.innerHTML = '<option value="">All statuses</option>' +
    STATUS_OPTIONS.map(s => `<option value="${s}">${s}</option>`).join('');
  sel.value = statusFilter;
}

const LIST_RENDER_CAP = 300;

function renderList() {
  const list = filteredVenues();
  const container = document.getElementById('venue-list');
  container.innerHTML = '';
  const frag = document.createDocumentFragment();
  const shown = list.slice(0, LIST_RENDER_CAP);
  shown.forEach(v => {
    const ov = getOverride(v.id);
    const row = document.createElement('div');
    row.className = 'venue-row';
    row.innerHTML = `
      <input type="checkbox" ${selectedRoute.has(v.id) ? 'checked' : ''}>
      <div class="vr-main">
        <div class="vr-name">${ov.priority ? '<span class="priority-star" title="Priority lead">★</span>' : ''}${escapeHtml(v.name)}</div>
        <div class="vr-addr">${escapeHtml(v.address || 'No address on record')}</div>
        <div class="vr-meta">
          <span class="pill" style="${pillStyle(CATEGORIES[v.category].color)}">${CATEGORIES[v.category].label}</span>
          <span class="pill" style="${pillStyle(STATUS_COLORS[ov.status])}">${ov.status}</span>
          ${isChain(v) ? `<span class="pill" style="${pillStyle('#22231F')}">Chain</span>` : ''}
          ${v.id.startsWith('manual/') ? `<span class="pill" style="${pillStyle('#7A8B5E')}">Manually added</span>` : ''}
          <span class="dist">${v.distance.toFixed(1)} mi</span>
        </div>
      </div>`;
    row.querySelector('input').addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.checked) selectedRoute.add(v.id); else selectedRoute.delete(v.id);
      updateRouteBar();
    });
    row.addEventListener('click', () => openDetail(v.id));
    frag.appendChild(row);
  });
  container.appendChild(frag);
  let summary = list.length > LIST_RENDER_CAP
    ? `${list.length} venues match (nearest ${LIST_RENDER_CAP} listed — narrow with filters/search to see the rest). All matches are pinned on the map.`
    : `${list.length} of ${venues.length} venues shown`;
  if (!showChains) {
    const chainCount = venues.filter(v => activeTypes.has(v.category) && isChain(v)).length;
    if (chainCount > 0) summary += ` (${chainCount} chain venues hidden)`;
  }
  document.getElementById('results-summary').textContent = summary;
  rebuildMarkers(list);
}

function renderAll() {
  renderList();
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pillStyle(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `background:rgba(${r},${g},${b},.15);color:${hex}`;
}

// ---------- detail panel ----------

let reopenRouteOverlayAfterDetail = false;

function closeDetailOverlay() {
  document.getElementById('detail-overlay').classList.add('hidden');
  if (reopenRouteOverlayAfterDetail) {
    reopenRouteOverlayAfterDetail = false;
    renderRouteChecklist();
    document.getElementById('route-overlay').classList.remove('hidden');
  }
}

function openDetail(id) {
  const v = venues.find(x => x.id === id) || lastRouteOrder.find(x => x.id === id);
  if (!v) return;
  const ov = getOverride(id);
  const overlay = document.getElementById('detail-overlay');
  const content = document.getElementById('detail-content');
  const routeOverlay = document.getElementById('route-overlay');
  reopenRouteOverlayAfterDetail = !routeOverlay.classList.contains('hidden');
  routeOverlay.classList.add('hidden');
  content.innerHTML = `
    <h2>${escapeHtml(v.name)}</h2>
    <div class="dc-addr">${escapeHtml(v.address || 'No address on record')} &middot; ${v.distance.toFixed(1)} mi away${isChain(v) ? ' &middot; <strong>Chain</strong>' : ''}</div>
    <div class="dc-links">
      <a href="https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lon}" target="_blank" rel="noopener">Directions</a>
      ${v.phone ? `<a href="tel:${v.phone.replace(/\s+/g, '')}">Call ${escapeHtml(v.phone)}</a>` : ''}
      ${v.website ? `<a href="${escapeHtml(v.website)}" target="_blank" rel="noopener">Website</a>` : ''}
      <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.name + ' ' + (v.address || ''))}" target="_blank" rel="noopener">Google reviews</a>
    </div>
    <div class="dc-row">
      <label>Status</label>
      <select id="dc-status">${STATUS_OPTIONS.map(s => `<option value="${s}" ${s === ov.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
    </div>
    <div class="dc-row">
      <label>Last visited</label>
      <input type="date" id="dc-visited" value="${ov.lastVisited || ''}">
    </div>
    <div class="dc-row">
      <label>Notes</label>
      <textarea id="dc-notes" placeholder="Who you spoke to, what they order now, follow-up plan...">${escapeHtml(ov.notes)}</textarea>
    </div>
    <div class="dc-row">
      <label class="checkbox-row"><input type="checkbox" id="dc-priority" ${ov.priority ? 'checked' : ''}> Priority lead</label>
    </div>
    <div class="dc-row">
      <label class="checkbox-row"><input type="checkbox" id="dc-route" ${selectedRoute.has(id) ? 'checked' : ''}> Add to today's route</label>
    </div>
    <button id="save-detail-btn" class="btn-primary">Save</button>
    ${v.id.startsWith('manual/') ? '<button id="delete-venue-btn" class="btn-outline dc-delete-venue">Delete this manually-added venue</button>' : ''}
  `;
  if (v.id.startsWith('manual/')) {
    content.querySelector('#delete-venue-btn').onclick = async () => {
      if (!confirm(`Delete "${v.name}"? This can't be undone.`)) return;
      try {
        await deleteManualVenue(v.id);
        manualVenues = manualVenues.filter(x => x.id !== v.id);
        venues = venues.filter(x => x.id !== v.id);
        selectedRoute.delete(v.id);
        updateRouteBar();
        renderAll();
        closeDetailOverlay();
      } catch (e) {
        console.error('Failed to delete venue', e);
      }
    };
  }
  content.querySelector('#save-detail-btn').onclick = () => {
    setOverride(id, {
      status: content.querySelector('#dc-status').value,
      lastVisited: content.querySelector('#dc-visited').value,
      notes: content.querySelector('#dc-notes').value,
      priority: content.querySelector('#dc-priority').checked,
    });
    if (content.querySelector('#dc-route').checked) selectedRoute.add(id); else selectedRoute.delete(id);
    updateRouteBar();
    renderAll();
    closeDetailOverlay();
  };
  overlay.classList.remove('hidden');
  map.setView([v.lat, v.lon], Math.max(map.getZoom(), 15));
}

document.getElementById('detail-close').onclick = () => closeDetailOverlay();
document.getElementById('detail-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'detail-overlay') closeDetailOverlay();
});

// ---------- route ----------

function nearestNeighborOrder(points) {
  if (points.length <= 1) return points.slice();
  const remaining = points.slice();
  let anchorIdx = 0;
  if (centerPoint) {
    let best = Infinity;
    remaining.forEach((p, i) => {
      const d = haversineMiles(centerPoint.lat, centerPoint.lon, p.lat, p.lon);
      if (d < best) { best = d; anchorIdx = i; }
    });
  }
  const route = [remaining.splice(anchorIdx, 1)[0]];
  while (remaining.length) {
    const last = route[route.length - 1];
    let bestIdx = 0, bestDist = Infinity;
    remaining.forEach((p, i) => {
      const d = haversineMiles(last.lat, last.lon, p.lat, p.lon);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    route.push(remaining.splice(bestIdx, 1)[0]);
  }
  return route;
}

async function fetchOptimizedOrder(points) {
  if (points.length <= 2) return points.slice();
  let anchorIdx = 0;
  if (centerPoint) {
    let best = Infinity;
    points.forEach((p, i) => {
      const d = haversineMiles(centerPoint.lat, centerPoint.lon, p.lat, p.lon);
      if (d < best) { best = d; anchorIdx = i; }
    });
  }
  const ordered = [points[anchorIdx], ...points.slice(0, anchorIdx), ...points.slice(anchorIdx + 1)];
  const coordStr = ordered.map(p => `${p.lon},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/trip/v1/driving/${coordStr}?roundtrip=false&source=first&destination=any&overview=false`;
  const res = await fetchWithTimeout(url, {}, 15000);
  if (!res.ok) throw new Error(`OSRM returned ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.waypoints) throw new Error('OSRM optimization failed');
  return data.waypoints
    .map((wp, i) => ({ venue: ordered[i], order: wp.waypoint_index }))
    .sort((a, b) => a.order - b.order)
    .map(x => x.venue);
}

function updateRouteBar() {
  document.getElementById('route-count').textContent = `${selectedRoute.size} selected`;
  document.getElementById('route-btn').disabled = selectedRoute.size === 0;
  document.getElementById('save-route-btn').disabled = selectedRoute.size === 0;
}

function renderRouteChecklist() {
  const container = document.getElementById('route-list');
  container.innerHTML = '';
  if (lastRouteOrder.length === 0) {
    container.innerHTML = '<p class="routes-empty">No route planned yet. Tick venues and tap "Maps", or open Saved Routes and tap "Go".</p>';
    return;
  }
  lastRouteOrder.forEach((v, i) => {
    const row = document.createElement('div');
    row.className = 'route-stop' + (visitedToday.has(v.id) ? ' done' : '');
    row.innerHTML = `
      <input type="checkbox" ${visitedToday.has(v.id) ? 'checked' : ''}>
      <span class="rs-num">${i + 1}</span>
      <div class="rs-main">
        <div class="rs-name">${escapeHtml(v.name)}</div>
        <div class="rs-addr">${escapeHtml(v.address || 'No address on record')}</div>
      </div>
      <a class="rs-dir" href="https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lon}" target="_blank" rel="noopener" title="Directions">
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 20l-5.5-2V4L9 6m0 14 6-2m-6 2V6m6 12 5.5 2V6L15 4m0 14V4m0 0L9 6"/></svg>
      </a>`;
    row.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) visitedToday.add(v.id); else visitedToday.delete(v.id);
      row.classList.toggle('done', e.target.checked);
      saveLastRouteCache();
    });
    row.querySelector('.rs-main').addEventListener('click', () => openDetail(v.id));
    container.appendChild(row);
  });
}

document.getElementById('view-route-btn').onclick = () => {
  renderRouteChecklist();
  document.getElementById('route-overlay').classList.remove('hidden');
};
document.getElementById('route-close').onclick = () => document.getElementById('route-overlay').classList.add('hidden');
document.getElementById('route-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'route-overlay') e.currentTarget.classList.add('hidden');
});

// ---------- save route ----------

document.getElementById('save-route-btn').onclick = () => {
  if (selectedRoute.size === 0) return;
  document.getElementById('save-route-sub').textContent = `Saving ${selectedRoute.size} selected venue${selectedRoute.size === 1 ? '' : 's'} as a named route.`;
  document.getElementById('save-route-name').value = '';
  document.getElementById('save-route-overlay').classList.remove('hidden');
  document.getElementById('save-route-name').focus();
};
document.getElementById('save-route-close').onclick = () => document.getElementById('save-route-overlay').classList.add('hidden');
document.getElementById('save-route-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'save-route-overlay') e.currentTarget.classList.add('hidden');
});
document.getElementById('save-route-confirm').onclick = async () => {
  const nameInput = document.getElementById('save-route-name');
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  const btn = document.getElementById('save-route-confirm');
  btn.disabled = true;
  try {
    await saveCurrentSelectionAsRoute(name);
    document.getElementById('save-route-overlay').classList.add('hidden');
  } catch (e) {
    console.error('Failed to save route', e);
  } finally {
    btn.disabled = false;
  }
};

// ---------- saved routes list ----------

function renderSavedRoutesList() {
  const container = document.getElementById('routes-list');
  if (!container) return;
  container.innerHTML = '';
  if (savedRoutes.length === 0) {
    container.innerHTML = '<p class="routes-empty">No saved routes yet. Tick venues, then "Save route" to plan ahead.</p>';
    return;
  }
  savedRoutes.forEach(route => {
    const card = document.createElement('div');
    card.className = 'route-card';
    const stopCount = (route.stops || []).length;
    const dateLabel = route.createdAt && route.createdAt.toDate ? route.createdAt.toDate().toLocaleDateString() : '';
    card.innerHTML = `
      <div class="rc-main">
        <div class="rc-name">${escapeHtml(route.name)}</div>
        <div class="rc-meta">${stopCount} stop${stopCount === 1 ? '' : 's'}${dateLabel ? ' · saved ' + dateLabel : ''}</div>
      </div>
      <button class="btn-primary rc-go">Go</button>
      <button class="rc-edit btn-outline" title="Edit route">
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
      </button>
      <button class="rc-delete" title="Delete route">
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>
      </button>`;
    card.querySelector('.rc-edit').addEventListener('click', () => openEditRoute(route));
    card.querySelector('.rc-go').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (!stopCount) return;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Optimizing…';
      document.getElementById('routes-overlay').classList.add('hidden');
      await planAndShowRoute(route.stops);
      btn.disabled = false;
      btn.textContent = originalText;
    });
    card.querySelector('.rc-delete').addEventListener('click', async () => {
      if (!confirm(`Delete the saved route "${route.name}"?`)) return;
      try { await deleteSavedRoute(route.id); }
      catch (e) { console.error('Failed to delete route', e); }
    });
    container.appendChild(card);
  });
}

document.getElementById('view-routes-btn').onclick = () => {
  renderSavedRoutesList();
  document.getElementById('routes-overlay').classList.remove('hidden');
};
document.getElementById('routes-close').onclick = () => document.getElementById('routes-overlay').classList.add('hidden');
document.getElementById('routes-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'routes-overlay') e.currentTarget.classList.add('hidden');
});

// ---------- edit route ----------

let editingRouteId = null;
let editingStops = [];

function openEditRoute(route) {
  editingRouteId = route.id;
  editingStops = (route.stops || []).slice();
  document.getElementById('edit-route-name').value = route.name;
  renderEditStops();
  document.getElementById('routes-overlay').classList.add('hidden');
  document.getElementById('edit-route-overlay').classList.remove('hidden');
}

function renderEditStops() {
  const container = document.getElementById('edit-stops-list');
  container.innerHTML = '';
  if (editingStops.length === 0) {
    container.innerHTML = '<p class="routes-empty">No stops yet — add some below.</p>';
    return;
  }
  editingStops.forEach((v, i) => {
    const row = document.createElement('div');
    row.className = 'edit-stop-row';
    row.innerHTML = `
      <div class="es-main">
        <div class="es-name">${escapeHtml(v.name)}</div>
        <div class="es-addr">${escapeHtml(v.address || 'No address on record')}</div>
      </div>
      <button class="es-remove" title="Remove stop">
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>`;
    row.querySelector('.es-remove').addEventListener('click', () => {
      editingStops.splice(i, 1);
      renderEditStops();
    });
    container.appendChild(row);
  });
}

document.getElementById('edit-add-selected-btn').onclick = () => {
  const toAdd = venues.filter(v => selectedRoute.has(v.id) && !editingStops.some(s => s.id === v.id));
  editingStops = editingStops.concat(toAdd);
  renderEditStops();
};

document.getElementById('edit-route-save').onclick = async () => {
  const nameInput = document.getElementById('edit-route-name');
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  const btn = document.getElementById('edit-route-save');
  btn.disabled = true;
  try {
    await db.collection('routes').doc(editingRouteId).update({ name, stops: editingStops });
    document.getElementById('edit-route-overlay').classList.add('hidden');
  } catch (e) {
    console.error('Failed to save route edits', e);
  } finally {
    btn.disabled = false;
  }
};
document.getElementById('edit-route-close').onclick = () => document.getElementById('edit-route-overlay').classList.add('hidden');
document.getElementById('edit-route-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'edit-route-overlay') e.currentTarget.classList.add('hidden');
});

async function planAndShowRoute(stops) {
  let ordered;
  try {
    ordered = await fetchOptimizedOrder(stops);
  } catch (e) {
    console.error('Route optimization failed, using straight-line fallback', e);
    ordered = nearestNeighborOrder(stops);
  }
  const dest = ordered[ordered.length - 1];
  const waypoints = ordered.slice(0, -1).map(v => `${v.lat},${v.lon}`).join('|');
  let url = `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lon}&travelmode=driving`;
  if (waypoints) url += `&waypoints=${encodeURIComponent(waypoints)}`;
  window.open(url, '_blank');
  lastRouteOrder = ordered;
  visitedToday.clear();
  saveLastRouteCache();
  renderRouteChecklist();
  document.getElementById('route-overlay').classList.remove('hidden');
}

document.getElementById('route-btn').onclick = async () => {
  const chosen = venues.filter(v => selectedRoute.has(v.id));
  if (chosen.length === 0) return;
  const btn = document.getElementById('route-btn');
  const label = document.getElementById('route-btn-label');
  const originalText = label.textContent;
  btn.disabled = true;
  label.textContent = 'Optimizing route…';
  await planAndShowRoute(chosen);
  btn.disabled = false;
  label.textContent = originalText;
};

document.getElementById('clear-route-btn').onclick = () => {
  selectedRoute.clear();
  updateRouteBar();
  renderList();
};

// ---------- export / import ----------

document.getElementById('export-csv-btn').onclick = () => {
  const rows = [['Name', 'Category', 'Address', 'Phone', 'Website', 'Distance (mi)', 'Status', 'Last visited', 'Notes', 'Lat', 'Lon']];
  venues.forEach(v => {
    const ov = getOverride(v.id);
    rows.push([v.name, CATEGORIES[v.category].label, v.address, v.phone, v.website, v.distance.toFixed(2), ov.status, ov.lastVisited, ov.notes, v.lat, v.lon]);
  });
  const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  downloadBlob(csv, 'canvassing-venues.csv', 'text/csv');
};

document.getElementById('export-json-btn').onclick = () => {
  const payload = { venues, overrides, exportedAt: new Date().toISOString() };
  downloadBlob(JSON.stringify(payload, null, 2), 'canvassing-backup.json', 'application/json');
};

document.getElementById('import-json-btn').onclick = () => document.getElementById('import-file-input').click();
document.getElementById('import-file-input').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const payload = JSON.parse(text);
    if (payload.overrides) {
      overrides = Object.assign({}, overrides, payload.overrides);
      saveOverrides();
    }
    if (Array.isArray(payload.venues) && payload.venues.length) {
      venues = payload.venues;
      saveCache({ venues, center: centerPoint, radius: parseFloat(document.getElementById('radius-input').value), savedAt: new Date().toISOString() });
    }
    renderAll();
    setStatus('Backup restored.');
  } catch (err) {
    setStatus('Could not read that backup file.');
  }
};

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- add venue ----------

let addVenueLocation = null;

function populateAddVenueCategories() {
  const sel = document.getElementById('add-venue-category');
  sel.innerHTML = Object.entries(CATEGORIES).map(([key, cfg]) => `<option value="${key}">${cfg.label}</option>`).join('');
}

document.getElementById('add-venue-btn').onclick = () => {
  addVenueLocation = null;
  document.getElementById('add-venue-name').value = '';
  document.getElementById('add-venue-address').value = '';
  document.getElementById('add-venue-location-status').textContent = 'No location set — tap above, or leave blank to use the address instead.';
  document.getElementById('add-venue-overlay').classList.remove('hidden');
};
document.getElementById('add-venue-close').onclick = () => document.getElementById('add-venue-overlay').classList.add('hidden');
document.getElementById('add-venue-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'add-venue-overlay') e.currentTarget.classList.add('hidden');
});

document.getElementById('add-venue-locate').onclick = () => {
  const statusEl = document.getElementById('add-venue-location-status');
  if (!navigator.geolocation) { statusEl.textContent = 'Location isn\'t available on this device/browser — type the address instead.'; return; }
  statusEl.textContent = 'Getting your location…';
  navigator.geolocation.getCurrentPosition(
    pos => {
      addVenueLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      statusEl.textContent = `Location set (accurate to ~${Math.round(pos.coords.accuracy)}m).`;
    },
    err => { statusEl.textContent = `Couldn't get your location (${err.message}) — type the address instead.`; },
    { enableHighAccuracy: true, timeout: 10000 }
  );
};

document.getElementById('add-venue-save').onclick = async () => {
  const nameInput = document.getElementById('add-venue-name');
  const name = nameInput.value.trim();
  const category = document.getElementById('add-venue-category').value;
  const address = document.getElementById('add-venue-address').value.trim();
  const statusEl = document.getElementById('add-venue-location-status');
  if (!name) { nameInput.focus(); return; }
  const btn = document.getElementById('add-venue-save');
  btn.disabled = true;
  try {
    let loc = addVenueLocation;
    if (!loc) {
      if (!address) { statusEl.textContent = 'Set a location or enter an address.'; return; }
      statusEl.textContent = 'Locating address…';
      loc = await geocodePostcode(address);
    }
    const venue = await addManualVenue({ name, category, address, lat: loc.lat, lon: loc.lon });
    manualVenues = manualVenues.filter(v => v.id !== venue.id).concat(venue);
    venues = mergeManualVenues(venues.filter(v => !v.id.startsWith('manual/')));
    renderAll();
    document.getElementById('add-venue-overlay').classList.add('hidden');
  } catch (e) {
    console.error('Failed to add venue', e);
    statusEl.textContent = 'Could not add that venue: ' + e.message;
  } finally {
    btn.disabled = false;
  }
};

// ---------- load flow ----------

function setStatus(msg) {
  document.getElementById('load-status').textContent = msg;
}

document.getElementById('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const postcode = document.getElementById('postcode-input').value;
  const radius = parseFloat(document.getElementById('radius-input').value) || 25;
  const btn = document.getElementById('load-btn');
  btn.disabled = true;
  setStatus('Locating…');
  try {
    centerPoint = await geocodePostcode(postcode);
    map.setView([centerPoint.lat, centerPoint.lon], radiusToZoom(radius));
    setStatus(`Querying OpenStreetMap within ${radius} mi (this can take up to a minute for large radii)…`);
    venues = mergeManualVenues(await fetchVenues(centerPoint, radius));
    saveCache({ venues, center: centerPoint, radius, savedAt: new Date().toISOString() });
    setStatus(`Loaded ${venues.length} venues, saved ${new Date().toLocaleTimeString()}.`);
    renderAll();
  } catch (err) {
    console.error(err);
    setStatus('Error: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});

function radiusToZoom(miles) {
  if (miles <= 3) return 13;
  if (miles <= 8) return 11;
  if (miles <= 15) return 10;
  if (miles <= 30) return 9;
  return 8;
}

document.getElementById('search-box').addEventListener('input', (e) => { searchTerm = e.target.value; renderAll(); });
document.getElementById('status-filter').addEventListener('change', (e) => { statusFilter = e.target.value; renderAll(); });
document.getElementById('visited-filter').addEventListener('change', (e) => { visitedFilter = e.target.value; renderAll(); });
document.getElementById('hide-not-interested').addEventListener('change', (e) => { hideNotInterested = e.target.checked; renderAll(); });
document.getElementById('show-chains').addEventListener('change', (e) => { showChains = e.target.checked; renderAll(); });
document.getElementById('priority-only').addEventListener('change', (e) => { priorityOnly = e.target.checked; renderAll(); });
document.getElementById('needs-followup').addEventListener('change', (e) => { needsFollowup = e.target.checked; renderAll(); });

// ---------- boot ----------

function boot() {
  initMap();
  renderTypeFilters();
  renderStatusFilterOptions();
  populateAddVenueCategories();
  updateRouteBar();

  const cached = loadCache();
  if (cached && cached.venues && cached.venues.length) {
    centerPoint = cached.center;
    venues = mergeManualVenues(cached.venues);
    document.getElementById('radius-input').value = cached.radius;
    if (centerPoint) map.setView([centerPoint.lat, centerPoint.lon], radiusToZoom(cached.radius));
    setStatus(`Showing cached data from ${new Date(cached.savedAt).toLocaleString()}. Click "Load venues" to refresh.`);
    renderAll();
  } else {
    setStatus('Enter a postcode and radius, then click "Load venues".');
  }
}

// ---------- login gate ----------

const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const loginPasscode = document.getElementById('login-passcode');
const loginError = document.getElementById('login-error');
let booted = false;

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = loginForm.querySelector('button');
  btn.disabled = true;
  loginError.textContent = '';
  try {
    await auth.signInWithEmailAndPassword(SHARED_LOGIN_EMAIL, loginPasscode.value);
  } catch (err) {
    loginError.textContent = 'Incorrect passcode.';
  } finally {
    btn.disabled = false;
  }
});

auth.onAuthStateChanged(user => {
  if (user) {
    loginOverlay.classList.add('hidden');
    loginPasscode.value = '';
    if (!booted) {
      booted = true;
      boot();
    }
    subscribeOverrides();
    subscribeSavedRoutes();
    subscribeManualVenues();
  } else {
    loginOverlay.classList.remove('hidden');
    if (unsubscribeOverrides) { unsubscribeOverrides(); unsubscribeOverrides = null; }
    if (unsubscribeSavedRoutes) { unsubscribeSavedRoutes(); unsubscribeSavedRoutes = null; }
    if (unsubscribeManualVenues) { unsubscribeManualVenues(); unsubscribeManualVenues = null; }
  }
});
