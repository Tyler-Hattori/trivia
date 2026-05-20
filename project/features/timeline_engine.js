import { toast, $ } from '../utils/helpers.js';
import { parseMovements } from '../utils/layout.js';
import { estimateCardWidth } from '../utils/layout.js';
import { yearNumSafe } from '../utils/helpers.js';
import { state } from '../core/state.js';

export async function openTimeline(rows = null, dataset = null){
  const win = window.open("", "timeline");

  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="UTF-8">
    <title>Timeline</title>
    </head>
    <body style="margin:0;background:white;font-family:Arial,sans-serif;"></body>
    </html>
      `);
  win.document.close();

  const doc=win.document;
  const body=doc.body;

  let META = {};
  let allRows = [];

  const selected = new Set();

  let renderCount = 0;

  let zoom = 50;
  const ZMIN = 10;
  const ZMAX = 100;

  const LEFT_PAD = 50;
  const CARD_W = 170;
  const LANE_H = 184;
  const HEADER_H = 54;

  const LABEL_ROW_H = 26;
  const LABEL_TOP_PAD = 8;
  const LABEL_BOTTOM_PAD = 10;

  const minYear = 1300;
  const maxYear = 1980;
  
  let filtersOpen = false;

  const palette = [
    "#D7263D", "#0072CE", "#2E8B57", "#FF8C00", "#6A0DAD", "#008B8B",
    "#C2185B", "#556B2F", "#B22222", "#1E90FF", "#228B22", "#FF1493",
    "#8B4513", "#20B2AA", "#483D8B", "#DC143C", "#4682B4", "#9ACD32",
    "#FF6347", "#7B68EE", "#008080", "#A0522D", "#E91E63", "#3CB371",
    "#4169E1", "#CD5C5C", "#9932CC", "#5F9EA0", "#DAA520", "#708090"
  ];
  const colorMap=new Map();
  let cIdx=0;

  try {
    const res = await fetch(`/thumbnails/meta.json`);
    META = await res.json();
  } catch (e) {
    console.warn("meta.json failed, continuing without thumbnails");
  }

  function slugify(str = "") {
    return String(str)
      .toLowerCase()
      .trim()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function buildNameFromRow(r) {
    const primary =
      r.meta?.primary ||
      r.artist ||
      r.occupation ||
      '';

    const title =
      r.title ||
      r.name ||
      '';

    const year =
      r.year ??
      r.start ??
      '';

    return `${slugify(primary)}_${slugify(title)}_${year}.jpg`;
  }

  function resolveImage(r) {
    const filename = buildNameFromRow(r.raw || r);
    const thumbPath = `/thumbnails/${filename}`;

    if (META[filename]) {
      return {
        src: thumbPath,
        ratio: META[filename],
        hasMeta: true,
        filename
      };
    }
    return {
      src: r.image,
      ratio: Number.isFinite(r.imgRatio) ? r.imgRatio : 1.2,
      hasMeta: false,
      filename
    };
  }

  function multiColorSegments(tags){
    if (!tags?.length) return '';

    const w = 100 / tags.length;

    return tags.map((t,i)=>`
      <div style="
        width:${w}%;
        background:${getColor(t)};
        height:100%;
      "></div>
    `).join('');
  }

  function start(rows = null) {
    const base = rows ?? state.data;

    allRows = base.map(r => {
      const resolved = resolveImage(r);

      return {
        type: r.type || 'point',

        year: yearNumSafe(r.year),
        start: yearNumSafe(r.start),
        end: yearNumSafe(r.end),

        label: r.title || r.label || "",
        image: resolved.src,

        imgRatio:
          Number.isFinite(r.imgRatio)
            ? r.imgRatio
            : (resolved.ratio ?? 1.2),

        _needsMeta:
          !Number.isFinite(r.imgRatio) &&
          !Number.isFinite(resolved.ratio),

        meta: {
          primary:
            r.meta?.primary ||
            r.artist ||
            '',

          secondary:
            r.meta?.secondary ||
            r.movement ||
            '',

          tags: (
            r.meta?.tags?.length
              ? r.meta.tags
              : parseMovements(
                  r.movement ||
                  r.raw?.movement ||
                  ''
                )
          ).filter(Boolean)
        },

        raw: r
      };
    });

    render(false);
  }

  function openLightbox(row){
  
    const overlay = doc.createElement('div');
  
    function close(){
      overlay.remove();
      doc.removeEventListener('keydown', esc);
    }
  
    function esc(e){
      if(e.key === 'Escape') close();
    }
  
    doc.addEventListener('keydown', esc);
  
    overlay.style.cssText = `
      position:fixed;
      inset:0;
      background:rgba(0,0,0,.9);
      display:flex;
      align-items:center;
      justify-content:center;
      z-index:9999;
      cursor:pointer;
      padding:32px;
    `;
  
    overlay.innerHTML = `
      <div style="
        max-width:95vw;
        max-height:95vh;
        display:flex;
        flex-direction:column;
        align-items:center;
        gap:14px;
      ">
        <img
          src="${row.raw.image}"
          style="
            max-width:95vw;
            max-height:78vh;
            object-fit:contain;
            border-radius:12px;
            background:white;
            box-shadow:0 20px 60px rgba(0,0,0,.45);
          ">
  
        <div style="
          text-align:center;
          color:white;
          line-height:1.35;
        ">
          <div style="
            font-size:26px;
            font-weight:800;
            font-style:italic;
          ">
            ${row.label}
          </div>
  
          <div style="
            font-size:18px;
            opacity:.92;
          ">
            ${row.meta.primary || ''}
          </div>
  
          <div style="
            font-size:16px;
            opacity:.75;
          ">
            ${row.year || (row.start + '-' + row.end)}
          </div>
        </div>
      </div>
    `;
  
    overlay.onclick = close;
    doc.body.appendChild(overlay);
  }

  function xPos(year){
    return LEFT_PAD + (yearNumSafe(year)-minYear)*zoom;
  }

  function getX(r){
    if(r.type === 'point') return xPos(r.year);
    if(r.type === 'range') return xPos((r.start + r.end)/2);
  }

  function widthNow(){
    return LEFT_PAD + (maxYear-minYear+1)*zoom + LEFT_PAD;
  }

  function getColor(m){
    if(!colorMap.has(m)){
      colorMap.set(m,palette[cIdx % palette.length]);
      cIdx++;
    }
    return colorMap.get(m);
  }

  function rowIncluded(r){
    if(selected.size===0) return true;
    return (r.meta?.tags || []).some(t=>selected.has(t));
  }

  /* =======================================================
     LABEL LAYOUT (dynamic height)
  ======================================================= */
  function buildLabels(){
    const firstSeen=new Map();
    allRows.forEach(r=>{
      const yRaw = r.type === 'point' ? r.year : (r.start + r.end) / 2;
      const y = Number.isFinite(yRaw) ? yRaw : 0;
      
      (r.meta?.tags || []).forEach(t=>{
        if(!firstSeen.has(t) || y<firstSeen.get(t)){
          firstSeen.set(t,y);
        }
      });
    });

    const anchors=[...firstSeen.entries()]
      .map(([movement,year])=>({movement,year}))
      .sort((a,b)=>a.year-b.year);

    const lanes=[];

    const items = anchors.map(a=>{

      const x = xPos(a.year);
      const est=Math.max(72,a.movement.length*7+24);

      let lane=0;

      while(true){
        if(!lanes[lane]) lanes[lane]=[];

        const clash=lanes[lane].some(o =>
          Math.abs(o.x-x) < ((o.w+est)/2 + 8)
        );

        if(!clash){
          lanes[lane].push({x,w:est});
          break;
        }

        lane++;
      }

      return {
        ...a,
        x,
        lane
      };
    });

    const laneCount = Math.max(1, lanes.length);

    const LABEL_H =
      LABEL_TOP_PAD +
      laneCount * LABEL_ROW_H +
      LABEL_BOTTOM_PAD;

    const html = items.map(a=>{

      const active=selected.has(a.movement);

      return `
        <div data-move="${a.movement}" style="
          position:absolute;
          left:${a.x}px;
          top:${LABEL_TOP_PAD + a.lane*LABEL_ROW_H}px;
          transform:translateX(-50%);
          white-space:nowrap;
          padding:3px 8px;
          border-radius:999px;
          font-size:12px;
          font-weight:700;
          cursor:pointer;
          user-select:none;
          color:${active?'white':getColor(a.movement)};
          background:${active?getColor(a.movement):'white'};
          border:1px solid ${getColor(a.movement)};
          box-shadow:0 1px 4px rgba(0,0,0,.08);
        ">${a.movement}</div>
      `;
    }).join("");

    return { LABEL_H, html };
  }

  /* =======================================================
     RETILE VISIBLE CARDS ONLY
  ======================================================= */
  function packVisible(rows){

    const lanes=[];

    return rows.map(r=>{

      const x = getX(r);

      let lane=0;

      while(true){
        if(!lanes[lane]) lanes[lane]=[];

        const w = estimateCardWidth(r);
        if (!Number.isFinite(w)) w = 140;
        const clash = lanes[lane].some(o =>
          Math.abs(o.x - x) < ((o.w + w)/2 + 2)
        );

        if(!clash){
          lanes[lane].push({x,w});
          break;
        }

        lane++;
      }

      return Object.assign(r, { x, lane });
    });
  }

  let rerenderQueued = false;

  function requestRender(){
    if(rerenderQueued) return;
    rerenderQueued = true;

    console.log("requesting render");

    requestAnimationFrame(()=>{
      render(true);
      rerenderQueued = false;
    });
  }

  /* =======================================================
     RENDER
  ======================================================= */
  function render(keepCenter=true){
    const oldScroller = body.querySelector("#scrollWrap");
    const prevX = oldScroller ? oldScroller.scrollLeft : 0;
    const prevY = oldScroller ? oldScroller.scrollTop : 0;
    const prevW = oldScroller ? oldScroller.clientWidth : 0;
    const oldSW = oldScroller ? oldScroller.scrollWidth : 1;

    const { LABEL_H, html:labels } = buildLabels();
    const FILTER_H = filtersOpen ? LABEL_H + 16 : 0;

    const visibleRows = allRows
      .filter(rowIncluded)
      .sort((a,b)=>{
        const ay = a.type === 'point' ? a.year : (a.start + a.end)/2;
        const by = b.type === 'point' ? b.year : (b.start + b.end)/2;
        return ay - by;
      });

    const positioned = packVisible(visibleRows);

    const laneCount =
      positioned.length
        ? Math.max(...positioned.map(r=>r.lane))+1
        : 1;

    const totalHeight =
      (filtersOpen ? LABEL_H : 0) +
      laneCount * LANE_H +
      140;

    /* ticks */
    let ticks="";
    const tickLineTop = (filtersOpen ? LABEL_H : 0) + 18;

    for(let y=minYear;y<=maxYear;y+=10){

      const x = xPos(y);

      ticks += `
        <div style="
          position:absolute;
          left:${x}px;
          top:${(filtersOpen ? LABEL_H : 0) + 2}px;
          transform:translateX(-50%);
          font-size:11px;
          color:#64748b;
          z-index:2;
        ">${y}</div>

        <div style="
          position:absolute;
          left:${x}px;
          top:${tickLineTop}px;
          width:1px;
          height:${totalHeight-tickLineTop}px;
          background:#edf2f7;
          z-index:1;
        "></div>
      `;
    }

    /* cards */
    const cards = positioned.map((r,i)=>{
      const top = (filtersOpen ? LABEL_H : 0) + 34 + r.lane * LANE_H;

      if(r.type === 'range'){
        const left = xPos(r.start);
        const right = xPos(r.end);
        const width = right - left;

        return `
          <div
            style="
              position:absolute;
              left:${left}px;
              top:${top}px;
              width:${width}px;
              height:140px;
              background:rgba(59,130,246,.15);
              border:1px solid rgba(59,130,246,.4);
              border-radius:12px;
              padding:6px;
              cursor:pointer;
            "
          >
            <div style="display:flex; gap:8px;">
              <img src="${r.image}" style="
                width:60px;
                height:60px;
                object-fit:cover;
                border-radius:8px;
              ">
              <div>
                <div style="font-weight:700;">${r.label}</div>
                <div style="font-size:12px;color:#555;">${r.meta?.primary || ''}</div>
                <div style="font-size:11px;color:#777;">
                  ${r.start}-${r.end}
                </div>
              </div>
            </div>
          </div>
        `;
      }

      const w = estimateCardWidth(r);
      if (!Number.isFinite(w)) w = 140;
      const primary = getColor(r.meta.tags?.[0]);
      const bar = multiColorSegments(r.meta.tags);

      return `
        <div
          data-full="${r.image}"
          data-idx="${i}"
          style="
            position:absolute;
            cursor:pointer;
            left:${r.x}px;
            top:${top}px;
            width:${w}px;
            transform:translateX(-50%);
            z-index:10;
          ">
          <div style="
            border-radius:14px;
            overflow:hidden;
            border:1px solid ${primary}44;
            box-shadow:0 6px 14px rgba(0,0,0,.08);
          ">
            <div style="
              height:4px;
              display:flex;
              border-radius:4px 4px 0 0;
              overflow:hidden;
            ">
              ${multiColorSegments(r.meta.tags)}
            </div>
            <img src="${r.image}" style="
              width:100%;
              height:104px;
              object-fit:contain;
              background:#f8fafc;
            ">

            <div style="padding:8px">
              <div style="
                font-size:12px;
                font-weight:700;
                line-height:1.2em;
                overflow:hidden;
                display:-webkit-box;
                -webkit-line-clamp:2;
                -webkit-box-orient:vertical;
              ">
                ${r.label}
              </div>
              <div style="font-size:11px;color:#64748b;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;">
                ${r.meta?.primary}
              </div>
              <div style="font-size:10px;color:#94a3b8;">
                ${r.type === 'point' ? r.year : `${r.start}-${r.end}`}
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');

    body.innerHTML=`
      <div style="
        position:sticky;
        top:0;
        z-index:60;
        height:${HEADER_H}px;
        background:white;
        border-bottom:1px solid #e5e7eb;
        display:flex;
        align-items:center;
        justify-content:space-between;
        padding:0 16px;
      ">
        <div style="font-size:20px;font-weight:800;">
          ${dataset === 'global' ? 'Global Timeline' : 'Art Timeline'}
        </div>

        <div style="display:flex;gap:8px;align-items:center;">
          <button id="toggleFilters" style="
            border:1px solid #d1d5db;
            background:white;
            border-radius:8px;
            padding:4px 10px;
            cursor:pointer;
          ">Filters</button>
          
          <button id="zoomOut" style="
            border:1px solid #d1d5db;
            background:white;
            border-radius:8px;
            padding:4px 10px;
            cursor:pointer;
          ">-</button>

          <div style="
            font-size:12px;
            color:#475569;
            min-width:58px;
            text-align:center;
          ">${zoom.toFixed(1)} px/yr</div>

          <button id="zoomIn" style="
            border:1px solid #d1d5db;
            background:white;
            border-radius:8px;
            padding:4px 10px;
            cursor:pointer;
          ">+</button>
        </div>
      </div>

      <div id="scrollWrap" style="
        height:calc(100vh - ${HEADER_H}px);
        overflow:auto;
      ">
        <div style="
          position:relative;
          width:${widthNow()}px;
          height:${totalHeight}px;
          background:white;
        ">

          ${filtersOpen ? `
            <div style="
              position:sticky;
              top:0;
              z-index:40;
              background:rgba(255,255,255,.97);
              border-bottom:1px solid #e5e7eb;
            ">
              <div style="
                position:relative;
                width:${widthNow()}px;
                height:${LABEL_H}px;
              ">
                ${labels}
              </div>
            </div>
          ` : ``}

          ${ticks}
          ${cards}

        </div>
      </div>
    `;

    const scroller = body.querySelector("#scrollWrap");

    body.querySelector("#toggleFilters").onclick = () => {
      filtersOpen = !filtersOpen;
      render(false);
    };

    if(oldScroller && keepCenter){
      const centerRatio = (prevX + prevW/2) / oldSW;
      const newX =
        centerRatio * scroller.scrollWidth -
        scroller.clientWidth/2;

      scroller.scrollLeft=Math.max(0,newX);
      scroller.scrollTop=prevY;
    }else{
      scroller.scrollLeft=prevX;
      scroller.scrollTop=prevY;
    }

    /* movement clicks */
    body.querySelectorAll("[data-move]").forEach(el=>{
      el.onclick=()=>{
        const m=el.dataset.move;
        if(selected.has(m)) selected.delete(m);
        else selected.add(m);
        render(false);
      };
    });

    body.querySelectorAll('[data-full]').forEach(el=>{
      el.onclick = (e)=>{
        e.stopPropagation();
        openLightbox(
          positioned[Number(el.dataset.idx)]
        );
      };
    });

    body.querySelectorAll('[data-full]').forEach((el) => {
      const img = el.querySelector('img');
      const idx = Number(el.dataset.idx);

      const r = positioned[idx];

      const source = allRows.find(x =>
        x.label === r.label &&
        x.year === r.year
      );

      if (!img) return;

      function apply() {
        if (img.naturalWidth && img.naturalHeight) {
          const ratio =
            img.naturalWidth / img.naturalHeight;
          r.imgRatio = ratio;

          if (source) {
            source.imgRatio = ratio;
            source._needsMeta = false;
          }
          
          renderCount++;
          if (renderCount === positioned.length) {
            render(true);
          }
        }
      }

      if (img.complete) {
        apply();
      } else {
        img.onload = apply;
      }
    });

    /* zoom */
    body.querySelector("#zoomIn").onclick=()=>{
      zoom=Math.min(ZMAX,zoom+5);
      render(true);
    };

    body.querySelector("#zoomOut").onclick=()=>{
      zoom=Math.max(ZMIN,zoom-5);
      render(true);
    };
  }

  function blobToBase64(blob) {
    return new Promise(res => {
      const reader = new FileReader();
      reader.onloadend = () => res(reader.result);
      reader.readAsDataURL(blob);
    });
  }

  start(rows); // ALWAYS run
}
