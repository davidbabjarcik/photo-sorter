// CLIP rozumie hlavne angličtine. Jednoduchý slovník SK → EN pre vyhľadávanie (neznáme slová ostanú bez zmeny).
const DICT = {
  svetla: 'lights', svetlo: 'light', svetlami: 'lights', stage: 'stage', stagei: 'stage', pódium: 'stage', podium: 'stage', javisko: 'stage',
  torta: 'cake', torty: 'cake', tortu: 'cake', kolac: 'cake', jedlo: 'food', jedla: 'food', obed: 'lunch', vecera: 'dinner', ranajky: 'breakfast',
  pizza: 'pizza', kava: 'coffee', pivo: 'beer', vino: 'wine', drink: 'drink', koktail: 'cocktail', burger: 'burger', zmrzlina: 'ice cream', ovocie: 'fruit',
  pes: 'dog', psa: 'dog', psik: 'dog', macka: 'cat', macku: 'cat', kon: 'horse', vtak: 'bird', zviera: 'animal', zvierata: 'animals',
  more: 'sea', mora: 'sea', plaz: 'beach', plazi: 'beach', hory: 'mountains', hora: 'mountain', les: 'forest', lese: 'forest', jazero: 'lake', rieka: 'river',
  zapad: 'sunset', zapadom: 'sunset', vychod: 'sunrise', slnka: 'sun', slnko: 'sun', sneh: 'snow', snehu: 'snow', obloha: 'sky', mraky: 'clouds', kvety: 'flowers', kvet: 'flower', strom: 'tree', stromy: 'trees',
  mesto: 'city', meste: 'city', ulica: 'street', ulici: 'street', budova: 'building', most: 'bridge', kostol: 'church', hrad: 'castle', letisko: 'airport', lietadlo: 'airplane',
  auto: 'car', auta: 'cars', bicykel: 'bicycle', vlak: 'train', lod: 'boat', dom: 'house', izba: 'room', kuchyna: 'kitchen', zahrada: 'garden', bazen: 'swimming pool',
  svadba: 'wedding', svadby: 'wedding', nevesta: 'bride', zenich: 'groom', oslava: 'celebration', party: 'party', narodeniny: 'birthday', vianoce: 'christmas', stromcek: 'christmas tree',
  koncert: 'concert', festival: 'festival', publikum: 'audience', dav: 'crowd', ludia: 'people', clovek: 'person', deti: 'children', dieta: 'child', bábätko: 'baby', babatko: 'baby', rodina: 'family', priatelia: 'friends',
  dj: 'DJ', pult: 'booth', pulte: 'booth', mixpult: 'mixing console', reproduktory: 'speakers', reproduktor: 'speaker', kable: 'cables', technika: 'equipment', lasery: 'lasers', laser: 'laser', dym: 'smoke', ohnostroj: 'fireworks',
  backstage: 'backstage', plagat: 'poster', plagaty: 'posters', flyer: 'flyer', letak: 'flyer', vstupenka: 'ticket', listok: 'ticket',
  selfie: 'selfie', tvar: 'face', usmev: 'smile', skupina: 'group', skupinova: 'group',
  screenshot: 'screenshot', obrazovka: 'screen', chat: 'chat', sprava: 'message', mem: 'meme', vtip: 'joke',
  blocok: 'receipt', blocek: 'receipt', doklad: 'document', faktura: 'invoice', pas: 'passport', obcianka: 'ID card', dokument: 'document', text: 'text',
  oblecenie: 'clothes', topanky: 'shoes', mobil: 'phone', telefon: 'phone', notebook: 'laptop', pocitac: 'computer', hodinky: 'watch', nakup: 'shopping',
  noc: 'night', noci: 'night', vecer: 'evening', den: 'day', leto: 'summer', zima: 'winter', jesen: 'autumn', jar: 'spring',
  cervena: 'red', cervene: 'red', modra: 'blue', modre: 'blue', zelena: 'green', zlta: 'yellow', biela: 'white', cierna: 'black', farebne: 'colorful',
  na: 'on', v: 'in', vo: 'in', pri: 'near', s: 'with', so: 'with', a: 'and', pod: 'under', nad: 'above', za: 'behind', pred: 'in front of',
};

const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function toEnglishQuery(q) {
  const words = q.trim().split(/\s+/).filter(Boolean);
  const tr = words.map((w) => DICT[w.toLowerCase()] ?? DICT[strip(w)] ?? w);
  const text = tr.join(' ');
  return { text: `a photo of ${text}`, translated: text };
}
