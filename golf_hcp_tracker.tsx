import { useState, useEffect, useMemo } from "react";

const TEES = ["Gelb","Weiß","Blau","Rot"];
const MODES = ["Stableford","Stroke Play"];
const FORMATS = ["Einzel","Vierer","Vierball"];
const COLORS = { hcp:"#1D9E75", stroke:"#378ADD", stableford:"#7F77DD", border:"var(--color-border-tertiary)", textSec:"var(--color-text-secondary)" };
const inp = { width:"100%", boxSizing:"border-box", padding:"8px 10px", borderRadius:"var(--border-radius-md)", border:"0.5px solid var(--color-border-secondary)", background:"#ffffff", color:"#111", fontSize:14, fontFamily:"var(--font-sans)" };
const sel = { ...inp };

function initDB() {
  try {
    const raw = localStorage.getItem("golf_hcp_db");
    if (raw) { const p = JSON.parse(raw); if (!p.profile) p.profile = {name:"",startHcp:54}; return p; }
  } catch(e) {}
  return { courses:[], rounds:[], profile:{name:"",startHcp:54}, nextRoundId:1, nextCourseId:1 };
}
function saveDB(db) { try { localStorage.setItem("golf_hcp_db", JSON.stringify(db)); } catch(e) {} }

function isHcpEligible(r) {
  return r.submitted && r.markerSigned && r.format==="Einzel" &&
    ["Stableford","Stroke Play"].includes(r.mode) &&
    (parseInt(r.holes)===18 || r.nineHoleAllowed);
}

function calcScoreDiff(r) {
  const cr=parseFloat(r.courseRating), sr=parseFloat(r.slopeRating);
  const par=parseFloat(r.par)||36, phcp=parseFloat(r.playingHcp)||0;
  const gbe=parseFloat(r.gbe)||parseFloat(r.adjustedGross);
  if (!cr||!sr||!gbe) return null;
  if (parseInt(r.holes)===9) {
    const gbe18 = gbe + par + phcp + 1;
    return parseFloat(((gbe18 - cr*2)*113/sr).toFixed(1));
  }
  return parseFloat(((gbe-cr)*113/sr).toFixed(1));
}

function missingDiffReason(r) {
  if (!parseFloat(r.courseRating)) return "Course Rating fehlt";
  if (!parseFloat(r.slopeRating)) return "Slope Rating fehlt";
  if (!parseFloat(r.gbe) && !parseFloat(r.adjustedGross)) return "GBE/AGS fehlt";
  if (parseInt(r.holes)===9 && !parseFloat(r.playingHcp)) return "Playing HCP fehlt";
  return null;
}

function hcpStatus(r) {
  if (!r.submitted) return {label:"Nicht eingereicht", dot:"#B4B2A9"};
  if (!r.markerSigned) return {label:"Marker fehlt", dot:"#E24B4A"};
  if (r.format!=="Einzel") return {label:"Nicht HCP-wirksam (Format)", dot:"#B4B2A9"};
  if (parseInt(r.holes)<18 && !r.nineHoleAllowed) return {label:"9-Loch (nicht aktiviert)", dot:"#D3D1C7"};
  return {label:"HCP-wirksam", dot:"#1D9E75"};
}

function calcHcp(diffs) {
  if (!diffs.length) return null;
  const n = Math.min(diffs.length, 20);
  const table = [
    {take:1,adj:-2},{take:1,adj:-1},{take:2,adj:-1},{take:2,adj:-1},
    {take:2,adj:1},{take:2,adj:1},{take:3,adj:0},{take:3,adj:0},
    {take:3,adj:0},{take:3,adj:0},{take:3,adj:0},{take:4,adj:0},
    {take:4,adj:0},{take:4,adj:0},{take:5,adj:0},{take:6,adj:0},
    {take:7,adj:0},{take:8,adj:0},{take:9,adj:0},{take:10,adj:0},
  ];
  const {take,adj} = table[n-1];
  const best = [...diffs].sort((a,b)=>a-b).slice(0,take);
  const avg = best.reduce((s,d)=>s+d,0)/best.length;
  return Math.min(54, parseFloat(((avg+adj)*0.96).toFixed(1)));
}

function field(label, children, hint) {
  return (
    <div style={{marginBottom:14}}>
      <label style={{fontSize:12,color:"var(--color-text-secondary)",display:"block",marginBottom:4}}>
        {label}{hint && <span style={{marginLeft:6,color:"#1D9E75",fontStyle:"italic"}}>{hint}</span>}
      </label>
      {children}
    </div>
  );
}

function badge(label, bg, color) {
  return <span style={{fontSize:11,fontWeight:500,padding:"2px 8px",borderRadius:6,background:bg,color,whiteSpace:"nowrap"}}>{label}</span>;
}

