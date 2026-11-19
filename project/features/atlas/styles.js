/*
 * The atlas stylesheet, injected once into the atlas window. The entries,
 * lanes, era bands and overview strip are the topic timeline's own rules
 * (ui/lanes-css.js); this file adds the atlas's shell around them, in the same
 * vocabulary as the topic page (features/topic/styles.js): white, one hairline,
 * near-black for the active state, colour only as an accent.
 *
 * NO BACKTICKS INSIDE THIS TEMPLATE, including in comments: one closes the
 * string and the rest parses as JavaScript (docs/ATLAS.md, gotchas).
 */
import { LANES_CSS } from '../../ui/lanes-css.js';

export const CSS = String.raw`
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;background:#fff;color:#0f172a;
  font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
button,select,input{font:inherit;color:inherit}
button{cursor:pointer}
#boot{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#64748b;z-index:99;background:#fff}
#boot.gone{display:none}
#boot pre{font:12px/1.6 ui-monospace,Menlo,monospace;white-space:pre-wrap;max-width:640px}
#app{display:flex;flex-direction:column;height:100%}

/* ---------- toolbar: one compact row, more behind a button, the whole bar can fold away ---------- */
.al-bar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid #e5e7eb;flex-wrap:nowrap;min-height:42px}
.al-bar.off{display:none}
.al-title{font-weight:800;font-size:16px;margin-right:4px;white-space:nowrap}
.al-btn{border:1px solid #d1d5db;background:#fff;border-radius:9px;padding:4px 10px;color:#334155;font-size:13px;white-space:nowrap}
.al-btn:hover{background:#f8fafc}
.al-btn.on{background:#0f172a;color:#fff;border-color:#0f172a}
.al-btn.ic{width:30px;padding:4px 0;text-align:center}
.al-seg{display:inline-flex;border:1px solid #d1d5db;border-radius:9px;overflow:hidden;flex:none}
.al-seg button{border:0;background:#fff;padding:4px 10px;color:#334155;font-size:13px;white-space:nowrap}
.al-seg button+button{border-left:1px solid #e5e7eb}
.al-seg button.on{background:#0f172a;color:#fff}
.al-seg button.edge{background:#f1f5f9;font-weight:600}
.al-seg button.edge::after{content:" ›"}
.al-search{flex:1;min-width:120px;max-width:360px;border:1px solid #d1d5db;border-radius:9px;padding:5px 10px;outline:none;font-size:13px}
.al-search:focus{border-color:#94a3b8}
.al-sp{flex:1}
.al-seg .sh{display:none}
.al-count{font-size:12px;color:#94a3b8;white-space:nowrap}
.al-more{display:none;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid #e5e7eb;flex-wrap:wrap}
.al-more.on{display:flex}
.al-more label{font-size:12px;color:#64748b}
.al-more select{border:1px solid #d1d5db;border-radius:9px;padding:4px 8px;background:#fff;font-size:13px;max-width:240px}
.al-unfold{position:absolute;right:8px;top:6px;z-index:30;display:none}
.al-unfold.on{display:block}

/* ---------- header: overview strip, era bands, ticks, pinned lanes ---------- */
.al-hdr{position:relative;flex:none;border-bottom:1px solid #e5e7eb;background:#fff}
.al-hdr .tp-over{padding:6px 10px}
.al-bands{position:relative;height:28px;overflow:hidden}
.al-bands .tp-band{top:3px}
.al-ticks{position:relative;height:20px;overflow:hidden}
.al-ticks .tp-tick{top:2px}
.al-pins{position:relative;overflow:hidden;border-top:1px solid #e5e7eb;display:none}
.al-pins.on{display:block}

/* ---------- body: native vertical scroll, horizontal pan by transform ---------- */
.al-main{position:relative;flex:1;min-height:0}
.al-grid{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.al-grid i{position:absolute;top:0;bottom:0;width:1px;background:#f1f5f9}
.al-body{position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;touch-action:pan-y;cursor:grab;overscroll-behavior:contain}
.al-body.drag{cursor:grabbing;user-select:none}
.al-sizer{position:relative;width:100%}
.al-world{position:absolute;left:0;top:0;width:0;height:0;will-change:transform}
.al-labs{position:absolute;left:0;top:0;width:100%;height:0;pointer-events:none}
.al-pins .al-world,.al-pins .al-labs{top:0}

/* a section: its name, the count, a fold toggle */
.al-sec{position:absolute;left:0;right:0;height:30px;display:flex;align-items:center;gap:8px;padding:0 10px;
  border-top:1px solid #e5e7eb;background:linear-gradient(#fff,rgba(255,255,255,.92));pointer-events:auto;cursor:pointer;z-index:6}
.al-sec b{font-size:13px;font-weight:800;color:#0f172a;letter-spacing:.01em}
.al-sec .sw{width:9px;height:9px;border-radius:2px;background:var(--c)}
.al-sec .n{font-size:11.5px;color:#94a3b8}
.al-sec .tw{color:#94a3b8;font-size:11px;width:10px}
.al-sec:hover b{text-decoration:underline;text-decoration-color:#cbd5e1;text-underline-offset:2px}

/* a lane: the hairline and the name, as .tp-lane; the name pins it (as on the timeline) */
.al-lane{position:absolute;left:0;right:0;height:0;border-top:1px solid #eef2f7}
.al-lane .tp-lanelab{position:absolute;top:-8px;left:8px;pointer-events:auto;cursor:pointer;border-radius:3px;z-index:6}
.al-lane .tp-lanelab:hover{color:#334155;background:#f1f5f9}
.al-lane.d1 .tp-lanelab{left:20px}
.al-lane.d2 .tp-lanelab{left:32px}
.al-lane .tp-lanelab i{color:#cbd5e1;margin-left:5px}
.al-lane .al-mo{position:absolute;top:-8px;pointer-events:auto;font-size:10px;color:#94a3b8;background:#fff;border:0;padding:0 4px;border-radius:3px;cursor:pointer;z-index:6}
.al-lane .al-mo:hover{color:#0f172a;background:#f1f5f9}
.al-lane.hit .tp-lanelab{color:#0f172a;background:#fef3c7}

/* the hover tip and the detail panel: the topic page's */
.tp-hover{position:fixed;z-index:80;width:330px;background:#0f172a;color:#e2e8f0;border-radius:10px;padding:9px 11px;font-size:12.5px;line-height:1.5;
  pointer-events:none;opacity:0;transition:opacity .12s;box-shadow:0 10px 30px rgba(15,23,42,.3)}
.tp-hover.on{opacity:1}
.tp-hover b{color:#fff}
.tp-hover .tp-meta{color:#94a3b8}
.tp-hover div{margin-top:4px}
.al-detail{position:absolute;right:0;top:0;bottom:0;width:420px;max-width:100%;z-index:40;background:#fff;border-left:1px solid #e5e7eb;
  overflow:auto;box-shadow:-14px 0 34px rgba(15,23,42,.10);display:none}
.al-detail.open{display:block}
.al-detail .hd{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid #f1f5f9;position:sticky;top:0;background:#fff;z-index:2;font-size:12px;color:#64748b}
.al-detail .hd .path{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.al-detail img.pic{width:100%;max-height:340px;object-fit:contain;background:#f8fafc;display:block}
.al-detail .in{padding:14px 18px 28px}
.al-detail h2{font-size:21px;line-height:1.25;margin:0 0 4px;font-weight:800}
.al-detail .sub{color:#64748b;font-size:13px;margin-bottom:4px}
.al-detail .yr{color:#64748b;font-size:13px;margin-bottom:12px;font-variant-numeric:tabular-nums}
.al-detail p{color:#334155;line-height:1.6;margin:0 0 10px;font-size:14px}
.al-detail .lb{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#94a3b8;margin:16px 0 6px}
.al-detail .chips{display:flex;flex-wrap:wrap;gap:6px}
.al-detail .chips button{border:1px solid #d1d5db;background:#fff;border-radius:999px;padding:3px 10px;font-size:12.5px;color:#334155}
.al-detail .chips button:hover{background:#f8fafc}
.al-detail .near button{display:flex;gap:8px;width:100%;text-align:left;border:0;background:none;padding:4px 2px;font-size:13px;color:#334155;border-radius:6px}
.al-detail .near button:hover{background:#f8fafc}
.al-detail .near .y{color:#94a3b8;font-variant-numeric:tabular-nums;margin-left:auto;white-space:nowrap}
.al-detail a{color:#334155}

#status{position:absolute;left:8px;bottom:8px;z-index:20;font-size:11px;color:#94a3b8;background:rgba(255,255,255,.9);border-radius:6px;padding:2px 7px;pointer-events:none}
#empty{position:absolute;left:0;right:0;top:80px;text-align:center;color:#94a3b8;font-size:13px;display:none;pointer-events:none}
#empty.on{display:block}
#help{position:fixed;inset:0;z-index:90;background:rgba(15,23,42,.35);display:none;align-items:center;justify-content:center}
#help.on{display:flex}
#help .box{background:#fff;border-radius:12px;padding:18px 22px;max-width:520px;box-shadow:0 20px 60px rgba(15,23,42,.3);font-size:13px}
#help h3{margin:0 0 10px;font-size:15px}
#help dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0}
#help dt{font-family:ui-monospace,Menlo,monospace;color:#0f172a;white-space:nowrap}
#help dd{margin:0;color:#475569}
#help p{color:#64748b;font-size:12px;line-height:1.55;margin:12px 0 0}

@media (max-width:700px){
  .al-title{display:none}
  .al-count{display:none}
  .al-seg .sh{display:inline}
  .al-seg .lg{display:none}
  #zoomIn,#zoomOut{display:none}
  .al-bar{gap:5px;padding:6px 8px}
  .al-search{min-width:80px}
  .al-seg button{padding:4px 7px;font-size:12px}
  .al-btn{padding:4px 8px;font-size:12px}
  .al-detail{width:100%;top:auto;height:62%;border-left:0;border-top:1px solid #e5e7eb;box-shadow:0 -10px 30px rgba(15,23,42,.15)}
  .tp-hover{display:none}
  .al-hdr .tp-over{padding:4px 8px}
}

${LANES_CSS}
`;
