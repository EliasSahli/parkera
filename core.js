// core.js – ren logik utan nätverk eller DOM (testbar i Node)
import {
  parseWKT, toWgs84, osmGeometry, centroid, pointInGeom, isArea, hasShape,
  distToAreaM, areaM2, circlePolygon, M2_PER_SPACE,
} from './geometry.js';

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
  const geom = osmGeometry(el);
  const mid = el.center || centroid(geom);
  const lat = el.lat ?? mid?.lat;
  const lon = el.lon ?? mid?.lon;
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
    geom,
    access: access === 'customers' ? 'customers' : 'public',
    operator: t.operator || null,
  };
}

// Göteborgs Stads ParkingService -> intern parkering (fältnamn hanteras tolerant)
// kind: 'time' = gratis gatuparkering, 'toll' = avgift på gata,
//       'private' = p-hus/garage/privat mark med avgift, 'commuter' = pendelparkering
const GBG_KIND = {
  time: { label: 'Gatuparkering (tidsbegränsad)', fallback: 'Gatuparkering' },
  toll: { label: 'Avgiftsparkering', fallback: 'Avgiftsparkering' },
  private: { label: 'Parkeringshus / anläggning', fallback: 'Parkeringsanläggning' },
  commuter: { label: 'Pendelparkering', fallback: 'Pendelparkering' },
  handicap: { label: 'Parkering för rörelsehindrade', fallback: 'Parkering för rörelsehindrade' },
};

// Avgiftsstatus ur fritext (pendelparkeringar m.fl.)
export function feeFromText(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return 'unknown';
  if (/gratis|avgiftsfri|ingen avgift|kostnadsfri|^0 ?kr|utan avgift/.test(t)) return 'free';
  if (/\d\s*(kr|:-|sek)|avgift|taxa/.test(t)) return 'paid';
  return 'unknown';
}