function Modal({title, children, onClose}) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.35)",zIndex:100,display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"40px 16px",overflowY:"auto"}}
      onClick={e=>{if(e.target===e.currentTarget) onClose();}}>
      <div style={{background:"#fff",borderRadius:"var(--border-radius-lg)",border:"0.5px solid var(--color-border-tertiary)",padding:"20px 24px",width:"100%",maxWidth:520}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontWeight:500,fontSize:16,color:"#111"}}>{title}</div>
          <button onClick={onClose} style={{background:"transparent",border:"none",cursor:"pointer",fontSize:18,color:"#888",lineHeight:1}}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ScoreChart({data}) {
  const w=680,h=200,pad={t:16,r:20,b:32,l:44};
  const diffs=data.map(d=>d.diff).filter(x=>x!==null);
  if (!diffs.length) return null;
  const min=Math.min(...diffs)-2, max=Math.max(...diffs)+2;
  const dates=data.map(d=>new Date(d.date).getTime());
  const tMin=Math.min(...dates), tMax=Math.max(...dates);
  const sx=t=>tMax===tMin ? pad.l : pad.l+((t-tMin)/(tMax-tMin))*(w-pad.l-pad.r);
  const sy=v=>pad.t+((max-v)/(max-min))*(h-pad.t-pad.b);
  const visible=data.filter(d=>d.diff!==null);
  const pts=visible.map(d=>`${sx(new Date(d.date).getTime())},${sy(d.diff)}`).join(" ");
  const fmt=t=>new Date(t).toLocaleDateString("de-DE",{day:"2-digit",month:"2-digit",year:"2-digit"});
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{width:"100%",height:"auto",display:"block"}}>
      {[Math.ceil(min),Math.round((min+max)/2),Math.floor(max)].map(v=>(
        <g key={v}>
          <line x1={pad.l} x2={w-pad.r} y1={sy(v)} y2={sy(v)} stroke="#D3D1C7" strokeWidth={0.5}/>
          <text x={pad.l-6} y={sy(v)+4} fontSize={10} textAnchor="end" fill="#888">{v}</text>
        </g>
      ))}
      <polyline points={pts} fill="none" stroke={COLORS.hcp} strokeWidth={1.5}/>
      {visible.map((d,i)=>(
        <circle key={i} cx={sx(new Date(d.date).getTime())} cy={sy(d.diff)} r={3} fill={d.mode==="Stableford"?COLORS.stableford:COLORS.stroke}/>
      ))}
      <text x={pad.l} y={h-4} fontSize={10} fill="#888">{fmt(tMin)}</text>
      {tMax!==tMin && <text x={w-pad.r} y={h-4} fontSize={10} textAnchor="end" fill="#888">{fmt(tMax)}</text>}
    </svg>
  );
}

function HcpTrendChart({trend}) {
  const w=680,h=180,pad={t:16,r:20,b:28,l:44};
  const vals=trend.map(t=>t.hcp);
  const min=Math.min(...vals)-1, max=Math.max(...vals)+1;
  const dates=trend.map(t=>new Date(t.date).getTime());
  const tMin=Math.min(...dates), tMax=Math.max(...dates);
  const sx=t=>tMax===tMin ? pad.l : pad.l+((t-tMin)/(tMax-tMin))*(w-pad.l-pad.r);
  const sy=v=>pad.t+((max-v)/(max-min))*(h-pad.t-pad.b);
  const pts=trend.map(t=>`${sx(new Date(t.date).getTime())},${sy(t.hcp)}`).join(" ");
  const fmt=t=>new Date(t).toLocaleDateString("de-DE",{day:"2-digit",month:"2-digit",year:"2-digit"});
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{width:"100%",height:"auto",display:"block"}}>
      {[Math.floor(min),Math.round((min+max)/2),Math.ceil(max)].map(v=>(
        <g key={v}>
          <line x1={pad.l} x2={w-pad.r} y1={sy(v)} y2={sy(v)} stroke="#D3D1C7" strokeWidth={0.5}/>
          <text x={pad.l-6} y={sy(v)+4} fontSize={10} textAnchor="end" fill="#888">{v}</text>
        </g>
      ))}
      <polyline points={pts} fill="none" stroke={COLORS.hcp} strokeWidth={2}/>
      {trend.map((t,i)=><circle key={i} cx={sx(new Date(t.date).getTime())} cy={sy(t.hcp)} r={3} fill={COLORS.hcp}/>)}
      <text x={pad.l} y={h-4} fontSize={10} fill="#888">{fmt(tMin)}</text>
      {tMax!==tMin && <text x={w-pad.r} y={h-4} fontSize={10} textAnchor="end" fill="#888">{fmt(tMax)}</text>}
    </svg>
  );
}

