// mapstyle.js – färgsätter OpenFreeMaps "liberty"-stil som Apple Kartor (ljust och mörkt läge)
// Ren funktion: tar stil-JSON och returnerar en ändrad kopia. Testbar i Node.

export const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

export const PALETTE = {
  light: {
    bg: '#f4f2ee',
    residential: '#f1efea',
    park: '#cfe8c3',
    wood: '#c4e2b6',
    water: '#9fcff2',
    waterLine: '#9fcff2',
    sand: '#f3ecd7',
    school: '#ece7f1',
    hospital: '#f6e3e3',
    building: '#e4e1db',
    buildingLine: '#d6d2cb',
    roadMinor: '#ffffff',
    roadMinorCase: '#ddd9d2',
    roadSecondary: '#ffffff',
    roadSecondaryCase: '#d3cec6',
    roadMajor: '#fde49b',
    roadMajorCase: '#e6c46b',
    motorway: '#f9c768',
    motorwayCase: '#d9a44a',
    path: '#d9d5ce',
    rail: '#c9c6c0',
    aeroway: '#e8e5e0',
    boundary: '#b9b4c9',
    text: '#4a4a4f',
    textMajor: '#2a2a2e',
    halo: 'rgba(255,255,255,0.9)',
    waterText: '#3d7fb8',
  },
  dark: {
    bg: '#2c3343',
    residential: '#2f3647',
    park: '#24504a',
    wood: '#22483f',
    water: '#1d3a57',
    waterLine: '#1d3a57',
    sand: '#3a3c40',
    school: '#3a3550',
    hospital: '#4a3540',
    building: '#3d4558',
    buildingLine: '#4a5367',
    roadMinor: '#4d5669',
    roadMinorCase: '#4d5669',
    roadSecondary: '#5d667b',
    roadSecondaryCase: '#5d667b',
    roadMajor: '#6f7891',
    roadMajorCase: '#6f7891',
    motorway: '#8a7a55',
    motorwayCase: '#8a7a55',
    path: '#465064',
    rail: '#525c70',
    aeroway: '#363d4e',
    boundary: '#6c6488',
    text: '#c3c8d4',
    textMajor: '#e6e9ef',
    halo: 'rgba(30,35,48,0.9)',
    waterText: '#7fb2e0',
  },
};

// Vilken färg ett lager ska ha, utifrån dess id i liberty-stilen
function colorFor(id, type, c) {
  if (id === 'background') return { 'background-color': c.bg };
  if (type === 'fill') {
    if (/^park$|landcover_grass|landuse_pitch|landuse_cemetery|landuse_track/.test(id)) return { 'fill-color': c.park, 'fill-opacity': 1, 'fill-outline-color': c.park };
    if (/landcover_wood|landcover_wetland/.test(id)) return { 'fill-color': c.wood, 'fill-opacity': 0.9 };
    if (/landuse_residential/.test(id)) return { 'fill-color': c.residential, 'fill-opacity': 1 };
    if (/^water$/.test(id)) return { 'fill-color': c.water };
    if (/landcover_sand|landcover_ice/.test(id)) return { 'fill-color': c.sand, 'fill-opacity': 0.8 };
    if (/landuse_school/.test(id)) return { 'fill-color': c.school, 'fill-opacity': 1 };
    if (/landuse_hospital/.test(id)) return { 'fill-color': c.hospital, 'fill-opacity': 1 };
    if (/aeroway/.test(id)) return { 'fill-color': c.aeroway };
    if (/^building$/.test(id)) return { 'fill-color': c.building, 'fill-outline-color': c.buildingLine, 'fill-opacity': 1 };
    return null;
  }
  if (type === 'line') {
    if (/^waterway/.test(id)) return { 'line-color': c.waterLine };
    if (/boundary/.test(id)) return { 'line-color': c.boundary };
    if (/aeroway/.test(id)) return { 'line-color': c.aeroway };
    if (/rail/.test(id)) return { 'line-color': c.rail };
    const casing = /casing/.test(id);
    if (/path_pedestrian/.test(id)) return { 'line-color': casing ? c.bg : c.path };
    if (/motorway/.test(id)) return { 'line-color': casing ? c.motorwayCase : c.motorway };
    if (/trunk_primary/.test(id)) return { 'line-color': casing ? c.roadMajorCase : c.roadMajor };
    if (/secondary_tertiary/.test(id)) return { 'line-color': casing ? c.roadSecondaryCase : c.roadSecondary };
    if (/minor|street|link|service_track/.test(id)) return { 'line-color': casing ? c.roadMinorCase : c.roadMinor };
    return null;
  }
  if (type === 'symbol') {
    const major = /label_city|label_town|highway-name-major/.test(id);
    const water = /water/.test(id);
    return {
      'text-color': water ? c.waterText : major ? c.textMajor : c.text,
      'text-halo-color': c.halo,
      'text-halo-width': 1.4,
    };
  }
  return null;
}

// Lager som Apple-looken klarar sig utan
const HIDE = /^natural_earth$|park_outline|road_area_pattern|building-3d|hatching|highway-shield|road_shield/;

export function appleStyle(style, dark = false) {
  const c = dark ? PALETTE.dark : PALETTE.light;
  const out = JSON.parse(JSON.stringify(style));
  out.layers = out.layers
    .filter((l) => !HIDE.test(l.id))
    .map((l) => {
      const paint = colorFor(l.id, l.type, c);
      let out2 = paint ? { ...l, paint: { ...(l.paint || {}), ...paint } } : l;
      // Liberty visar platta hus bara upp till zoom 14 och 3D-hus därefter.
      // 3D-lagret är dolt (Apple-looken är platt), så de platta husen måste gälla på alla zoomnivåer.
      if (l.id === 'building' && out2.maxzoom != null) {
        out2 = { ...out2 };
        delete out2.maxzoom;
      }
      return out2;
    });
  return out;
}
