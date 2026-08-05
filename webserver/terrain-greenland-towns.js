// Greenland's 17 towns. Coordinates are the same GeoNames-derived settlement
// centres used by flaskserver/grundkort_catalog.py to acquire Asiaq town data.
export const GREENLAND_TOWNS = Object.freeze([
  { name: 'Nanortalik', lat: 60.14169, lon: -45.24069 },
  { name: 'Qaqortoq', lat: 60.71839, lon: -46.03561, aliases: ['Julianehaab', 'Julianehåb'] },
  { name: 'Narsaq', lat: 60.91298, lon: -46.05055 },
  { name: 'Paamiut', lat: 61.99402, lon: -49.66776, aliases: ['Frederikshaab', 'Frederikshåb'] },
  { name: 'Nuuk', lat: 64.18347, lon: -51.72157, aliases: ['Godthaab', 'Godthåb'] },
  { name: 'Maniitsoq', lat: 65.41506, lon: -52.89822, aliases: ['Sukkertoppen'] },
  { name: 'Sisimiut', lat: 66.93946, lon: -53.67350, aliases: ['Holsteinsborg'] },
  { name: 'Kangaatsiaq', lat: 68.30648, lon: -53.46405 },
  { name: 'Aasiaat', lat: 68.70869, lon: -52.86366, aliases: ['Egedesminde'] },
  { name: 'Qasigiannguit', lat: 68.81926, lon: -51.19221, aliases: ['Christianshaab', 'Christianshåb'] },
  { name: 'Ilulissat', lat: 69.21981, lon: -51.09861, aliases: ['Jakobshavn'] },
  { name: 'Qeqertarsuaq', lat: 69.24721, lon: -53.53682, aliases: ['Godhavn'] },
  { name: 'Uummannaq', lat: 70.67442, lon: -52.12545, aliases: ['Umanak'] },
  { name: 'Upernavik', lat: 72.78358, lon: -56.14933 },
  { name: 'Qaanaaq', lat: 77.46666, lon: -69.23155, aliases: ['Thule'] },
  { name: 'Tasiilaq', lat: 65.61451, lon: -37.63676, aliases: ['Ammassalik', 'Angmagssalik'] },
  { name: 'Ittoqqortoormiit', lat: 70.48456, lon: -21.96221, aliases: ['Scoresbysund'] },
]);

function normalizeTownName(value) {
  return String(value ?? '').trim().toLocaleLowerCase('en').normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function findGreenlandTown(value) {
  const query = normalizeTownName(value);
  if (!query) return null;
  return GREENLAND_TOWNS.find(town => (
    normalizeTownName(town.name) === query ||
    town.aliases?.some(alias => normalizeTownName(alias) === query)
  )) ?? null;
}