function HcpRoundsTable({rounds}) {
  const takes = [1,1,2,2,2,2,3,3,3,3,3,4,4,4,5,6,7,8,9,10];
  const n = Math.min(rounds.length, 20);
  const take = takes[n-1];
  const withDiffs = [...rounds].reverse().slice(0,20).map(r=>({r, diff:calcScoreDiff(r)}));
  const counting = new Set(
    [...withDiffs].filter(x=>x.diff!==null).sort((a,b)=>a.diff-b.diff).slice(0,take).map(x=>x.r.id)
  );
  return (
    <div style={{marginBottom:24}}>
      <div style={{fontSize:14,fontWeight:500,marginBottom:4}}>HCP-wirksame Runden</div>
      <div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:10}}>
        {n} Runden · beste {take} fließen in die Berechnung ein
      </div>
      <div style={{border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-md)",overflow:"hidden"}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 60px 40px 90px",background:"var(--color-background-secondary)",padding:"6px 12px",fontSize:11,color:"var(--color-text-secondary)",fontWeight:500,gap:8}}>
          <span>Platz / Datum</span>
          <span style={{textAlign:"right"}}>Diff</span>
          <span style={{textAlign:"center"}}>zählt</span>
          <span style={{textAlign:"right"}}>Format</span>
        </div>
        {withDiffs.map(({r, diff}, i)=>{
          const counts = counting.has(r.id);
          return (
            <div key={r.id} style={{
              display:"grid",gridTemplateColumns:"1fr 60px 40px 90px",gap:8,
              padding:"8px 12px",alignItems:"center",
              background: counts ? "#E1F5EE" : i%2===0 ? "#fff" : "var(--color-background-secondary)",
              borderTop: i>0 ? "0.5px solid var(--color-border-tertiary)" : "none"
            }}>
              <div>
                <div style={{fontSize:13,fontWeight:counts?500:400,color:"var(--color-text-primary)"}}>{r.courseName}</div>
                <div style={{fontSize:11,color:"var(--color-text-secondary)"}}>{r.date} · {r.holes} Loch · PHCP {r.playingHcp}</div>
              </div>
              <div style={{fontSize:14,fontWeight:500,textAlign:"right",color:counts?"#1D9E75":"var(--color-text-primary)"}}>
                {diff!==null ? diff : <span title={missingDiffReason(r)||""} style={{color:"#E24B4A",fontSize:12,cursor:"help"}}>fehlt{missingDiffReason(r)?" ⚠":""}​</span>}
              </div>
              <div style={{textAlign:"center",color:"#1D9E75",fontWeight:500}}>{counts?"✓":""}</div>
              <div style={{textAlign:"right"}}>
                {badge(r.mode, r.mode==="Stableford"?"#EEEDFE":"#E6F1FB", r.mode==="Stableford"?"#3C3489":"#0C447C")}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProfileForm({profile, onSave, isSetup}) {
  const [p, setP] = useState({name:profile.name||"", startHcp:profile.startHcp??54});
  const set = (k,v) => setP(prev=>({...prev,[k]:v}));
  return (
    <div style={{background:"#fff",borderRadius:"var(--border-radius-lg)",border:"0.5px solid var(--color-border-tertiary)",padding:"20px 24px"}}>
      {isSetup && <p style={{fontSize:14,color:"var(--color-text-secondary)",marginBottom:16}}>Einmal einrichten – wird für alle Runden verwendet.</p>}
      {field("Dein Name", <input style={inp} value={p.name} onChange={e=>set("name",e.target.value)} placeholder="z.B. Max Mustermann"/>)}
      {field("Start-HCP Index", <input type="number" step="0.1" style={inp} value={p.startHcp} onChange={e=>set("startHcp",parseFloat(e.target.value))}/>, "(Standard: 54)")}
      <button onClick={()=>{ if(!p.name) return alert("Bitte Namen eingeben"); onSave(p); }}
        style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontWeight:500,fontSize:14}}>
        {isSetup?"Loslegen":"Speichern"}
      </button>
    </div>
  );
}

function RoundForm({initial, courses, onSave, onCancel}) {
  const [r, setR] = useState(initial);
  const set = (k,v) => setR(prev=>({...prev,[k]:v}));
  const eligible = isHcpEligible(r);
  const cr=parseFloat(r.courseRating), sr=parseFloat(r.slopeRating);
  const par=parseInt(r.par)||36, phcp=parseFloat(r.playingHcp)||0;
  const phcpAdj = parseInt(r.holes)===9 ? Math.round(phcp/2) : phcp;

  const prefill = c => setR(prev=>({...prev,courseId:c.id,courseName:c.name,courseRating:c.courseRating,slopeRating:c.slopeRating,par:c.par}));

  const handleSave = () => {
    if (!r.date) return alert("Datum erforderlich");
    const final = {...r};
    if (final.courseId) {
      const c = courses.find(x=>x.id===parseInt(final.courseId));
      if (c) { final.courseName=c.name; final.courseRating=c.courseRating; final.slopeRating=c.slopeRating; final.par=c.par; }
    }
    if (!final.courseName) return alert("Bitte Platzname angeben");
    if (final.gbe) final.gbe = parseInt(final.gbe);
    const cr2=parseFloat(final.courseRating), sr2=parseFloat(final.slopeRating);
    const par2=parseInt(final.par)||36, phcp2=parseFloat(final.playingHcp)||0;
    const phcp2Adj = parseInt(final.holes)===9 ? Math.round(phcp2/2) : phcp2;
    const pts2=parseInt(final.stablefordPoints);
    if (final.mode==="Stableford" && cr2&&sr2&&pts2) {
      final.adjustedGross = Math.round(cr2+(par2+phcp2Adj-pts2)*(sr2/113));
    }
    onSave(final);
  };

  return (
    <div>
      {field("Datum", <input type="date" style={inp} value={r.date||""} onChange={e=>set("date",e.target.value)}/>)}
      {field("Platz aus Datenbank", <select style={sel} value={r.courseId||""} onChange={e=>{const c=courses.find(x=>x.id===parseInt(e.target.value));if(c) prefill(c);}}>
        <option value="">– wählen oder manuell –</option>
        {courses.map(c=><option key={c.id} value={c.id}>{c.name} (CR {c.courseRating} / SR {c.slopeRating})</option>)}
      </select>)}
      {field("Platzname", <input style={inp} value={r.courseName||""} onChange={e=>set("courseName",e.target.value)} placeholder="z.B. GC Bergisch Land"/>)}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
        {field("Course Rating", <input type="number" step="0.1" style={inp} value={r.courseRating||""} onChange={e=>set("courseRating",parseFloat(e.target.value))} placeholder="36.0"/>)}
        {field("Slope Rating", <input type="number" style={inp} value={r.slopeRating||""} onChange={e=>set("slopeRating",parseInt(e.target.value))} placeholder="130"/>)}
        {field("Par", <input type="number" style={inp} value={r.par||""} onChange={e=>set("par",parseInt(e.target.value))} placeholder="37"/>)}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        {field("Wertungsform", <select style={sel} value={r.mode||"Stableford"} onChange={e=>set("mode",e.target.value)}>
          {MODES.map(m=><option key={m}>{m}</option>)}
        </select>)}
        {field("Format", <select style={sel} value={r.format||"Einzel"} onChange={e=>set("format",e.target.value)}>
          {FORMATS.map(f=><option key={f}>{f}</option>)}
        </select>)}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        {field("Anzahl Löcher", <select style={sel} value={r.holes||18} onChange={e=>set("holes",parseInt(e.target.value))}>
          <option value={18}>18 Loch</option>
          <option value={9}>9 Loch</option>
        </select>)}
        {field("Playing HCP (Spielvorgabe)", <input type="number" step="0.1" style={inp} value={r.playingHcp||""} onChange={e=>set("playingHcp",parseFloat(e.target.value))} placeholder="31"/>)}
      </div>
      {parseInt(r.holes)===9 && (
        <div style={{marginBottom:14}}>
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,cursor:"pointer"}}>
            <input type="checkbox" checked={r.nineHoleAllowed||false} onChange={e=>set("nineHoleAllowed",e.target.checked)}/>
            9-Loch HCP-wirksam (WHS seit April 2024)
          </label>
        </div>
      )}
      {r.mode==="Stableford" && (()=>{
        const pts=parseInt(r.stablefordPoints);
        const autoAGS=(cr&&sr&&pts)?Math.round(cr+(par+phcpAdj-pts)*(sr/113)):null;
        return (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {field("Stableford Punkte", <input type="number" style={inp} value={r.stablefordPoints||""} onChange={e=>{
              const p=parseInt(e.target.value);
              const upd={stablefordPoints:p};
              if(cr&&sr&&p) upd.adjustedGross=Math.round(cr+(par+phcpAdj-p)*(sr/113));
              setR(prev=>({...prev,...upd}));
            }} placeholder="23"/>)}
            {field("AGS (berechnet)", <input type="number" style={{...inp,background:"#f8f8f8"}} value={r.adjustedGross||""} onChange={e=>set("adjustedGross",parseInt(e.target.value))}/>, autoAGS?"auto":"")}
          </div>
        );
      })()}
      {r.mode==="Stroke Play" && field("Adjusted Gross Score", <input type="number" style={inp} value={r.adjustedGross||""} onChange={e=>set("adjustedGross",parseInt(e.target.value))} placeholder="92"/>)}
      {field(
        parseInt(r.holes)===9 ? "GBE von golf.de (überschreibt AGS)" : "GBE von golf.de (optional)",
        <input type="number" style={{...inp,background:r.gbe?"#E1F5EE":"#fff"}} value={r.gbe||""} onChange={e=>set("gbe",e.target.value?parseInt(e.target.value):"")} placeholder="z.B. 48"/>,
        r.gbe?"wird verwendet":""
      )}
      <div style={{display:"flex",gap:24,marginBottom:14}}>
        <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,cursor:"pointer"}}>
          <input type="checkbox" checked={r.submitted||false} onChange={e=>set("submitted",e.target.checked)}/>
          Eingereicht (DGVnet)
        </label>
        <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,cursor:"pointer"}}>
          <input type="checkbox" checked={r.markerSigned||false} onChange={e=>set("markerSigned",e.target.checked)}/>
          Marker unterschrieben
        </label>
      </div>
      <div style={{padding:"10px 14px",borderRadius:"var(--border-radius-md)",background:eligible?"#E1F5EE":"#F1EFE8",marginBottom:16,fontSize:13,color:eligible?"#085041":"#5F5E5A"}}>
        {eligible?"✓ Diese Runde wird HCP-wirksam eingehen.":"✗ Diese Runde ist nicht HCP-wirksam."}
        {!r.submitted&&" → Runde einreichen."}
        {r.submitted&&!r.markerSigned&&" → Marker-Unterschrift fehlt."}
        {r.submitted&&r.markerSigned&&r.format!=="Einzel"&&" → Nur Einzel ist HCP-wirksam."}
        {parseInt(r.holes)===9&&!r.nineHoleAllowed&&" → Checkbox '9-Loch HCP-wirksam' aktivieren."}
      </div>
      <div style={{display:"flex",gap:8}}>
        <button onClick={handleSave} style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontWeight:500,fontSize:14}}>Speichern</button>
        <button onClick={onCancel} style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:"transparent",border:"0.5px solid var(--color-border-tertiary)",cursor:"pointer",fontSize:14,color:"var(--color-text-primary)"}}>Abbrechen</button>
      </div>
    </div>
  );
}

