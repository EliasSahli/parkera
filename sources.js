// sources.js – hämtar data från nätet (körs i webbläsaren)
import { fromOsm, fromGbg, buildOverpassQuery } from './core.js';
import { PROXY_URL } from './config.js';

// Göteborgsområdet – styr adressökningen hit
const GBG_VIEWBOX = '11.70,57.85,12.25,57.55'; // väst,nord,öst,syd
const GBG_CENTER = { lat: 57.7089, lon: 11.9746 };

async function fetchJson(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const outer = opts.signal;
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Adress -> lista med träffar {label, lat, lon}
export async function geocode(query) {
  const q = query.trim();
  if (!q) return [];
  try {
    const url =
      'https://nominatim.openstreetmap.org/search?' +
      new URLSearchParams({
        q, format: 'jsonv2', limit: '5', countrycodes: 'se',
        viewbox: GBG_VIEWBOX, bounded: '0', 'accept-language': 'sv', addressdetails: '1',
      });
    const data = await fetchJson(url, { headers: { Accept: 'application/json' } });
    if (data.length) {
      return data.map((d) => ({
        label: shortLabel(d),
        full: d.display_name,
        lat: parseFloat(d.lat),
        lon: parseFloat(d.lon),
      }));
    }
  } catch (e) {
    console.warn('Nominatim misslyckades, provar Photon', e);
  }
  // Reserv: Photon (komoot)
  const url =
    'https://photon.komoot.io/api/?' +
    new URLSearchParams({ q, limit: '5', lang: 'default', lat: GBG_CENTER.lat, lon: GBG_CENTER.lon });
  const data = await fetchJson(url);
  return (data.features || [])
    .filter((f) => (f.properties.countrycode || '').toUpperCase() === 'SE')
    .map((f) => {
      const p = f.properties;
      const street = [p.street || p.name, p.housenumber].filter(Boolean).join(' ');
      return {
        label: [p.name && p.name !== p.street ? p.name : street || p.name, p.city].filter(Boolean).join(', '),
        full: [p.name, street, p.postcode, p.city].filter(Boolean).join(', '),
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
      };
    });
}

// Position -> kort adress ("Vasagatan 12") för "Parkera här"
export async function reverseGeocode(lat, lon) {
  try {
    const data = await fetchJson(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&limit=1`, {}, 5000);
    const p = data.features?.[0]?.properties;
    if (!p) return null;
    const street = [p.street || p.name, p.housenumber].filter(Boolean).join(' ');
    return street || p.name || null;
  } catch { return null; }
}

// ---------- Sökförslag medan man skriver (Photon – byggt för autocomplete) ----------
const suggestCache = new Map();

export async function suggest(query, signal) {
  const q = query.trim();
  if (q.length < 2) return [];
  const key = q.toLowerCase();
  if (suggestCache.has(key)) return suggestCache.get(key);
  const url =
    'https://photon.komoot.io/api/?' +
    new URLSearchParams({
      q, limit: '8', lang: 'default',
      lat: GBG_CENTER.lat, lon: GBG_CENTER.lon, location_bias_scale: '0.3', zoom: '12',
    });
  const data = await fetchJson(url, { signal }, 6000);
  const seen = new Set();
  const out = [];
  for (const f of data.features || []) {
    const p = f.properties || {};
    if ((p.countrycode || '').toUpperCase() !== 'SE') continue;
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const isAddress = p.osm_key === 'place' && p.osm_value === 'house' || (!p.name && street);
    const title = isAddress ? street || p.name : p.name || street;
    if (!title) continue;
    const place = p.city || p.town || p.village || p.locality || p.district || p.county || '';
    const sub = [isAddress ? '' : street, place].filter(Boolean).join(', ');
    const id = `${title}|${sub}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      label: [title, place].filter(Boolean).join(', '),
      title,
      sub,
      full: [title, sub].filter(Boolean).join(', '),
      kind: kindOf(p),
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
    });
    if (out.length >= 6) break;
  }
  suggestCache.set(key, out);
  return out;
}

function kindOf(p) {
  const v = `${p.osm_key}:${p.osm_value}`;
  if (/amenity:(restaurant|cafe|bar|pub|fast_food)/.test(v)) return '🍽';
  if (/shop:|amenity:marketplace/.test(v)) return '🛍';
  if (/railway|public_transport|highway:bus_stop|amenity:bus_station/.test(v)) return '🚉';
  if (/amenity:(hospital|clinic|doctors|dentist)/.test(v)) return '🏥';
  if (/leisure|tourism|amenity:(theatre|cinema|arts_centre)/.test(v)) return '★';
  if (/place:(city|town|village|suburb|neighbourhood|quarter)/.test(v)) return '◎';
  if (/highway/.test(v)) return '⟋';
  return '📍';
}

function shortLabel(d) {
  const a = d.address || {};
  const street = [a.road || a.pedestrian, a.house_number].filter(Boolean).join(' ');
  const place = a.city || a.town || a.village || a.municipality || '';
  const head = d.name && d.name !== a.road ? d.name : street;
  return [head || d.display_name.split(',')[0], place].filter(Boolean).join(', ');
}

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Enkel cache (10 min) så att samma mål inte hämtas om
const CACHE_MS = 10 * 60 * 1000;
function cacheGet(key, ttl = CACHE_MS) {
  try {
    const raw = sessionStorage.getItem('parkera.c.' + key);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    return Date.now() - t < ttl ? v : null;
  } catch { return null; }
}
function cacheSet(key, v) {
  try { sessionStorage.setItem('parkera.c.' + key, JSON.stringify({ t: Date.now(), v })); } catch { /* fullt */ }
}

