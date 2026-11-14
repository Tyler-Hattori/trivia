/**
 * What KIND of thing an entry is: event, person, work, period, place, group,
 * or concept.
 *
 * Pure and dependency-free, so the browser can import it too (like years.mjs).
 *
 * Why it matters: a timeline is a list of things that HAPPENED. Ingesting the
 * links of "History of England" brought in entities that merely have a date
 * attached — *Celtic languages* at 1707 (the year the term was coined),
 * *Colchester* at 2021 (city status), *Catholic Church* at 2026 (an open span
 * read as "now"). Each renders exactly like a real event, and the quiz asked
 * "What year: Trinovantes?" about an Iron Age tribe. Typing the entry is what
 * lets a timeline and a quiz leave those out.
 *
 * Signals, most trusted first:
 *   1. the source dataset (a `leaders` row is a person; `art` a work)
 *   2. how Wikidata dated it (P569+P570 = birth/death = a person)
 *   3. Wikidata `instanceOf`, then the description in `subtitle`
 *   4. a mined line from a timeline page is an event by construction
 */

const RX = {
  event: /\b(battles?|wars?|warfare|treaty|treaties|rebellions?|revolts?|uprisings?|revolutions?|conquests?|invasions?|sieges?|massacres?|plots?|conspiracy|elections?|crisis|riots?|coups?|disasters?|pandemics?|epidemics?|plagues?|famines?|campaigns?|expeditions?|conflicts?|insurrections?|mutiny|raids?|landing|abdication|coronation|assassinations?|murders?|executions?|congress|conference|act of parliament|act\b|acts\b|statutes?|charter|reformation|dissolution|schism|strike|protests?|referendum|declaration|accession|founding|invention|voyages?|exploration|earthquakes?|fires?|floods?|eruptions?|extinction event|event|occurrence|incident|ceremony|festival|tournament|olympic|championship|cup)\b/,
  person: /\b(king|queen|monarch|emperor|empress|ruler|wife|husband|son|daughter|mother|father|mistress|favou?rite|peer|chieftain|prince|princess|duke|duchess|earl|count|countess|lord|lady|baron|knight|bishop|archbishop|pope|saint|abbot|monk|nun|politician|statesman|prime minister|president|chancellor|general|admiral|soldier|commander|officer|writer|poet|novelist|playwright|dramatist|author|philosopher|theologian|scientist|physicist|chemist|mathematician|astronomer|biologist|naturalist|inventor|engineer|architect|painter|sculptor|artist|composer|musician|singer|actor|actress|director|explorer|historian|economist|businessman|lawyer|judge|activist|reformer|missionary|chronicler|scholar|human|person|consort|regent|pretender|claimant)\b/,
  work: /\b(painting|sculpture|fresco|mural|altarpiece|portrait|drawing|engraving|tapestry|embroider(?:y|ed)|wall-hanging|collection of stories|stories|manuscript|book|novel|poem|play|treatise|literary work|written work|film|opera|symphony|song|album|essay|chronicle|epic|codex|bible|map|statue|work of art|artwork)\b/,
  period: /\b(period|era|age|epoch|eon|dynasty|house of|reign|historical country|kingdom|empire|caliphate|sultanate|principality|duchy|countship|monarchy|republic|confederation|heptarchy|archaeological culture|culture|civili[sz]ation|historical period|stage|regime|protectorate|commonwealth|interregnum|restoration|renaissance|enlightenment|revolution era|polity|state)\b/,
  place: /\b(town|city|village|county|shire|borough|parish|river|island|islands|mountain|hill|valley|lake|sea|bay|coast|region|province|country|sovereign state|territory|capital|settlement|fort|fortress|castle|palace|cathedral|abbey|church building|monastery|priory|wall|road|bridge|building|house|hall|tower|site|archaeological site|cave|monument|museum|university|college|school|harbou?r|port|street|square|park|area|district|metropolitan|ceremonial county|unitary authority|local government)\b/,
  group: /\b(people|peoples|tribe|tribes|ethnic group|clan|army|team|club|navy|regiment|order|party|political party|faction|movement|organi[sz]ation|company|society|denomination|religion|parliament|government|council of|legislature|institution|guild|union of|league|alliance)\b/,
  artifact: /\b(archaeological (find|discovery)|artefact|artifact|hoard|shield|helmet|jewel|brooch|sword|crown jewels?)\b/,
  building: /\b(cathedral|castle|abbey|priory|palace|church building|fortress|hillfort|monument|henge|earthworks?|archaeological site|ruins?)\b/,
  language: /\b(languages?|dialects?|language family)\b/,
  concept: /\b(language|languages|dialect|law|legal|concept|theory|doctrine|ideology|philosophy|religion|belief|tradition|custom|style|genre|aspect of history|history of|list of|topic|term|title|office|position|rank|currency|system|feudalism|technology)\b/,
};