function CourseForm({initial, onSave, onCancel}) {
  const [c, setC] = useState(initial);
  const set = (k,v) => setC(prev=>({...prev,[k]:v}));
  return (
    <div>
      {field("Platzname", <input style={inp} value={c.name||""} onChange={e=>set("name",e.target.value)} placeholder="GC Bergisch Land"/>)}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
        {field("Course Rating", <input type="number" step="0.1" style={inp} value={c.courseRating||""} onChange={e=>set("courseRating",parseFloat(e.target.value))} placeholder="36.0"/>)}
        {field("Slope Rating", <input type="number" style={inp} value={c.slopeRating||""} onChange={e=>set("slopeRating",parseInt(e.target.value))} placeholder="130"/>)}
        {field("Par", <input type="number" style={inp} value={c.par||""} onChange={e=>set("par",parseInt(e.target.value))} placeholder="37"/>)}
      </div>
      {field("Abschlag / Tee", <select style={sel} value={c.tee||"Gelb"} onChange={e=>set("tee",e.target.value)}>
        {TEES.map(t=><option key={t}>{t}</option>)}
      </select>)}
      {field("Notizen", <textarea style={{...inp,resize:"vertical",minHeight:60}} value={c.notes||""} onChange={e=>set("notes",e.target.value)} placeholder="z.B. Heimatplatz"/>)}
      <div style={{display:"flex",gap:8}}>
        <button onClick={()=>{if(!c.name) return alert("Name erforderlich"); onSave(c);}}
          style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontWeight:500,fontSize:14}}>Speichern</button>
        <button onClick={onCancel} style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:"transparent",border:"0.5px solid var(--color-border-tertiary)",cursor:"pointer",fontSize:14,color:"var(--color-text-primary)"}}>Abbrechen</button>
      </div>
    </div>
  );
}

