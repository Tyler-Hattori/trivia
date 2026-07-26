/*
 * The scale ladder.
 *
 * A single number — pixels per year — drives both the x mapping and the level
 * of detail. Representation is a *function* of the scale, so zooming out turns
 * cards into chips into dots into a density heat strip. That is what makes
 * "eras" and "year by year" the same control, and it is also the reason the
 * renderer never has to materialise thousands of cards at once.
 */

export const PAD = 64;                 // px of breathing room at each end of the canvas

export const STOPS = [
  { id: 'eras',      label: 'Eras',      ppy: 0.12 },
  { id: 'centuries', label: 'Centuries', ppy: 0.75 },
  { id: 'decades',   label: 'Decades',   ppy: 4.5  },
  { id: 'years',     label: 'Years',     ppy: 18   },
  { id: 'detail',    label: 'Detail',    ppy: 58   }
];

export const PPY_MIN = 0.015;
export const PPY_MAX = 160;

/** Which visual tier a given zoom renders point events at. */
export function tierFor(ppy){
  if(ppy < 0.35) return 'heat';
  if(ppy < 2.2)  return 'dot';
  if(ppy < 10)   return 'chip';
  if(ppy < 38)   return 'card';
  return 'detail';
}

const TIER_STOP = { heat: 'eras', dot: 'centuries', chip: 'decades', card: 'years', detail: 'detail' };

/**
 * Which ladder button to highlight. Derived from the tier rather than from the
 * nearest stop, so the highlighted label always names what you are looking at.
 */
export function stopFor(ppy){
  return TIER_STOP[tierFor(ppy)];
}

const NICE = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];

/** Smallest "nice" year interval that keeps ticks at least `targetPx` apart. */
export function tickStep(ppy, targetPx = 108){
  const target = targetPx / ppy;
  for(const n of NICE) if(n >= target) return n;
  return NICE[NICE.length - 1];
}

/** The next nice interval at least 5x the minor step — used for the era row. */
export function majorStep(step){
  for(const n of NICE) if(n >= step * 5) return n;
  return step * 5;
}

/** Create the year <-> pixel mapping for a given zoom and lower bound. */
export function makeScale(minYear, ppy){
  return {
    ppy,
    minYear,
    x: (year) => PAD + (year - minYear) * ppy,
    year: (px) => minYear + (px - PAD) / ppy,
    width: (years) => years * ppy
  };
}

export function contentWidth(minYear, maxYear, ppy){
  return PAD * 2 + Math.max(1, maxYear - minYear) * ppy;
}

/**
 * Zoom while holding the year under `anchorClientX` still.
 * Returns the scrollLeft that preserves it.
 */
export function anchoredScrollLeft(minYear, oldPpy, newPpy, scrollLeft, anchorClientX){
  const anchorYear = minYear + (scrollLeft + anchorClientX - PAD) / oldPpy;
  return PAD + (anchorYear - minYear) * newPpy - anchorClientX;
}