/** The best-guess type for one entry. */
export function entryType(e){
  const ds = e.origin?.dataset || e.dataset || '';
  const src = e.origin?.dateSource || '';
  const inst = String([].concat(e.facets?.instanceOf || []).join(' ')).toLowerCase();
  const sub = String(e.subtitle || '').toLowerCase();
  const title = String(e.title || '').toLowerCase();

  // 1. Source dataset.
  if(ds === 'leaders' || ds === 'people') return 'person';
  if(ds === 'art' || ds === 'film' || ds === 'philosophy' || ds === 'literature') return 'work';
  if(e.facets?.artist || e.facets?.director || e.facets?.author) return 'work';

  // 2. Wikidata dating.
  if(src === 'P569+P570') return 'person';

  // 3. An overview article is a topic, not a thing that happened.
  if(/^(history|list|timeline|outline|historiography) of\b/.test(title)) return 'concept';

  // 4. instanceOf, then description. `subtitle` is usually Wikidata's
  //    description but sometimes a creator or head of state ("United Kingdom —
  //    Keir Starmer"); a bare proper name says nothing about type, so skip it.
  //    Order matters: events before places (*Battle of Hastings* is a battle at a
  //    place), groups before periods (*Trinovantes*, "British tribe of the Iron
  //    Age", is a tribe, not an age), periods before places (*Kingdom of Kent*).
  const desc = /^[A-Z][\w'’.-]*( [A-Z][\w'’.-]*){0,3}$/.test(e.subtitle || '') ? '' : sub;
  for(const text of [inst, desc]){
    if(!text) continue;
    if(/\bhuman\b/.test(text)) return 'person';
    // A description's head noun decides before any later word can: "large city
    // in the West Midlands… second city of the United Kingdom" is a city, not a
    // kingdom (Birmingham was a period, and an essential of a physics course).
    if(text === desc && RX.place.test(text.split(/\s+/).slice(0, 4).join(' ')) && !RX.event.test(text.split(/\s+/).slice(0, 4).join(' '))) return 'place';
    if(RX.artifact.test(text)) return 'work';
    if(RX.building.test(text)) return 'place';
    if(RX.language.test(text)) return 'concept';
    if(RX.event.test(text)) return 'event';
    if(RX.work.test(text)) return 'work';
    if(RX.person.test(text)) return 'person';
    if(RX.group.test(text)) return 'group';
    // A present-day country is a place, not a period: "sovereign state" hit
    // the period rule's "state", and "constituent country of the United
    // KINGDOM" its "kingdom", so England and Germany were essentials of a
    // physics course. A historical/former country stays a period.
    if(/\b(sovereign state|country|nation)\b/.test(text) && !/\b(historical|former|ancient|medieval)\b/.test(text)) return 'place';
    if(RX.period.test(text)) return 'period';
    if(RX.place.test(text)) return 'place';
    if(RX.concept.test(text)) return 'concept';
  }

  // 6. A line mined out of a timeline/history page is a dated statement. After
  //    the description pass, because hand-entered rows are `manual` too and some
  //    of them describe a work (*The Canterbury Tales*).
  if(e.origin?.manual && !e.origin?.qid) return 'event';

  // 7. Nothing from Wikidata: read the title and the excerpt's first sentence.
  if(/^(battle|siege|treaty|war|sack|massacre|capture|raid|council|peace|siege) of\b/.test(title)) return 'event';
  if(/\bact( of)? \d{3,4}\b|\bact \d{3,4}$/.test(title)) return 'event';
  // Regnal names: "Edmund I", "Louis VIII of France".
  if(/^[A-Z][a-z]+(?: [A-Z][a-z]+)? (?:[IVX]+)(?: of [A-Z][\w ]+)?$/.test(e.title || '')) return 'person';
  const first = String(e.excerpt || '').slice(0, 300);
  // "Joan of Arc (c. 1412 – 30 May 1431) was a …", "Arthur (1486–1502) was …"
  if(/^[^.]{0,160}\((?:[^()]*\b(?:born|c\.)\s*)?[^()]*\d{3,4}[^()]*[–-][^()]*\d{3,4}[^()]*\)\s+(?:was|is)\b/.test(first)) return 'person';
  if(/\b(?:was|is) (?:an?|the) [^.]{0,60}\b(king|queen|prince|princess|nobleman|noblewoman|bishop|saint|politician|writer|poet|soldier|general|heroine|hero|peer|knight|son|daughter|wife|husband|mother|father|brother|sister)\b/.test(first)) return 'person';

  // A dated statement in prose with no Wikidata is most likely an event.
  if(!e.origin?.qid && e.excerpt && /^\W*\d/.test(e.excerpt)) return 'event';
  return 'concept';
}

/** Types that belong on a timeline by default. */
export const TIMELINE_TYPES = new Set(['event', 'person', 'work', 'period']);

/**
 * Types whose DATE is a fair question. A place's or a concept's year is usually
 * a coincidence of how Wikidata recorded it (founding, renaming, coinage of the
 * word), not something worth memorising.
 */
export const DATE_QUIZ_TYPES = new Set(['event', 'person', 'work', 'period']);

export const TYPE_LABEL = {
  event: 'Event', person: 'Person', work: 'Work', period: 'Period',
  place: 'Place', group: 'Group', concept: 'Concept',
};