function RoundRow({round:r, onEdit, onDelete, compact, counting}) {
  const status=hcpStatus(r);
  const diff=calcScoreDiff(r);
  return (
    <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",borderRadius:"var(--border-radius-md)",border:`0.5px solid ${counting?"#1D9E75":"var(--color-border-tertiary)"}`,background:counting?"#E1F5EE":"#fff",marginBottom:8}}>
      <div style={{width:10,height:10,borderRadius:"50%",background:status.dot,flexShrink:0}}/>
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <span style={{fontWeight:500,fontSize:14,color:"var(--color-text-primary)"}}>{r.courseName||"Unbekannter Platz"}</span>
          {badge(r.mode,r.mode==="Stableford"?"#EEEDFE":"#E6F1FB",r.mode==="Stableford"?"#3C3489":"#0C447C")}
          {badge(status.label,status.dot==="#1D9E75"?"#E1F5EE":"#F1EFE8",status.dot==="#1D9E75"?"#085041":"#5F5E5A")}
        </div>
        <div style={{fontSize:12,color:"var(--color-text-secondary)",marginTop:2}}>
          {r.date} · {r.holes} Loch · CR {r.courseRating} / SR {r.slopeRating}
          {r.gbe?` · GBE ${r.gbe}`:r.adjustedGross?` · AGS ${r.adjustedGross}`:""}
          {diff!==null?` · Diff: ${diff}`:""}
        </div>
      </div>
      {!compact && (
        <div style={{display:"flex",gap:6}}>
          <button onClick={onEdit} style={{padding:"4px 10px",borderRadius:"var(--border-radius-md)",border:"0.5px solid var(--color-border-tertiary)",background:"transparent",cursor:"pointer",fontSize:12,color:"var(--color-text-primary)"}}>Bearbeiten</button>
          <button onClick={onDelete} style={{padding:"4px 10px",borderRadius:"var(--border-radius-md)",border:"0.5px solid #E24B4A",background:"transparent",cursor:"pointer",fontSize:12,color:"#E24B4A"}}>Löschen</button>
        </div>
      )}
    </div>
  );
}

function RoundList({rounds, courses, onNew, onEdit, onDelete}) {
  const [filter, setFilter] = useState("all");

  const hcpEligible = rounds.filter(isHcpEligible);
  const n = Math.min(hcpEligible.length, 20);
  const takes = [1,1,2,2,2,2,3,3,3,3,3,4,4,4,5,6,7,8,9,10];
  const take = n > 0 ? takes[n-1] : 0;
  const countingIds = new Set(
    [...hcpEligible].reverse().slice(0,20)
      .map(r=>({r, diff:calcScoreDiff(r)}))
      .filter(x=>x.diff!==null)
      .sort((a,b)=>a.diff-b.diff)
      .slice(0,take)
      .map(x=>x.r.id)
  );

  const filtered = rounds.filter(r=>{
    if (filter==="hcp") return isHcpEligible(r);
    if (filter==="no_hcp") return !isHcpEligible(r);
    if (filter==="counting") return countingIds.has(r.id);
    return true;
  });
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{display:"flex",gap:6}}>
          {[["all","Alle"],["hcp","HCP-wirksam"],["counting",`Zählt aktuell (${take})`],["no_hcp","Nicht wirksam"]].map(([v,l])=>(
            <button key={v} onClick={()=>setFilter(v)} style={{fontSize:12,padding:"4px 10px",borderRadius:"var(--border-radius-md)",background:filter===v?COLORS.hcp:"transparent",color:filter===v?"#fff":"var(--color-text-secondary)",border:`0.5px solid ${filter===v?COLORS.hcp:"var(--color-border-tertiary)"}`,cursor:"pointer"}}>{l}</button>
          ))}
        </div>
        <button onClick={onNew} style={{padding:"8px 14px",borderRadius:"var(--border-radius-md)",background:COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontSize:13,fontWeight:500}}>+ Neue Runde</button>
      </div>
      {filtered.length===0 && <div style={{color:"var(--color-text-secondary)",fontSize:14,padding:"24px 0"}}>Keine Runden gefunden.</div>}
      {filtered.map(r=><RoundRow key={r.id} round={r} onEdit={()=>onEdit(r)} onDelete={()=>onDelete(r.id)} counting={countingIds.has(r.id)}/>)}
    </div>
  );
}

function CourseList({courses, onNew, onEdit}) {
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{fontSize:13,color:"var(--color-text-secondary)"}}>{courses.length} Plätze gespeichert</div>
        <button onClick={onNew} style={{padding:"8px 14px",borderRadius:"var(--border-radius-md)",background:COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontSize:13,fontWeight:500}}>+ Neuer Platz</button>
      </div>
      {courses.length===0 && <div style={{color:"var(--color-text-secondary)",fontSize:14,padding:"24px 0"}}>Noch keine Plätze angelegt.</div>}
      {courses.map(c=>(
        <div key={c.id} style={{padding:"10px 14px",borderRadius:"var(--border-radius-md)",border:"0.5px solid var(--color-border-tertiary)",background:"#fff",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontWeight:500,fontSize:14,color:"var(--color-text-primary)"}}>{c.name}</div>
            <div style={{fontSize:12,color:"var(--color-text-secondary)"}}>CR {c.courseRating} · SR {c.slopeRating} · Par {c.par} · {c.tee}</div>
          </div>
          <button onClick={()=>onEdit(c)} style={{padding:"4px 10px",borderRadius:"var(--border-radius-md)",border:"0.5px solid var(--color-border-tertiary)",background:"transparent",cursor:"pointer",fontSize:12,color:"var(--color-text-primary)"}}>Bearbeiten</button>
        </div>
      ))}
    </div>
  );
}

