/**
 * Results tables: the winners of a competition, one row per year ("List of
 * World Series champions", "List of FIFA World Cup finals"). The generic table
 * miner in wiki.mjs reads ONE text column, which here gives "Boston Americans
 * (1, 1–0)" with no word of what they won. A recipe names the competition and
 * the columns, so each row becomes "Boston Americans win the World Series" with
 * the loser and score in the excerpt.
 *
 * Recipes are keyed by page title. Columns are found by header regex; the table
 * used is the one whose header has the year column and a winner column (the
 * largest, when several do). Seasons ("1955–56") date to their end year, when
 * the final is played. Rows with no winner ("not played", future games) are
 * skipped.
 */
import { wikitables, tableGrid, cellText } from './wiki.mjs';

const YEAR = /^(year|season|date)/i;
const WIN = /^(winn(er|ing team|ers)|champions?\b|champion \(|horse$)/i;
const LOSE = /^(los(er|ing team)|runners?-?up)/i;
const SCORE = /^(score|final score|series|games|result|winning margin|margin)$/i;

export const RECIPES = {
  'List of World Series champions':      { comp: 'the World Series' },
  'List of Stanley Cup champions':       { comp: 'the Stanley Cup', all: true },
  'List of Super Bowl champions':        { comp: 'Super Bowl {game}', game: /^game$/i, score2: true },
  'List of NBA champions':               { comp: 'the NBA Finals', between: [/^western champion/i, /^eastern champion/i] },
  'List of FIFA World Cup finals':       { comp: 'the FIFA World Cup' },
  'List of European Cup and UEFA Champions League finals': { comp: 'the European Cup / Champions League' },
  'List of English football champions':  { comp: 'the English league title', win: /^champions/i, noLose: true },
  'List of Cricket World Cup finals':    { comp: 'the Cricket World Cup' },
  'List of Rugby World Cup finals':      { comp: 'the Rugby World Cup' },
  "List of Formula One World Drivers' Champions": { comp: 'the Formula One World Championship', win: /^driver$/i, extra: /^constructor$/i, one: true },
  'List of Masters Tournament champions':   { comp: 'the Masters', win: /^champion$/i, one: true },
  'List of U.S. Open (golf) champions':     { comp: 'the U.S. Open (golf)', win: /^champion$/i, one: true },
  'List of PGA Championship champions':     { comp: 'the PGA Championship', win: /^champion$/i, one: true, all: true },
  "List of Grand Slam men's singles champions":   { one: true, cols: [[/^australian open$/i, "the Australian Open men's singles"], [/^french open$/i, "the French Open men's singles"], [/^wimbledon$/i, "Wimbledon men's singles"], [/^us open$/i, "the US Open men's singles"]] },
  "List of Grand Slam women's singles champions": { one: true, cols: [[/^australian open$/i, "the Australian Open women's singles"], [/^french open$/i, "the French Open women's singles"], [/^wimbledon$/i, "Wimbledon women's singles"], [/^us open$/i, "the US Open women's singles"]] },
  'Triple Crown of Thoroughbred Racing (United States)': { one: true, comp: 'the US Triple Crown', win: /^winner$/i, extra: /^jockey$/i, extraLabel: 'ridden by',
    also: { cols: [[/^kentucky derby/i, 'the Kentucky Derby'], [/^preakness/i, 'the Preakness Stakes'], [/^belmont/i, 'the Belmont Stakes']] } },
  'Kentucky Derby':                      { one: true, comp: 'the Kentucky Derby', win: /^winner$/i, extra: /^jockey$/i, extraLabel: 'ridden by' },
  'Grand National':                      { one: true, comp: 'the Grand National', win: /^horse$/i, extra: /^jockey$/i, extraLabel: 'ridden by', all: true },
  'List of Olympic Games host cities':   { olympics: true },
  'List of world heavyweight boxing champions': { boxing: true },
};

/** Cell text without footnotes, flags' alt text, "(1, 1–0)" tallies and dagger marks. */
const tidy = (html) => cellText(String(html || '')
  .replace(/<sup\b[\s\S]*?<\/sup>/gi, '')
  .replace(/<span[^>]*display:\s*none[\s\S]*?<\/span>/gi, ''))
  .replace(/\[[^\]]*\]/g, '')
  .replace(/\s*\((?:\d+(?:[,/]\s*\d+[–-]\d+)?|\d+\/\d+|[A-Z]{1,4})\)/g, '')
  .replace(/\s*\(\d+\)\s*$/, '')
  .replace(/[†‡*#§¤^]+/g, '')
  .replace(/\s+/g, ' ').trim();

/** Year of a row: a season "1955–56" is its end year; otherwise the first 4-digit year. */
function yearOf(text){
  const t = String(text).replace(/\[[^\]]*\]/g, '');
  const s = t.match(/^\s*(\d{4})\s*[–-]\s*(\d{2,4})\b/);
  if(s){ const a = +s[1]; let b = +s[2]; if(b < 100) b = Math.floor(a / 100) * 100 + b; if(b < a) b += 100; return b - a === 1 ? b : a; }
  const m = t.match(/\b(1[6-9]\d\d|20\d\d)\b/);
  return m ? +m[1] : null;
}

const NOT_PLAYED = /^(not (played|held|awarded|contested)|no (series|competition|champion|race|tournament)|cancel|—|–|-|tbd|tba|n\/a|none)\b/i;

/**
 * Mine a results page (its parsed HTML). Returns drafts in mineEventsFrom's
 * shape (minus the bookkeeping push() adds), or null when no recipe applies.
 */
export function mineResults(title, url, html){
  const R = RECIPES[title];
  if(!R) return null;
  const out = [];
  const add = (year, titleText, excerpt) => {
    if(!year || !titleText) return;
    out.push({ title: titleText, subtitle: '', excerpt, image: '', start: year, end: year, kind: 'point',
      yearText: String(year), circa: false, topics: [], facets: {}, origin: { wiki: url, qid: null, manual: true },
      _dateSource: 'mined-results', _mined: title, _links: [] });
  };
  const win = R.one ? 'wins' : 'win';
  const tables = wikitables(html).map((t) => {
    const rows = tableGrid(t.html);
    const hi = rows.findIndex((r) => r.cells.length > 1 && r.tags.filter((x) => x === 'th').length >= r.cells.length - 1);
    return hi < 0 ? null : { rows: rows.slice(hi + 1), head: rows[hi].cells.map((c) => tidy(c)) };
  }).filter(Boolean);
  const col = (T, re) => (re ? T.head.findIndex((h) => re.test(h)) : -1);

  if(R.olympics){
    for(const T of tables){
      const y = col(T, /^year$/i), su = col(T, /^summer$/i), wi = col(T, /^winter$/i), city = col(T, /^city/i), ctry = col(T, /^country$/i);
      if(y < 0 || city < 0) continue;
      for(const r of T.rows){
        const year = yearOf(tidy(r.cells[y]) || tidy(r.cells[y + 1])), c = tidy(r.cells[city]), k = tidy(r.cells[ctry]);
        if(!year || !c || /cancel/i.test(r.cells.map(tidy).join(' '))) continue;
        for(const [i, kind] of [[su, 'Summer'], [wi, 'Winter']]){
          const n = tidy(r.cells[i]).replace(/^[SW]\d{3}/, '');
          if(!n || /^—|^-$/.test(n) || !/^[IVXLC]+$/.test(n.split(/\s/)[0])) continue;
          if(year > new Date().getFullYear()) continue;
          add(year, `${c} hosts the ${kind} Olympics`, `${year} – The ${n} ${kind} Olympic Games are held in ${c}, ${k}.`);
        }
      }
    }
    return out;
  }
  if(R.boxing){
    const T = tables.filter((t) => col(t, /^champion$/i) >= 0 && col(t, /^begin reign/i) >= 0).sort((a, b) => b.rows.length - a.rows.length)[0];
    if(!T) return out;
    const c = col(T, /^champion$/i), b = col(T, /^begin reign/i), rec = col(T, /^recognition/i);
    for(const r of T.rows){
      const who = tidy(r.cells[c]).replace(/\s+def\..*$/, '').replace(/\s*\([^)]*reign\)/i, ''), year = yearOf(tidy(r.cells[b]));
      const org = tidy(r.cells[rec]);
      if(!who || !year) continue;
      add(year, `${who} becomes heavyweight champion`, `${tidy(r.cells[b])} – ${who} wins the world heavyweight title${org ? ` (${org})` : ''}.`);
    }
    return out;
  }

  // Multi-column pages (tennis majors, the Triple Crown races): each cell is a winner.
  const multi = (cols, tablesIn) => {
    for(const T of tablesIn){
      const y = col(T, YEAR);
      const cs = cols.map(([re, name]) => [col(T, re), name]).filter(([i]) => i >= 0);
      if(y < 0 || cs.length < 2) continue;
      for(const r of T.rows){
        const year = yearOf(tidy(r.cells[y]));
        for(const [i, name] of cs){
          const w = tidy(r.cells[i]).replace(/\s*\(\d+\/\d+\)/g, '').replace(/\s*\((?:Jan|Dec)\)\s*/gi, '').trim();
          if(!year || !w || NOT_PLAYED.test(w) || /^started in/i.test(w) || w.length > 60) continue;
          add(year, `${w} ${win} ${name}`, `${year} – ${w} ${win} ${name}.`);
        }
      }
      if(!R.all) break;
    }
  };
  if(R.cols){ multi(R.cols, tables); return out; }

  const cands = tables.filter((T) => col(T, YEAR) >= 0 && (R.between ? col(T, R.between[0]) >= 0 : col(T, R.win || WIN) >= 0))
    .sort((a, b) => b.rows.length - a.rows.length);
  for(const T of R.all ? cands : cands.slice(0, 1)){
    const y = col(T, YEAR), w = col(T, R.win || WIN), l = col(T, LOSE), s = col(T, SCORE), g = col(T, R.game), x = col(T, R.extra);
    const sIdx = T.head.map((h, i) => (/^score$/i.test(h) ? i : -1)).filter((i) => i >= 0);
    for(const r of T.rows){
      const year = yearOf(tidy(r.cells[y]));
      let winner = '', loser = '', flip = false;
      if(R.between){
        const a = r.cells[col(T, R.between[0])] || '', b = r.cells[col(T, R.between[1])] || '';
        const bold = (h) => /<b>|<b\s/i.test(h);
        if(bold(a) === bold(b)) continue;
        [winner, loser] = bold(a) ? [tidy(a), tidy(b)] : [tidy(b), tidy(a)];
        flip = !bold(a);   // the result is written Western–Eastern
      } else {
        winner = tidy(r.cells[w]); loser = l >= 0 && !R.noLose ? tidy(r.cells[l]) : '';
      }
      if(!year || !winner || NOT_PLAYED.test(winner) || winner.length > 60 || year > new Date().getFullYear()) continue;
      const comp = (R.comp || '').replace('{game}', g >= 0 ? tidy(r.cells[g]) : '').trim();
      let score = R.score2 && sIdx.length >= 2 ? `${tidy(r.cells[sIdx[0]])}–${tidy(r.cells[sIdx[1]])}` : s >= 0 ? tidy(r.cells[s]) : '';
      if(flip) score = score.split(/[–-]/).reverse().join('–');
      const extra = x >= 0 ? tidy(r.cells[x]) : '';
      let ex = `${year} – ${winner} ${win} ${comp}`;
      if(loser) ex += `, beating ${loser}${score ? (/runs|wickets|up\b|&/.test(score) ? ` by ${score}` : ` ${score}`) : ''}`;
      else if(score && !R.one) ex += ` (${score})`;
      if(extra) ex += R.extraLabel ? `, ${R.extraLabel} ${extra}` : ` (${extra})`;
      add(year, `${winner} ${win} ${comp}`, ex + '.');
    }
  }
  if(R.also) multi(R.also.cols, tables);
  return out;
}
