// Predvolené kategórie a nastavenia. CLIP rozumie najlepšie anglicky, preto sú prompty v angličtine.
import { kvGet, kvSet } from './db.js';

export const MODEL_ID = 'Xenova/clip-vit-base-patch32';

const cat = (id, name, icon, prompts, extra = {}) => ({ id, name, icon, prompts, ...extra });

export const DEFAULT_SETS = [
  {
    id: 'general',
    name: 'Všeobecné',
    enabled: true,
    categories: [
      cat('selfie', 'Selfie', '🤳', ['a selfie', 'a close-up selfie of a person holding a phone', 'a front camera photo of a face']),
      cat('family', 'Rodina a priatelia', '👨‍👩‍👧', ['a photo of family members together', 'a group of friends posing for a photo', 'people smiling together at home', 'a child playing', 'a portrait photo of a person', 'a pet dog or cat at home']),
      cat('events', 'Eventy a svadby', '💍', ['a wedding ceremony', 'a bride and groom', 'a party celebration with guests', 'a birthday party with balloons', 'a sports match in a stadium']),
      cat('food', 'Jedlo', '🍽️', ['a photo of food on a plate', 'a meal in a restaurant', 'a birthday cake', 'a drink or cocktail', 'a cup of coffee', 'bread and pastries']),
      cat('travel', 'Cestovanie', '✈️', ['a travel photo of a famous landmark', 'a city street while traveling', 'an airport or airplane window view', 'a tourist on vacation', 'a beach resort']),
      cat('nature', 'Príroda a výhľady', '🏞️', ['a landscape with mountains', 'a forest or nature scene', 'a sunset over the sea', 'a scenic view', 'flowers and plants', 'a wild animal in nature', 'a beach with the ocean and sky']),
      cat('screenshots', 'Screenshoty', '📱', ['a screenshot of a phone screen', 'a screenshot of a website or app user interface', 'a screenshot of a chat conversation', 'a computer desktop screenshot'], { nonPhoto: true, screenshot: true }),
      cat('memes', 'Memy a preposlané', '😂', ['a meme with text caption', 'a funny internet meme', 'an image with large text overlay', 'a cartoon or comic image'], { nonPhoto: true }),
      cat('docs', 'Doklady a bločky', '🧾', ['a photo of a paper receipt', 'a scanned document', 'an ID card or passport', 'an invoice or bill', 'a page of printed text'], { nonPhoto: true }),
      cat('things', 'Veci a nákupy', '🛍️', ['a product photo of an object', 'an item for sale', 'clothes or shoes', 'a close-up of a gadget on a table', 'furniture in a store']),
    ],
  },
  {
    id: 'jef',
    name: 'Eventy (JEF PRODUCTION)',
    enabled: true,
    categories: [
      cat('stage', 'Stage a svetlá', '🎆', ['a concert stage with colorful lights', 'stage lighting and lasers in the dark', 'a performer on a stage', 'moving head lights and smoke on stage']),
      cat('crowd', 'Publikum', '🙌', ['a crowd of people at a concert', 'audience with raised hands', 'a festival crowd at night', 'people dancing at a club']),
      cat('dj', 'DJ pult', '🎧', ['a DJ mixing at a DJ booth', 'DJ controller and turntables', 'a DJ playing music with headphones']),
      cat('tech', 'Technika', '🔌', ['audio equipment and loudspeakers', 'a mixing console with cables', 'lighting equipment and stage truss rigging', 'technical equipment cases']),
      cat('backstage', 'Backstage', '🎬', ['a backstage area behind the scenes', 'a crew working backstage', 'artists in a dressing room', 'event setup before the show']),
      cat('posters', 'Plagáty a flyery', '🎟️', ['an event poster', 'a party flyer with text', 'a concert advertisement graphic', 'a festival line-up poster'], { nonPhoto: true }),
    ],
  },
];

export const FALLBACK_CATEGORY = { id: 'other', name: 'Ostatné', icon: '🗂️', prompts: [] };
export const DUPES_FOLDER = '_Duplikáty';

export const DEFAULT_SETTINGS = {
  sets: DEFAULT_SETS,
  eventGapHours: 6,
  minConfidence: 0.2, // pod touto istotou ide fotka do „Ostatné“
  screenshotHeuristics: true,
  nearDupHamming: 5, // dHash vzdialenosť pre „takmer rovnaké“
  nearDupClip: 0.965, // podobnosť CLIP embeddingov (fotky blízko v čase)
  layout: 'cat-date', // 'cat' | 'date' | 'cat-date'
  dupes: 'folder', // 'folder' | 'skip' | 'keep'
  mode: 'copy', // 'copy' | 'move'
  forceWasm: false,
  batchSize: 8,
};

const clone = (o) => JSON.parse(JSON.stringify(o));

export async function loadSettings() {
  const saved = (await kvGet('settings')) || {};
  // Kategórie sa ukladajú len ak ich používateľ upravil – inak sa vždy použijú aktuálne predvolené.
  if (!saved.setsCustomized) delete saved.sets;
  return { ...clone(DEFAULT_SETTINGS), ...saved };
}

export async function saveSettings(s) {
  const out = clone(s);
  if (!out.setsCustomized) delete out.sets;
  await kvSet('settings', out);
}

export function resetSettings() {
  return clone(DEFAULT_SETTINGS);
}

export function activeCategories(settings) {
  return settings.sets.filter((s) => s.enabled).flatMap((s) => s.categories.filter((c) => c.prompts.length));
}