function Dashboard({rounds, hcpRounds, recentDiffs, estimatedHcp, onNew}) {
  const avgDiff = recentDiffs.length?(recentDiffs.reduce((s,d)=>s+d,0)/recentDiffs.length).toFixed(1):null;
  const chartData = useMemo(()=>[...hcpRounds].reverse().map((r,i)=>({x:i+1,diff:calcScoreDiff(r),mode:r.mode,date:r.date})),[hcpRounds]);
  const trendData = useMemo(()=>{
    const el=[...hcpRounds].reverse();
    return el.map((r,i)=>{
      const diffs=el.slice(Math.max(0,i-19),i+1).map(x=>calcScoreDiff(x)).filter(d=>d!==null);
      const h=calcHcp(diffs);
      return h!==null?{i:i+1,hcp:h,date:r.date}:null;
    }).filter(Boolean);
  },[hcpRounds]);

  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:12,marginBottom:24}}>
        {[["Runden gesamt",rounds.length],["HCP-wirksam",hcpRounds.length],["Ø Differenzial",avgDiff??"–"],["Bestes Diff",recentDiffs.length?Math.min(...recentDiffs).toFixed(1):"–"]].map(([label,val])=>(
          <div key={label} style={{background:"var(--color-background-secondary)",borderRadius:"var(--border-radius-md)",padding:"12px 14px"}}>
            <div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:4}}>{label}</div>
            <div style={{fontSize:22,fontWeight:500,color:"var(--color-text-primary)"}}>{val}</div>
          </div>
        ))}
      </div>

      {hcpRounds.length>0 && <HcpRoundsTable rounds={hcpRounds}/>}

      {(chartData.length>0 || trendData.length>=2) && (
        <div style={{display:"grid",gridTemplateColumns:trendData.length>=2&&chartData.length>0?"1fr 1fr":"1fr",gap:16,marginBottom:24}}>
          {chartData.length>0 && (
            <div>
              <div style={{fontSize:14,fontWeight:500,marginBottom:12}}>Score Differenzials</div>
              <ScoreChart data={chartData}/>
            </div>
          )}
          {trendData.length>=2 && (
            <div>
              <div style={{fontSize:14,fontWeight:500,marginBottom:10}}>HCP-Entwicklung</div>
              <HcpTrendChart trend={trendData}/>
            </div>
          )}
        </div>
      )}

      {rounds.length===0 ? (
        <div style={{textAlign:"center",padding:"40px 0",color:"var(--color-text-secondary)"}}>
          <div style={{fontSize:32,marginBottom:12}}>⛳</div>
          <div style={{fontSize:15,marginBottom:16}}>Noch keine Runden erfasst</div>
          <button onClick={onNew} style={{padding:"10px 20px",borderRadius:"var(--border-radius-md)",background:COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontWeight:500,fontSize:14}}>Erste Runde erfassen</button>
        </div>
      ) : (
        <div>
          <div style={{fontSize:14,fontWeight:500,marginBottom:10}}>Letzte Runden</div>
          {rounds.slice(0,5).map(r=><RoundRow key={r.id} round={r} compact/>)}
        </div>
      )}
    </div>
  );
}

