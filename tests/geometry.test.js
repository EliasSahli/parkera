import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWKT, gridToLatLon, PROJ, toWgs84, osmGeometry, centroid } from '../geometry.js';
import { fromGbg, fromOsm } from '../core.js';
import { appleStyle, PALETTE } from '../mapstyle.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
// Göteborg, Brunnsparken-ish. Referensvärden framtagna med proj4.
const LON = 11.9746;
const LAT = 57.7089;
const TM = [319758.0, 6400326.0];
const S1200 = [148485.9, 6398861.7];

test('WKT: alla geometrityper', () => {
  assert.deepEqual(parseWKT('POINT (11.97 57.70)'), { type: 'Point', coordinates: [11.97, 57.7] });
  assert.deepEqual(parseWKT('LINESTRING(1 2, 3 4)').coordinates, [[1, 2], [3, 4]]);
  assert.deepEqual(parseWKT('POLYGON ((0 0, 1 0, 1 1, 0 0))').coordinates, [[[0, 0], [1, 0], [1, 1], [0, 0]]]);
  assert.equal(parseWKT('MULTILINESTRING ((0 0, 1 1), (2 2, 3 3))').coordinates.length, 2);
  assert.equal(parseWKT('MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5)))').coordinates.length, 2);
  assert.equal(parseWKT('SRID=3007;POINT (1 2)').type, 'Point');
  assert.equal(parseWKT('LINESTRING Z (1 2 3, 4 5 6)').coordinates[1][1], 5);
  assert.equal(parseWKT(''), null);
  assert.equal(parseWKT('nonsens'), null);
});

test('SWEREF 99 TM och 12 00 till WGS84 (jämfört med proj4)', () => {
  const [lon1, lat1] = gridToLatLon(TM[1], TM[0], PROJ.tm);
  const [lon2, lat2] = gridToLatLon(S1200[1], S1200[0], PROJ['1200']);
  assert.ok(near(lon1, LON, 1e-5) && near(lat1, LAT, 1e-5), `${lon1} ${lat1}`);
  assert.ok(near(lon2, LON, 1e-5) && near(lat2, LAT, 1e-5), `${lon2} ${lat2}`);
});

test('Koordinatsystem gissas rätt utifrån platsens position', () => {
  const cases = [
    `LINESTRING (${TM[0]} ${TM[1]}, ${TM[0] + 20} ${TM[1]})`, // TM, öst nord
    `LINESTRING (${S1200[0]} ${S1200[1]}, ${S1200[0] + 20} ${S1200[1]})`, // 12 00, öst nord
    `LINESTRING (${S1200[1]} ${S1200[0]}, ${S1200[1]} ${S1200[0] + 20})`, // 12 00, nord öst
    `LINESTRING (${LON} ${LAT}, 11.9749 ${LAT})`, // WGS84
    `LINESTRING (${LAT} ${LON}, ${LAT} 11.9749)`, // WGS84 lat/lon
  ];
  for (const w of cases) {
    const g = toWgs84(parseWKT(w), LAT, LON);
    assert.ok(g, w);
    const [lon, lat] = g.coordinates[0];
    assert.ok(near(lon, LON, 1e-4) && near(lat, LAT, 1e-4), `${w} -> ${lon},${lat}`);
  }
  // Långt från platsen -> ingen geometri hellre än fel geometri
  assert.equal(toWgs84(parseWKT('POINT (12.5 58.5)'), LAT, LON), null);
});

test('Göteborgs data får sin form från WKT', () => {
  const p = fromGbg({ Id: 'X', Name: 'Vasagatan', Lat: LAT, Long: LON, WKT: `LINESTRING (${S1200[0]} ${S1200[1]}, ${S1200[0] + 40} ${S1200[1] + 10})` }, 'time');
  assert.equal(p.geom.type, 'LineString');
  assert.equal(p.geom.coordinates.length, 2);
  assert.equal(fromGbg({ Lat: LAT, Long: LON }, 'time').geom, null);
});

