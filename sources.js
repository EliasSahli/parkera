// sources.js – hämtar data från nätet (körs i webbläsaren)
import { fromOsm, fromGbg, buildOverpassQuery } from './core.js';

// Göteborgsområdet – styr adressökningen hit
const GBG_VIEWBOX = '11.70,57.85,12.25,57.55'; // väst,nord,öst,syd
const GBG_CENTER = { lat: 57.7089, lon: 11.9746 };

async function fetchJson(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
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
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export async function fetchOsmParkings(lat, lon, radius) {
  const body = 'data=' + encodeURIComponent(buildOverpassQuery(lat, lon, radius));
  let lastErr;
  for (const url of OVERPASS_MIRRORS) {
    try {
      const data = await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }, 20000);
      return (data.elements || []).map(fromOsm).filter(Boolean);
    } catch (e) {
      lastErr = e;
      console.warn('Overpass-spegel misslyckades:', url, e);
    }
  }
  throw lastErr || new Error('Overpass otillgängligt');
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

async function gbgGet(url) {
  if (gbgTransport !== 'jsonp') {
    try {
      const data = await fetchJson(url, {}, 10000);
      gbgTransport = 'fetch';
      return data;
    } catch (e) {
      if (gbgTransport === 'fetch') throw e;
    }
  }
  const data = await jsonp(url);
  gbgTransport = 'jsonp';
  return data;
}

export async function fetchGbgParkings(appId, lat, lon, radius) {
  if (!appId) return { items: [], ok: false, reason: 'ingen APPID' };
  const qs = `?latitude=${lat.toFixed(6)}&longitude=${lon.toFixed(6)}&radius=${Math.round(radius)}&format=Json`;
  const calls = [
    ['PublicTimeParkings', 'time'], // gratis gatuparkering med tidsgräns
    ['PublicTollParkings', 'toll'], // avgiftsparkering (pris + ibland lediga platser)
  ].map(async ([ep, kind]) => {
    const data = await gbgGet(`${GBG_BASE}/${ep}/${encodeURIComponent(appId)}${qs}`);
    return (Array.isArray(data) ? data : []).map((it) => fromGbg(it, kind)).filter(Boolean);
  });
  const results = await Promise.allSettled(calls);
  const items = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const ok = results.some((r) => r.status === 'fulfilled');
  const reason = ok ? '' : results.map((r) => r.reason?.message || String(r.reason))[0];
  return { items, ok, reason, transport: gbgTransport };
}

// Snabbtest av nyckeln mot Kungsportsplatsen
export async function testGbgKey(appId) {
  return fetchGbgParkings(appId, 57.7045, 11.97, 800);
}
