// core.js – ren logik utan nätverk eller DOM (testbar i Node)

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Gångtid: luftlinje * 1.3 (gatunät) i 5 km/h
export function walkMinutes(meters) {
  return Math.max(1, Math.round((meters * 1.3) / 83));
}

export function formatDistance(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

const BLOCKED_ACCESS = new Set(['private', 'no', 'permit', 'residents', 'delivery', 'employees', 'staff', 'emergency']);

// OpenStreetMap-element (från Overpass) -> intern parkering, eller null om ej publik
export function fromOsm(el) {
  const t = el.tags || {};
  if (t.amenity !== 'parking') return null;
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;
  const access = (t.access || 'yes').toLowerCase();
  if (BLOCKED_ACCESS.has(access)) return null;
  const feeTag = (t.fee || '').toLowerCase();
  let fee = 'unknown';
  if (feeTag === 'no') fee = 'free';
  else if (feeTag === 'yes' || feeTag.startsWith('sek') || /\d/.test(feeTag)) fee = 'paid';
  if (t['fee:conditional'] && fee === 'unknown') fee = 'paid';

  const kind = {
    'multi-storey': 'Parkeringshus',
    underground: 'Garage',
    surface: 'Parkering',
    street_side: 'Gatuparkering',
    lane: 'Gatuparkering',
  }[t.parking] || 'Parkering';

  return {
    id: `osm-${el.type}-${el.id}`,
    source: 'osm',
    name: t.name || t.operator || kind,
    kind,
    lat,
    lon,
    fee,
    price: t.charge || null,
    maxStay: t.maxstay || null,
    capacity: t.capacity ? parseInt(t.capacity, 10) || null : null,
    freeSpaces: null,
    payCode: t['payment:zone'] || t['zone'] || null,
    access: access === 'customers' ? 'customers' : 'public',
    operator: t.operator || null,
  };
}

// Göteborgs Stads ParkingService -> intern parkering (fältnamn hanteras tolerant)
export function fromGbg(item, kind) {
  const lat = num(item.Lat ?? item.lat ?? item.Latitude);
  const lon = num(item.Long ?? item.Lon ?? item.lng ?? item.Longitude);
  if (lat == null || lon == null) return null;
  const isFree = kind === 'time';
  const price = item.ParkingCost || item.ParkingCharge ||
    (item.CurrentParkingCost != null && item.CurrentParkingCost !== '' ? `${item.CurrentParkingCost} kr/h` : null);
  return {
    id: `gbg-${kind}-${item.Id ?? `${lat},${lon}`}`,
    source: 'gbg',
    name: item.Name || (isFree ? 'Gatuparkering' : 'Avgiftsparkering'),
    kind: isFree ? 'Gatuparkering (tidsbegränsad)' : 'Avgiftsparkering',
    lat,
    lon,
    fee: isFree ? 'free' : 'paid',
    price: isFree ? null : price,
    maxStay: item.MaxParkingTime || null,
    capacity: num(item.ParkingSpaces),
    freeSpaces: freshFreeSpaces(item),
    currentRate: num(item.CurrentParkingCost),
    payCode: item.PhoneParkingCode ? String(item.PhoneParkingCode).trim() : null,
    access: 'public',
    operator: item.Owner || 'Göteborgs Stad',
    extra: item.ExtraInfo || null,
    restriction: item.MaxParkingTimeLimitation || null,
  };
}

// Lediga platser räknas bara om uppgiften är färsk (max 30 min gammal) eller saknar tidsstämpel
export function freshFreeSpaces(item, now = Date.now()) {
  const n = num(item.FreeSpaces ?? item.FreeParkingSpaces);
  if (n == null) return null;
  const raw = item.FreeSpacesDate;
  if (!raw) return n;
  const ms = parseGbgDate(raw);
  if (ms == null) return n;
  return now - ms <= 30 * 60 * 1000 ? n : null;
}

// Hanterar både ISO-datum och .NET-formatet "/Date(1700000000000+0100)/"
export function parseGbgDate(v) {
  const m = /\/Date\((-?\d+)/.exec(String(v));
  if (m) return Number(m[1]);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Slå ihop källor, räkna avstånd, ta bort dubbletter (inom 25 m med samma avgiftsstatus)
export function prepare(parkings, dest) {
  const withDist = parkings
    .filter(Boolean)
    .map((p) => ({ ...p, distance: haversine(dest.lat, dest.lon, p.lat, p.lon) }))
    .sort((a, b) => a.distance - b.distance);
  const out = [];
  for (const p of withDist) {
    const dup = out.find(
      (q) => q.fee === p.fee && haversine(p.lat, p.lon, q.lat, q.lon) < 25
    );
    if (dup) {
      // föredra kommunal data (har pris/tidsgräns)
      if (p.source === 'gbg' && dup.source !== 'gbg') out[out.indexOf(dup)] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

// Ett fullt känt objekt räknas som fullt och väljs inte som förslag
const isFull = (p) => p.freeSpaces != null && p.freeSpaces <= 0;

// Plats som passar vald parkeringstid (eller saknar bedömning)
export const fits = (p) => !isFull(p) && p.eval?.ok !== false;

// Tre förslag. Kort 2 blir aldrig samma plats som kort 3:
// är närmaste plats gratis visas närmaste avgiftsparkering i kort 2 istället.
export function pickOptions(list) {
  const usable = list.filter((p) => fits(p) && p.access === 'public');
  const nearestFree = usable.find((p) => p.fee === 'free') || null;

  let nearest = usable[0] || null;
  if (nearest && nearest.fee === 'unknown') {
    const known = usable.find((p) => p.fee !== 'unknown');
    if (known && known.distance - nearest.distance <= 150) nearest = known;
  }
  let nearestTitle = 'Närmaste parkering';
  if (nearest && nearestFree && nearest.id === nearestFree.id) {
    nearest = usable.find((p) => p.fee === 'paid') || usable.find((p) => p.id !== nearestFree.id) || null;
    nearestTitle = nearest?.fee === 'paid' ? 'Närmaste avgiftsparkering' : 'Annan parkering';
  }
  return { nearest, nearestFree, nearestTitle };
}

export function applyFilters(list, { maxDistance = Infinity, fee = 'all', hideCustomers = false, onlyFits = false } = {}) {
  return list.filter((p) => {
    if (onlyFits && !fits(p)) return false;
    if (p.distance > maxDistance) return false;
    if (fee === 'free' && p.fee !== 'free') return false;
    if (fee === 'paid' && p.fee !== 'paid') return false;
    if (hideCustomers && p.access === 'customers') return false;
    return true;
  });
}

// Djuplänkar som startar bilnavigation i vald kartapp
export function navUrl(app, lat, lon, label = '') {
  const ll = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  switch (app) {
    case 'google':
      return `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving&dir_action=navigate`;
    case 'waze':
      return `https://waze.com/ul?ll=${ll}&navigate=yes`;
    case 'apple':
    default:
      return `https://maps.apple.com/?daddr=${ll}&dirflg=d${label ? `&q=${encodeURIComponent(label)}` : ''}`;
  }
}

export function feeLabel(p) {
  if (p.fee === 'free') return p.maxStay ? `Gratis · max ${p.maxStay}` : 'Gratis';
  if (p.fee === 'paid') return p.price ? `Avgift · ${p.price}` : 'Avgift';
  return 'Avgift okänd';
}

export function buildOverpassQuery(lat, lon, radius) {
  return `[out:json][timeout:20];nwr["amenity"="parking"](around:${Math.round(radius)},${lat},${lon});out center tags;`;
}

// ---------- Betalning ----------
// Appar som kan betala Göteborgs Stads parkeringar. Att öppna en annan app från en webbsida
// fungerar inte pålitligt, så vi länkar till appens butikssida (visar "Öppna" om den finns installerad).
export const PAY_APPS = {
  pgbg: { name: 'Parkering Göteborg', ios: 'https://apps.apple.com/se/app/id1184264972', android: 'https://play.google.com/store/search?q=Parkering%20G%C3%B6teborg&c=apps' },
  easypark: { name: 'EasyPark', ios: 'https://apps.apple.com/se/app/id449594317', android: 'https://play.google.com/store/search?q=EasyPark&c=apps' },
  parkster: { name: 'Parkster', ios: 'https://apps.apple.com/se/app/id533140250', android: 'https://play.google.com/store/search?q=Parkster&c=apps' },
};
export function payAppUrl(key, isIos) {
  const a = PAY_APPS[key] || PAY_APPS.pgbg;
  return isIos ? a.ios : a.android;
}

// Delningslänk till appen, valfritt med nyckel
export function shareUrl(base, appId) {
  const u = new URL(base);
  u.search = '';
  u.hash = '';
  if (appId) u.searchParams.set('appid', appId);
  return u.toString();
}
