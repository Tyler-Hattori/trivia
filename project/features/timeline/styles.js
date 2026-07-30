/* One stylesheet, injected once into the timeline window. Replaces the inline
 * style strings the old renderer regenerated on every interaction. */

export const CSS = `
*,*::before,*::after{box-sizing:border-box}
html,body{height:100%;margin:0;overflow:hidden}
body{
  font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
  color:#0f172a;background:#fff;-webkit-font-smoothing:antialiased;
}
button{font:inherit;color:inherit}
:root{
  --rail:264px;
  --line:#e2e8f0;
  --line-soft:#eef2f7;
  --muted:#64748b;
  --faint:#94a3b8;
  --grid:#eef2f7;
  --grid-major:#dbe3ee;
}

#app{height:100%;display:flex;flex-direction:column}

/* ---------- command bar ---------- */
#cmd{flex:0 0 auto;border-bottom:1px solid var(--line);background:#fff;z-index:40}
.cmdrow{display:flex;align-items:center;gap:10px;padding:0 12px;height:46px}
.cmdrow + .cmdrow{border-top:1px solid var(--line-soft);height:auto;min-height:42px;padding:7px 12px;flex-wrap:wrap}
#tlTitle{font-size:15px;font-weight:800;white-space:nowrap;letter-spacing:-.01em}
#tlCount{font-size:11px;color:var(--faint);white-space:nowrap;font-variant-numeric:tabular-nums}

.searchbox{position:relative;flex:1 1 320px;max-width:520px;min-width:180px}
.searchbox input{
  width:100%;height:30px;padding:0 68px 0 30px;border:1px solid var(--line);border-radius:8px;
  background:#f8fafc;font-size:13px;outline:none;
}
.searchbox input:focus{background:#fff;border-color:#93c5fd;box-shadow:0 0 0 3px #bfdbfe55}
.searchbox .mag{position:absolute;left:9px;top:6px;color:var(--faint);font-size:13px;pointer-events:none}
.searchbox .kbd{position:absolute;right:8px;top:6px;font-size:10px;color:var(--faint);
  border:1px solid var(--line);border-radius:4px;padding:1px 5px;background:#fff;pointer-events:none}
.searchbox .hits{position:absolute;right:8px;top:7px;font-size:10px;color:#2563eb;font-weight:700}

.btn{
  border:1px solid var(--line);background:#fff;border-radius:7px;padding:4px 9px;cursor:pointer;
  font-size:12px;white-space:nowrap;line-height:1.5;
}
.btn:hover{background:#f1f5f9}
.btn.on{background:#0f172a;border-color:#0f172a;color:#fff}
.btn.accent.on{background:#2563eb;border-color:#2563eb}
.btn.icon{padding:4px 7px}
.btn:disabled{opacity:.4;cursor:default}

.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{border:0;background:#fff;padding:4px 10px;cursor:pointer;font-size:12px;white-space:nowrap}
.seg button + button{border-left:1px solid var(--line)}
.seg button:hover{background:#f1f5f9}
.seg button.on{background:#0f172a;color:#fff}

.grp{display:flex;align-items:center;gap:5px}
.grp .lbl{font-size:10px;font-weight:700;color:var(--faint);text-transform:uppercase;letter-spacing:.06em}
.spacer{margin-left:auto}
.dschip{
  display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line);background:#fff;
  border-radius:999px;padding:3px 9px 3px 6px;cursor:pointer;font-size:12px;white-space:nowrap;
}
.dschip:hover{background:#f8fafc}
.dschip .sw{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.dschip.off{opacity:.42}
.dschip.off .sw{background:#cbd5e1 !important}
.dschip .n{font-size:10px;color:var(--faint);font-variant-numeric:tabular-nums}

/* ---------- main grid: rail and stage share rows, so they always align ---------- */
#mid{
  flex:1 1 auto;min-height:0;display:grid;
  grid-template-columns:var(--rail) minmax(0,1fr);
  grid-template-rows:auto auto auto minmax(0,1fr);
}
#mid.norail{--rail:0px}
#mid.norail .railcell{display:none}
.railcell{border-right:1px solid var(--line);background:#fff;overflow:hidden;min-width:0}

.bandlabel{
  display:flex;align-items:center;gap:6px;padding:0 10px;font-size:10px;font-weight:700;
  color:var(--faint);text-transform:uppercase;letter-spacing:.06em;
}

/* ruler */
#rulerCell{border-bottom:1px solid var(--line)}
#ruler{position:relative;overflow:hidden;height:44px;border-bottom:1px solid var(--line);background:#fff}
#rulerInner{position:absolute;left:0;top:0;height:100%;will-change:transform}
.tick{position:absolute;top:24px;width:1px;height:8px;background:#cbd5e1}
.tick.maj{top:20px;height:12px;background:#94a3b8}
.ticklab{position:absolute;top:24px;transform:translateX(-50%);font-size:10.5px;color:#475569;
  font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.eralab{position:absolute;top:5px;transform:translateX(-50%);font-size:11px;color:#0f172a;
  font-weight:800;letter-spacing:.02em;white-space:nowrap}
#crosshair{position:absolute;top:0;width:1px;height:100%;background:#2563eb;display:none;pointer-events:none}
#crosshairLab{position:absolute;top:2px;transform:translateX(-50%);background:#2563eb;color:#fff;
  font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;display:none;pointer-events:none;
  font-variant-numeric:tabular-nums;white-space:nowrap}

/* era band + pin band */
#eraBand,#pinBand{position:relative;overflow:hidden;background:#fcfdff;border-bottom:1px solid var(--line)}
#pinBand{overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}
#eraInner,#pinInner{position:absolute;left:0;top:0;will-change:transform}
#eraCell{border-bottom:1px solid var(--line);display:flex;align-items:center}
#pinBand{background:#fffdf5}
#pinCell{border-bottom:1px solid var(--line);background:#fffdf5;position:relative}
#pinRailInner{position:absolute;inset:0}

/* scroller + canvas */
#scrollWrap{overflow:auto;position:relative;background:#fff;overscroll-behavior:contain}
#canvas{position:relative;transform-origin:0 0}
#canvas.grabbing{cursor:grabbing}

/* gridlines are painted as a background — zero DOM nodes */
#gridlayer{position:absolute;left:0;top:0;pointer-events:none;
  background-repeat:repeat;background-position:0 0}

/* rail */
#railBody{position:relative;overflow:hidden;background:#fff;border-right:1px solid var(--line)}
#railInner{position:absolute;left:0;top:0;width:100%;will-change:transform}
.rrow{position:absolute;left:0;width:100%;display:flex;align-items:center;gap:7px;
  padding:0 8px 0 0;cursor:pointer;user-select:none}
.rrow.section{background:#f1f5f9;border-top:1px solid var(--line);border-bottom:1px solid var(--line);
  padding-left:8px;font-weight:800}
.rrow.section .caret{width:12px;color:var(--muted);font-size:10px;text-align:center}
.rrow.section .nm{font-size:12.5px;color:#0f172a;letter-spacing:-.01em}
.rrow.section .n{margin-left:auto;font-size:10px;color:var(--faint);font-variant-numeric:tabular-nums}
/* Lanes can be thousands of pixels tall; anchor the label to the lane's top
   edge so it is on screen whenever any part of the lane is. */
.rrow.lane{border-left:4px solid transparent;padding-left:14px;
  align-items:flex-start;padding-top:5px}
.rrow.lane:hover{background:#f8fafc}
.rrow.lane .sw{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
.rrow.lane .nm{font-size:11.5px;color:#334155;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;text-transform:capitalize;min-width:0}
.rrow.lane .n{font-size:10px;color:var(--faint);font-variant-numeric:tabular-nums;flex:0 0 auto}
.rrow.lane.sel{font-weight:800}
.rrow.lane.sel .nm{color:#0f172a;font-weight:800}
.rrow.lane.nomatch{opacity:.32}
.rrow.lane.rollup .nm{font-style:italic;color:var(--muted)}
.rrow.lane.rollup:hover{background:#f1f5f9}
.rrow .pin{opacity:0;flex:0 0 auto;border:0;background:transparent;cursor:pointer;
  font-size:11px;color:var(--faint);padding:2px 3px;border-radius:4px;line-height:1}
.rrow:hover .pin{opacity:1}
.rrow .pin.on{opacity:1;color:#b45309}
.rrow .pin:hover{background:#e2e8f0}

/* A packed band holds several lanes at one height, so its rail row lists them
   as chips instead of a single name. Each chip is its own filter target. */
.rrow.band{align-items:flex-start;padding:4px 6px 0 10px;display:flex;flex-wrap:wrap;
  gap:3px 4px;align-content:flex-start;cursor:default}
.rrow.band .lchip{display:inline-flex;align-items:center;gap:4px;max-width:100%;
  border:1px solid var(--line);border-left-width:3px;border-radius:0 5px 5px 0;
  padding:1px 5px 1px 4px;background:#fff;cursor:pointer;min-width:0}
.rrow.band .lchip:hover{background:#f1f5f9}
.rrow.band .lchip.sel{background:#0f172a;border-color:#0f172a}
.rrow.band .lchip.sel .nm,.rrow.band .lchip.sel .n{color:#fff}
.rrow.band .lchip .sw{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
.rrow.band .lchip .nm{font-size:10.5px;color:#334155;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;text-transform:capitalize;min-width:0}
.rrow.band .lchip .n{font-size:9.5px;color:var(--faint);font-variant-numeric:tabular-nums;flex:0 0 auto}
.rrow.band .lchip.rollup .nm{font-style:italic;color:var(--muted)}
.rrow.band .lchip.nomatch{opacity:.35}

/* canvas furniture */
.secband{position:absolute;left:0;top:0;pointer-events:none;
  background:linear-gradient(#f1f5f9,#f8fafc);border-top:1px solid var(--line);
  border-bottom:1px solid var(--line-soft)}
.laneband{position:absolute;left:0;top:0;pointer-events:none;border-bottom:1px dashed var(--line-soft)}
.laneband.alt{background:#fbfcfe}
.lanetag{position:absolute;top:0;left:0;z-index:6;pointer-events:none;
  font-size:10px;font-weight:700;color:#334155;background:#ffffffdd;backdrop-filter:blur(3px);
  border:1px solid var(--line);border-left-width:3px;border-radius:0 6px 6px 0;
  padding:1px 7px 1px 6px;text-transform:capitalize;white-space:nowrap;max-width:190px;
  overflow:hidden;text-overflow:ellipsis}

/* items */
.it{position:absolute;left:0;top:0;cursor:pointer;contain:layout style paint}
.it.dim{opacity:.13}
.it.flash{animation:flash 1.3s ease-out}
@keyframes flash{
  0%{box-shadow:0 0 0 3px #2563eb,0 0 0 9px #2563eb44}
  100%{box-shadow:0 0 0 0 #2563eb00,0 0 0 0 #2563eb00}
}

.card{border-radius:10px;overflow:hidden;background:#fff;border:1px solid var(--bd);
  box-shadow:0 3px 9px rgba(15,23,42,.09);height:100%;display:flex;flex-direction:column}
.card .bar{height:3px;background:var(--c);flex:0 0 auto}
/* The picture is the point of a card, so it takes every pixel the caption does
   not need. object-fit is contain, not cover: cover was slicing a horizontal
   band out of every portrait image. The matte reads as a gallery mount. */
.card .ph{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;
  background:#eceff4;overflow:hidden}
.card .ph img{width:100%;height:100%;object-fit:contain;display:block}
/* A dead image URL degrades to a text card instead of a broken-image icon. */
.card .ph.failed,.card img.failed{display:none}
/* The detail tier is the reading tier, so the excerpt keeps a fixed share. */
.card.detail .ph{flex:0 0 auto;height:132px}
.card .body{flex:0 0 auto;padding:5px 7px 6px;min-height:0;overflow:hidden}
.card .t{font-size:11.5px;font-weight:700;line-height:1.22;color:#0f172a;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card .s{font-size:10.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .y{font-size:10px;color:var(--faint);margin-top:1px;font-variant-numeric:tabular-nums}
.card .x{font-size:10.5px;line-height:1.35;color:#475569;margin-top:4px;
  display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}

.chip{display:flex;height:100%;background:#fff;border:1px solid var(--bd);
  border-left:3px solid var(--c);border-radius:5px;box-shadow:0 1px 2px rgba(15,23,42,.08);overflow:hidden}
.chip .body{padding:4px 7px;min-width:0}
.chip .t{font-size:11px;font-weight:700;line-height:1.2;color:#0f172a;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.chip .y{font-size:9.5px;color:var(--faint);font-variant-numeric:tabular-nums}

.dot{border-radius:50%;background:var(--c);height:10px !important;width:10px !important;
  margin-top:4px;box-shadow:0 0 0 2px #fff}
.cluster{border-radius:999px;background:var(--c);color:#fff;font-size:9.5px;font-weight:800;
  display:flex;align-items:center;justify-content:center;height:16px !important;margin-top:1px;
  box-shadow:0 0 0 2px #fff;font-variant-numeric:tabular-nums}

.bin{background:var(--c);border-radius:1px;align-self:flex-end}

.span{border-radius:999px;background:var(--soft);border:1px solid var(--line2);
  display:flex;align-items:center;gap:5px;padding:0 7px;overflow:hidden;white-space:nowrap}
.span .sd{width:6px;height:6px;border-radius:50%;background:var(--c);flex:0 0 auto}
.span .t{font-size:10.5px;font-weight:700;color:#0f172a;overflow:hidden;text-overflow:ellipsis}
.span.tight{padding:0 3px;border-radius:3px}
.span.tight .sd,.span.tight .t{display:none}
.span.tight{background:var(--c);opacity:.72}

/* tooltip */
#tip{position:fixed;z-index:200;max-width:300px;background:#0f172a;color:#e2e8f0;
  padding:9px 11px;border-radius:9px;box-shadow:0 12px 32px rgba(0,0,0,.34);
  font-size:12px;line-height:1.45;pointer-events:none;display:none}
#tip .t{font-weight:800;font-size:12.5px;color:#fff;margin-bottom:2px}
#tip .m{color:#93c5fd;margin-bottom:2px}
#tip .y{color:#cbd5e1;font-variant-numeric:tabular-nums}
#tip .x{color:#94a3b8;margin-top:5px}

/* minimap */
#minimap{flex:0 0 auto;height:56px;border-top:1px solid var(--line);background:#f8fafc;
  position:relative;display:flex;align-items:stretch;user-select:none}
#mmLabel{flex:0 0 var(--rail);border-right:1px solid var(--line);background:#fff;
  display:flex;align-items:center;padding:0 10px;font-size:10px;font-weight:700;color:var(--faint);
  text-transform:uppercase;letter-spacing:.06em;gap:6px}
#mid.norail ~ #minimap #mmLabel{display:none}
#mmWrap{flex:1 1 auto;position:relative;cursor:crosshair;min-width:0}
#mmCanvas{position:absolute;inset:0;width:100%;height:100%;display:block}
#mmWindow{position:absolute;top:0;height:100%;background:#2563eb1a;border-left:2px solid #2563eb;
  border-right:2px solid #2563eb;pointer-events:none;min-width:3px}
#mmTicks{position:absolute;left:0;right:0;bottom:0;height:13px;pointer-events:none}
#mmTicks span{position:absolute;transform:translateX(-50%);font-size:9px;color:#94a3b8;
  font-variant-numeric:tabular-nums}

/* palette */
#palette{position:fixed;inset:0;z-index:400;background:rgba(15,23,42,.42);display:none;
  align-items:flex-start;justify-content:center;padding-top:11vh}
#palette.open{display:flex}
#palBox{width:min(660px,92vw);background:#fff;border-radius:14px;overflow:hidden;
  box-shadow:0 26px 70px rgba(0,0,0,.4);display:flex;flex-direction:column;max-height:70vh}
#palInput{border:0;border-bottom:1px solid var(--line);height:52px;padding:0 18px;font-size:16px;outline:none}
#palList{overflow:auto;padding:6px}
#palList .grp{padding:7px 12px 3px;font-size:10px;font-weight:800;color:var(--faint);
  text-transform:uppercase;letter-spacing:.06em;display:block}
#palList .row{display:flex;align-items:center;gap:9px;padding:7px 11px;border-radius:8px;cursor:pointer}
#palList .row.cur{background:#eff6ff}
#palList .row .sw{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
#palList .row .t{font-size:13px;font-weight:600;color:#0f172a;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
#palList .row .s{font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;min-width:0}
#palList .row .y{margin-left:auto;font-size:11px;color:var(--faint);flex:0 0 auto;
  font-variant-numeric:tabular-nums}
#palFoot{border-top:1px solid var(--line);padding:6px 14px;font-size:11px;color:var(--faint);
  display:flex;gap:14px;background:#f8fafc}
#palEmpty{padding:22px;text-align:center;color:var(--faint);font-size:13px}

/* lightbox */
#lb{position:fixed;inset:0;z-index:500;background:rgba(0,0,0,.9);display:none;
  align-items:center;justify-content:center;padding:30px}
#lb.open{display:flex}
.lbcard{background:#111827;border-radius:16px;overflow:hidden;
  box-shadow:0 22px 64px rgba(0,0,0,.5);max-height:92vh;display:flex;position:relative}
.lbcard.split{width:min(1120px,95vw);flex-direction:row;gap:22px}
.lbcard.stack{flex-direction:column}
.lbcard .imgwrap{background:#000;display:flex;align-items:center;justify-content:center;min-height:0}
.lbcard.split .imgwrap{flex:0 0 52%}
.lbcard.stack .imgwrap{flex:0 0 auto;overflow:hidden}
.lbcard img{width:100%;height:100%;object-fit:contain;display:block}
.lbcard .txt{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;overflow:hidden;padding:26px}
.lbcard.split .txt{padding:26px 26px 22px 0}
.lbcard .h{font-size:27px;font-weight:800;line-height:1.15;color:#fff;margin-bottom:8px}
.lbcard .m{font-size:15px;color:#d1d5db;margin-bottom:4px}
.lbcard .y{font-size:13px;font-weight:700;color:#93c5fd;letter-spacing:.04em;margin-bottom:15px;
  font-variant-numeric:tabular-nums}
.lbcard .body{flex:1 1 auto;overflow-y:auto;padding-right:10px;font-size:15px;line-height:1.7;color:#e5e7eb}
.lbcard .foot{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding-top:14px;
  border-top:1px solid #1f2937;margin-top:14px}
.lbbtn{border:1px solid #374151;background:#1f2937;color:#e5e7eb;border-radius:7px;
  padding:5px 11px;cursor:pointer;font-size:12px}
.lbbtn:hover{background:#374151}
.lbbtn:disabled{opacity:.35;cursor:default}
.lbcount{margin-left:auto;font-size:11px;color:#6b7280;font-variant-numeric:tabular-nums}
#lbClose{position:absolute;top:10px;right:12px;z-index:2;border:0;background:#00000055;color:#fff;
  width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:15px;line-height:1}

/* status / empty */
#empty{grid-row:4;grid-column:2;display:none;align-items:center;justify-content:center;
  flex-direction:column;gap:8px;color:var(--faint);font-size:14px;pointer-events:none;z-index:5}
#empty.on{display:flex}
#boot{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
  background:#fff;z-index:900;color:var(--faint);font-size:14px;gap:10px}
#boot.done{display:none}
.spin{width:15px;height:15px;border:2px solid #cbd5e1;border-top-color:#2563eb;border-radius:50%;
  animation:sp .7s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
`;
