/* ---------- date / format helpers (pure — no imports) ----------
   Deliberately dependency-free so every other module can use these without
   risking an import cycle. Nothing here reads `state`, `ui`, or `tr()`. */

export function pad2(n){ return (n<10?"0":"")+n; }

export function dateKey(d){ return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()); }

export function addDays(key, n){
  var p = key.split("-").map(Number);
  var d = new Date(p[0], p[1]-1, p[2]);
  d.setDate(d.getDate()+n);
  return dateKey(d);
}

export function todayKey(){ return dateKey(new Date()); }

export function shortDate(key){
  var p = key.split("-").map(Number);
  return pad2(p[2])+"/"+pad2(p[1]);
}

export function clockStr(d){ return pad2(d.getHours())+":"+pad2(d.getMinutes())+":"+pad2(d.getSeconds()); }

export function dateTimeOf(dateKeyStr, hm){
  var dp = dateKeyStr.split("-").map(Number);
  var tp = hm.split(":").map(Number);
  return new Date(dp[0], dp[1]-1, dp[2], tp[0], tp[1], 0);
}

export function fmtElapsed(ms){
  var s = Math.max(0, Math.floor(ms/1000));
  var h = Math.floor(s/3600); s -= h*3600;
  var m = Math.floor(s/60); s -= m*60;
  if(h>0) return h+":"+pad2(m)+":"+pad2(s);
  return pad2(m)+":"+pad2(s);
}

export function esc(str){
  return String(str==null?"":str).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c];
  });
}
