import { useState, useEffect, useMemo } from "react";
import { auth, db, googleProvider } from "./firebase";
import { signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";

// ─── Constants ───────────────────────────────────────────────
const DAYS_LABEL = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const DAYS_SHORT = ["S","M","T","W","T","F","S"];
const STATUS_CONFIG = {
  good: { label: "Best", color: "#2E7D32", bg: "#E8F5E9", dot: "#4CAF50", tag: "🟢" },
  okay: { label: "Okay", color: "#E65100", bg: "#FFF8E1", dot: "#FFC107", tag: "🟡" },
  bad:  { label: "Bad",  color: "#C62828", bg: "#FFEBEE", dot: "#EF5350", tag: "🔴" },
};
const PALETTES = [
  { bg:"#E3F2FD",fg:"#1565C0",accent:"#42A5F5" },{ bg:"#F3E5F5",fg:"#7B1FA2",accent:"#AB47BC" },
  { bg:"#E0F7FA",fg:"#00695C",accent:"#26A69A" },{ bg:"#FFF3E0",fg:"#E65100",accent:"#FFA726" },
  { bg:"#FCE4EC",fg:"#C62828",accent:"#EF5350" },{ bg:"#E8F5E9",fg:"#2E7D32",accent:"#66BB6A" },
  { bg:"#EDE7F6",fg:"#4527A0",accent:"#7E57C2" },{ bg:"#EFEBE9",fg:"#4E342E",accent:"#8D6E63" },
  { bg:"#F1F8E9",fg:"#33691E",accent:"#9CCC65" },{ bg:"#FFF8E1",fg:"#F57F17",accent:"#FFCA28" },
];
const EMOJIS = ["😊","🎸","🎨","📚","🏃","🎮","🍕","🌟","🎵","🧑‍💻","☕","🌊","🎯","🚀","🌸","🦊","🐝","🎲"];

// ─── Helpers ─────────────────────────────────────────────────
function dateDiffDays(a, b) {
  return Math.floor((Date.UTC(b.getFullYear(),b.getMonth(),b.getDate()) - Date.UTC(a.getFullYear(),a.getMonth(),a.getDate())) / 86400000);
}
function getCycleDay(startDate, targetDate, cycleLength) {
  const diff = dateDiffDays(startDate, targetDate);
  return ((diff % cycleLength) + cycleLength) % cycleLength + 1;
}
function parseDate(str) { const [y,m,d] = str.split("-").map(Number); return new Date(y,m-1,d); }
function fmtDate(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; }
function getDaysInMonth(y,m) { return new Date(y,m+1,0).getDate(); }
function getFirstDayOfMonth(y,m) { return new Date(y,m,1).getDay(); }
function makeDays(len, fn) { const d={}; for(let i=1;i<=len;i++) d[i]=fn(i); return d; }
function useWidth() {
  const [w,setW] = useState(typeof window!=="undefined"?window.innerWidth:400);
  useEffect(()=>{ const h=()=>setW(window.innerWidth); window.addEventListener("resize",h); return()=>window.removeEventListener("resize",h); },[]);
  return w;
}

const today = new Date();
const todayStr = fmtDate(today);

// ─── Default Data ────────────────────────────────────────────
const DEFAULT_SCHEDULES = [
  { id:"28-day", name:"28 Day Cycle", cycleLength:28, builtIn:true, days:makeDays(28, d=>d<=5?"bad":d>=15&&d<=20?"good":"okay") },
  { id:"7-day", name:"7 Day Cycle", cycleLength:7, builtIn:true, days:makeDays(7, d=>(d===1||d===7)?"bad":"good") },
];

const DEFAULT_FRIENDS = [
  { id:"1", name:"Alex", emoji:"🎸", palette:0, description:"", scheduleHistory:[{scheduleId:"28-day",cycleStart:"2026-03-01",changedAt:"2026-03-01T00:00:00Z",notes:""}] },
  { id:"2", name:"Jordan", emoji:"🎨", palette:1, description:"", scheduleHistory:[{scheduleId:"28-day",cycleStart:"2026-03-05",changedAt:"2026-03-05T00:00:00Z",notes:""}] },
  { id:"3", name:"Sam", emoji:"📚", palette:2, description:"", scheduleHistory:[{scheduleId:"7-day",cycleStart:"2026-03-10",changedAt:"2026-03-10T00:00:00Z",notes:""}] },
];

// ─── Schedule Logic ──────────────────────────────────────────
function getActiveEntry(friend, date) {
  const sorted = [...friend.scheduleHistory].sort((a,b)=>a.cycleStart.localeCompare(b.cycleStart));
  if (sorted.length === 0) return null;
  let active = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (parseDate(sorted[i].cycleStart) <= date) active = sorted[i];
    else break;
  }
  return active;
}

function getFriendStatusOnDate(friend, date, schedules) {
  const entry = getActiveEntry(friend, date);
  if (!entry) return { status:"okay", cycleDay:0, schedule:null, entry:null };
  const schedule = schedules.find(s=>s.id===entry.scheduleId);
  if (!schedule) return { status:"okay", cycleDay:0, schedule:null, entry };
  const cycleDay = getCycleDay(parseDate(entry.cycleStart), date, schedule.cycleLength);
  const status = schedule.days[cycleDay] || "okay";
  return { status, cycleDay, schedule, entry };
}

function addScheduleChange(friend, scheduleId, cycleStart, notes) {
  const newEntry = { scheduleId, cycleStart, changedAt: new Date().toISOString(), notes: notes || "" };
  const kept = friend.scheduleHistory.filter(e => e.cycleStart < cycleStart);
  return { ...friend, scheduleHistory: [...kept, newEntry].sort((a,b)=>a.cycleStart.localeCompare(b.cycleStart)) };
}

// ─── Firestore helpers ───────────────────────────────────────
function getUserDocRef(uid) { return doc(db, "users", uid); }

async function loadData(uid) {
  try {
    const snap = await getDoc(getUserDocRef(uid));
    if (snap.exists()) return snap.data();
  } catch (e) { console.error("Firestore load error:", e); }
  return null;
}

async function saveData(uid, friends, schedules) {
  try {
    await setDoc(getUserDocRef(uid), { friends, schedules, updatedAt: new Date().toISOString() }, { merge: true });
  } catch (e) { console.error("Firestore save error:", e); }
}

// ─── Small Components ────────────────────────────────────────
function FriendBadge({ friend, size="md", status }) {
  const p = PALETTES[friend.palette%PALETTES.length];
  const s = size==="sm"?24:size==="xs"?20:size==="lg"?42:30;
  const fs = size==="sm"?11:size==="xs"?9:size==="lg"?20:15;
  const border = status?STATUS_CONFIG[status].dot:p.accent;
  return (<div title={friend.name} style={{
    width:s,height:s,borderRadius:"50%",background:p.bg,border:`2px solid ${border}`,
    display:"flex",alignItems:"center",justifyContent:"center",fontSize:fs,flexShrink:0,
    boxShadow:status==="good"?"0 0 6px rgba(76,175,80,0.35)":"none",
  }}>{friend.emoji}</div>);
}