function DataPortability({db, onImport}) {
  const [importError, setImportError] = useState("");
  const [importSuccess, setImportSuccess] = useState(false);

  const handleExport = () => {
    const json = JSON.stringify(db, null, 2);
    const blob = new Blob([json], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `golf-hcp-export-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e) => {
    setImportError("");
    setImportSuccess(false);
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result as string);
        if (!data.rounds || !data.courses || !data.profile) throw new Error("Ungültiges Format");
        onImport(data);
        setImportSuccess(true);
      } catch(err) {
        setImportError("Datei konnte nicht gelesen werden. Bitte eine gültige Export-Datei verwenden.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const btn = (onClick, label, danger=false) => (
    <button onClick={onClick} style={{padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:danger?"#E24B4A":COLORS.hcp,color:"#fff",border:"none",cursor:"pointer",fontWeight:500,fontSize:14}}>
      {label}
    </button>
  );

  return (
    <div style={{background:"#fff",borderRadius:"var(--border-radius-lg)",border:"0.5px solid var(--color-border-tertiary)",padding:"20px 24px"}}>
      <div style={{marginBottom:24}}>
        <div style={{fontSize:14,fontWeight:500,marginBottom:6}}>Export</div>
        <div style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:12}}>
          Alle Runden, Plätze und Profildaten als JSON-Datei herunterladen.
        </div>
        {btn(handleExport, `Exportieren (${db.rounds.length} Runden, ${db.courses.length} Plätze)`)}
      </div>

      <div style={{borderTop:"0.5px solid var(--color-border-tertiary)",paddingTop:20}}>
        <div style={{fontSize:14,fontWeight:500,marginBottom:6}}>Import</div>
        <div style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:12}}>
          Daten aus einer Export-Datei wiederherstellen. <strong>Bestehende Daten werden überschrieben.</strong>
        </div>
        <label style={{display:"inline-block",padding:"9px 18px",borderRadius:"var(--border-radius-md)",background:"#F5F4F0",border:"0.5px solid var(--color-border-secondary)",cursor:"pointer",fontWeight:500,fontSize:14,color:"#111"}}>
          JSON-Datei wählen
          <input type="file" accept=".json,application/json" onChange={handleImport} style={{display:"none"}}/>
        </label>
        {importSuccess && <div style={{marginTop:10,fontSize:13,color:"#1D9E75",fontWeight:500}}>Import erfolgreich.</div>}
        {importError && <div style={{marginTop:10,fontSize:13,color:"#E24B4A"}}>{importError}</div>}
      </div>
    </div>
  );
}

function HcpInfo() {
  const takes = [1,1,2,2,2,2,3,3,3,3,3,4,4,4,5,6,7,8,9,10];
  const adjs  = [-2,-1,-1,-1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  const card = (children) => (
    <div style={{background:"#fff",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"16px 20px",marginBottom:14}}>
      {children}
    </div>
  );
  const h = (text) => <div style={{fontSize:14,fontWeight:500,marginBottom:8,color:"#111"}}>{text}</div>;
  const formula = (text) => (
    <div style={{background:"#F5F4F0",borderRadius:"var(--border-radius-md)",padding:"10px 14px",fontFamily:"monospace",fontSize:13,margin:"8px 0",color:"#111"}}>
      {text}
    </div>
  );
  const p = (text) => <div style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:6,lineHeight:1.6}}>{text}</div>;

  return (
    <div>
      {card(<>
        {h("Was ist der Handicap Index?")}
        {p("Der Handicap Index (HCP) ist eine Kennzahl, die dein spielerisches Potential widerspiegelt – unabhängig vom Platz. Grundlage ist das World Handicap System (WHS), das seit 2020 weltweit gilt und in Deutschland vom DGV angewendet wird.")}
        {p("Ein niedriger HCP bedeutet besseres Spiel. Anfänger starten bei max. 54.")}
      </>)}

      {card(<>
        {h("Schritt 1 – Score Differenzial berechnen")}
        {p("Nach jeder HCP-wirksamen Runde wird ein Score Differenzial ermittelt. Es normiert dein Ergebnis auf einen Standardplatz (Slope 113).")}
        {formula("Differenzial = (GBE − Course Rating) × 113 ÷ Slope Rating")}
        {p("GBE = Gross Brutto Ergebnis (angepasstes Brutto-Score). Course Rating und Slope Rating stehen auf der Scorekarte des Platzes.")}
        {p("Beispiel: GBE 95, CR 72.0, SR 130 → (95 − 72) × 113 ÷ 130 = 20.0")}
        {formula("9-Loch: GBE18 = GBE + Par + Playing HCP + 1\ndann gleiche Formel mit CR × 2 und SR")}
      </>)}

      {card(<>
        {h("Schritt 2 – Beste Differenziale auswählen")}
        {p("Es zählen die letzten 20 HCP-wirksamen Runden. Je nach Gesamtanzahl werden die besten N Differenziale gewählt:")}
        <div style={{border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-md)",overflow:"hidden",marginTop:8}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",background:"var(--color-background-secondary)",padding:"6px 12px",fontSize:11,fontWeight:500,color:"var(--color-text-secondary)"}}>
            <span>Runden</span><span style={{textAlign:"center"}}>Beste</span><span style={{textAlign:"right"}}>Anpassung</span>
          </div>
          {takes.map((t,i)=>(
            <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",padding:"5px 12px",fontSize:12,borderTop:"0.5px solid var(--color-border-tertiary)",background:i%2===0?"#fff":"var(--color-background-secondary)"}}>
              <span>{i+1}</span>
              <span style={{textAlign:"center"}}>{t}</span>
              <span style={{textAlign:"right",color:adjs[i]<0?"#E24B4A":adjs[i]>0?"#888":"inherit"}}>
                {adjs[i]<0 ? adjs[i] : adjs[i]>0 ? `+${adjs[i]}` : "–"}
              </span>
            </div>
          ))}
        </div>
      </>)}

      {card(<>
        {h("Schritt 3 – Handicap Index berechnen")}
        {p("Der Durchschnitt der ausgewählten Differenziale wird mit einem Faktor von 0,96 multipliziert (\"Playing Conditions Calculation\"). Das Ergebnis wird auf 1 Dezimalstelle gerundet und auf max. 54 begrenzt.")}
        {formula("HCP Index = Ø(beste Differenziale + Anpassung) × 0,96")}
        {p("Der Faktor 0,96 sorgt dafür, dass der HCP Index leicht unter dem tatsächlichen Durchschnitt liegt – das System geht davon aus, dass Spieler ihr bestes Spiel wiederholen können.")}
      </>)}

      {card(<>
        {h("Wann ist eine Runde HCP-wirksam?")}
        {[
          "Eingereicht (submitted)",
          "Marker unterschrieben",
          "Einzel-Format (kein Vierer/Vierball)",
          "Spielmodus: Stableford oder Stroke Play",
          "18 Loch – oder 9 Loch mit aktivierter 9-Loch-Wertung",
        ].map((item,i)=>(
          <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",fontSize:13,color:"var(--color-text-secondary)",marginBottom:4}}>
            <span style={{color:"#1D9E75",fontWeight:500,flexShrink:0}}>✓</span>
            <span>{item}</span>
          </div>
        ))}
      </>)}
    </div>
  );
}

export default function App() {
  const [db, setDB] = useState(initDB);
  const [view, setView] = useState("dashboard");
  const [form, setForm] = useState(null);
  const [courseForm, setCourseForm] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  useEffect(()=>saveDB(db),[db]);

  const updateDB = fn => setDB(prev=>{ const next=fn({...prev}); saveDB(next); return next; });

  const saveRound = r => { updateDB(db=>{ if(r.id) db.rounds=db.rounds.map(x=>x.id===r.id?r:x); else { r.id=db.nextRoundId++; r.createdAt=new Date().toISOString(); db.rounds=[...db.rounds,r]; } return db; }); setForm(null); };
  const saveCourse = c => { updateDB(db=>{ if(c.id) db.courses=db.courses.map(x=>x.id===c.id?c:x); else { c.id=db.nextCourseId++; db.courses=[...db.courses,c]; } return db; }); setCourseForm(null); };
  const saveProfile = p => updateDB(db=>{ db.profile=p; return db; });
  const deleteRound = id => { updateDB(db=>{ db.rounds=db.rounds.filter(r=>r.id!==id); return db; }); setDeleteConfirm(null); };

  const sortedRounds = useMemo(()=>[...db.rounds].sort((a,b)=>b.date.localeCompare(a.date)),[db.rounds]);
  const hcpRounds = useMemo(()=>sortedRounds.filter(isHcpEligible),[sortedRounds]);
  const recentDiffs = useMemo(()=>hcpRounds.map(r=>calcScoreDiff(r)).filter(d=>d!==null).slice(0,20),[hcpRounds]);
  const estimatedHcp = useMemo(()=>calcHcp(recentDiffs),[recentDiffs]);
  const displayHcp = estimatedHcp??db.profile.startHcp??54;

  const newRound = () => setForm({ date:new Date().toISOString().slice(0,10), mode:"Stableford", format:"Einzel", holes:18, submitted:false, markerSigned:false, nineHoleAllowed:false, playingHcp:displayHcp });

  if (!db.profile.name) return (
    <div style={{maxWidth:480,margin:"40px auto",padding:"0 1rem",fontFamily:"var(--font-sans)",color:"var(--color-text-primary)"}}>
      <div style={{fontSize:20,fontWeight:500,marginBottom:4}}>Golf HCP Tracker</div>
      <div style={{fontSize:13,color:COLORS.textSec,marginBottom:24}}>Einmalige Einrichtung – DGV · WHS</div>
      <ProfileForm profile={db.profile} onSave={saveProfile} isSetup/>
    </div>
  );

  return (
    <div style={{maxWidth:760,margin:"0 auto",padding:"1rem 1rem 3rem",fontFamily:"var(--font-sans)",color:"var(--color-text-primary)"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
        <div>
          <div style={{fontSize:20,fontWeight:500}}>Golf HCP Tracker</div>
          <div style={{fontSize:13,color:COLORS.textSec}}>{db.profile.name} · DGV · WHS</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:11,color:COLORS.textSec}}>{estimatedHcp?"Aktueller HCP Index":"Start-HCP"}</div>
          <div style={{fontSize:36,fontWeight:500,color:COLORS.hcp,lineHeight:1.1}}>{displayHcp}</div>
          <div style={{fontSize:11,color:COLORS.textSec}}>{estimatedHcp?`aus ${Math.min(hcpRounds.length,20)} HCP-wirks. Runden`:"noch keine gewerteten Runden"}</div>
        </div>
      </div>

      <div style={{display:"flex",gap:4,marginBottom:20,borderBottom:`0.5px solid ${COLORS.border}`,paddingBottom:4}}>
        {[["dashboard","Dashboard"],["rounds","Runden"],["courses","Plätze"],["profile","Profil"],["data","Daten"],["info","HCP-Info"]].map(([id,label])=>(
          <button key={id} onClick={()=>setView(id)} style={{padding:"6px 14px",borderRadius:"var(--border-radius-md)",background:view===id?COLORS.hcp:"transparent",color:view===id?"#fff":COLORS.textSec,border:"none",cursor:"pointer",fontWeight:view===id?500:400,fontSize:14}}>{label}</button>
        ))}
      </div>

      {view==="dashboard" && <Dashboard rounds={sortedRounds} hcpRounds={hcpRounds} recentDiffs={recentDiffs} estimatedHcp={estimatedHcp} onNew={()=>{newRound();setView("rounds");}}/>}
      {view==="rounds" && <RoundList rounds={sortedRounds} courses={db.courses} onNew={newRound} onEdit={r=>setForm({...r})} onDelete={id=>setDeleteConfirm(id)}/>}
      {view==="courses" && <CourseList courses={db.courses} onNew={()=>setCourseForm({name:"",courseRating:"",slopeRating:"",par:36,tee:"Gelb",notes:""})} onEdit={c=>setCourseForm({...c})}/>}
      {view==="profile" && <ProfileForm profile={db.profile} onSave={saveProfile}/>}
      {view==="data" && <DataPortability db={db} onImport={data=>{ saveDB(data); setDB(data); }}/>}
      {view==="info" && <HcpInfo/>}

      {form && <Modal title={form.id?"Runde bearbeiten":"Neue Runde"} onClose={()=>setForm(null)}><RoundForm initial={form} courses={db.courses} onSave={saveRound} onCancel={()=>setForm(null)}/></Modal>}
      {courseForm && <Modal title={courseForm.id?"Platz bearbeiten":"Neuer Platz"} onClose={()=>setCourseForm(null)}><CourseForm initial={courseForm} onSave={saveCourse} onCancel={()=>setCourseForm(null)}/></Modal>}
      {deleteConfirm && <Modal title="Runde löschen?" onClose={()=>setDeleteConfirm(null)}>
        <p style={{color:COLORS.textSec,fontSize:14}}>Diese Runde wird unwiderruflich gelöscht.</p>
        <div style={{display:"flex",gap:8,marginTop:16}}>
          <button onClick={()=>deleteRound(deleteConfirm)} style={{padding:"8px 16px",borderRadius:"var(--border-radius-md)",background:"#E24B4A",color:"#fff",border:"none",cursor:"pointer",fontWeight:500}}>Löschen</button>
          <button onClick={()=>setDeleteConfirm(null)} style={{padding:"8px 16px",borderRadius:"var(--border-radius-md)",background:"transparent",border:`0.5px solid ${COLORS.border}`,cursor:"pointer",color:"var(--color-text-primary)"}}>Abbrechen</button>
        </div>
      </Modal>}
    </div>
  );
}
