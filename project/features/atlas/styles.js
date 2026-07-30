/*
 * The whole stylesheet, injected once into the atlas window.
 *
 * Two rules here are load-bearing and were bugs in the old view:
 *
 *   1. ONE EDGE PER SURFACE. A card gets a `border` and nothing else. Selection
 *      and hover are `box-shadow` rings, which paint outside the border box and
 *      so read as a halo rather than a second frame. There is deliberately no
 *      `outline` anywhere except the accessibility focus ring, and every
 *      interactive element sets `outline:none` on `:focus` while providing a
 *      shadow-based `:focus-visible` instead. That is what stops the doubled
 *      outlines that appeared when zoomed in.
 *
 *   2. NEVER CROP. Every `img` that shows a dataset picture is
 *      `object-fit: contain` on a matte. `cover` fills the frame prettily and
 *      slices a band out of the middle of every portrait, which is unacceptable
 *      for a timeline whose subject is often the picture itself.
 */

export const CSS = `
:root{
  --bg:#0b0e14; --bg2:#0e121a; --panel:#111726; --panel2:#151c2c;
  --line:#1f2937; --line2:#2b3a52;
  --text:#e2e8f0; --muted:#94a3b8; --faint:#64748b;
  --accent:#38bdf8; --accent2:#0ea5e9;
  --matte:#0d1119;
  --shadow:0 10px 34px rgba(0,0,0,.5);
}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden}
body{
  background:var(--bg); color:var(--text);
  font:13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
button:focus{outline:none}
button:focus-visible{box-shadow:0 0 0 2px var(--accent)}
a{color:var(--accent)}

/* ---------- boot ---------- */
#boot{
  position:fixed;inset:0;display:flex;gap:12px;align-items:center;justify-content:center;
  background:var(--bg);z-index:99;color:var(--muted);
}
#boot.gone{display:none}
.spin{
  width:16px;height:16px;border:2px solid var(--line);border-top-color:var(--accent);
  border-radius:50%;animation:sp .7s linear infinite;
}
@keyframes sp{to{transform:rotate(360deg)}}
#boot pre{
  margin:0;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--muted);text-align:left;white-space:pre-wrap;max-width:620px;
}

/* ---------- shell ---------- */
#app{display:flex;flex-direction:column;height:100%}

#cmd{
  flex:0 0 auto;background:var(--panel);border-bottom:1px solid var(--line);
  padding:7px 10px;display:flex;flex-direction:column;gap:7px;
}
.cmdrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:28px}
#title{font-weight:650;letter-spacing:.2px}
#count{color:var(--faint);font-size:11.5px;white-space:nowrap}
.spacer{margin-left:auto}
.grp{display:flex;align-items:center;gap:5px}

.btn{
  padding:4px 9px;border:1px solid var(--line);border-radius:6px;
  background:var(--panel2);color:var(--muted);font-size:11.5px;white-space:nowrap;
}
.btn:hover{border-color:#3b4c66;color:var(--text)}
.btn.on{background:var(--accent);border-color:var(--accent);color:#04212f;font-weight:600}
.btn.icon{width:26px;text-align:center;padding:4px 0}
.btn.tiny{padding:2px 6px;font-size:10.5px;border-radius:5px}
.btn[disabled]{opacity:.4;cursor:default}

.seg{display:flex;border:1px solid var(--line);border-radius:7px;overflow:hidden}
.seg button{padding:4px 10px;font-size:11.5px;color:var(--muted);background:var(--panel2)}
.seg button+button{border-left:1px solid var(--line)}
.seg button.on{background:var(--accent);color:#04212f;font-weight:600}

.searchbox{position:relative;display:flex;align-items:center;min-width:270px;flex:1;max-width:480px}
.searchbox input{
  width:100%;padding:5px 52px 5px 26px;border:1px solid var(--line);border-radius:7px;
  background:var(--bg2);color:var(--text);font-size:12px;
}
.searchbox input:focus{outline:none;border-color:var(--accent2)}
.searchbox .mag{position:absolute;left:8px;color:var(--faint);font-size:12px;pointer-events:none}
.searchbox .kbd{
  position:absolute;right:7px;color:var(--faint);font-size:10px;
  border:1px solid var(--line);border-radius:4px;padding:0 4px;pointer-events:none;
}
.searchbox .clear{position:absolute;right:26px;color:var(--faint);font-size:13px;display:none}
.searchbox.filled .clear{display:block}
.searchbox.filled .kbd{display:none}

#ppyLab{font-size:11px;color:var(--faint);min-width:74px;text-align:center;font-variant-numeric:tabular-nums}

/* ---------- filter row ---------- */
#facets{display:none;gap:6px;align-items:flex-start;flex-wrap:wrap}
#facets.on{display:flex}
.facet{display:flex;gap:4px;align-items:center;flex-wrap:wrap;max-width:100%}
.facet>label{color:var(--faint);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;margin-right:2px}
.tag{
  padding:2px 7px;border:1px solid var(--line);border-radius:999px;
  background:var(--panel2);color:var(--muted);font-size:11px;
}
.tag:hover{border-color:#3b4c66;color:var(--text)}
.tag.on{background:var(--accent);border-color:var(--accent);color:#04212f;font-weight:600}

/* ---------- middle ---------- */
#mid{flex:1;display:flex;min-height:0;position:relative}

/*
 * The rail is created inside a host div, but it is written to BE the flex item of
 * #mid (flex:0 0 216px, a bounded column so .railbody can scroll). Left as a plain
 * wrapper, #railHost would be the flex item instead and the rail would size to its
 * content with an unbounded height. display:contents dissolves the wrapper.
 */
#railHost{display:contents}

.rail{
  flex:0 0 216px;background:var(--panel);border-right:1px solid var(--line);
  display:flex;flex-direction:column;min-height:0;
}
.rail.hidden{display:none}
.railhead{
  flex:0 0 auto;display:flex;align-items:center;gap:5px;padding:6px 8px;
  border-bottom:1px solid var(--line);font-size:10.5px;text-transform:uppercase;
  letter-spacing:.07em;color:var(--faint);
}
.railhead>span{margin-right:auto}
.railbody{flex:1;overflow-y:auto;overflow-x:hidden;padding:3px 0 10px}
.railbody::-webkit-scrollbar{width:9px}
.railbody::-webkit-scrollbar-thumb{background:#243044;border-radius:5px}

.rrow{
  display:flex;align-items:center;gap:4px;padding:2px 6px 2px 0;
  padding-left:calc(4px + var(--ind));font-size:11.5px;cursor:pointer;
  border-left:2px solid transparent;
}
.rrow:hover{background:#18202f}
.rrow.cur{background:#1b2740;border-left-color:var(--accent)}
.rrow.muted{opacity:.38}
.rrow .twist{width:13px;flex:0 0 13px;color:var(--faint);font-size:9px;text-align:center}
.rrow .sw{width:8px;height:8px;flex:0 0 8px;border-radius:2px;background:var(--hue)}
.rrow .rlabel{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#cbd5e1}
.rrow.col .rlabel{color:var(--hue);font-weight:600}
.rrow .rn{color:var(--faint);font-size:10px;font-variant-numeric:tabular-nums}
.rrow .rpin{width:15px;flex:0 0 15px;color:var(--line2);font-size:9px;opacity:0;text-align:center}
.rrow:hover .rpin{opacity:.6}
.rrow .rpin.on{opacity:1;color:var(--accent)}

/* ---------- canvas stack ---------- */
#stage{flex:1;position:relative;min-width:0;overflow:hidden;background:var(--bg)}
#pinWrap{
  position:absolute;left:0;right:0;top:0;z-index:3;
  border-bottom:1px solid var(--line);box-shadow:0 6px 16px rgba(0,0,0,.35);
  display:none;
}
#pinWrap.on{display:block}
#pinCanvas{display:block}
#pinBar{
  position:absolute;right:6px;top:3px;display:flex;gap:4px;z-index:4;
}

#surface{position:absolute;inset:0;cursor:grab}
#surface.dragging{cursor:grabbing}
#canvas{display:block;position:absolute;inset:0}

.cardlayer{position:absolute;inset:0;pointer-events:none}
.cardlayer .c{pointer-events:auto}

/* ---------- cards ---------- */
/*
 * One border, no outline. The --hue variable is the cluster colour, used for the
 * accent bar and the selection ring, so a card visibly belongs to its band.
 */
.c{
  position:absolute;top:0;left:0;
  display:flex;flex-direction:column;overflow:hidden;
  background:var(--panel);border:1px solid var(--line);border-radius:7px;
  will-change:transform;contain:layout paint style;
  transition:box-shadow .1s linear,border-color .1s linear;
}
.c::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--hue);opacity:.85}
.c:hover,.c.hov{border-color:#3d4f6b;box-shadow:0 0 0 2px rgba(226,232,240,.16),var(--shadow);z-index:2}
.c.sel{border-color:var(--accent);box-shadow:0 0 0 3px rgba(56,189,248,.34),var(--shadow);z-index:3}
.c.dimmed{opacity:.26}

/*
 * The picture takes every pixel the caption does not, and is CONTAINED on a
 * matte. A portrait shows as a portrait with matte at the sides; a landscape
 * shows with matte above and below. Nothing is ever sliced.
 */
.c .pic{flex:1;min-height:0;background:var(--matte);display:flex;align-items:center;justify-content:center}
.c .pic img{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:block}
.c.noimg .pic{display:none}
.c .cap{flex:0 0 auto;padding:4px 6px 5px 8px;border-top:1px solid var(--line)}
.c.noimg .cap{border-top:0;padding-top:7px}
.c .t{
  font-size:11px;line-height:1.25;font-weight:600;color:#e8eef7;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
}
.c .y{font-size:10px;color:var(--faint);margin-top:1px;font-variant-numeric:tabular-nums}
.c .ex{display:none}
.c.withex .ex{
  display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;
  margin:0;padding:0 8px 7px;font-size:10.5px;line-height:1.42;color:#a9b6c8;
}
.c.big .t{font-size:12px}

/* ---------- hover preview ---------- */
.tip{
  position:fixed;left:0;top:0;z-index:40;width:300px;max-height:70vh;
  background:var(--panel);border:1px solid var(--line);border-radius:9px;
  box-shadow:var(--shadow);overflow:hidden;pointer-events:none;
  opacity:0;transition:opacity .08s linear;will-change:transform;
  display:flex;flex-direction:column;
}
.tip.on{opacity:1}
.tip::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--hue)}
.tip .tpic{flex:0 0 auto;max-height:190px;background:var(--matte);display:flex;align-items:center;justify-content:center}
.tip .tpic img{max-width:100%;max-height:190px;width:auto;height:auto;object-fit:contain;display:block}
.tip .tbody{padding:7px 10px 9px 11px;overflow:hidden}
.tip .tt{font-weight:650;font-size:12.5px;line-height:1.3}
.tip .ts{font-size:11px;color:var(--muted);margin-top:1px}
.tip .ty{font-size:10.5px;color:var(--faint);margin-top:3px;font-variant-numeric:tabular-nums}
.tip .tex{margin:6px 0 0;font-size:11px;line-height:1.45;color:#aab7c9}
.tip .ttopics{display:flex;flex-wrap:wrap;gap:3px;margin-top:7px}
.tip .ttopics span{font-size:9.5px;color:var(--faint);border:1px solid var(--line);border-radius:999px;padding:0 5px}

/* ---------- detail panel ---------- */
.detail{
  position:absolute;right:0;top:0;bottom:0;width:376px;z-index:20;
  background:var(--panel);border-left:1px solid var(--line);
  box-shadow:-14px 0 34px rgba(0,0,0,.45);
  overflow-y:auto;transform:translateX(100%);
  transition:transform .16s cubic-bezier(.32,.72,.32,1);
}
.detail.on{transform:none}
.detail::-webkit-scrollbar{width:10px}
.detail::-webkit-scrollbar-thumb{background:#243044;border-radius:5px}

.dhead{
  position:sticky;top:0;z-index:2;display:flex;align-items:flex-start;gap:6px;
  padding:7px 8px;background:var(--panel);border-bottom:1px solid var(--line);
}
.dpath{flex:1;display:flex;align-items:center;gap:3px;flex-wrap:wrap;font-size:10.5px}
.dpath .crumb{color:var(--hue);border:1px solid var(--line);border-radius:5px;padding:1px 6px}
.dpath .crumb:hover{border-color:var(--hue)}
.dpath .sep{color:var(--faint)}
.dclose{flex:0 0 22px;height:22px;border-radius:5px;color:var(--muted);font-size:12px}
.dclose:hover{background:#1d2739;color:var(--text)}

/* Uncropped here too, and clickable to go larger — still uncropped. */
.dpic{margin:0;background:var(--matte);cursor:zoom-in;position:relative}
.dpic img{display:block;width:100%;max-height:330px;object-fit:contain}
.dpic figcaption{
  position:absolute;right:6px;bottom:5px;font-size:9.5px;color:var(--muted);
  background:rgba(11,14,20,.72);border-radius:4px;padding:1px 5px;
}

.dbody{padding:11px 13px 26px}
.dbody h2{margin:0;font-size:16px;line-height:1.28}
.dsub{color:var(--muted);font-size:12px;margin-top:2px}
.dyear{color:var(--faint);font-size:11.5px;margin-top:5px;font-variant-numeric:tabular-nums}
.dyear .approx{border:1px solid var(--line);border-radius:4px;padding:0 4px;font-size:9.5px}
.dex{margin-top:11px;font-size:12.5px;line-height:1.62;color:#c4cfdd}
.dex p{margin:0 0 9px}
.dex.empty{color:var(--faint);font-size:11.5px}
.dex code{background:var(--bg2);border:1px solid var(--line);border-radius:4px;padding:1px 4px;font-size:11px}

.dsection{margin-top:16px;border-top:1px solid var(--line);padding-top:11px}
.dsection h3{
  margin:0 0 7px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);
}
.chips{display:flex;flex-wrap:wrap;gap:4px}
.chip{
  border:1px solid var(--line);border-radius:999px;padding:2px 8px;
  font-size:11px;color:var(--muted);background:var(--panel2);
}
.chip:hover{border-color:var(--accent2);color:var(--text)}

.facets{margin:0;display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:11.5px}
.facets dt{color:var(--faint)}
.facets dd{margin:0;color:#c4cfdd}

.near{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
.near button{
  display:flex;align-items:center;gap:7px;width:100%;text-align:left;
  padding:3px 5px;border-radius:5px;font-size:11.5px;
}
.near button:hover{background:#1b2434}
.near .swatch{width:7px;height:7px;border-radius:2px;flex:0 0 7px}
.near .nt{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.near .ny{color:var(--faint);font-size:10px;font-variant-numeric:tabular-nums}

.dlinks{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px}
.dlinks .did{color:#3d4a5c;font-family:ui-monospace,Menlo,monospace;font-size:9.5px;word-break:break-all}

/* ---------- enlarged image ---------- */
.lightbox{
  position:fixed;inset:0;z-index:60;background:rgba(6,9,14,.92);
  display:none;align-items:center;justify-content:center;cursor:zoom-out;
}
.lightbox.on{display:flex}
.lightbox .lbinner{position:relative;max-width:94vw;max-height:94vh}
.lightbox img{
  display:block;max-width:94vw;max-height:94vh;
  width:auto;height:auto;object-fit:contain;   /* never cropped, at any size */
  border-radius:4px;box-shadow:0 24px 70px rgba(0,0,0,.6);
}
.lbclose{
  position:absolute;right:-6px;top:-30px;color:var(--muted);font-size:15px;
  width:26px;height:26px;border-radius:6px;
}
.lbclose:hover{color:var(--text);background:rgba(255,255,255,.09)}

/* ---------- ruler ---------- */
#ruler{
  flex:0 0 auto;height:22px;position:relative;overflow:hidden;
  background:var(--panel);border-bottom:1px solid var(--line);
}
#ruler .tk{
  position:absolute;top:0;bottom:0;padding-left:5px;font-size:10px;
  color:var(--faint);border-left:1px solid var(--line);
  line-height:21px;white-space:nowrap;font-variant-numeric:tabular-nums;
}
#ruler .tk.maj{color:#a9b7c9;border-left-color:#2f3d52}

/* ---------- minimap ---------- */
#mini{
  flex:0 0 auto;height:44px;background:var(--panel);border-top:1px solid var(--line);
  position:relative;display:flex;align-items:stretch;
}
#miniCanvas{display:block;flex:1;cursor:crosshair}
#miniWin{
  position:absolute;top:0;bottom:0;border:1px solid var(--accent);
  background:rgba(56,189,248,.13);pointer-events:none;
}

/* ---------- empty state ---------- */
#empty{
  position:absolute;inset:0;display:none;align-items:center;justify-content:center;
  color:var(--faint);font-size:13px;pointer-events:none;z-index:5;
}
#empty.on{display:flex}
#empty div{background:rgba(11,14,20,.86);border:1px solid var(--line);border-radius:8px;padding:10px 16px}

/* ---------- status ---------- */
#status{
  position:absolute;left:8px;bottom:8px;z-index:6;font-size:10.5px;color:var(--faint);
  background:rgba(11,14,20,.78);border:1px solid var(--line);border-radius:6px;
  padding:3px 8px;pointer-events:none;font-variant-numeric:tabular-nums;
}

/* ---------- help ---------- */
#help{
  position:fixed;inset:0;z-index:70;background:rgba(6,9,14,.86);
  display:none;align-items:center;justify-content:center;
}
#help.on{display:flex}
#helpBox{
  background:var(--panel);border:1px solid var(--line);border-radius:11px;
  padding:18px 22px;max-width:560px;box-shadow:var(--shadow);
}
#helpBox h3{margin:0 0 12px;font-size:14px}
#helpBox dl{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;margin:0;font-size:12px}
#helpBox dt{color:var(--accent);font-family:ui-monospace,Menlo,monospace;white-space:nowrap}
#helpBox dd{margin:0;color:var(--muted)}
#helpBox .note{margin-top:13px;font-size:11px;color:var(--faint);line-height:1.55}
`;
