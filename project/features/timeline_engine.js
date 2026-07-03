import { toast, $ } from '../utils/helpers.js';
import { estimateCardWidth } from '../utils/layout.js';
import { yearNumSafe } from '../utils/helpers.js';
import { state } from '../core/state.js';

export async function openTimeline({
    rows = null,
    title = null,

    minYear = null,
    maxYear = null
  } = {}){

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

  const selected = new Map();

  let renderCount = 0;

  let zoom = 50;
  const ZMIN = 10;
  const ZMAX = 100;

  const LEFT_PAD = 50;
  const CARD_W = 170;
  const LANE_H = 184;
  const HEADER_H = 54;

  const SPAN_CARD_H = 92;
  const RAIL_H = 14;
  const RAIL_GAP = 6;
  const RAIL_STEP = RAIL_H + RAIL_GAP;
  const SPAN_Y_CENTER_OFFSET = 46;
  const SPAN_CARD_W = 220;

  const LABEL_ROW_H = 26;
  const LABEL_TOP_PAD = 8;
  const LABEL_BOTTOM_PAD = 10;
  
  let filtersOpen = false;
  let activeFilterKey = null;
  let paintingsEnabled = true;
  let leadersEnabled = true;

  const timelineConfig =
    state.active?.timeline ||
    state.timeline ||
    {};

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
    const res = await fetch(`./thumbnails/meta.json`);
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
    const subtitle = r.subtitle || '';
    const title = r.title || '';
    const year =
      r.year ??
      r.start ??
      '';

    return `${slugify(subtitle)}_${slugify(title)}_${year}.jpg`;
  }

  function resolveImage(r) {
    const filename = buildNameFromRow(r);
    const thumbPath = `./thumbnails/${filename}`;

    if (META[filename]) {
      return {
        src: thumbPath,
        ratio: Number(META[filename]),
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

  function normalizeFilters(filters = {}) {
    const out = {};

    for(const key in filters){
      const raw = filters[key];

      if(Array.isArray(raw)){

        out[key] = raw.flatMap(v =>
          String(v)
            .split('/')
            .map(s => s.trim())
            .filter(Boolean)
        );

      } else {

        out[key] = String(raw || '')
          .split('\\')
          .map(s => s.trim())
          .filter(Boolean);
      }
    }

    return out;
  }

  function start(rows = null) {
    const base = rows ?? state.data;

    const defs = timelineConfig.filterable || [];

    activeFilterKey =
      defs.length
        ? `${defs[0].dataset || 'global'}:${defs[0].key}`
        : null;

    /* -----------------------------------
      dynamic year bounds
    ----------------------------------- */

    const years = [];

    base.forEach(r => {
      if(r.type === 'point'){

        const y = Number(r.year);

        if(Number.isFinite(y))
          years.push(y);
      }

      else if(r.type === 'span'){
        const s = Number(r.start);
        const e = Number(r.end);

        if(Number.isFinite(s))
          years.push(s);

        if(Number.isFinite(e))
          years.push(e);
      }
    });

    if(years.length){
      minYear =
        Math.floor(Math.min(...years) / 10) * 10;

      maxYear =
        Math.ceil(Math.max(...years) / 10) * 10;
    }

    /* optional padding */
    minYear -= 0;
    maxYear += 0;

    allRows = base.map((r, idx) => {

      const normalizedFilters =
        normalizeFilters(r.filters);

      const resolved = resolveImage(r);

      const ratio =
        Number.isFinite(r.imgRatio)
          ? r.imgRatio
          : Number.isFinite(resolved.ratio)
            ? resolved.ratio
            : 1.2;
      
      const initialKey = activeFilterKey?.split(':')[1];

      return {
        ...r,

        dataset: r.dataset || 'global',

        __id: idx,

        image: resolved.src,
        imgRatio: ratio,
        _metaRatio: ratio,

        filters: normalizedFilters,

        displayYear:
          r.years ||
          r.year ||
          (r.start && r.end
            ? `${r.start}-${r.end}`
            : ''),

        _needsMeta:
          !Number.isFinite(r.imgRatio) &&
          !Number.isFinite(resolved.ratio),

        tags:
          normalizedFilters[initialKey] ||
          ['uncategorized']
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
        width:min(1100px, 95vw);
        max-height:92vh;

        display:flex;
        gap:24px;

        background:#111827;
        border-radius:18px;

        overflow:hidden;

        box-shadow:
          0 20px 60px rgba(0,0,0,.45);
      ">

        <!-- image side -->
        <div style="
          flex:0 0 52%;
          background:black;

          display:flex;
          align-items:center;
          justify-content:center;

          min-height:0;
        ">
          <img
            src="${row.raw.image}"
            style="
              width:100%;
              height:100%;
              object-fit:contain;
            ">
        </div>

        <!-- text side -->
        <div style="
          flex:1;
          min-width:0;

          display:flex;
          flex-direction:column;

          padding:28px 28px 24px 0;

          overflow:hidden;
        ">

          <div style="
            flex:0 0 auto;
          ">

            <div style="
              font-size:32px;
              font-weight:800;
              line-height:1.1;
              color:white;
              margin-bottom:10px;
            ">
              ${row.label}
            </div>

            <div style="
              font-size:18px;
              color:#d1d5db;
              margin-bottom:6px;
            ">
              ${row.subtitle || ''}
            </div>

            <div style="
              font-size:15px;
              color:#9ca3af;
              margin-bottom:18px;
            ">
              ${row.misc || ''}
            </div>

            <div style="
              font-size:14px;
              font-weight:700;
              color:#93c5fd;
              letter-spacing:.04em;
              margin-bottom:22px;
            ">
              ${row.displayYear || row.year}
            </div>
          </div>

          <!-- scrollable text -->
          <div style="
            flex:1 1 auto;
            overflow-y:auto;

            padding-right:10px;

            font-size:16px;
            line-height:1.75;

            color:#e5e7eb;

            text-align:left;
          ">${(row.excerpt || '').replace(/\\n/g, '<br>')}</div>

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
    if(r.type === 'span') return xPos((r.start + r.end)/2);
  }

  function widthNow(){
    return LEFT_PAD + (maxYear-minYear+1)*zoom + LEFT_PAD;
  }

  function currentFilterKey(){
    return activeFilterKey?.split(':')[1];
  }

  function getColor(value){
    const key = `${activeFilterKey}:${value}`;

    if(!colorMap.has(key)){
      colorMap.set(
        key,
        palette[cIdx % palette.length]
      );
      cIdx++;
    }

    return colorMap.get(key);
  }

  function rowIncluded(r){
    if (!paintingsEnabled && r.dataset === 'art') { return false; }
    if (!leadersEnabled && r.dataset === 'leaders') { return false; }

    for (const [compoundKey, set] of selected.entries()) {
      const [dataset, key] = compoundKey.split(':');

      if(!set?.size) continue;

      const rowDataset =
        r.dataset || 'global'; // MUST exist in normalized row

      if(dataset !== 'global' && dataset !== rowDataset)
        continue;

      const vals = r.filters?.[key] || [];

      const hit = vals.some(v => set.has(v));

      if(!hit) return false;
    }

    return true;
  }

  /* =======================================================
     LABEL LAYOUT (dynamic height)
  ======================================================= */
  function buildLabels(){
    const defs =
      timelineConfig.filterable || [];

    const def =
      defs.find(d =>
        `${d.dataset || 'global'}:${d.key}` === activeFilterKey
      );

    if(!def){
      return {
        LABEL_H: 0,
        html: ''
      };
    }

    const firstSeen = new Map();

    allRows.forEach(r => {
      const activeDataset =
        def.dataset || 'global';

      const rowDataset =
        r.dataset || 'global';

      if (
        activeDataset !== 'global' &&
        rowDataset !== activeDataset
      ){
        return;
      }

      const vals =
        r.filters?.[def.key] || [];

      const yRaw =
        r.type === 'point'
          ? r.year
          : (r.start + r.end) / 2;

      vals.forEach(v => {

        if(
          !firstSeen.has(v) ||
          yRaw < firstSeen.get(v)
        ){
          firstSeen.set(v, yRaw);
        }
      });
    });

    const anchors =
      [...firstSeen.entries()]
        .map(([value, year]) => ({
          value,
          year
        }))
        .sort((a,b)=>a.year-b.year);

    const lanes = [];

    const items = anchors.map(a => {

      const x = xPos(a.year);

      const est =
        Math.max(
          72,
          a.value.length * 7 + 24
        );

      let lane = 0;

      while(true){

        if(!lanes[lane])
          lanes[lane] = [];

        const clash =
          lanes[lane].some(o =>
            Math.abs(o.x - x)
              < ((o.w + est)/2 + 8)
          );

        if(!clash){
          lanes[lane].push({
            x,
            w: est
          });
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

    const laneCount =
      Math.max(1, lanes.length);

    const LABEL_H =
      LABEL_TOP_PAD +
      laneCount * LABEL_ROW_H +
      LABEL_BOTTOM_PAD;

    const html = items.map(a => {

      const compoundKey =
        `${def.dataset || 'global'}:${def.key}`;

      const active =
        selected.get(compoundKey)?.has(a.value);

      return `
        <div
          data-filter-key="${def.key}"
          data-filter-value="${a.value}"
          data-dataset="${def.dataset || 'global'}"

          style="
            position:absolute;
            left:${a.x}px;
            top:${LABEL_TOP_PAD + a.lane * LABEL_ROW_H}px;

            transform:translateX(-50%);

            white-space:nowrap;

            padding:3px 8px;

            border-radius:999px;

            font-size:12px;
            font-weight:700;

            cursor:pointer;
            user-select:none;

            color:
              ${active
                ? 'white'
                : getColor(a.value)};

            background:
              ${active
                ? getColor(a.value)
                : 'white'};

            border:
              1px solid ${getColor(a.value)};

            box-shadow:
              0 1px 4px rgba(0,0,0,.08);
          "
        >
          ${a.value}
        </div>
      `;
    }).join('');

    return {
      LABEL_H,
      html
    };
  }

  /* =======================================================
     RETILE VISIBLE CARDS ONLY
  ======================================================= */
  function packVisible(rows, contentTop){
    const cardLanes = [];
    const railLanes = [];

    return rows.map(r => {

      if (r.type === 'span') {
        const railLeft = xPos(r.start);
        const railRight = xPos(r.end);
        const centerX = (railLeft + railRight) / 2;

        const cardLeft = centerX - SPAN_CARD_W / 2;
        const cardRight = centerX + SPAN_CARD_W / 2;

        let railLane = 0;

        while (true) {

          const cardTop =
            contentTop +
            railLane * RAIL_STEP +
            SPAN_Y_CENTER_OFFSET -
            SPAN_CARD_H / 2;

          const cardBottom = cardTop + SPAN_CARD_H;

          const railClash =
            (railLanes[railLane] || []).some(o => {

              const horizontal =
                !(railRight < o.left || railLeft > o.right);

              return horizontal;
            });

          const spanCardClash =
            cardLanes.some(lane =>
              (lane || []).some(o => {

                const horizontal =
                  !(cardRight < o.left || cardLeft > o.right);

                const vertical =
                  !(cardBottom < o.top || cardTop > o.bottom);

                return horizontal && vertical;
              })
            );

          if (!railClash && !spanCardClash) {

            if (!railLanes[railLane])
              railLanes[railLane] = [];

            railLanes[railLane].push({
              left: railLeft,
              right: railRight,
              top: cardTop,
              bottom: cardBottom
            });

            break;
          }

          railLane++;
        }

        let cardLane = 0;

        while (true) {

          const cardTop =
            contentTop +
            railLane * RAIL_STEP +
            SPAN_Y_CENTER_OFFSET -
            SPAN_CARD_H / 2;

          const cardBottom = cardTop + SPAN_CARD_H;

          if (!cardLanes[cardLane])
            cardLanes[cardLane] = [];

          const clash = cardLanes[cardLane].some(o =>
            !(cardRight < o.left || cardLeft > o.right)
          );

          if (!clash) {

            cardLanes[cardLane].push({
              left: cardLeft,
              right: cardRight,
              top: cardTop,
              bottom: cardBottom
            });

            break;
          }

          cardLane++;
        }

        return Object.assign(r, {
          x: centerX,
          railLane,
          cardLane,
          railLeft,
          railRight,
          cardLeft,
          cardRight
        });
      }

      /* =====================================
        point cards
      ===================================== */

      const x = getX(r);

      let w = estimateCardWidth(r);

      if(!Number.isFinite(w))
        w = 140;

      const left = x - w/2;
      const right = x + w/2;

      let cardLane = 0;

      while(true){

        if(!cardLanes[cardLane])
          cardLanes[cardLane] = [];

        const top =
          contentTop +
          cardLane * LANE_H;

        const bottom =
          top + LANE_H;

        const clash = cardLanes[cardLane].some(o => {

          const horizontal =
            !(right < o.left || left > o.right);

          const vertical =
            !(bottom < o.top || top > o.bottom);

          return horizontal && vertical;
        });

        if(!clash){
          const top =
            contentTop +
            cardLane * LANE_H;

          const bottom =
            top + LANE_H;

          cardLanes[cardLane].push({
            left,
            right,
            top,
            bottom
          });

          break;
        }

        cardLane++;
      }

      return Object.assign(r,{
        x,
        left,
        right,
        cardLane
      });
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
    const contentTop = (filtersOpen ? LABEL_H : 0) + 34;

    const visibleRows = allRows
      .filter(rowIncluded)
      .sort((a,b)=>{
        const ay = a.type === 'point' ? a.year : (a.start + a.end)/2;
        const by = b.type === 'point' ? b.year : (b.start + b.end)/2;
        return ay - by;
      });

    const positioned = packVisible(visibleRows, contentTop);

    const laneCount =
      positioned.length
        ? Math.max(...positioned.map(r =>
            Math.max(
              r.cardLane || 0,
              r.railLane || 0
            )
          )) + 1
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

    let railHTML = '';
    let cardHTML = '';

    positioned.forEach((r,i)=>{
      const railY =
        contentTop +
        r.railLane * RAIL_STEP +
        SPAN_Y_CENTER_OFFSET;

      const cardTop = railY - (SPAN_CARD_H / 2);
      const spanCardW =
        Math.max(
          180,
          Math.min(
            280,
            r.label.length * 7 + 100
          )
        );

      if(r.type === 'span'){
        const left = xPos(r.start);
        const right = xPos(r.end);

        const spanWidth = Math.max(140, right - left);

        const center = left + spanWidth / 2;

        const primary = getColor(
            r.filters?.[currentFilterKey()]?.[0]
            || 'uncategorized'
          );

        railHTML += `
          <div
            style="
              position:absolute;
              left:${left}px;
              top:${railY}px;
              width:${spanWidth}px;
              height:6px;

              border-radius:999px;
              overflow:hidden;

              background:${primary}22;

              pointer-events:none;
            "
          >
            <div style="
              width:100%;
              height:100%;
              background:${primary};
              opacity:.55;
            "></div>
          </div>
        `;

        cardHTML += `
          <div
            data-full="${r.image}"
            data-idx="${i}"

            style="
              display:block;
              position:absolute;

              left:${left + spanWidth/2}px;
              top:${cardTop}px;

              width:${spanCardW}px;
              height:${SPAN_CARD_H}px;

              transform:translateX(-50%);

              border-radius:14px;
              overflow:hidden;

              background:white;

              border:1px solid ${primary}44;

              box-shadow:
                0 4px 10px rgba(0,0,0,.06),
                0 10px 24px rgba(0,0,0,.08);

              cursor:pointer;
            "
          >

            <div style="
              height:4px;
              display:flex;
              overflow:hidden;
            ">
              ${multiColorSegments(
                r.filters?.[currentFilterKey()] || []
              )}
            </div>

            <div style="
              display:flex;
              gap:10px;
              padding:10px;
              align-items:flex-start;
            ">

              <img
                src="${r.image}"
                style="
                  width:68px;
                  height:68px;
                  object-fit:cover;
                  border-radius:10px;
                  background:#f1f5f9;
                  flex-shrink:0;
                "
              >

              <div style="
                min-width:0;
                flex:1;
              ">

                <div style="
                  font-size:13px;
                  font-weight:800;
                  line-height:1.2;
                  margin-bottom:4px;

                  overflow:hidden;
                  display:-webkit-box;
                  -webkit-line-clamp:2;
                  -webkit-box-orient:vertical;
                ">
                  ${r.label}
                </div>

                <div style="
                  font-size:11px;
                  color:#64748b;

                  overflow:hidden;
                  text-overflow:ellipsis;
                  white-space:nowrap;
                ">
                  ${r.subtitle || ''}
                </div>

                <div style="
                  margin-top:6px;
                  font-size:10px;
                  font-weight:700;
                  color:${primary};
                  letter-spacing:.03em;
                ">
                  ${r.start} — ${r.end}
                </div>

              </div>
            </div>
          </div>
        `;

        return;
      }

      const w = estimateCardWidth(r);
      if (!Number.isFinite(w)) w = 140;
      const primary = getColor(
          r.filters?.[currentFilterKey()]?.[0]
          || 'uncategorized'
        );
      const bar = multiColorSegments( r.filters?.[currentFilterKey()] || [] );
      const top = contentTop + r.cardLane * LANE_H;

      cardHTML += `
        <div
          data-full="${r.image}"
          data-idx="${i}"
          style="
            display:block;
            position:absolute;
            cursor:pointer;
            left:${r.x}px;
            top:${top}px;
            width:${w}px;
            transform:translateX(-50%);
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
              ${multiColorSegments( r.filters?.[currentFilterKey()] || [] )}
            </div>
            <img src="${r.image}" style="
              width:100%;
              height:104px;
              object-fit:contain;
              background:#f8fafc;
            ">

            <div style="padding:8px; background:white;">
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
                ${r.subtitle || ''}
              </div>
              <div style="font-size:10px;color:#94a3b8;">
                ${r.displayYear || r.year}
              </div>
            </div>
          </div>
        </div>
      `;
    });

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
          ${title ?? state.active.title ?? 'Timeline'}
        </div>

        <div style="display:flex;gap:12px;align-items:center; margin-right:auto;">
          <button id="togglePaintings" style="
            border:1px solid #d1d5db;
            background:${paintingsEnabled ? '#111827' : 'white'};
            color:${paintingsEnabled ? 'white' : '#111827'};
            border-radius:8px;
            padding:4px 10px;
            cursor:pointer;
            margin-left:10px;
            white-space:nowrap;
          ">
            Art
          </button>
          <button id="toggleLeaders" style="
            border:1px solid #d1d5db;
            background:${leadersEnabled ? '#111827' : 'white'};
            color:${leadersEnabled ? 'white' : '#111827'};
            border-radius:8px;
            padding:4px 10px;
            cursor:pointer;
            white-space:nowrap;
          ">
            Leaders
          </button>
        </div>

        <div style="display:flex;gap:8px;align-items:center;">
          ${(() => {
            const defs = timelineConfig.filterable || [];
            const grouped = new Map();

            for (const d of defs) {
              const k = `${d.dataset || 'global'}:${d.key}`;
              if (!paintingsEnabled && d.dataset === 'art') continue;
              if (!leadersEnabled && d.dataset === 'leaders') continue;

              if (!grouped.has(k)) grouped.set(k, []);
              grouped.get(k).push(d);
            }

            return [...grouped.entries()].map(([key, items]) => `
              <div style="display:flex;gap:6px;align-items:center;margin-right:10px;">
                ${items.map(def => `
                  <button
                    class="toggleFilter"
                    data-filter-section="${def.key}"
                    data-dataset="${def.dataset || ''}"
                    style="
                      border:1px solid #d1d5db;
                      background:white;
                      border-radius:8px;
                      padding:4px 10px;
                      cursor:pointer;
                      white-space:nowrap;
                    "
                  >
                    ${def.label}
                  </button>
                `).join('')}
              </div>
            `).join('');
          })()}
          
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

          <!-- rails -->
          <div style="
            position:absolute;
            inset:0;
            z-index:1;
            pointer-events:none;
          ">
            ${railHTML}
          </div>

          <!-- cards -->
          <div style="
            position:absolute;
            inset:0;
            z-index:20;
          ">
            ${cardHTML}
          </div>

        </div>
      </div>
    `;

    const scroller = body.querySelector("#scrollWrap");
    const paintBtn = body.querySelector("#togglePaintings");
    const leadersBtn = body.querySelector("#toggleLeaders");
    if (paintBtn) {
      paintBtn.onclick = () => {
        paintingsEnabled = !paintingsEnabled;
        render(false);
      };
    }

    if (leadersBtn) {
      leadersBtn.onclick = () => {
        leadersEnabled = !leadersEnabled;
        render(false);
      };
    }

    body.querySelectorAll(".toggleFilter")
    .forEach(btn => {

      btn.onclick = () => {
        const dataset =
          btn.dataset.dataset || 'global';

        const key =
          btn.dataset.filterSection;

        const compoundKey =
          `${dataset}:${key}`;

        if(activeFilterKey === compoundKey){
          filtersOpen = !filtersOpen;
        } else {
          activeFilterKey = compoundKey;
          filtersOpen = true;
        }

        render(false);
      };
    });

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
    body.querySelectorAll("[data-filter-key]").forEach(el => {
      el.onclick = () => {
        const key = el.dataset.filterKey;
        const dataset = el.dataset.dataset || 'global';
        const value = el.dataset.filterValue;

        const compoundKey = `${dataset}:${key}`;

        if (!selected.has(compoundKey)) {
          selected.set(compoundKey, new Set());
        }

        const set = selected.get(compoundKey);

        if (set.has(value)) set.delete(value);
        else set.add(value);

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

      const source = r;

      if (!img) return;

      function apply() {
        if (img.naturalWidth && img.naturalHeight) {
          const ratio = img.naturalWidth / img.naturalHeight;
          r._naturalRatio = ratio;

          if (source) {
            source.imgRatio = ratio;
            source._needsMeta = false;
          }
        }
      }

      if (img.complete) {
        renderCount++;
        apply();
      } else {
        console.log(r.title);
        img.onload = apply;
      }
      if (renderCount === positioned.length) {
        render(true);
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
