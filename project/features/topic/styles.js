/*
 * The topic page's stylesheet. Deliberately close to the original art timeline
 * (white, one hairline, image cards with a colour strip) — that was the design
 * that was easy to read. Injected once.
 *
 * NO BACKTICKS INSIDE THIS TEMPLATE, including in comments (see README: it has
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
.tp-search{border:1px solid #d1d5db;border-radius:9px;padding:6px 10px;width:260px;outline:none}
.tp-search:focus{border-color:#94a3b8}
.tp-meta{font-size:12px;color:#64748b}
.tp-spacer{flex:1}

/* chapter chips: the filter, always visible */
.tp-chips{display:flex;gap:6px;padding:8px 16px;border-bottom:1px solid #e5e7eb;overflow-x:auto;flex-wrap:nowrap;background:#fff}
.tp-chip{white-space:nowrap;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700;border:1px solid var(--c);color:var(--c);background:#fff;user-select:none}
.tp-chip.on{background:var(--c);color:#fff}
.tp-chip .n{font-weight:500;opacity:.7;margin-left:4px}

.tp-body{flex:1;min-height:0;position:relative;display:flex}
.tp-scroll{flex:1;overflow:auto;position:relative}
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
.tp-badge{display:inline-block;font-size:11px;border-radius:999px;padding:1px 8px;margin-right:6px;border:1px solid #e5e7eb;color:#475569}

/* read view */
.tp-read{max-width:880px;margin:0 auto;padding:18px 24px 80px}
.tp-read h2{font-size:24px;margin:34px 0 4px;font-weight:800;display:flex;align-items:baseline;gap:10px}
.tp-read h2 .yr{font-size:13px;color:#64748b;font-weight:500}
.tp-read .bar{height:4px;border-radius:2px;margin-bottom:12px;width:64px}
.tp-row{display:grid;grid-template-columns:92px 1fr 96px;gap:14px;padding:12px 0;border-bottom:1px solid #f1f5f9;cursor:pointer}
.tp-row:hover{background:#fafafa}
.tp-row.dim{display:none}
.tp-row .yr{font-variant-numeric:tabular-nums;color:#475569;font-size:13px;font-weight:600;padding-top:1px}
.tp-row .t{font-weight:700;font-size:15px}
.tp-row .s{color:#475569;font-size:13.5px;line-height:1.55;margin-top:2px}
.tp-row img{width:96px;height:72px;object-fit:contain;background:#f8fafc;border-radius:6px}
.tp-row.key .t::after{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#f59e0b;margin-left:6px;vertical-align:middle}

/* topic list */
.tp-list{max-width:1100px;margin:0 auto;padding:24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px}
.tp-tile{border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;background:#fff;cursor:pointer;text-align:left;padding:0}
.tp-tile:hover{box-shadow:0 10px 24px rgba(15,23,42,.1)}
.tp-tile img{width:100%;height:170px;object-fit:cover;background:#f1f5f9;display:block}
.tp-tile .in{padding:12px 14px}
.tp-tile .t{font-size:18px;font-weight:800}
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
`;

let injected = false;
export function injectStyles(){
  if(injected) return;
  const el = document.createElement('style');
  el.textContent = CSS;
  document.head.appendChild(el);
  injected = true;
}
