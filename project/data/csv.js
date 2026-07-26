function splitCSVRow(line){
  const cols=[];
  let cur='';
  let inQuotes=false;

  for(let i=0;i<line.length;i++){
    const ch=line[i];

    if(ch === '"'){
      if(inQuotes && line[i+1] === '"'){
        cur+='"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    }
    else if(ch === ',' && !inQuotes){
      cols.push(cur.trim());
      cur='';
    }
    else{
      cur += ch;
    }
  }

  cols.push(cur.trim());
  return cols;
}

/**
 * Header-driven CSV parse. Returns an array of objects keyed by the actual
 * column names in the header row. Column order (and where "image" sits) is
 * irrelevant — dropping in a new CSV just works.
 *
 * Note: fields spanning multiple physical lines via quoted newlines are not
 * supported; keep each record on one line (existing datasets already do).
 */
export function parseCSV(text){
  const lines = text.replace(/\r/g,'')
    .split('\n')
    .filter(x => x.trim());

  if(!lines.length) return [];

  const headers = splitCSVRow(lines[0]);

  const out = [];

  for(let i=1;i<lines.length;i++){
    const cols = splitCSVRow(lines[i]);

    // Extra columns almost always mean an unquoted comma (e.g. inside an image
    // filename/URL). Surface it instead of silently shifting every field.
    if(cols.length > headers.length){
      console.warn(
        `parseCSV: row ${i + 1} has ${cols.length} columns but header has ${headers.length}. ` +
        `Likely an unquoted comma — quote the field or encode the comma as %2C. Row: ${lines[i].slice(0, 80)}…`
      );
    }

    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] ?? '';
    });

    out.push(row);
  }

  return out;
}

export function esc(v){
  v=String(v??'');
  if(/[",\n]/.test(v)){
    return '"' + v.replace(/"/g,'""') + '"';
  }
  return v;
}

/**
 * Serialize rows back to CSV using an explicit column list (the header order).
 */
export function csvOut(rows, columns){
  const header = columns.join(',');

  const body = rows.map(r =>
    columns.map(c => esc(r[c])).join(',')
  );

  return header + '\n' + body.join('\n') + '\n';
}