export function fromGbg(item, kind) {
  const lat = num(item.Lat ?? item.lat ?? item.Latitude);
  const lon = num(item.Long ?? item.Lon ?? item.lng ?? item.Longitude);
  if (lat == null || lon == null) return null;
  const k = GBG_KIND[kind] || GBG_KIND.toll;
  const priceText = item.ParkingCost || item.ParkingCharge ||
    (item.CurrentParkingCost != null && item.CurrentParkingCost !== '' ? `${item.CurrentParkingCost} kr/h` : null);
  let fee;
  if (kind === 'time' || kind === 'handicap') fee = 'free'; // rörelsehindrade: avgiftsfritt med tillstånd
  else if (kind === 'commuter') fee = feeFromText([priceText, item.ExtraInfo].filter(Boolean).join('. '));
  else if (kind === 'private' && !priceText && !/kr|avgift/i.test(item.ExtraInfo || '')) fee = 'unknown'; // ingen prisuppgift alls
  else fee = feeFromText(priceText) === 'free' ? 'free' : 'paid';
  const defaultOwner = kind === 'private' ? null : 'Göteborgs Stad';
  return {
    id: `gbg-${kind}-${item.Id ?? `${lat},${lon}`}`,
    source: 'gbg',
    gbgKind: kind,
    name: item.Name || k.fallback,
    kind: k.label,
    lat,
    lon,
    fee,
    price: fee === 'free' ? null : priceText,
    maxStay: item.MaxParkingTime || null,
    capacity: num(item.ParkingSpaces),
    freeSpaces: freshFreeSpaces(item),
    currentRate: num(item.CurrentParkingCost),
    payCode: item.PhoneParkingCode ? String(item.PhoneParkingCode).trim() : null,
    access: 'public',
    operator: item.Owner || defaultOwner,
    extra: item.ExtraInfo || null,
    restriction: item.MaxParkingTimeLimitation || null,
    geom: item.WKT ? toWgs84(parseWKT(item.WKT), lat, lon) : null,
    ...(kind === 'handicap' ? { prh: true } : {}), // kräver parkeringstillstånd för rörelsehindrade
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
// Göteborgs data saknar ofta form för p-hus och parkeringsytor (bara en punkt).
// Ligger punkten inuti en OSM-yta är det samma anläggning: Göteborgs uppgifter
// (pris, platser, lediga) behålls och formen lånas från OSM.
export function borrowShapes(parkings) {
  const areas = parkings.filter((p) => p && p.source === 'osm' && isArea(p.geom));
  const used = new Set();
  const out = parkings.filter(Boolean).map((p) => {
    if (p.source === 'curated' && p.osmId) used.add(p.osmId); // samma anläggning som OSM-ytan
    if ((p.source !== 'gbg' && p.source !== 'curated') || hasShape(p.geom)) return p;
    // Punkten inuti en yta, annars närmaste yta vars kant ligger inom 35 m (t.ex. punkt vid infarten)
    let area = areas.find((a) => !used.has(a.id) && pointInGeom(p.lon, p.lat, a.geom));
    if (!area) {
      let best = 35;
      for (const a of areas) {
        if (used.has(a.id) || haversine(p.lat, p.lon, a.lat, a.lon) > 400) continue;
        const d = distToAreaM(p.lon, p.lat, a.geom);
        if (d < best) { best = d; area = a; }
      }
    }
    if (!area) return p;
    used.add(area.id);
    return { ...p, geom: area.geom, capacity: p.capacity ?? area.capacity };
  });
  return out.filter((p) => !used.has(p.id));
}

// Form och kapacitet där källorna saknar dem:
//  - ingen form alls -> ungefärlig cirkel efter antal platser (ritas streckad på kartan)
//  - markparkering med yta men utan antal platser -> uppskattat antal (yta / 25 m²)
export function addEstimates(p) {
  let q = p;
  if (!hasShape(q.geom)) {
    const spaces = Math.max(q.capacity ?? 15, 6);
    const r = Math.min(45, Math.max(9, Math.sqrt((spaces * M2_PER_SPACE) / Math.PI)));
    q = { ...q, geom: circlePolygon(q.lon, q.lat, r), geomEst: true };
  } else if (q.capacity == null && isArea(q.geom) && !/Parkeringshus|Garage|anläggning/i.test(q.kind || '')) {
    const est = Math.round(areaM2(q.geom) / M2_PER_SPACE);
    if (est >= 2) q = { ...q, capacityEst: est };
  }
  return q;
}

export function prepare(parkings, dest) {
  const withDist = borrowShapes(parkings)
    .map((p) => ({ ...p, distance: haversine(dest.lat, dest.lon, p.lat, p.lon) }))
    .sort((a, b) => a.distance - b.distance);
  const out = [];
  for (const p of withDist) {
    const dup = out.find((q) => {
      const d = haversine(p.lat, p.lon, q.lat, q.lon);
      // p-hus/garage är stora: samma anläggning kan ha olika mittpunkt i olika källor
      if (isGarage(p) && isGarage(q) && p.source !== q.source) return d < 90;
      return q.fee === p.fee && d < 25;
    });
    if (dup) {
      // föredra kommunal data (har pris/tidsgräns), men behåll formen om bara OSM har den
      if (p.source === 'gbg' && dup.source !== 'gbg') {
        out[out.indexOf(dup)] = hasShape(p.geom) || !hasShape(dup.geom) ? p : { ...p, geom: dup.geom };
      } else if (!hasShape(dup.geom) && hasShape(p.geom)) {
        out[out.indexOf(dup)] = { ...dup, geom: p.geom };
      }
      continue;
    }
    out.push(p);
  }
  // Uppskattningar sist, så att riktiga former från andra källor vinner vid sammanslagning
  return out.map(addEstimates);
}

function isGarage(p) {
  return p.gbgKind === 'private' || /Parkeringshus|Garage/.test(p.kind || '');
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
  return `[out:json][timeout:20];nwr["amenity"="parking"](around:${Math.round(radius)},${lat},${lon});out geom;`;
}

// ---------- Betalning ----------
// 'open' = länk som öppnar appen direkt (Universal Link, verifierad via appens
// apple-app-site-association hos Apple). Finns ingen sådan används appbutiken.
// Ingen av apparna har ett offentligt sätt att ta emot zonkoden via länk,
// därför kopieras koden till urklipp innan appen öppnas.
export const PAY_APPS = {
  parkster: {
    name: 'Parkster',
    open: 'https://www.parkster.com/app',
    ios: 'https://apps.apple.com/se/app/id533140250',
    android: 'https://play.google.com/store/search?q=Parkster&c=apps',
  },
  easypark: {
    name: 'EasyPark',
    open: 'https://easypark.app.link/',
    ios: 'https://apps.apple.com/se/app/id449594317',
    android: 'https://play.google.com/store/search?q=EasyPark&c=apps',
  },
  pgbgShortcut: {
    name: 'Parkering Göteborg',
    // iPhone-genväg som öppnar appen (skapas en gång av användaren, se inställningar)
    open: 'shortcuts://run-shortcut?name=' + encodeURIComponent('Betala parkering'),
    ios: 'https://apps.apple.com/se/app/id1184264972',
    android: 'https://play.google.com/store/search?q=Parkering%20G%C3%B6teborg&c=apps',
    iosOnly: true,
  },
  pgbg: {
    name: 'Parkering Göteborg',
    open: null,
    ios: 'https://apps.apple.com/se/app/id1184264972',
    android: 'https://play.google.com/store/search?q=Parkering%20G%C3%B6teborg&c=apps',
  },
};
export function payAppUrl(key, isIos) {
  const a = PAY_APPS[key] || PAY_APPS.parkster;
  if (a.iosOnly && !isIos) return a.android;
  return a.open || (isIos ? a.ios : a.android);
}
export const opensDirectly = (key, isIos = true) => {
  const a = PAY_APPS[key] || PAY_APPS.parkster;
  return Boolean(a.open) && (!a.iosOnly || isIos);
};

// Delningslänk till appen, valfritt med nyckel
export function shareUrl(base, appId) {
  const u = new URL(base);
  u.search = '';
  u.hash = '';
  if (appId) u.searchParams.set('appid', appId);
  return u.toString();
}

// ---------- Felrapport ----------
// Förifylld GitHub-issue med allt som behövs för att återskapa felet
export const REPO_ISSUES = 'https://github.com/EliasSahli/parkera/issues/new';
export function reportUrl(p, ctx = {}) {
  const lines = [
    '**Vad är fel?**',
    '(skriv här: t.ex. "skylten säger max 2 tim", "platsen finns inte", "fel pris")',
    '',
    '---',
    `Plats: ${p.name} (${p.id})`,
    `Källa: ${p.source}${p.gbgKind ? ` / ${p.gbgKind}` : ''} · ${p.kind || ''}`,
    `Position: ${p.lat?.toFixed?.(5)}, ${p.lon?.toFixed?.(5)}`,
    p.price ? `Pris (källa): ${p.price}` : '',
    p.maxStay ? `Maxtid (källa): ${p.maxStay}` : '',
    p.restriction ? `Tidsgräns (källa): ${p.restriction}` : '',
    p.extra ? `Övrigt (källa): ${p.extra}` : '',
    `Appens tolkning: ${p.eval ? (p.eval.ok ? `passar, kostnad ${p.eval.cost ?? 'okänd'} kr` : `passar inte – ${p.eval.reason}`) : '–'}`,
    ctx.dur ? `Vald tid: ${ctx.dur} min från ${ctx.arrival}` : '',
    ctx.version ? `Appversion: ${ctx.version}` : '',
  ].filter((l) => l !== '');
  const q = new URLSearchParams({ title: `Fel vid ${p.name}`, body: lines.join('\n'), labels: 'datafel' });
  return `${REPO_ISSUES}?${q}`;
}
