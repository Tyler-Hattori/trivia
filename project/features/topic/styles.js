/*
 * The topic page's stylesheet. Deliberately close to the original art timeline
 * (white, one hairline, image cards with a colour strip) — that was the design
 * that was easy to read. Injected once.
 *
 * NO BACKTICKS INSIDE THIS TEMPLATE, including in comments (see docs/ATLAS.md, Atlas gotchas: it has
 * broken styles.js files three times).
 */
export const CSS = String.raw`
.tp{position:fixed;inset:0;z-index:50;background:#fff;color:#0f172a;display:flex;flex-direction:column;
  font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.tp *{box-sizing:border-box}
.tp button{font:inherit;cursor:pointer}
.tp-bar{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid #e5e7eb;background:#fff;flex-wrap:wrap}
.tp-title{font-size:20px;font-weight:800;letter-spacing:-.01em;margin-right:4px}
.tp-src{font-size:12px;color:#64748b;text-decoration:none}
.tp-src:hover{text-decoration:underline}
.tp-seg{display:inline-flex;border:1px solid #d1d5db;border-radius:9px;overflow:hidden}
.tp-seg button{border:0;background:#fff;padding:5px 11px;color:#334155}
.tp-seg button+button{border-left:1px solid #e5e7eb}
.tp-seg button.on{background:#0f172a;color:#fff}
.tp-btn{border:1px solid #d1d5db;background:#fff;border-radius:9px;padding:5px 11px;color:#334155}
.tp-btn:hover{background:#f8fafc}
.tp-btn.primary{background:#0f172a;color:#fff;border-color:#0f172a}
.tp-search{border:1px solid #d1d5db;border-radius:9px;padding:6px 10px;width:210px;outline:none}
.tp-search:focus{border-color:#94a3b8}
.tp-meta{font-size:12px;color:#64748b}
.tp-spacer{flex:1}

/* chapter chips: the filter, always visible */
.tp-chips{display:flex;gap:6px;padding:8px 16px;border-bottom:1px solid #e5e7eb;overflow-x:auto;flex-wrap:nowrap;background:#fff}
.tp-chip{white-space:nowrap;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700;border:1px solid var(--c);color:var(--c);background:#fff;user-select:none}
.tp-chip.on{background:var(--c);color:#fff}
.tp-chip .n{font-weight:500;opacity:.7;margin-left:4px}

.tp-body{flex:1;min-height:0;position:relative;display:flex}
.tp-main{flex:1;min-width:0;display:flex;flex-direction:column}
.tp-scroll{flex:1;overflow:auto;position:relative}
.tp-scroll.dragging{cursor:grabbing;user-select:none}
.tp-select{border:1px solid #d1d5db;border-radius:9px;padding:5px 8px;background:#fff;color:#334155;font:inherit;max-width:170px}
.tp-btn.sm{padding:3px 9px;font-size:12px}
.tp-btn:disabled{opacity:.35;cursor:default}

/* contents rail */
.tp-rail{width:258px;flex:none;border-right:1px solid #e5e7eb;overflow:auto;padding:12px 10px 20px;background:#fcfcfd}
.tp-rail .hd{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#94a3b8;padding:2px 8px 8px}
.tp-rail .ft{padding:12px 8px 0;line-height:1.5}
.tp-toc{display:flex;align-items:flex-start;gap:9px;width:100%;text-align:left;border:0;background:none;border-radius:10px;padding:7px 8px;color:#334155}
.tp-toc:hover{background:#f1f5f9}
.tp-toc.on{background:#fff;box-shadow:0 0 0 1px #e2e8f0,0 2px 6px rgba(15,23,42,.06)}
.tp-toc .dot{width:9px;height:9px;border-radius:3px;background:var(--c);margin-top:5px;flex:none}
.tp-toc .tx{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.tp-toc .nm{font-weight:650;font-size:13px;line-height:1.3}
.tp-toc.on .nm{color:#0f172a}
.tp-toc .yr{font-size:11px;color:#94a3b8}
.tp-toc .k{font-size:11px;color:#94a3b8;font-variant-numeric:tabular-nums;margin-top:2px}
.tp-prog{display:block;height:3px;border-radius:2px;background:#e2e8f0;overflow:hidden;margin-top:4px}
.tp-prog i{display:block;height:100%;background:#16a34a;border-radius:2px}

/* timeline overview strip */
.tp-over{display:flex;align-items:center;gap:10px;padding:6px 16px;border-bottom:1px solid #e5e7eb;background:#fcfcfd}
.tp-over .strip{position:relative;flex:1;height:22px;border-radius:6px;background:#f1f5f9;cursor:pointer;overflow:hidden}
.tp-over .seg{position:absolute;top:3px;bottom:3px;border-radius:4px;color:#fff;font-size:10.5px;font-weight:700;padding:1px 5px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.85}
.tp-over .seg:hover{opacity:1}
.tp-over .yr{position:absolute;top:4px;font-size:10.5px;color:#64748b;transform:translateX(-50%);pointer-events:none}
.tp-over .win{position:absolute;top:0;bottom:0;border:2px solid #0f172a;border-radius:6px;pointer-events:none;background:rgba(15,23,42,.06)}
.tp-hover{position:fixed;z-index:80;width:330px;background:#0f172a;color:#e2e8f0;border-radius:10px;padding:9px 11px;font-size:12.5px;line-height:1.5;
  pointer-events:none;opacity:0;transition:opacity .12s;box-shadow:0 10px 30px rgba(15,23,42,.3)}
.tp-hover.on{opacity:1}
.tp-hover b{color:#fff}
.tp-hover .tp-meta{color:#94a3b8}
.tp-hover div{margin-top:4px}
.tp-canvas{position:relative}

/* chapter bands across the top of the canvas, sticky vertically */
.tp-bands{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.97);border-bottom:1px solid #e5e7eb}
.tp-band{position:absolute;height:22px;border-radius:5px;font-size:11.5px;font-weight:700;color:#fff;padding:3px 8px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;opacity:.92}
.tp-band:hover{opacity:1}
.tp-band.dim{opacity:.25}
.tp-tick{position:absolute;font-size:11px;color:#64748b;transform:translateX(-50%);white-space:nowrap}
.tp-grid{position:absolute;width:1px;background:#f1f5f9}
.tp-break{position:absolute;display:flex;align-items:flex-start;justify-content:center;padding-top:24px;font-size:11px;color:#94a3b8;
  background:repeating-linear-gradient(135deg,#fff 0 6px,#f8fafc 6px 12px);border-left:1px dashed #cbd5e1;border-right:1px dashed #cbd5e1}
.tp-break span{background:#fff;padding:2px 6px;border-radius:6px;writing-mode:vertical-rl;transform:rotate(180deg)}

/* cards */
.tp-card{position:absolute;width:var(--w);background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;
  box-shadow:0 4px 12px rgba(15,23,42,.06);cursor:pointer;transition:box-shadow .15s,opacity .15s}
.tp-card:hover{box-shadow:0 8px 20px rgba(15,23,42,.14);z-index:5}
.tp-card.sel{box-shadow:0 0 0 2px #0f172a,0 8px 20px rgba(15,23,42,.14);z-index:6}
.tp-card.dim{opacity:.16}
.tp-card.minor{box-shadow:none;border-color:#eef2f7}
.tp-card .strip{height:6px}
.tp-card img{display:block;width:100%;height:var(--ih);object-fit:contain;background:#f8fafc}
.tp-card .noimg{height:var(--ih);padding:8px 9px;background:#f8fafc;font-size:11px;color:#475569;overflow:hidden;
  display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical}
.tp-card .cap{padding:6px 9px 8px}
.tp-card .t{font-size:12px;font-weight:700;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tp-card .y{font-size:11px;color:#64748b;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tp-card .ty{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#94a3b8}
.tp-card .ok{color:#16a34a}
.tp-span{position:absolute;height:3px;border-radius:2px;opacity:.55;pointer-events:none}
.tp-subj{padding-top:6px;padding-bottom:6px;background:#fafafa}
.tp-subj .tp-chip{font-weight:600}
.tp-pin{position:absolute;width:1px;background:#cbd5e1}

/* detail drawer */
.tp-detail{width:420px;max-width:42vw;border-left:1px solid #e5e7eb;overflow:auto;background:#fff;display:none}
.tp-detail.open{display:block}
.tp-detail .hd{display:flex;align-items:center;gap:6px;padding:10px 14px;border-bottom:1px solid #f1f5f9;position:sticky;top:0;background:#fff}
.tp-detail img{width:100%;max-height:340px;object-fit:contain;background:#f8fafc;display:block}
.tp-detail .in{padding:14px 18px 24px}
.tp-detail h2{font-size:21px;line-height:1.25;margin:0 0 4px;font-weight:800}
.tp-detail .sub{color:#64748b;font-size:13px;margin-bottom:10px}
.tp-detail p{color:#334155;line-height:1.6;margin:0 0 10px}
.tp-detail .lb,.tp-ctx .lb{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#94a3b8;margin:16px 0 6px}
.tp-ctx{border-left:3px solid var(--c);padding:2px 0 2px 12px;color:#1e293b;font-size:15px;line-height:1.6}
.tp-ctx .lb{margin-top:0}
.tp-note{margin-top:12px;font-size:14px}
.tp-credit{font-size:13px;color:#475569;margin:2px 0 6px}
.tp-credit a{color:#0f172a}
.tp-rel{display:flex;flex-wrap:wrap;gap:6px}
.tp-relc{border:1px solid #e2e8f0;background:#fff;border-radius:999px;padding:3px 10px;font-size:12.5px;color:#0f172a}
.tp-relc:hover{background:#f8fafc;border-color:#cbd5e1}
.tp-relc span{color:#94a3b8;margin-left:3px}
.tp-about p{font-size:13.5px}
.tp-about summary{cursor:pointer;color:#64748b;font-size:13px;margin-bottom:8px}
.tp-nav2{display:flex;justify-content:space-between;gap:8px;margin-top:16px;border-top:1px solid #f1f5f9;padding-top:12px}
.tp-nav2 .tp-btn{font-size:12px;max-width:48%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tp-badge{display:inline-block;font-size:11px;border-radius:999px;padding:1px 8px;margin-right:6px;border:1px solid #e5e7eb;color:#475569}

/* learn view */
.tp-read{max-width:860px;margin:0 auto;padding:22px 32px 120px}
.tp-head h1{font-size:34px;font-weight:850;letter-spacing:-.02em;margin:6px 0 4px}
.tp-head .tp-meta a{color:#475569}
.tp-intro{color:#1e293b;font-size:16px;line-height:1.7;margin:14px 0 6px;max-width:72ch}
.tp-intro p{margin:0 0 10px}
.tp-intro.lead{font-size:17px;padding-bottom:6px}
.tp-ch{padding-top:30px;scroll-margin-top:8px}
.tp-chhd{border-top:4px solid var(--c);padding-top:12px}
.tp-chhd .num{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--c)}
.tp-chhd h2{font-size:27px;font-weight:850;letter-spacing:-.015em;margin:2px 0 2px}
.tp-chhd .yr{font-size:13px;color:#64748b}
.tp-sub{font-size:13px;font-weight:700;letter-spacing:.03em;color:#64748b;margin:22px 0 2px;text-transform:uppercase}
.tp-row{display:grid;grid-template-columns:118px 1fr 64px;gap:14px;padding:10px 10px;margin:0 -10px;border-radius:10px;cursor:pointer}
.tp-row:hover{background:#f8fafc}
.tp-row.sel{background:#f1f5f9}
.tp-row .yr{font-variant-numeric:tabular-nums;color:#475569;font-size:12.5px;font-weight:650;padding-top:2px}
.tp-row .t{font-weight:700;font-size:15px;display:flex;align-items:baseline;gap:7px}
.tp-row .t .ok{color:#16a34a;font-size:13px}
.tp-row .t .ty{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8}
.tp-row .s{color:#334155;font-size:14px;line-height:1.55;margin-top:2px}
.tp-row .im img{width:64px;height:52px;object-fit:cover;background:#f8fafc;border-radius:7px;display:block}
.tp-row:not(.key) .t{font-weight:600;color:#334155}
.tp-chend{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 6px;padding:14px;border-radius:12px;background:#f8fafc}

/* topic list */
.tp-chiprow{display:flex;gap:6px;padding:8px 16px;border-bottom:1px solid #e5e7eb;overflow-x:auto;background:#fff;align-items:center}
.tp-tlist{max-width:1280px;margin:0 auto;padding:6px 24px 60px}
.tp-shelf{font-size:13px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#475569;margin:22px 0 10px}
.tp-tgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px}
.tp-tcard{position:relative;display:flex;gap:12px;border:1px solid #e5e7eb;border-radius:14px;background:#fff;cursor:pointer;padding:10px;outline:none}
.tp-tcard:hover,.tp-tcard:focus{box-shadow:0 8px 20px rgba(15,23,42,.09);border-color:#cbd5e1}
.tp-tcard.hid{opacity:.45}
.tp-tcard .im{width:76px;height:76px;flex:none;border-radius:10px;overflow:hidden;background:#f1f5f9}
.tp-tcard .im img{width:100%;height:100%;object-fit:cover;display:block}
.tp-tcard .in{flex:1;min-width:0}
.tp-tcard .t{font-weight:800;font-size:15px;line-height:1.25}
.tp-tcard .bl{font-size:12.5px;color:#475569;line-height:1.45;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tp-tcard .tp-prog{margin-top:6px}
.tp-tcard .x{position:absolute;top:6px;right:6px;border:0;background:#fff;color:#94a3b8;border-radius:6px;width:22px;height:22px;line-height:1;opacity:0}
.tp-tcard:hover .x,.tp-tcard.hid .x{opacity:1}
.tp-tcard .x:hover{color:#0f172a;background:#f1f5f9}
.tp-also{text-decoration:none}
.tp-list{max-width:1100px;margin:0 auto;padding:24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px}
.tp-tile{border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;background:#fff;cursor:pointer;text-align:left;padding:0}
.tp-tile:hover{box-shadow:0 10px 24px rgba(15,23,42,.1)}
.tp-tile img{width:100%;height:170px;object-fit:cover;background:#f1f5f9;display:block}
.tp-tile .in{padding:12px 14px}
.tp-tile .t{font-size:18px;font-weight:800}
.tp-tile .tp-prog{margin:6px 0}
.tp-empty{max-width:700px;margin:40px auto;color:#475569;line-height:1.6}
.tp-empty code{background:#f1f5f9;padding:2px 6px;border-radius:5px}

/* quiz */
.tp-quiz{max-width:860px;margin:0 auto;padding:20px 24px 80px}
.tp-q{border:1px solid #e5e7eb;border-radius:18px;padding:20px;margin-top:14px}
.tp-q h3{font-size:22px;margin:0 0 12px}
.tp-opt{display:block;width:100%;text-align:left;border:1px solid #e5e7eb;border-radius:12px;padding:10px 12px;margin:6px 0;background:#fff}
.tp-opt:hover{background:#f8fafc}
.tp-opt.ok{border-color:#16a34a;background:#f0fdf4}
.tp-opt.bad{border-color:#f87171;background:#fef2f2}
.tp-opt .num{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:#0f172a;color:#fff;font-size:12px;margin-right:8px}
.tp-opt .num.empty{background:#e2e8f0}
.tp-in{border:1px solid #d1d5db;border-radius:12px;padding:10px 12px;width:100%;font-size:16px}
.tp-in.ok{border-color:#16a34a;background:#f0fdf4}
.tp-in.bad{border-color:#f87171;background:#fef2f2}
.tp-score{display:flex;gap:16px;font-size:13px;color:#334155}
.tp-qhead{font-size:15px;margin-bottom:10px}
.tp-ordr{margin:6px 0}
.tp-ordr a{color:#0f172a}

/* links styled as buttons, home bar, review counts */
a.tp-btn{text-decoration:none;display:inline-flex;align-items:center;gap:5px}
.tp-btn.primary b{color:#fde68a}
.tp-brand{font-size:21px}
.tp-due{color:#b45309;font-weight:700}
.tp-mob{display:none}
.tp-row .yr2{display:none}

/* Meanwhile: the other topics at the same time */
.tp-mw-r{font-weight:500;letter-spacing:0;text-transform:none;color:#94a3b8;margin-left:4px}
.tp-mw{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}
.tp-mw .g{min-width:0}
.tp-mw .h{font-size:12px;font-weight:700;color:#334155;margin-bottom:3px}
.tp-mw .h span{color:#94a3b8;font-weight:500}
.tp-mw a{display:block;font-size:12.5px;color:#0f172a;text-decoration:none;padding:2px 0;line-height:1.35;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tp-mw a:hover{text-decoration:underline}
.tp-mw a .y{color:#64748b;font-variant-numeric:tabular-nums;font-size:11.5px}

/* phones: one column; the rail is a drawer, the detail panel a full screen */
@media (max-width:760px){
  .tp-mob{display:inline-flex}
  .tp-hide-m{display:none !important}
  .tp-bar{gap:6px;padding:8px 10px}
  .tp-title{font-size:17px;margin-right:0}
  .tp-search{width:100%;order:10}
  .tp-src,.tp-bar>.tp-meta{display:none}
  .tp-select{max-width:46vw}
  .tp-seg button{padding:5px 9px}
  .tp-rail{position:fixed;left:0;top:0;bottom:0;width:86vw;max-width:340px;z-index:75;transform:translateX(-102%);
    transition:transform .2s;box-shadow:0 0 40px rgba(15,23,42,.25);padding-top:16px}
  .tp-rail.open{transform:none}
  .tp-railx{position:absolute;right:10px;top:8px}
  .tp-detail{position:fixed;inset:0;width:100%;max-width:100%;z-index:80;border:0}
  .tp-detail img{max-height:260px}
  .tp-read{padding:12px 16px 100px}
  .tp-head h1{font-size:27px}
  .tp-chhd h2{font-size:22px}
  .tp-intro{font-size:15.5px;line-height:1.65}
  .tp-intro.lead{font-size:16px}
  .tp-row{grid-template-columns:1fr 56px;gap:10px;padding:9px 8px;margin:0 -8px}
  .tp-row>.yr{display:none}
  .tp-row .yr2{display:block;font-size:12px;color:#64748b;font-weight:600;margin-top:1px}
  .tp-row .t{font-size:15px;flex-wrap:wrap}
  .tp-row .im img{width:56px;height:48px}
  .tp-chend{padding:10px}
  .tp-quiz{padding:10px 12px 80px}
  .tp-q{padding:14px;border-radius:14px}
  .tp-q h3{font-size:19px}
  .tp-tlist{padding:4px 12px 60px}
  .tp-tgrid{grid-template-columns:1fr}
  .tp-tcard .x{opacity:1}
  .tp-over{padding:6px 10px}
  .tp-mw{grid-template-columns:1fr}
}
`;

let injected = false;
export function injectStyles(){
  if(injected) return;
  const el = document.createElement('style');
  el.textContent = CSS;
  document.head.appendChild(el);
  injected = true;
}