test('OSM: parkeringsyta blir polygon med nål i mitten', () => {
  const el = {
    type: 'way', id: 5, tags: { amenity: 'parking', fee: 'no' },
    geometry: [{ lat: 57.70, lon: 11.97 }, { lat: 57.70, lon: 11.972 }, { lat: 57.701, lon: 11.972 }, { lat: 57.701, lon: 11.97 }, { lat: 57.70, lon: 11.97 }],
  };
  const g = osmGeometry(el);
  assert.equal(g.type, 'Polygon');
  const c = centroid(g);
  assert.ok(near(c.lat, 57.7005, 1e-9) && near(c.lon, 11.971, 1e-9));
  const p = fromOsm(el);
  assert.ok(near(p.lat, 57.7005, 1e-9));
  assert.equal(p.geom.type, 'Polygon');
  // Gatuparkering som linje (ej sluten)
  assert.equal(osmGeometry({ type: 'way', geometry: [{ lat: 1, lon: 1 }, { lat: 1, lon: 2 }] }).type, 'LineString');
  // Relation med yttre ring
  const rel = { type: 'relation', members: [{ role: 'outer', geometry: el.geometry }, { role: 'inner', geometry: el.geometry }] };
  assert.equal(osmGeometry(rel).coordinates.length, 1);
});

test('Apple-stil: lager färgas och onödiga lager tas bort', () => {
  const style = {
    version: 8, sources: {}, layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#000' } },
      { id: 'natural_earth', type: 'raster' },
      { id: 'park', type: 'fill', paint: { 'fill-color': '#0f0' } },
      { id: 'water', type: 'fill', paint: { 'fill-color': '#00f' } },
      { id: 'road_minor', type: 'line', paint: { 'line-color': '#f00', 'line-width': 2 } },
      { id: 'road_trunk_primary_casing', type: 'line', paint: { 'line-color': '#f00' } },
      { id: 'building', type: 'fill', paint: { 'fill-color': '#999' } },
      { id: 'building-3d', type: 'fill-extrusion' },
      { id: 'label_city', type: 'symbol', paint: { 'text-color': '#000' } },
    ],
  };
  const light = appleStyle(style, false);
  const dark = appleStyle(style, true);
  const get = (s, id) => s.layers.find((l) => l.id === id);
  assert.equal(get(light, 'natural_earth'), undefined);
  assert.equal(get(light, 'building-3d'), undefined);
  assert.equal(get(light, 'background').paint['background-color'], PALETTE.light.bg);
  assert.equal(get(dark, 'park').paint['fill-color'], PALETTE.dark.park);
  assert.equal(get(dark, 'water').paint['fill-color'], PALETTE.dark.water);
  assert.equal(get(light, 'road_minor').paint['line-color'], PALETTE.light.roadMinor);
  assert.equal(get(light, 'road_minor').paint['line-width'], 2, 'övriga egenskaper behålls');
  assert.equal(get(light, 'road_trunk_primary_casing').paint['line-color'], PALETTE.light.roadMajorCase);
  assert.equal(get(dark, 'label_city').paint['text-color'], PALETTE.dark.textMajor);
  assert.equal(style.layers.length, 9, 'originalet ändras inte');
});

import { prepare, borrowShapes } from '../core.js';

test('P-hus utan form i Göteborgs data får formen från OSM-ytan den ligger i', () => {
  const ring = [{ lat: 57.700, lon: 11.980 }, { lat: 57.700, lon: 11.986 }, { lat: 57.703, lon: 11.986 }, { lat: 57.703, lon: 11.980 }, { lat: 57.700, lon: 11.980 }];
  const osm = fromOsm({ type: 'way', id: 77, tags: { amenity: 'parking', fee: 'yes', name: 'Heden', capacity: '700' }, geometry: ring });
  // Göteborgs punkt ligger inne på ytan men långt från OSM-mittpunkten
  const gbg = fromGbg({ Id: 'H', Name: 'P-hus Heden', ParkingSpaces: 728, ParkingCost: '32 kr/tim', Lat: 57.7005, Long: 11.9805, WKT: 'POINT (11.9805 57.7005)' }, 'private');
  const list = prepare([osm, gbg], { lat: 57.701, lon: 11.982 });
  assert.equal(list.length, 1, 'samma anläggning visas en gång');
  assert.equal(list[0].name, 'P-hus Heden');
  assert.equal(list[0].capacity, 728, 'Göteborgs uppgifter behålls');
  assert.equal(list[0].geom.type, 'Polygon', 'formen kommer från OSM');
  // Punkt utanför ytan lånar inte formen
  const far = fromGbg({ Id: 'F', Name: 'Annat', Lat: 57.71, Long: 11.99 }, 'private');
  const out = borrowShapes([osm, far]);
  assert.equal(out.length, 2);
  assert.equal(out[1].geom, null);
});