function CycleRing({ friend, targetDate, size=56, schedules }) {
  const { status, cycleDay, schedule } = getFriendStatusOnDate(friend, targetDate, schedules);
  const cfg = STATUS_CONFIG[status];
  const cl = schedule?.cycleLength || 28;
  const r = (size-8)/2;
  const circ = 2*Math.PI*r;
  const progress = cycleDay/cl;
  return (
    <div style={{ position:"relative",width:size,height:size,flexShrink:0 }}>
      <svg width={size} height={size} style={{ transform:"rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#EDE7E3" strokeWidth={3}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={cfg.dot}
          strokeWidth={3} strokeDasharray={circ} strokeDashoffset={circ*(1-progress)}
          strokeLinecap="round" style={{ transition:"stroke-dashoffset 0.4s" }}/>
      </svg>
      <div style={{ position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center" }}>
        <span style={{ fontSize:size*0.3,lineHeight:1 }}>{friend.emoji}</span>
        <span style={{ fontSize:Math.max(size*0.16,8),fontWeight:700,color:cfg.color,lineHeight:1,marginTop:1 }}>D{cycleDay}</span>
      </div>
    </div>
  );
}

function ScheduleBar({ schedule, currentDay, compact, interactive, onDayClick }) {
  const len = schedule.cycleLength;
  return (
    <div>
      <div style={{ display:"flex",gap:compact?0.5:1,borderRadius:5,overflow:"hidden" }}>
        {Array.from({length:len},(_,i)=>{
          const cd=i+1;
          const status=schedule.days[cd]||"okay";
          const cfg=STATUS_CONFIG[status];
          const isCurrent=cd===currentDay;
          return (
            <div key={i} title={`Day ${cd} — ${cfg.label}`}
              onClick={interactive?()=>onDayClick(cd):undefined}
              style={{
                flex:1,height:isCurrent?16:interactive?20:10,background:cfg.dot,
                opacity:isCurrent?1:interactive?0.7:0.4,borderRadius:isCurrent?2:interactive?2:0,
                transition:"all 0.15s",position:"relative",cursor:interactive?"pointer":"default",minWidth:interactive?8:0,
              }}>
              {isCurrent&&!interactive&&<div style={{ position:"absolute",top:-12,left:"50%",transform:"translateX(-50%)",fontSize:7,fontWeight:800,color:cfg.color }}>▼</div>}
              {interactive&&len<=31&&<div style={{ position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:len>21?6:len>14?7:9,fontWeight:600,color:"#FFF",textShadow:"0 1px 2px rgba(0,0,0,0.3)" }}>{cd}</div>}
            </div>
          );
        })}
      </div>
      {!interactive&&<div style={{ display:"flex",justifyContent:"space-between",fontSize:8,color:"#BBB",marginTop:2,padding:"0 1px" }}>
        <span>1</span>{len>14&&<span>{Math.floor(len/2)}</span>}<span>{len}</span>
      </div>}
    </div>
  );
}

function ScheduleEditor({ schedule, onSave, onCancel, compact }) {
  const [name, setName] = useState(schedule?.name || "");
  const [cycleLength, setCycleLength] = useState(schedule?.cycleLength || 14);
  const [days, setDays] = useState(schedule?.days || makeDays(14, ()=>"okay"));

  const updateLength = (len) => {
    const n = Math.max(2, Math.min(60, len));
    setCycleLength(n);
    const newDays = {};
    for (let i=1;i<=n;i++) newDays[i]=days[i]||"okay";
    setDays(newDays);
  };

  const cycleDayStatus = (day) => {
    const current = days[day]||"okay";
    const next = current==="good"?"okay":current==="okay"?"bad":"good";
    setDays({...days,[day]:next});
  };

  const setAll = (status) => { const d={}; for(let i=1;i<=cycleLength;i++) d[i]=status; setDays(d); };

  const handleSave = () => {
    if(!name.trim()) return;
    onSave({ id:schedule?.id||Date.now().toString(), name:name.trim(), cycleLength, days, builtIn:false });
  };

  return (
    <div style={{ background:"#FFF",borderRadius:14,padding:compact?14:20,boxShadow:"0 2px 12px rgba(0,0,0,0.06)",border:"2px solid #2E3A23" }}>
      <h4 style={{ margin:"0 0 14px 0",fontFamily:"'DM Serif Display',serif",fontWeight:400,fontSize:compact?16:18 }}>
        {schedule?.id?"Edit Schedule":"New Schedule"}
      </h4>
      <div style={{ marginBottom:12 }}>
        <label style={labelStyle}>Schedule Name</label>
        <input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Monthly Cycle" style={inputStyle} autoFocus />
      </div>
      <div style={{ marginBottom:12 }}>
        <label style={labelStyle}>Cycle Length (days)</label>
        <div style={{ display:"flex",alignItems:"center",gap:8 }}>
          <button onClick={()=>updateLength(cycleLength-1)} style={stepBtn}>−</button>
          <input type="number" value={cycleLength} onChange={e=>updateLength(parseInt(e.target.value)||2)} style={{ ...inputStyle,width:70,textAlign:"center",MozAppearance:"textfield" }}/>
          <button onClick={()=>updateLength(cycleLength+1)} style={stepBtn}>+</button>
        </div>
      </div>
      <div style={{ marginBottom:12 }}>
        <label style={labelStyle}>Day Statuses <span style={{ fontWeight:400,textTransform:"none",opacity:0.7 }}>— tap to cycle</span></label>
        <div style={{ display:"flex",gap:4,marginBottom:8,flexWrap:"wrap" }}>
          <button onClick={()=>setAll("good")} style={{ ...quickBtn,color:"#2E7D32",background:"#E8F5E9" }}>All Green</button>
          <button onClick={()=>setAll("okay")} style={{ ...quickBtn,color:"#E65100",background:"#FFF8E1" }}>All Yellow</button>
          <button onClick={()=>setAll("bad")} style={{ ...quickBtn,color:"#C62828",background:"#FFEBEE" }}>All Red</button>
        </div>
        <ScheduleBar schedule={{ cycleLength, days }} interactive onDayClick={cycleDayStatus} compact={compact}/>
        <div style={{ display:"flex",gap:8,marginTop:6,fontSize:10,color:"#888" }}>
          <span>🟢 Good</span><span>🟡 Okay</span><span>🔴 Bad</span>
        </div>
      </div>
      <div style={{ display:"flex",gap:8 }}>
        <button onClick={handleSave} style={{ flex:1,padding:12,borderRadius:10,border:"none",background:"#2E3A23",color:"#FFF",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"inherit",minHeight:46,opacity:name.trim()?1:0.5 }}>Save Schedule</button>
        <button onClick={onCancel} style={{ padding:"12px 16px",borderRadius:10,border:"1px solid #C5BEAD",background:"transparent",fontWeight:600,fontSize:14,cursor:"pointer",fontFamily:"inherit",color:"#7A8B6A",minHeight:46 }}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Landing Page / Login ────────────────────────────────────
const DEMO_FRIENDS = [
  { name:"Alex",emoji:"🎸",status:"good",day:16 },
  { name:"Jordan",emoji:"🎨",status:"okay",day:8 },
  { name:"Sam",emoji:"📚",status:"good",day:18 },
  { name:"Riley",emoji:"🎮",status:"bad",day:3 },
  { name:"Casey",emoji:"🌟",status:"good",day:15 },
];

function DemoCycleRing({ friend, size=52, delay=0 }) {
  const [visible,setVisible]=useState(false);
  useEffect(()=>{const t=setTimeout(()=>setVisible(true),delay);return()=>clearTimeout(t);},[delay]);
  const cfg=STATUS_CONFIG[friend.status];
  const r=(size-6)/2; const circ=2*Math.PI*r; const progress=friend.day/28;
  return (
    <div style={{ position:"relative",width:size,height:size,flexShrink:0,opacity:visible?1:0,transform:visible?"scale(1)":"scale(0.5)",transition:"all 0.5s cubic-bezier(0.34,1.56,0.64,1)" }}>
      <svg width={size} height={size} style={{ transform:"rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={3}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={cfg.dot} strokeWidth={3} strokeDasharray={circ} strokeDashoffset={visible?circ*(1-progress):circ} strokeLinecap="round" style={{ transition:`stroke-dashoffset 1.2s ease-out ${delay}ms` }}/>
      </svg>
      <div style={{ position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center" }}>
        <span style={{ fontSize:size*0.35,lineHeight:1 }}>{friend.emoji}</span>
        <span style={{ fontSize:7,fontWeight:700,color:cfg.dot,marginTop:1 }}>D{friend.day}</span>
      </div>
    </div>
  );
}

function DemoCalendarRow({ delay }) {
  const [visible,setVisible]=useState(false);
  useEffect(()=>{const t=setTimeout(()=>setVisible(true),delay);return()=>clearTimeout(t);},[delay]);
  const days=[{d:14,good:1,okay:2},{d:15,good:3,okay:1},{d:16,good:4,okay:0},{d:17,good:2,okay:2},{d:18,good:3,okay:1},{d:19,good:2,okay:1},{d:20,good:1,okay:2}];
  return (
    <div style={{ display:"flex",gap:4,opacity:visible?1:0,transform:visible?"translateY(0)":"translateY(12px)",transition:"all 0.6s ease-out" }}>
      {days.map((day,i)=>{
        const bg=day.good>=3?"#E8F5E9":day.good>=1?"#F1F8E9":"#FFFDE7";
        return (<div key={i} style={{ width:38,height:38,borderRadius:8,background:bg,border:day.d===16?"2px solid #2E3A23":"1px solid rgba(255,255,255,0.08)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:2 }}>
          <span style={{ fontSize:11,fontWeight:day.d===16?800:600,color:"#2E3A23",lineHeight:1 }}>{day.d}</span>
          <div style={{ display:"flex",gap:1 }}>
            {Array.from({length:Math.min(day.good,3)}).map((_,j)=>(<div key={j} style={{ width:5,height:5,borderRadius:"50%",background:"#4CAF50" }}/>))}
            {Array.from({length:Math.min(day.okay,1)}).map((_,j)=>(<div key={`o-${j}`} style={{ width:5,height:5,borderRadius:"50%",background:"#FFC107" }}/>))}
          </div>
        </div>);
      })}
    </div>
  );
}

function LoginScreen() {
  const [loaded,setLoaded]=useState(false);
  const [error,setError]=useState(null);
  useEffect(()=>{ setLoaded(true); getRedirectResult(auth).catch(()=>{}); },[]);

  const handleLogin = async () => {
    setError(null);
    try { await signInWithPopup(auth, googleProvider); }
    catch(e){
      if(e.code==="auth/popup-blocked"||e.code==="auth/popup-closed-by-browser"){
        try{ await signInWithRedirect(auth,googleProvider); }catch(e2){ setError("Sign-in failed. Please try again."); }
      } else if(e.code!=="auth/cancelled-popup-request"){ setError("Sign-in failed. Please try again."); console.error(e); }
    }
  };

  return (
    <div style={{ fontFamily:"'DM Sans','Nunito',system-ui,sans-serif",background:"linear-gradient(155deg,#1B2416 0%,#2E3A23 35%,#4A5D3A 100%)",minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"40px 24px",position:"relative",overflow:"hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Serif+Display&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        @keyframes pulse-glow{0%,100%{box-shadow:0 0 0 0 rgba(76,175,80,0.3)}50%{box-shadow:0 0 20px 4px rgba(76,175,80,0.15)}}
      `}</style>
      <div style={{ position:"absolute",top:-100,right:-80,width:280,height:280,borderRadius:"50%",background:"rgba(76,175,80,0.05)" }}/>
      <div style={{ position:"absolute",bottom:-60,left:-50,width:200,height:200,borderRadius:"50%",background:"rgba(255,193,7,0.04)" }}/>

      <div style={{ opacity:loaded?1:0,transform:loaded?"translateY(0)":"translateY(12px)",transition:"all 0.6s ease-out",marginBottom:32,display:"flex",alignItems:"center",gap:10 }}>
        <span style={{ fontSize:28 }}>👥</span>
        <span style={{ fontFamily:"'DM Serif Display',serif",fontSize:20,color:"#FFF",fontWeight:400 }}>Friend Finder</span>
      </div>

      <div style={{ opacity:loaded?1:0,transform:loaded?"translateY(0)":"translateY(20px)",transition:"all 0.8s ease-out 100ms",textAlign:"center",marginBottom:10 }}>
        <h1 style={{ fontFamily:"'DM Serif Display',serif",fontSize:"clamp(28px,7vw,44px)",fontWeight:400,color:"#FFF",lineHeight:1.15,maxWidth:480,margin:"0 auto" }}>
          Follow Your Friends'{" "}<span style={{ color:"#81C784" }}>Daily Schedules</span>
        </h1>
      </div>

      <div style={{ opacity:loaded?1:0,transform:loaded?"translateY(0)":"translateY(14px)",transition:"all 0.7s ease-out 250ms",textAlign:"center",marginBottom:36 }}>
        <p style={{ fontSize:"clamp(13px,3vw,16px)",color:"rgba(255,255,255,0.5)",lineHeight:1.6,maxWidth:380,margin:"0 auto" }}>
          Track recurring cycles. See who's having a great day. Reach out at the right time.
        </p>
      </div>

      <div style={{ opacity:loaded?1:0,transform:loaded?"translateY(0)":"translateY(16px)",transition:"all 0.8s ease-out 350ms",textAlign:"center",marginBottom:12 }}>
        <button onClick={handleLogin} style={{ padding:"16px 36px",borderRadius:14,border:"none",background:"#FFF",color:"#2E3A23",fontSize:16,fontWeight:700,cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:12,boxShadow:"0 4px 24px rgba(0,0,0,0.2)" }}>
          <svg width="20" height="20" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          Sign in with Google
        </button>
        {error&&<p style={{ color:"#EF5350",fontSize:13,marginTop:12 }}>{error}</p>}
        <p style={{ fontSize:11,color:"rgba(255,255,255,0.3)",marginTop:12 }}>Free forever · Syncs across devices · Private</p>
      </div>

      <div style={{ marginTop:32,display:"flex",flexDirection:"column",alignItems:"center",gap:16 }}>
        <div style={{ display:"flex",gap:8,justifyContent:"center",flexWrap:"wrap" }}>
          {DEMO_FRIENDS.map((f,i)=>(<DemoCycleRing key={f.name} friend={f} size={52} delay={500+i*120}/>))}
        </div>
        <DemoCalendarRow delay={1100}/>
        <div style={{ display:"flex",gap:6,flexWrap:"wrap",justifyContent:"center",opacity:loaded?1:0,transition:"opacity 0.8s ease-out 1.5s" }}>
          {DEMO_FRIENDS.filter(f=>f.status==="good").map(f=>(
            <div key={f.name} style={{ display:"flex",alignItems:"center",gap:5,background:"rgba(76,175,80,0.12)",padding:"4px 10px 4px 4px",borderRadius:14,animation:"pulse-glow 3s ease-in-out infinite" }}>
              <div style={{ width:22,height:22,borderRadius:"50%",background:"rgba(255,255,255,0.1)",border:`2px solid ${STATUS_CONFIG[f.status].dot}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11 }}>{f.emoji}</div>
              <span style={{ fontSize:12,color:"#81C784",fontWeight:600 }}>{f.name}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop:48,fontSize:11,color:"rgba(255,255,255,0.2)",textAlign:"center" }}>Your data stays private · No ads · No tracking</div>
    </div>
  );
}

// ─── Main Tracker ────────────────────────────────────────────
function Tracker({ user }) {
  const w = useWidth();
  const compact = w < 420;
  const tiny = w < 340;

  const [year,setYear]=useState(today.getFullYear());
  const [month,setMonth]=useState(today.getMonth());
  const [friends,setFriends]=useState([]);
  const [schedules,setSchedules]=useState(DEFAULT_SCHEDULES);
  const [selectedDay,setSelectedDay]=useState(today.getDate());
  const [view,setView]=useState("calendar");
  const [editingFriend,setEditingFriend]=useState(null);
  const [changingSchedule,setChangingSchedule]=useState(null);
  const [showAdd,setShowAdd]=useState(false);
  const [newName,setNewName]=useState("");
  const [newEmoji,setNewEmoji]=useState("😊");
  const [newScheduleId,setNewScheduleId]=useState("28-day");
  const [newCycleStart,setNewCycleStart]=useState(todayStr);
  const [editingSchedule,setEditingSchedule]=useState(null);
  const [showHistory,setShowHistory]=useState(null);
  const [loaded,setLoaded]=useState(false);
  const [saving,setSaving]=useState(false);
  const [csScheduleId,setCsScheduleId]=useState("");
  const [csCycleStart,setCsCycleStart]=useState(todayStr);
  const [csNotes,setCsNotes]=useState("");
  const [newDescription,setNewDescription]=useState("");

  // Load from Firestore
  useEffect(()=>{
    (async()=>{
      const data = await loadData(user.uid);
      if(data?.friends?.length>0) setFriends(data.friends);
      else setFriends(DEFAULT_FRIENDS);
      if(data?.schedules?.length>0) setSchedules(data.schedules);
      setLoaded(true);
    })();
  },[user.uid]);

  // Save to Firestore (debounced)
  useEffect(()=>{
    if(!loaded) return;
    setSaving(true);
    const timer = setTimeout(async()=>{
      await saveData(user.uid, friends, schedules);
      setSaving(false);
    }, 600);
    return ()=>clearTimeout(timer);
  },[friends, schedules, loaded, user.uid]);

  const daysInMonth=getDaysInMonth(year,month);
  const firstDay=getFirstDayOfMonth(year,month);
  const monthName=new Date(year,month).toLocaleString("default",{month:"long"});

  const prevMonth=()=>{if(month===0){setMonth(11);setYear(year-1);}else setMonth(month-1);setSelectedDay(1);};
  const nextMonth=()=>{if(month===11){setMonth(0);setYear(year+1);}else setMonth(month+1);setSelectedDay(1);};
  const goToday=()=>{setYear(today.getFullYear());setMonth(today.getMonth());setSelectedDay(today.getDate());};
  const isToday=(d)=>d===today.getDate()&&month===today.getMonth()&&year===today.getFullYear();

  const makeDateObj=(day)=>new Date(year,month,day);
  const selectedDate=makeDateObj(selectedDay);

  const getFriendsGrouped=(day)=>{
    const date=makeDateObj(day);
    const groups={good:[],okay:[],bad:[]};
    friends.forEach(f=>{const{status}=getFriendStatusOnDate(f,date,schedules);groups[status].push(f);});
    return groups;
  };

  const selectedGroups=getFriendsGrouped(selectedDay);

  const getWeekStart=()=>{const d=new Date(year,month,selectedDay);return new Date(d.getTime()-d.getDay()*86400000);};
  const weekStart=getWeekStart();
  const weekDates=Array.from({length:7},(_,i)=>new Date(weekStart.getTime()+i*86400000));

  const bestDayThisWeek=useMemo(()=>{
    let best=null,bestCount=-1;
    weekDates.forEach(d=>{const count=friends.filter(f=>getFriendStatusOnDate(f,d,schedules).status==="good").length;if(count>bestCount){bestCount=count;best=d;}});
    return bestCount>0?best:null;
  },[weekDates,friends,schedules]);

  const addFriend=()=>{
    if(!newName.trim()) return;
    const id=Date.now().toString();
    const palette=friends.length%PALETTES.length;
    setFriends([...friends,{id,name:newName.trim(),emoji:newEmoji,palette,description:newDescription.trim(),scheduleHistory:[{scheduleId:newScheduleId,cycleStart:newCycleStart,changedAt:new Date().toISOString(),notes:""}]}]);
    setNewName("");setNewEmoji("😊");setNewScheduleId("28-day");setNewCycleStart(todayStr);setNewDescription("");setShowAdd(false);
  };

  const removeFriend=(id)=>{setFriends(friends.filter(f=>f.id!==id));setEditingFriend(null);setChangingSchedule(null);setShowHistory(null);};

  const updateDescription=(id,desc)=>{setFriends(friends.map(f=>f.id===id?{...f,description:desc}:f));};

  const applyScheduleChange=(friendId)=>{
    setFriends(friends.map(f=>f.id===friendId?addScheduleChange(f,csScheduleId,csCycleStart,csNotes):f));
    setChangingSchedule(null);setCsNotes("");
  };

  const saveSchedule=(sched)=>{
    const exists=schedules.find(s=>s.id===sched.id);
    if(exists) setSchedules(schedules.map(s=>s.id===sched.id?sched:s));
    else setSchedules([...schedules,sched]);
    setEditingSchedule(null);
  };

  const deleteSchedule=(id)=>{
    const inUse=friends.some(f=>f.scheduleHistory.some(h=>h.scheduleId===id));
    if(inUse){alert("Can't delete — schedule is in use. Change friends off it first.");return;}
    setSchedules(schedules.filter(s=>s.id!==id));
  };

  const handleSignOut=async()=>{ await signOut(auth); };

  const px=compact?12:20;
  const dayLabels=tiny?DAYS_SHORT:DAYS_LABEL;
  const ringSize=compact?44:56;
  const views=["calendar","week","friends","schedules"];
  const viewIcons={calendar:"📅",week:"📋",friends:"👥",schedules:"⚙️"};
  const viewLabels={calendar:"Month",week:"Week",friends:"Friends",schedules:"Schedules"};

  return (
    <div style={{ fontFamily:"'DM Sans','Nunito',system-ui,sans-serif",background:"linear-gradient(145deg,#FAF9F6 0%,#F0ECE3 100%)",minHeight:"100vh",color:"#2D2A26",padding:0,paddingBottom:40,WebkitTapHighlightColor:"transparent",overflowX:"hidden" }}>
      <style>{`
        *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
        input[type="date"],input[type="number"],input{font-size:16px!important}
        button{-webkit-tap-highlight-color:transparent}
        input::-webkit-outer-spin-button,input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
      `}</style>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Serif+Display&display=swap" rel="stylesheet"/>

      {/* Header */}
      <div style={{ padding:compact?"18px 16px 12px":"24px 24px 16px",background:"linear-gradient(135deg,#2E3A23 0%,#4A5D3A 100%)",color:"#FFF",borderRadius:"0 0 20px 20px",marginBottom:compact?12:18,boxShadow:"0 4px 20px rgba(46,58,35,0.2)" }}>
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4 }}>
          <h1 style={{ fontFamily:"'DM Serif Display',serif",fontSize:compact?21:26,fontWeight:400,margin:0 }}>Friend Finder</h1>
          <div style={{ display:"flex",alignItems:"center",gap:8 }}>
            <span style={{ fontSize:9,opacity:0.5 }}>{saving?"saving…":"synced ✓"}</span>
            <button onClick={handleSignOut} title="Sign out" style={{ width:28,height:28,borderRadius:"50%",border:"2px solid rgba(255,255,255,0.3)",background:user.photoURL?`url(${user.photoURL}) center/cover`:"#7A8B6A",cursor:"pointer",overflow:"hidden",padding:0,fontSize:11,color:"#FFF",display:"flex",alignItems:"center",justifyContent:"center" }}>
              {!user.photoURL&&(user.displayName?.[0]||"?")}
            </button>
          </div>
        </div>
        <p style={{ margin:0,fontSize:11,opacity:0.5 }}>{schedules.length} schedule{schedules.length!==1?"s":""} · {friends.length} friend{friends.length!==1?"s":""}</p>
      </div>

      {/* View toggle */}
      <div style={{ display:"flex",gap:compact?4:6,padding:`0 ${px}px`,marginBottom:compact?10:16 }}>
        {views.map(v=>(<button key={v} onClick={()=>setView(v)} style={{ flex:1,padding:compact?"8px 0":"10px 0",borderRadius:10,border:"none",background:view===v?"#2E3A23":"#FFF",color:view===v?"#FFF":"#4A5D3A",fontWeight:600,fontSize:compact?11:13,cursor:"pointer",fontFamily:"inherit",boxShadow:view===v?"0 2px 8px rgba(46,58,35,0.2)":"0 1px 3px rgba(0,0,0,0.05)",transition:"all 0.2s" }}>
          {compact?viewIcons[v]:`${viewIcons[v]} ${viewLabels[v]}`}
        </button>))}
      </div>

      {/* Month nav */}
      {(view==="calendar"||view==="week")&&(
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:`0 ${px}px`,marginBottom:10 }}>
          <button onClick={prevMonth} style={{ ...navBtn,width:compact?32:36,height:compact?32:36 }}>‹</button>
          <div style={{ textAlign:"center",display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",justifyContent:"center" }}>
            <span style={{ fontFamily:"'DM Serif Display',serif",fontSize:compact?18:22 }}>{monthName} {year}</span>
            <button onClick={goToday} style={{ fontSize:10,padding:"2px 8px",borderRadius:20,border:"1px solid #A5B897",background:"transparent",color:"#4A5D3A",cursor:"pointer",fontFamily:"inherit",fontWeight:600 }}>Today</button>
          </div>
          <button onClick={nextMonth} style={{ ...navBtn,width:compact?32:36,height:compact?32:36 }}>›</button>
        </div>
      )}

      <div style={{ padding:`0 ${compact?8:16}px` }}>

        {/* MONTH VIEW */}
        {view==="calendar"&&(<>
          <div style={{ display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:1,marginBottom:3 }}>
            {dayLabels.map((d,i)=>(<div key={i} style={{ textAlign:"center",fontSize:compact?10:11,fontWeight:700,color:"#7A8B6A",padding:"3px 0",textTransform:"uppercase" }}>{d}</div>))}
          </div>
          <div style={{ display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:compact?2:3 }}>
            {Array.from({length:firstDay}).map((_,i)=><div key={`e-${i}`}/>)}
            {Array.from({length:daysInMonth},(_,i)=>{
              const day=i+1; const groups=getFriendsGrouped(day); const selected=day===selectedDay; const td=isToday(day);
              const gc=groups.good.length,oc=groups.okay.length;
              let bg="#FFF";if(gc>=2)bg="#E8F5E9";else if(gc===1)bg="#F1F8E9";else if(oc>=2)bg="#FFFDE7";
              return (<button key={day} onClick={()=>setSelectedDay(day)} style={{ aspectRatio:"1",borderRadius:compact?8:12,border:selected?"2px solid #2E3A23":td?"2px solid #7A8B6A":"1px solid #E4DDD4",background:bg,cursor:"pointer",padding:compact?2:3,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-start",gap:1,transition:"all 0.15s",fontFamily:"inherit",boxShadow:selected?"0 2px 8px rgba(46,58,35,0.15)":"none",minHeight:0,overflow:"hidden" }}>
                <span style={{ fontSize:compact?11:12,fontWeight:td?800:600,color:td?"#2E3A23":"#4A5D3A",lineHeight:1 }}>{day}</span>
                <div style={{ display:"flex",flexWrap:"wrap",gap:1,justifyContent:"center" }}>
                  {groups.good.slice(0,compact?2:3).map(f=>(<div key={f.id} style={{ width:compact?5:7,height:compact?5:7,borderRadius:"50%",background:"#4CAF50" }}/>))}
                  {groups.okay.slice(0,compact?1:2).map(f=>(<div key={f.id} style={{ width:compact?5:7,height:compact?5:7,borderRadius:"50%",background:"#FFC107" }}/>))}
                  {groups.bad.length>0&&gc===0&&oc===0&&(<div style={{ width:compact?5:7,height:compact?5:7,borderRadius:"50%",background:"#EF5350" }}/>)}
                </div>
              </button>);
            })}
          </div>
          <div style={{ marginTop:14,background:"#FFF",borderRadius:14,padding:compact?14:20,boxShadow:"0 2px 12px rgba(0,0,0,0.05)" }}>
            <h3 style={{ fontFamily:"'DM Serif Display',serif",fontSize:compact?16:18,margin:"0 0 2px 0",fontWeight:400 }}>
              {selectedDate.toLocaleDateString("default",{weekday:compact?"short":"long",month:compact?"short":"long",day:"numeric"})}
              {isToday(selectedDay)&&<span style={{ fontSize:11,marginLeft:6,color:"#7A8B6A" }}>· Today</span>}
            </h3>
            <div style={{ display:"flex",gap:compact?6:10,margin:"10px 0",overflowX:"auto",WebkitOverflowScrolling:"touch",paddingBottom:4,scrollbarWidth:"none" }}>
              {friends.map(f=><CycleRing key={f.id} friend={f} targetDate={selectedDate} size={ringSize} schedules={schedules}/>)}
            </div>
            {friends.length===0?<p style={{ color:"#7A8B6A",fontSize:14 }}>Add friends to get started!</p>:
              ["good","okay","bad"].map(status=>{
                const list=selectedGroups[status];if(list.length===0)return null;const cfg=STATUS_CONFIG[status];
                return (<div key={status} style={{ marginTop:8 }}>
                  <div style={{ fontSize:10,fontWeight:700,color:cfg.color,textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:5 }}>{cfg.tag} {cfg.label}</div>
                  <div style={{ display:"flex",flexWrap:"wrap",gap:6 }}>
                    {list.map(f=>{const info=getFriendStatusOnDate(f,selectedDate,schedules);
                      return (<div key={f.id} style={{ display:"flex",alignItems:"center",gap:5,background:cfg.bg,padding:compact?"4px 8px 4px 4px":"6px 12px 6px 6px",borderRadius:16,fontSize:compact?12:13,fontWeight:600,color:cfg.color }}>
                        <FriendBadge friend={f} size="sm" status={status}/>{f.name}<span style={{ fontSize:9,opacity:0.65,fontWeight:400 }}>D{info.cycleDay}</span>{info.schedule&&<span style={{ fontSize:8,opacity:0.5 }}>{info.schedule.name}</span>}
                      </div>);
                    })}
                  </div>
                </div>);
              })
            }
          </div>
        </>)}

        {/* WEEK VIEW */}
        {view==="week"&&(
          <div style={{ background:"#FFF",borderRadius:14,padding:compact?10:16,boxShadow:"0 2px 12px rgba(0,0,0,0.05)" }}>
            <div style={{ fontSize:11,color:"#7A8B6A",fontWeight:600,marginBottom:10,display:"flex",alignItems:"center",flexWrap:"wrap",gap:6 }}>
              <span>Week of {weekStart.toLocaleDateString("default",{month:"short",day:"numeric"})}</span>
              {bestDayThisWeek&&(<span style={{ background:"#E8F5E9",color:"#2E7D32",padding:"2px 7px",borderRadius:8,fontSize:10 }}>⭐ Best: {bestDayThisWeek.toLocaleDateString("default",{weekday:compact?"short":"long"})}</span>)}
            </div>
            {weekDates.map((date,idx)=>{
              const groups={good:[],okay:[],bad:[]};
              friends.forEach(f=>{const{status}=getFriendStatusOnDate(f,date,schedules);groups[status].push(f);});
              const isTodayRow=date.toDateString()===today.toDateString();const gc=groups.good.length;
              return (<div key={idx} style={{ padding:compact?"8px 4px":"10px 8px",borderRadius:8,background:isTodayRow?"#F9FBF4":"transparent",borderBottom:"1px solid #F2EDE6" }}>
                <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6 }}>
                  <div style={{ display:"flex",alignItems:"baseline",gap:6 }}>
                    <span style={{ fontSize:10,fontWeight:700,color:isTodayRow?"#2E3A23":"#7A8B6A",textTransform:"uppercase",minWidth:28 }}>{DAYS_LABEL[date.getDay()]}</span>
                    <span style={{ fontSize:15,fontWeight:700,color:"#2E3A23" }}>{date.getDate()}</span>
                    {isTodayRow&&<span style={{ fontSize:9,color:"#7A8B6A",fontWeight:600 }}>TODAY</span>}
                  </div>
                  <span style={{ fontSize:10,fontWeight:700,whiteSpace:"nowrap",color:gc>=2?"#4CAF50":gc===1?"#E65100":"#EF5350",background:gc>=2?"#E8F5E9":gc===1||groups.okay.length>0?"#FFF8E1":"#FFEBEE",padding:"2px 8px",borderRadius:6 }}>
                    {gc>=2?"🟢 Great":gc===1?"🟡 OK":groups.okay.length>0?"🟡 Maybe":"🔴 Tough"}
                  </span>
                </div>
                <div style={{ display:"flex",flexWrap:"wrap",gap:4 }}>
                  {["good","okay","bad"].map(s=>groups[s].map(f=>(<div key={f.id} style={{ display:"flex",alignItems:"center",gap:3,background:STATUS_CONFIG[s].bg,padding:"2px 8px 2px 2px",borderRadius:12,opacity:s==="bad"?0.5:1 }}>
                    <FriendBadge friend={f} size="xs" status={s}/><span style={{ fontSize:11,color:STATUS_CONFIG[s].color,fontWeight:s==="good"?600:500 }}>{f.name}</span>
                  </div>)))}
                </div>
              </div>);
            })}
          </div>
        )}

        {/* FRIENDS VIEW */}
        {view==="friends"&&(
          <div>
            {friends.map(f=>{
              const p=PALETTES[f.palette%PALETTES.length];const isEditing=editingFriend===f.id;const isChanging=changingSchedule===f.id;const isHistoryOpen=showHistory===f.id;
              const info=getFriendStatusOnDate(f,today,schedules);const cfgToday=STATUS_CONFIG[info.status];const activeSchedule=info.schedule;
              let nextGoodIn=null;
              if(info.status!=="good"){for(let i=1;i<=60;i++){const fd=new Date(today.getTime()+i*86400000);const{status}=getFriendStatusOnDate(f,fd,schedules);if(status==="good"){nextGoodIn=i;break;}}}

              return (<div key={f.id} style={{ background:"#FFF",borderRadius:14,padding:compact?12:16,marginBottom:10,boxShadow:"0 1px 6px rgba(0,0,0,0.04)",border:isEditing?`2px solid ${p.accent}`:"1px solid #EDE7E0" }}>
                <div style={{ display:"flex",alignItems:"flex-start",gap:compact?8:10 }}>
                  <CycleRing friend={f} targetDate={today} size={compact?40:48} schedules={schedules}/>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ display:"flex",alignItems:"center",gap:5,flexWrap:"wrap" }}>
                      <span style={{ fontWeight:700,fontSize:compact?15:16 }}>{f.name}</span>
                      <span style={{ fontSize:10,fontWeight:500,color:cfgToday.color,background:cfgToday.bg,padding:"1px 6px",borderRadius:6,whiteSpace:"nowrap" }}>D{info.cycleDay} · {cfgToday.label}</span>
                    </div>
                    <div style={{ fontSize:11,color:"#7A8B6A",marginTop:2,lineHeight:1.4 }}>
                      {activeSchedule?activeSchedule.name:"Unknown"} · {f.scheduleHistory.length} change{f.scheduleHistory.length!==1?"s":""}
                      {nextGoodIn&&<span style={{ color:"#4CAF50",fontWeight:600 }}> · Best in {nextGoodIn}d</span>}
                    </div>
                    {f.description&&<div style={{ fontSize:12,color:"#5D5347",marginTop:3,lineHeight:1.4 }}>{f.description}</div>}
                  </div>
                  <div style={{ display:"flex",gap:4,flexShrink:0 }}>
                    <button onClick={()=>{setEditingFriend(isEditing?null:f.id);setChangingSchedule(null);setShowHistory(null);}} style={{ padding:compact?"5px 8px":"6px 12px",borderRadius:8,border:"1px solid #D7D0C7",background:isEditing?p.bg:"transparent",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",color:p.fg,minHeight:32 }}>{isEditing?"Done":"Edit"}</button>
                    <button onClick={()=>removeFriend(f.id)} style={{ padding:compact?"5px 7px":"6px 10px",borderRadius:8,border:"1px solid #FFCDD2",background:"transparent",fontSize:11,cursor:"pointer",fontFamily:"inherit",color:"#EF5350",minHeight:32 }}>✗</button>
                  </div>
                </div>
                {activeSchedule&&<div style={{ marginTop:10 }}><ScheduleBar schedule={activeSchedule} currentDay={info.cycleDay} compact={compact}/></div>}
                {isEditing&&(
                  <div style={{ marginTop:12,padding:compact?10:12,background:"#FAFAF7",borderRadius:8 }}>
                    <div style={{ marginBottom:10 }}>
                      <label style={labelStyle}>Description <span style={{ fontWeight:400,textTransform:"none",opacity:0.7 }}>— optional</span></label>
                      <textarea value={f.description||""} onChange={e=>updateDescription(f.id,e.target.value)} placeholder="Notes about this friend, context, etc." rows={2} style={{ ...inputStyle,resize:"vertical",minHeight:44 }}/>
                    </div>
                    <div style={{ display:"flex",gap:6,flexWrap:"wrap",marginBottom:10 }}>
                      <button onClick={()=>{setChangingSchedule(isChanging?null:f.id);setCsScheduleId(info.entry?.scheduleId||schedules[0]?.id);setCsCycleStart(todayStr);setCsNotes("");setShowHistory(null);}} style={{ ...actionBtn,background:isChanging?"#2E3A23":"#FFF",color:isChanging?"#FFF":"#2E3A23" }}>{isChanging?"Cancel":"Change Schedule"}</button>
                      <button onClick={()=>{setShowHistory(isHistoryOpen?null:f.id);setChangingSchedule(null);}} style={{ ...actionBtn,background:isHistoryOpen?"#2E3A23":"#FFF",color:isHistoryOpen?"#FFF":"#2E3A23" }}>{isHistoryOpen?"Hide":"History"} ({f.scheduleHistory.length})</button>
                    </div>
                    {isChanging&&(
                      <div style={{ padding:10,background:"#FFF",borderRadius:8,border:"1px solid #E4DDD4",marginBottom:8 }}>
                        <label style={labelStyle}>Schedule</label>
                        <div style={{ display:"flex",flexWrap:"wrap",gap:4,marginBottom:10 }}>
                          {schedules.map(s=>(<button key={s.id} onClick={()=>setCsScheduleId(s.id)} style={{ padding:"6px 12px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",border:csScheduleId===s.id?"2px solid #2E3A23":"1px solid #D7D0C7",background:csScheduleId===s.id?"#F0ECE3":"#FFF",color:"#2E3A23" }}>{s.name} ({s.cycleLength}d)</button>))}
                        </div>
                        <label style={labelStyle}>Start Date (Day 1 of new cycle)</label>
                        <input type="date" value={csCycleStart} onChange={e=>setCsCycleStart(e.target.value)} style={{ ...inputStyle,maxWidth:200,marginBottom:10 }}/>
                        <label style={labelStyle}>Notes <span style={{ fontWeight:400,textTransform:"none",opacity:0.7 }}>— optional</span></label>
                        <textarea value={csNotes} onChange={e=>setCsNotes(e.target.value)} placeholder="Reason for change, reminders, etc." rows={2} style={{ ...inputStyle,resize:"vertical",minHeight:44,marginBottom:10 }}/>
                        <button onClick={()=>applyScheduleChange(f.id)} style={{ padding:"10px 20px",borderRadius:8,border:"none",background:"#2E3A23",color:"#FFF",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit" }}>Apply Change</button>
                      </div>
                    )}
                    {isHistoryOpen&&(
                      <div style={{ padding:10,background:"#FFF",borderRadius:8,border:"1px solid #E4DDD4" }}>
                        <label style={labelStyle}>Schedule History</label>
                        {[...f.scheduleHistory].sort((a,b)=>b.cycleStart.localeCompare(a.cycleStart)).map((entry,idx)=>{
                          const sched=schedules.find(s=>s.id===entry.scheduleId);const isActive=entry===getActiveEntry(f,today);
                          return (<div key={idx} style={{ display:"flex",alignItems:"flex-start",gap:8,padding:"8px 0",borderBottom:idx<f.scheduleHistory.length-1?"1px solid #F2EDE6":"none" }}>
                            <div style={{ width:8,height:8,borderRadius:"50%",background:isActive?"#4CAF50":"#D7D0C7",flexShrink:0,marginTop:5 }}/>
                            <div style={{ flex:1,minWidth:0 }}>
                              <div style={{ fontSize:13,fontWeight:600,color:"#2E3A23" }}>{sched?.name||"Deleted schedule"}</div>
                              <div style={{ fontSize:11,color:"#7A8B6A" }}>From {parseDate(entry.cycleStart).toLocaleDateString("default",{month:"short",day:"numeric",year:"numeric"})}<span style={{ opacity:0.6 }}> · changed {new Date(entry.changedAt).toLocaleDateString("default",{month:"short",day:"numeric"})}</span></div>
                              {entry.notes&&<div style={{ fontSize:12,color:"#5D5347",marginTop:3,padding:"4px 8px",background:"#FAFAF7",borderRadius:6,fontStyle:"italic",lineHeight:1.4 }}>{entry.notes}</div>}
                            </div>
                            {isActive&&<span style={{ fontSize:9,fontWeight:700,color:"#4CAF50",background:"#E8F5E9",padding:"2px 6px",borderRadius:4,flexShrink:0 }}>ACTIVE</span>}
                          </div>);
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>);
            })}

            {!showAdd?(<button onClick={()=>setShowAdd(true)} style={{ width:"100%",padding:compact?14:16,borderRadius:14,border:"2px dashed #C5BEAD",background:"transparent",fontSize:14,fontWeight:600,cursor:"pointer",color:"#7A8B6A",fontFamily:"inherit",marginTop:4,minHeight:48 }}>+ Add Friend</button>
            ):(
              <div style={{ background:"#FFF",borderRadius:14,padding:compact?14:20,marginTop:4,boxShadow:"0 2px 12px rgba(0,0,0,0.06)",border:"2px solid #2E3A23" }}>
                <h4 style={{ margin:"0 0 12px 0",fontFamily:"'DM Serif Display',serif",fontWeight:400,fontSize:compact?16:18 }}>New Friend</h4>
                <div style={{ marginBottom:12 }}><label style={labelStyle}>Name</label><input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Friend's name" style={inputStyle} autoFocus/></div>
                <div style={{ marginBottom:12 }}><label style={labelStyle}>Emoji</label><div style={{ display:"flex",flexWrap:"wrap",gap:5 }}>{EMOJIS.map(e=>(<button key={e} onClick={()=>setNewEmoji(e)} style={{ width:compact?34:36,height:compact?34:36,borderRadius:8,border:newEmoji===e?"2px solid #2E3A23":"1px solid #DDD",background:newEmoji===e?"#F0ECE3":"#FFF",fontSize:compact?16:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}>{e}</button>))}</div></div>
                <div style={{ marginBottom:12 }}><label style={labelStyle}>Description <span style={{ fontWeight:400,textTransform:"none",opacity:0.7 }}>— optional</span></label><textarea value={newDescription} onChange={e=>setNewDescription(e.target.value)} placeholder="Notes about this friend, context, etc." rows={2} style={{ ...inputStyle,resize:"vertical",minHeight:44 }}/></div>
                <div style={{ marginBottom:12 }}><label style={labelStyle}>Schedule</label><div style={{ display:"flex",flexWrap:"wrap",gap:4 }}>{schedules.map(s=>(<button key={s.id} onClick={()=>setNewScheduleId(s.id)} style={{ padding:"6px 12px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",border:newScheduleId===s.id?"2px solid #2E3A23":"1px solid #D7D0C7",background:newScheduleId===s.id?"#F0ECE3":"#FFF",color:"#2E3A23" }}>{s.name} ({s.cycleLength}d)</button>))}</div></div>
                <div style={{ marginBottom:14 }}><label style={labelStyle}>Cycle Start Date (Day 1)</label><input type="date" value={newCycleStart} onChange={e=>setNewCycleStart(e.target.value)} style={{ ...inputStyle,maxWidth:220 }}/></div>
                <div style={{ display:"flex",gap:8 }}>
                  <button onClick={addFriend} style={{ flex:1,padding:12,borderRadius:10,border:"none",background:"#2E3A23",color:"#FFF",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"inherit",minHeight:46 }}>Add Friend</button>
                  <button onClick={()=>setShowAdd(false)} style={{ padding:"12px 16px",borderRadius:10,border:"1px solid #C5BEAD",background:"transparent",fontWeight:600,fontSize:14,cursor:"pointer",fontFamily:"inherit",color:"#7A8B6A",minHeight:46 }}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* SCHEDULES VIEW */}
        {view==="schedules"&&(
          <div>
            {editingSchedule?(<ScheduleEditor schedule={editingSchedule==="new"?null:editingSchedule} onSave={saveSchedule} onCancel={()=>setEditingSchedule(null)} compact={compact}/>
            ):(<>
              {schedules.map(s=>{
                const usedBy=friends.filter(f=>f.scheduleHistory.some(h=>h.scheduleId===s.id));
                const goodDays=Object.values(s.days).filter(d=>d==="good").length;
                const badDays=Object.values(s.days).filter(d=>d==="bad").length;
                return (<div key={s.id} style={{ background:"#FFF",borderRadius:14,padding:compact?12:16,marginBottom:10,boxShadow:"0 1px 6px rgba(0,0,0,0.04)",border:"1px solid #EDE7E0" }}>
                  <div style={{ display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:8 }}>
                    <div>
                      <div style={{ fontWeight:700,fontSize:compact?15:16,display:"flex",alignItems:"center",gap:6 }}>{s.name}{s.builtIn&&<span style={{ fontSize:9,fontWeight:600,color:"#7A8B6A",background:"#F0ECE3",padding:"1px 5px",borderRadius:4 }}>BUILT-IN</span>}</div>
                      <div style={{ fontSize:11,color:"#7A8B6A",marginTop:2 }}>{s.cycleLength} days · {goodDays} good · {badDays} bad · {usedBy.length} friend{usedBy.length!==1?"s":""}</div>
                    </div>
                    <div style={{ display:"flex",gap:4 }}>
                      <button onClick={()=>setEditingSchedule({...s})} style={{ padding:"5px 10px",borderRadius:8,border:"1px solid #D7D0C7",background:"transparent",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",color:"#4A5D3A",minHeight:32 }}>Edit</button>
                      {!s.builtIn&&<button onClick={()=>deleteSchedule(s.id)} style={{ padding:"5px 8px",borderRadius:8,border:"1px solid #FFCDD2",background:"transparent",fontSize:11,cursor:"pointer",fontFamily:"inherit",color:"#EF5350",minHeight:32 }}>✗</button>}
                    </div>
                  </div>
                  <ScheduleBar schedule={s} compact={compact}/>
                  {usedBy.length>0&&(<div style={{ display:"flex",gap:4,marginTop:8,flexWrap:"wrap" }}>{usedBy.map(f=>(<div key={f.id} style={{ display:"flex",alignItems:"center",gap:3,fontSize:11,color:"#7A8B6A" }}><FriendBadge friend={f} size="xs"/>{f.name}</div>))}</div>)}
                </div>);
              })}
              <button onClick={()=>setEditingSchedule("new")} style={{ width:"100%",padding:compact?14:16,borderRadius:14,border:"2px dashed #C5BEAD",background:"transparent",fontSize:14,fontWeight:600,cursor:"pointer",color:"#7A8B6A",fontFamily:"inherit",marginTop:4,minHeight:48 }}>+ New Schedule</button>
            </>)}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── App Root ────────────────────────────────────────────────
export default function App() {
  const [user,setUser]=useState(null);
  const [authLoading,setAuthLoading]=useState(true);

  useEffect(()=>{
    const unsub=onAuthStateChanged(auth,u=>{setUser(u);setAuthLoading(false);});
    return unsub;
  },[]);

  if(authLoading) return (
    <div style={{ fontFamily:"'DM Sans',system-ui,sans-serif",minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"linear-gradient(145deg,#FAF9F6,#F0ECE3)",color:"#7A8B6A" }}>
      <div style={{ textAlign:"center" }}><div style={{ fontSize:36,marginBottom:8 }}>👥</div><p style={{ fontSize:14 }}>Loading…</p></div>
    </div>
  );

  if(!user) return <LoginScreen/>;
  return <Tracker user={user}/>;
}

// ─── Shared Styles ───────────────────────────────────────────
const navBtn={width:36,height:36,borderRadius:"50%",border:"1px solid #C5BEAD",background:"#FFF",fontSize:20,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:"#4A5D3A",fontFamily:"inherit"};
const labelStyle={display:"block",fontSize:11,fontWeight:700,color:"#4A5D3A",marginBottom:5,textTransform:"uppercase",letterSpacing:"0.5px"};
const inputStyle={width:"100%",padding:"10px 12px",borderRadius:8,border:"1px solid #C5BEAD",fontSize:16,fontFamily:"inherit",outline:"none",boxSizing:"border-box"};
const stepBtn={width:36,height:36,borderRadius:8,border:"1px solid #C5BEAD",background:"#FFF",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:"#2E3A23",fontFamily:"inherit"};
const quickBtn={padding:"5px 12px",borderRadius:8,border:"none",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"};
const actionBtn={padding:"7px 14px",borderRadius:8,border:"1px solid #2E3A23",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"};
