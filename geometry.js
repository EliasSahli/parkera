// geometry.js – parkeringsytornas form (för konturerna på kartan)
// Ren logik, testbar i Node. All geometri returneras som GeoJSON i [lon, lat].

// ---------- WKT ----------
// Stödjer POINT, LINESTRING, POLYGON, MULTILINESTRING, MULTIPOLYGON (med ev. "SRID=xxxx;")
export function parseWKT(wkt) {
  if (!wkt || typeof wkt !== 'string') return null;
  const s = wkt.trim().replace(/^SRID=\d+;/i, '');
  const m = /^(MULTIPOLYGON|MULTILINESTRING|POLYGON|LINESTRING|POINT)\s*(?:Z|M|ZM)?\s*(\(.*\))\s*$/is.exec(s);
  if (!m) return null;
  const type = m[1].toUpperCase();
  let pos = 0;
  const body = m[2];
  // Rekursiv parser för nästlade parenteser -> nästlade arrayer av [x, y]
  function parse() {
    const out = [];
    pos++; // '('
    while (pos < body.length) {
      const c = body[pos];
      if (c === '(') out.push(parse());
      else if (c === ')') { pos++; return out; }
      else if (c === ',' || /\s/.test(c)) pos++;
      else {
        const end = body.slice(pos).search(/[,)]/);
        const chunk = body.slice(pos, pos + end).trim();
        const nums = chunk.split(/\s+/).map(Number);
        if (nums.length >= 2 && nums.every(Number.isFinite)) out.push([nums[0], nums[1]]);
        pos += end;
      }
    }
    return out;
  }
  let coords;
  try { coords = parse(); } catch { return null; }
  const map = {
    POINT: ['Point', coords[0]],
    LINESTRING: ['LineString', coords],
    POLYGON: ['Polygon', coords],
    MULTILINESTRING: ['MultiLineString', coords],
    MULTIPOLYGON: ['MultiPolygon', coords],
  };
  const [gtype, c] = map[type];
  if (!c || (Array.isArray(c) && !c.length)) return null;
  return { type: gtype, coordinates: c };
}

// ---------- SWEREF 99 -> WGS84 (Gauss–Krüger, Lantmäteriets formler) ----------
const GRS80 = { a: 6378137, f: 1 / 298.257222101 };
export const PROJ = {
  tm: { lon0: 15, k0: 0.9996, fe: 500000, fn: 0 }, // SWEREF 99 TM (EPSG:3006)
  '1200': { lon0: 12, k0: 1, fe: 150000, fn: 0 }, // SWEREF 99 12 00 (EPSG:3007) – Göteborgs lokala
};

export function gridToLatLon(northing, easting, p) {
  const { a, f } = GRS80;
  const e2 = f * (2 - f);
  const n = f / (2 - f);
  const aRoof = (a / (1 + n)) * (1 + (n * n) / 4 + (n ** 4) / 64);
  const d1 = n / 2 - (2 * n * n) / 3 + (37 * n ** 3) / 96 - (n ** 4) / 360;
  const d2 = (n * n) / 48 + (n ** 3) / 15 - (437 * n ** 4) / 1440;
  const d3 = (17 * n ** 3) / 480 - (37 * n ** 4) / 840;
  const d4 = (4397 * n ** 4) / 161280;
  const As = e2 + e2 ** 2 + e2 ** 3 + e2 ** 4;
  const Bs = -(7 * e2 ** 2 + 17 * e2 ** 3 + 30 * e2 ** 4) / 6;
  const Cs = (224 * e2 ** 3 + 889 * e2 ** 4) / 120;
  const Ds = -(4279 * e2 ** 4) / 1260;
  const xi = (northing - p.fn) / (p.k0 * aRoof);
  const eta = (easting - p.fe) / (p.k0 * aRoof);
  const xiP = xi
    - d1 * Math.sin(2 * xi) * Math.cosh(2 * eta)
    - d2 * Math.sin(4 * xi) * Math.cosh(4 * eta)
    - d3 * Math.sin(6 * xi) * Math.cosh(6 * eta)
    - d4 * Math.sin(8 * xi) * Math.cosh(8 * eta);
  const etaP = eta
    - d1 * Math.cos(2 * xi) * Math.sinh(2 * eta)
    - d2 * Math.cos(4 * xi) * Math.sinh(4 * eta)
    - d3 * Math.cos(6 * xi) * Math.sinh(6 * eta)
    - d4 * Math.cos(8 * xi) * Math.sinh(8 * eta);
  const phiS = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  const dLon = Math.atan(Math.sinh(etaP) / Math.cos(xiP));
  const s2 = Math.sin(phiS) ** 2;
  const lat = phiS + Math.sin(phiS) * Math.cos(phiS) * (As + Bs * s2 + Cs * s2 ** 2 + Ds * s2 ** 3);
  return [p.lon0 + (dLon * 180) / Math.PI, (lat * 180) / Math.PI]; // [lon, lat]
}

