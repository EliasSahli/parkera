// tiles.js – delar upp Göteborgsdatan i rutor (~2,2 x 2,4 km) så att telefonen bara laddar det som behövs.
// Används både av nattjobbet (scripts/build-gbg-snapshot.mjs) och av appen (sources.js).

export const CELL_LAT = 0.02; // ~2,2 km
export const CELL_LON = 0.04; // ~2,4 km på Göteborgs breddgrad

export function cellKey(lat, lon) {
  return `${Math.floor(lat / CELL_LAT)}_${Math.floor(lon / CELL_LON)}`;
}

// Alla rutor som en cirkel med radie radiusM runt (lat, lon) kan beröra
export function cellsForRadius(lat, lon, radiusM) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  const keys = new Set();
  for (let a = Math.floor((lat - dLat) / CELL_LAT); a <= Math.floor((lat + dLat) / CELL_LAT); a++) {
    for (let b = Math.floor((lon - dLon) / CELL_LON); b <= Math.floor((lon + dLon) / CELL_LON); b++) {
      keys.add(`${a}_${b}`);
    }
  }
  return [...keys];
}

// Lista -> { key: [items] }
export function splitIntoCells(items) {
  const cells = {};
  for (const it of items) {
    const k = cellKey(it.lat, it.lon);
    (cells[k] ||= []).push(it);
  }
  return cells;
}