// Frågar båda speglarna samtidigt och tar det första svaret
export async function fetchOsmParkings(lat, lon, radius) {
  const key = `osm2:${lat.toFixed(4)},${lon.toFixed(4)},${radius}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const body = 'data=' + encodeURIComponent(buildOverpassQuery(lat, lon, radius));
  const ctrl = new AbortController();
  const attempts = OVERPASS_MIRRORS.map((url) =>
    fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: ctrl.signal,
    }, 9000).then((data) => {
      if (!Array.isArray(data.elements)) throw new Error('tomt svar');
      return data.elements;
    }),
  );
  try {
    const elements = await Promise.any(attempts);
    ctrl.abort(); // avbryt den långsammare
    const items = elements.map(fromOsm).filter(Boolean);
    cacheSet(key, items);
    return items;
  } catch (e) {
    throw new Error('Overpass otillgängligt');
  }
}

// ---------- Göteborgs Stads öppna API ----------
// Kräver gratis APPID från data.goteborg.se.
// Webbläsare blockerar ofta vanliga anrop till andra domäner (CORS). API:t stöder JSONP,
// så vi provar fetch först och faller tillbaka på JSONP (en <script>-tagg) om det blockeras.
const GBG_BASE = 'https://data.goteborg.se/ParkingService/v2.1';
let jsonpSeq = 0;

function jsonp(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const cb = `__parkeraGbg${Date.now()}_${jsonpSeq++}`;
    const s = document.createElement('script');
    const cleanup = () => { delete window[cb]; s.remove(); clearTimeout(timer); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeoutMs);
    window[cb] = (data) => { cleanup(); resolve(data); };
    s.onerror = () => { cleanup(); reject(new Error('nätverksfel eller ogiltig APPID')); };
    s.src = `${url}&callback=${cb}`;
    document.head.appendChild(s);
  });
}

let gbgTransport = null; // 'fetch' | 'jsonp' – kom ihåg vad som fungerade

async function gbgGet(url, timeoutMs = 10000) {
  if (gbgTransport !== 'jsonp') {
    try {
      const data = await fetchJson(url, {}, timeoutMs);
      gbgTransport = 'fetch';
      return data;
    } catch (e) {
      if (gbgTransport === 'fetch') throw e;
    }
  }
  const data = await jsonp(url, timeoutMs);
  gbgTransport = 'jsonp';
  return data;
}

export const hasProxy = () => Boolean(PROXY_URL);

// Via Parkeras egen server (nyckeln ligger på servern)
async function fetchViaProxy(lat, lon, radius) {
  const url = `${PROXY_URL.replace(/\/$/, '')}/parking?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&radius=${Math.round(radius)}`;
  const data = await fetchJson(url, {}, 8000);
  return [
    ...(data.time || []).map((it) => fromGbg(it, 'time')),
    ...(data.toll || []).map((it) => fromGbg(it, 'toll')),
    ...(data.private || []).map((it) => fromGbg(it, 'private')),
    ...(data.commuter || []).map((it) => fromGbg(it, 'commuter')),
  ].filter(Boolean);
}

// onPartial(items): anropas varje gång en lista har kommit, så att appen kan visa den direkt
// i stället för att vänta på den långsammaste (pendelparkeringarna svarade inte vid test).
export async function fetchGbgParkings(appId, lat, lon, radius, onPartial = null) {
  if (PROXY_URL) {
    const key = `gbgp:${lat.toFixed(4)},${lon.toFixed(4)},${radius}`;
    const hit = cacheGet(key, 3 * 60 * 1000);
    if (hit) return { items: hit, ok: true, reason: '', transport: 'cache' };
    try {
      const items = await fetchViaProxy(lat, lon, radius);
      cacheSet(key, items);
      return { items, ok: true, reason: '', transport: 'proxy' };
    } catch (e) {
      console.warn('Proxy misslyckades', e);
      if (!appId) return { items: [], ok: false, reason: 'servern svarar inte' };
    }
  }
  if (!appId) return { items: [], ok: false, reason: 'ingen APPID' };
  const key = `gbg:${lat.toFixed(4)},${lon.toFixed(4)},${radius}`;
  const hit = cacheGet(key, 3 * 60 * 1000); // kortare: lediga platser ändras
  if (hit) return { items: hit, ok: true, reason: '', transport: 'cache' };
  const qs = `?latitude=${lat.toFixed(6)}&longitude=${lon.toFixed(6)}&radius=${Math.round(radius)}&format=Json`;
  const sofar = [];
  const calls = [
    ['PublicTimeParkings', 'time', 9000], // gratis gatuparkering med tidsgräns
    ['PublicTollParkings', 'toll', 9000], // avgiftsparkering
    ['PrivateTollParkings', 'private', 9000], // p-hus, garage och privat mark med avgift
    ['CommuterParkings', 'commuter', 5000], // pendelparkeringar – svarade med serverfel vid test, kort timeout
  ].map(async ([ep, kind, tmo]) => {
    const data = await gbgGet(`${GBG_BASE}/${ep}/${encodeURIComponent(appId)}${qs}`, tmo);
    const items = (Array.isArray(data) ? data : []).map((it) => fromGbg(it, kind)).filter(Boolean);
    sofar.push(...items);
    if (onPartial) { try { onPartial([...sofar]); } catch (e) { console.warn(e); } }
    return items;
  });
  const results = await Promise.allSettled(calls);
  const items = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const ok = results.some((r) => r.status === 'fulfilled');
  const reason = ok ? '' : results.map((r) => r.reason?.message || String(r.reason))[0];
  if (ok) cacheSet(key, items);
  return { items, ok, reason, transport: gbgTransport };
}

// Snabbtest av nyckeln mot Kungsportsplatsen
export async function testGbgKey(appId) {
  return fetchGbgParkings(appId, 57.7045, 11.97, 800);
}