// ---------- Hjälpfunktioner ----------
function mapCoords(geom, fn) {
  const walk = (c) => (typeof c[0] === 'number' ? fn(c) : c.map(walk));
  return { type: geom.type, coordinates: walk(geom.coordinates) };
}
function firstCoord(geom) {
  let c = geom.coordinates;
  while (Array.isArray(c[0])) c = c[0];
  return c;
}
function distM(lon1, lat1, lon2, lat2) {
  const k = 111320;
  return Math.hypot((lon2 - lon1) * k * Math.cos((lat1 * Math.PI) / 180), (lat2 - lat1) * k);
}

// Gör om WKT-geometri till WGS84. Koordinatsystemet gissas och kontrolleras mot
// platsens kända position (refLat/refLon) – den tolkning som hamnar närmast vinner.
export function toWgs84(geom, refLat, refLon, maxOffsetM = 1500) {
  if (!geom) return null;
  const [x, y] = firstCoord(geom);
  const candidates = [];
  if (Math.abs(x) <= 180 && Math.abs(y) <= 90) {
    candidates.push(geom); // redan lon/lat
    candidates.push(mapCoords(geom, ([a, b]) => [b, a])); // lat/lon omvänt
  } else {
    // Projicerat i meter. Både "öst nord" och "nord öst" förekommer.
    for (const p of Object.values(PROJ)) {
      candidates.push(mapCoords(geom, ([e, n]) => gridToLatLon(n, e, p)));
      candidates.push(mapCoords(geom, ([n, e]) => gridToLatLon(n, e, p)));
    }
  }
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const [lon, lat] = firstCoord(c);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const d = refLat == null ? 0 : distM(lon, lat, refLon, refLat);
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= maxOffsetM ? best : null;
}

// ---------- OpenStreetMap (Overpass "out geom") ----------
const ringClosed = (pts) => pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];

export function osmGeometry(el) {
  if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length > 1) {
    const pts = el.geometry.filter(Boolean).map((g) => [g.lon, g.lat]);
    return ringClosed(pts) ? { type: 'Polygon', coordinates: [pts] } : { type: 'LineString', coordinates: pts };
  }
  if (el.type === 'relation' && Array.isArray(el.members)) {
    const polys = el.members
      .filter((m) => m.role !== 'inner' && Array.isArray(m.geometry))
      .map((m) => m.geometry.filter(Boolean).map((g) => [g.lon, g.lat]))
      .filter(ringClosed)
      .map((ring) => [ring]);
    if (polys.length) return { type: 'MultiPolygon', coordinates: polys };
  }
  return null;
}

// Mittpunkt (medel av hörnen) – räcker för att placera en nål
export function centroid(geom) {
  if (!geom) return null;
  let sx = 0; let sy = 0; let n = 0;
  const walk = (c) => {
    if (typeof c[0] === 'number') { sx += c[0]; sy += c[1]; n++; } else c.forEach(walk);
  };
  if (geom.type === 'Polygon') walk(geom.coordinates[0].slice(0, -1));
  else if (geom.type === 'MultiPolygon') geom.coordinates.forEach((p) => walk(p[0].slice(0, -1)));
  else walk(geom.coordinates);
  return n ? { lon: sx / n, lat: sy / n } : null;
}

// ---------- Punkt i yta ----------
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function pointInGeom(lon, lat, geom) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return inRing(lon, lat, geom.coordinates[0]);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some((p) => inRing(lon, lat, p[0]));
  return false;
}
export const isArea = (g) => Boolean(g) && (g.type === 'Polygon' || g.type === 'MultiPolygon');
export const hasShape = (g) => Boolean(g) && g.type !== 'Point';
