// Parkera – liten proxy för Göteborgs Stads parkerings-API (Cloudflare Worker, gratisnivå)
//
// Varför: så att vänner kan använda appen utan egen nyckel. Nyckeln ligger som hemlighet
// (GBG_APPID) här på servern och syns aldrig i webbläsaren. Svaren cachas en minut.
//
// Anrop:  GET /parking?lat=57.70&lon=11.97&radius=1500
// Svar:   { time, toll, private, commuter } – listor från Göteborgs Stads ParkingService

const UPSTREAM = 'https://data.goteborg.se/ParkingService/v2.1';
const ALLOWED_ORIGINS = [
  'https://eliassahli.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];
// Göteborgsområdet – vi svarar bara för koordinater här, så proxyn inte kan missbrukas brett
const BOUNDS = { minLat: 57.4, maxLat: 58.1, minLon: 11.5, maxLon: 12.6 };
const CACHE_SECONDS = 60;

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function json(body, status, origin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin), ...extra },
  });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'GET') return json({ error: 'method' }, 405, origin);

    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, key: Boolean(env.GBG_APPID) }, 200, origin);
    if (url.pathname !== '/parking') return json({ error: 'not found' }, 404, origin);
    if (!env.GBG_APPID) return json({ error: 'GBG_APPID saknas på servern' }, 500, origin);

    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    const radius = Math.min(Math.max(Number(url.searchParams.get('radius')) || 1000, 100), 3000);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: 'lat/lon krävs' }, 400, origin);
    if (lat < BOUNDS.minLat || lat > BOUNDS.maxLat || lon < BOUNDS.minLon || lon > BOUNDS.maxLon) {
      return json({ time: [], toll: [], private: [], commuter: [], outside: true }, 200, origin);
    }

    // Avrunda position (~50 m) så att närliggande sökningar delar cache
    const rLat = lat.toFixed(4);
    const rLon = lon.toFixed(4);
    const cacheKey = new Request(`https://cache.parkera/parking?lat=${rLat}&lon=${rLon}&radius=${radius}`);
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const body = await hit.text();
        return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT', ...cors(origin) } });
      }
    }

    const qs = `?latitude=${rLat}&longitude=${rLon}&radius=${radius}&format=Json`;
    const key = encodeURIComponent(env.GBG_APPID);
    const get = async (ep) => {
      const res = await fetch(`${UPSTREAM}/${ep}/${key}${qs}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`${ep}: HTTP ${res.status}`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    };
    const lists = {
      time: 'PublicTimeParkings',
      toll: 'PublicTollParkings',
      private: 'PrivateTollParkings',
      commuter: 'CommuterParkings',
    };
    const keys = Object.keys(lists);
    const results = await Promise.allSettled(keys.map((k) => get(lists[k])));
    if (results.every((r) => r.status === 'rejected')) {
      return json({ error: 'Göteborgs Stad svarar inte', detail: String(results[0].reason) }, 502, origin);
    }
    const out = {};
    keys.forEach((k, i) => { out[k] = results[i].status === 'fulfilled' ? results[i].value : []; });
    const body = JSON.stringify(out);
    if (cache) {
      ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } })));
    }
    return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'MISS', ...cors(origin) } });
  },
};
