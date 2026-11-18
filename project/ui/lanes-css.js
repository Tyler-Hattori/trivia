/*
 * The Lanes look, shared by the topic timeline (features/topic) and the atlas
 * (features/atlas), so both draw an event, a life, an era bar, a lane name, the
 * overview strip and the era bands the same way. Edit here, not in either page.
 *
 * NO BACKTICKS INSIDE THIS TEMPLATE, including in comments (docs/ATLAS.md, gotchas).
 */
export const LANES_CSS = String.raw`
/* timeline overview strip */
.tp-over{display:flex;align-items:center;gap:10px;padding:6px 16px;border-bottom:1px solid #e5e7eb;background:#fcfcfd}
.tp-over .strip{position:relative;flex:1;height:22px;border-radius:6px;background:#f1f5f9;cursor:pointer;overflow:hidden}
.tp-over .seg{position:absolute;top:3px;bottom:3px;border-radius:4px;color:#fff;font-size:10.5px;font-weight:700;padding:1px 5px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.85}
.tp-over .seg:hover{opacity:1}
.tp-over .yr{position:absolute;top:4px;font-size:10.5px;color:#64748b;transform:translateX(-50%);pointer-events:none}
.tp-over .win{position:absolute;top:0;bottom:0;border:2px solid #0f172a;border-radius:6px;pointer-events:none;background:rgba(15,23,42,.06)}
/* chapter bands across the top of the canvas, sticky vertically */
.tp-bands{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.97);border-bottom:1px solid #e5e7eb}
.tp-band{position:absolute;height:22px;border-radius:5px;font-size:11.5px;font-weight:700;color:#fff;padding:3px 8px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;opacity:.92}
.tp-band:hover{opacity:1}
.tp-band.dim{opacity:.25}
.tp-tick{position:absolute;font-size:11px;color:#64748b;transform:translateX(-50%);white-space:nowrap}
/* the eras track: dynasties, kingdoms and eras as bars across their years; rulers under them */
.tp-era{position:absolute;height:15px;border-radius:3px;font-size:10.5px;font-weight:600;line-height:15px;padding:0 5px;
  color:#1e293b;background:color-mix(in srgb,var(--c) 20%,#fff);border-left:3px solid var(--c);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;box-sizing:border-box}
.tp-era > span,.tp-band > span{display:inline-block}
.tp-era:hover{background:color-mix(in srgb,var(--c) 32%,#fff);z-index:2}
.tp-era.sel{box-shadow:0 0 0 2px #0f172a;z-index:3}
.tp-era.dim{opacity:.25}
.tp-era.ruler{font-weight:500;color:#334155;background:#f1f5f9;border-left-color:#94a3b8}
.tp-era.clipl{border-left-style:dashed}
.tp-era.clipr{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 18px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 18px),transparent)}
/* lanes: events, people and works in thin rows (layout.js layoutLanes) */
.tp-lane{position:absolute;left:0;height:0;border-top:1px solid #eef2f7;pointer-events:none}
.tp-lanelab{position:absolute;left:8px;top:-8px;font-size:9.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;
  background:#fff;padding:0 6px 0 2px}
.tp-trk{position:absolute;left:0;height:0;pointer-events:none}
.tp-trk .tp-lanelab{top:-1px;background:transparent}
.tp-lanelab{pointer-events:auto}
.tp-lanelab i{font-style:normal;font-weight:500;text-transform:none;letter-spacing:0}
.tp-lane .tp-lanelab{cursor:pointer;border-radius:3px}
.tp-lane .tp-lanelab:hover{color:#334155;background:#f1f5f9}
.tp-lanelab.pinned{color:#334155}
.tp-lanelab.pinned::after{content:"·  pinned";margin-left:5px;font-weight:500;letter-spacing:.02em;text-transform:none;color:#94a3b8}
.tp-ln{position:absolute;height:21px;cursor:pointer;font-size:11.5px;line-height:15px;color:#334155;white-space:nowrap}
.tp-ln .lb{position:absolute;top:0;overflow:hidden;text-overflow:ellipsis;font-weight:500;display:block}
.tp-ln.key .lb{font-weight:700;color:#0f172a}
.tp-ln.fill .lb{color:#64748b;font-size:11px}
.tp-ln .pt{position:absolute;left:-4px;top:4px;width:8px;height:8px;border-radius:50%;background:var(--c)}
.tp-ln.fill .pt{width:6px;height:6px;left:-3px;top:5px;opacity:.6}
.tp-ln .bar{position:absolute;left:0;top:17px;height:3px;border-radius:2px;background:var(--c);opacity:.75}
.tp-ln .bar::before,.tp-ln .bar::after{content:"";position:absolute;top:-3px;width:2px;height:6px;border-radius:1px;background:inherit}
.tp-ln .bar::before{left:0}
.tp-ln .bar::after{right:0}
.tp-ln.fill .bar{opacity:.4}
/* people: a grey life line, tinted for essentials */
.tp-ln.pe .bar{background:#94a3b8;opacity:.7}
.tp-ln.pe.key .bar{background:color-mix(in srgb,var(--c) 55%,#94a3b8);opacity:.9}
.tp-ln.pe .pt{background:#94a3b8}
.tp-ln .av{display:inline-block;vertical-align:-3px;margin-right:4px;width:15px;height:15px;border-radius:50%;object-fit:cover;object-position:50% 20%;flex:none;box-shadow:0 0 0 1px var(--c)}
/* works: a small square */
.tp-ln.wo .pt{border-radius:2px}
.tp-ln.ot .pt{background:#fff;border:2px solid var(--c);box-sizing:border-box}
.tp-ln:hover{z-index:5}
.tp-ln:hover .lb{text-decoration:underline;text-decoration-color:#cbd5e1;text-underline-offset:2px}
.tp-ln.sel .lb{background:#0f172a;color:#fff;border-radius:3px;padding:0 4px;margin-left:-4px}
.tp-ln.rel .lb{background:#fef3c7;border-radius:3px;padding:0 4px;margin-left:-4px}
.tp-ln.dim{opacity:.16}
.tp-ln .ok{color:#16a34a}
`;
