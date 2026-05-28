export function parseCSV(text, fields){
  const lines = text.replace(/\r/g,'')
    .split('\n')
    .filter(x => x.trim());

  const out = [];

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

  for(let i=0;i<lines.length;i++){
    const cols = splitCSVRow(lines[i]);

    // skip header
    if(i === 0) continue;

    const row = {
      image: cols[0] || ''
    };

    fields.forEach((f, idx) => {
      row[f] = cols[idx + 1] || '';
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

export function csvOut(rows, fields){
  const header =
    ['image', ...fields].join(',');

  const body = rows.map(r =>
    [
      esc(r.image),
      ...fields.map(f => esc(r[f]))
    ].join(',')
  );

  return header + '\n' + body.join('\n') + '\n';
}