export function parseCSV(text){
  const lines=text.replace(/\r/g,'').split('\n').filter(x=>x.trim());
  const out=[];

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
        }else{
          inQuotes=!inQuotes;
        }
      }
      else if(ch===',' && !inQuotes){
        cols.push(cur.trim());
        cur='';
      }
      else{
        cur+=ch;
      }
    }

    cols.push(cur.trim());
    return cols;
  }

  for(let i=0;i<lines.length;i++){
    const cols=splitCSVRow(lines[i]);

    if(i===0 && cols[0].toLowerCase()==='image') continue;

    out.push({
      image:cols[0]||'',
      title:cols[1]||'',
      artist:cols[2]||'',
      year:cols[3]||'',
      movement:cols[4]||''
    });
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

export function csvOut(rows){
  const header='image,title,artist,year,movement';

  const body=rows.map(r=>
    [
      esc(r.image),
      esc(r.title),
      esc(r.artist),
      esc(r.year),
      esc(r.movement)
    ].join(',')
  );

  return header + '\n' + body.join('\n') + '\n';
}