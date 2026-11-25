// nobil.js – tolkar laddstationer från NOBIL (Enova) och kopplar dem till parkeringar.
// Datan: NOBIL by Enova, CC BY 4.0 (https://nobil.no). Hämtas bara av nattjobbet –
// NOBIL:s villkor tillåter inte att nyckeln eller API-anropen syns i appen.
import { haversine } from './core.js';
import { pointInGeom, isArea, distToAreaM } from './geometry.js';

// Göteborg med kranskommuner (Kungälv–Kungsbacka, Öckerö–Lerum/Alingsås)
export const REGION = { south: 57.35, north: 58.05, west: 11.55, east: 12.6 };

const CONNECTORS = {
  30: 'CHAdeMO', 31: 'Typ 1', 32: 'Typ 2', 39: 'CCS', 40: 'Tesla', 50: 'Typ 2', 60: 'Typ 1/2',
};
const KW = {
  7: 3.7, 8: 7.4, 10: 11, 11: 22, 12: 43, 13: 50, 16: 11, 17: 22, 18: 43, 19: 20, 22: 135, 23: 100,
  24: 150, 25: 350, 29: 75, 30: 225, 31: 250, 32: 200, 33: 300, 36: 400, 37: 30, 38: 62.5, 39: 500, 41: 175, 42: 180,
};
const NON_ELECTRIC = new Set([70, 82]); // vätgas, biogas
const LOCATION = { 1: 'Gata', 2: 'Parkering', 3: 'Flygplats', 4: 'Köpcentrum', 5: 'Resecentrum', 6: 'Hotell/restaurang', 7: 'Bensinstation' };

// Alla attributobjekt ({attrtypeid, attrvalid, ...}) under en nod, oavsett nästling
function attrs(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if ('attrtypeid' in node) { out.push(node); return out; }
  for (const v of Object.values(node)) attrs(v, out);
  return out;
}
const val = (list, type) => {
  const a = list.find((x) => String(x.attrtypeid) === String(type));
  return a ? Number(a.attrvalid) : null;
};

// Positionen kommer som "(57.70681,11.96861)"
export function parsePosition(s) {
  const m = /\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)?/.exec(String(s || ''));
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
}

const inRegion = (lat, lon, r = REGION) => lat >= r.south && lat <= r.north && lon >= r.west && lon <= r.east;

// En station från NOBIL -> kompakt objekt för appen (eller null om den inte är relevant)
export function fromNobil(station, region = REGION) {
  const c = station?.csmd;
  if (!c) return null;
  const pos = parsePosition(c.Position);
  if (!pos || !inRegion(pos.lat, pos.lon, region)) return null;
  // Station_status/Active: betydelsen av koderna är inte dokumenterad – filtrera inte på dem än

  const st = attrs(station.attr?.st);
  const availability = val(st, 2); // 1 publik, 2 besökare, 3 anställda, 4 bokning, 5 boende
  if (availability != null && availability !== 1 && availability !== 2) return null;

  // Uttag: attr.conn är nästlad per uttag – räkna typ och effekt per uttag
  const connectors = {};
  let maxKw = 0;
  let points = 0;
  const connNode = station.attr?.conn || {};
  const perConn = Object.values(connNode).some((v) => v && typeof v === 'object' && !('attrtypeid' in v))
    ? Object.values(connNode)
    : [connNode];
  for (const conn of perConn) {
    const list = attrs(conn);
    const type = val(list, 4);
    if (type != null && NON_ELECTRIC.has(type)) continue;
    points++;
    const name = CONNECTORS[type] || 'Annat';
    connectors[name] = (connectors[name] || 0) + 1;
    maxKw = Math.max(maxKw, KW[val(list, 5)] || 0);
  }
  if (!perConn.some((x) => attrs(x).length)) points = Number(c.Number_charging_points) || 0; // inga uttag beskrivna
  if (!points) return null;

  const fee = val(st, 7); // parkeringsavgift 1 ja, 2 nej
  const address = [c.Street, c.House_number].filter(Boolean).join(' ').trim();
  return {
    id: `nobil-${c.id}`,
    source: 'nobil',
    name: String(c.name || address || 'Laddplats').trim(),
    lat: pos.lat,
    lon: pos.lon,
    address: [address, c.City].filter(Boolean).join(', ') || null,
    owner: c.Owned_by || null,
    location: LOCATION[val(st, 3)] || null,
    access: availability === 2 ? 'customers' : 'public',
    parkingFee: fee === 1 ? true : fee === 2 ? false : null,
    open24h: val(st, 24) === 1 ? true : val(st, 24) === 2 ? false : null,
    timeLimit: val(st, 6) === 1 ? true : val(st, 6) === 2 ? false : null,
    charging: { points, maxKw: maxKw || null, connectors },
  };
}

// Hela svaret (datadump eller sökning). Tål BOM och både {chargerstations:[...]} och en ren lista.
export function parseNobil(text, region = REGION) {
  const data = typeof text === 'string' ? JSON.parse(text.replace(/^﻿/, '')) : text;
  const list = Array.isArray(data) ? data : data?.chargerstations || data?.ChargerStations || [];
  return list.map((s) => fromNobil(s, region)).filter(Boolean);
}

function mergeCharging(a, b) {
  if (!a) return b;
  const connectors = { ...a.connectors };
  for (const [k, n] of Object.entries(b.connectors || {})) connectors[k] = (connectors[k] || 0) + n;
  return {
    points: a.points + b.points,
    maxKw: Math.max(a.maxKw || 0, b.maxKw || 0) || null,
    connectors,
    stations: [...(a.stations || []), ...(b.stations || [])],
  };
}

// Kopplar laddstationer till parkeringen de står på (inuti ytan eller inom 40 m).
// Stationer utan parkering blir egna poster som bara visas när man vill ladda (evOnly).
// Körs efter prepare(): parkings är färdiga (med former och avstånd), dest behövs för de fristående.
export function attachChargers(parkings, chargers, dest) {
  if (!chargers || !chargers.length) return parkings;
  const out = parkings.map((p) => ({ ...p }));
  const standalone = [];
  for (const ch of chargers) {
    const info = { ...ch.charging, stations: [{ name: ch.name, owner: ch.owner }] };
    let best = null;
    let bestD = 40;
    for (const p of out) {
      if (Math.abs(p.lat - ch.lat) > 0.01 || Math.abs(p.lon - ch.lon) > 0.02) continue;
      if (p.access === 'private') continue;
      let d;
      if (p.geom && isArea(p.geom)) d = pointInGeom(ch.lon, ch.lat, p.geom) ? 0 : distToAreaM(ch.lon, ch.lat, p.geom);
      else d = haversine(p.lat, p.lon, ch.lat, ch.lon);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) best.charging = mergeCharging(best.charging, info);
    else {
      standalone.push({
        ...ch,
        distance: dest ? haversine(dest.lat, dest.lon, ch.lat, ch.lon) : 0,
        kind: 'Laddplats',
        evOnly: true,
        fee: ch.parkingFee === false ? 'free' : ch.parkingFee === true ? 'paid' : 'unknown',
        charging: info,
        extra: [ch.address, ch.location, ch.open24h === false ? 'Ej öppet dygnet runt' : ''].filter(Boolean).join(' · ') || null,
      });
    }
  }
  return [...out, ...standalone].sort((a, b) => a.distance - b.distance);
}

export function chargingText(c) {
  if (!c) return '';
  const types = Object.entries(c.connectors || {}).map(([k, n]) => `${n}× ${k}`).join(', ');
  return `⚡ ${c.points} uttag${c.maxKw ? ` · upp till ${String(c.maxKw).replace('.', ',')} kW` : ''}${types ? ` (${types})` : ''}`;
}
