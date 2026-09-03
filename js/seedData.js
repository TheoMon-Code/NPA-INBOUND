/* ---------- optional demo data ----------
   Not called automatically (see main.js) — the app starts empty by default
   so nobody sees placeholder trucks by mistake. Kept here in case you want
   a quick visual demo before Supabase is connected: just call
   `seedIfEmpty()` from main.js's init block to turn it back on. */
import { pad2, addDays, todayKey, dateTimeOf } from "./dateUtils.js";
import { state } from "./state.js";

export function seedIfEmpty(){
  if(state.trucks && state.trucks.length) return;
  var y = addDays(todayKey(),-1), tk = todayKey(), tm = addDays(todayKey(),1);
  function iso(dateKeyStr, hm){ return dateTimeOf(dateKeyStr, hm).toISOString(); }
  state.seq = 10;
  state.trucks = [
    {id:"T-0001", carrier:"Aurora Freight Line", plant:"Plant 1", imExTr:"IM", poNo:"PO-10021", skuNo:"SKU-2210", qtt:"480 pcs", contNo:"CONU 445210", sealNo:"S-88213", contType:"40HC", closingDate:"", remark:"", details:"Aluminum brackets", date:y, eta:"09:00", status:"done", startedAt: iso(y,"09:05"), finishedAt: iso(y,"09:47")},
    {id:"T-0002", carrier:"Meridian Cargo Co.", plant:"Plant 2", imExTr:"EX", poNo:"PO-10034", skuNo:"SKU-2244", qtt:"1200 pcs", contNo:"MSCU 118820", sealNo:"S-88220", contType:"20GP", closingDate:"", remark:"", details:"Packaging film", date:y, eta:"13:30", status:"done", startedAt: iso(y,"13:40"), finishedAt: iso(y,"14:41")},
    {id:"T-0003", carrier:"Pacific Rim Movers", plant:"Plant 1", imExTr:"IM", poNo:"PO-10048", skuNo:"SKU-2267", qtt:"600 pcs", contNo:"TCLU 990112", sealNo:"S-88231", contType:"40HC", closingDate:"", remark:"", details:"Steel fasteners", date:tk, eta:"08:30", status:"done", startedAt: iso(tk,"08:35"), finishedAt: iso(tk,"09:20")},
    {id:"T-0004", carrier:"Solstice Transport", plant:"Plant 3", imExTr:"TR", poNo:"PO-10052", skuNo:"SKU-2298", qtt:"350 pcs", contNo:"", sealNo:"", contType:"", closingDate:"", remark:"", details:"Motor housings", date:tk, eta: (function(){ var d=new Date(); d.setMinutes(d.getMinutes()-38); return pad2(d.getHours())+":"+pad2(d.getMinutes()); })(), status:"unloading", startedAt: (function(){ var d=new Date(); d.setMinutes(d.getMinutes()-22); return d.toISOString(); })(), finishedAt:null},
    {id:"T-0005", carrier:"Northgate Haulage", plant:"Plant 2", imExTr:"IM", poNo:"PO-10061", skuNo:"SKU-2301", qtt:"720 pcs", contNo:"", sealNo:"", contType:"", closingDate:"", remark:"", details:"Rubber gaskets", date:tk, eta:(function(){ var d=new Date(); d.setHours(d.getHours()-1); return pad2(d.getHours())+":"+pad2(d.getMinutes()); })(), status:"scheduled", startedAt:null, finishedAt:null},
    {id:"T-0006", carrier:"Cascade Line Logistics", plant:"Plant 1", imExTr:"EX", poNo:"PO-10075", skuNo:"SKU-2318", qtt:"900 pcs", contNo:"", sealNo:"", contType:"", closingDate:"", remark:"", details:"Wiring harnesses", date:tk, eta:(function(){ var d=new Date(); d.setHours(d.getHours()+2); return pad2(d.getHours())+":"+pad2(d.getMinutes()); })(), status:"scheduled", startedAt:null, finishedAt:null},
    {id:"T-0007", carrier:"Aurora Freight Line", plant:"Plant 3", imExTr:"IM", poNo:null, skuNo:"", qtt:"", contNo:"", sealNo:"", contType:"", closingDate:"", remark:"", details:"", date:tk, eta:null, status:"scheduled", startedAt:null, finishedAt:null},
    {id:"T-0008", carrier:"Meridian Cargo Co.", plant:"Plant 2", imExTr:"TR", poNo:"PO-10082", skuNo:"SKU-2340", qtt:"540 pcs", contNo:"", sealNo:"", contType:"", closingDate:"", remark:"", details:"Circuit boards", date:tm, eta:"08:00", status:"scheduled", startedAt:null, finishedAt:null},
    {id:"T-0009", carrier:"Pacific Rim Movers", plant:"Plant 1", imExTr:"IM", poNo:null, skuNo:"", qtt:"", contNo:"", sealNo:"", contType:"", closingDate:"", remark:"", details:"", date:tm, eta:null, status:"scheduled", startedAt:null, finishedAt:null},
    {id:"T-0010", carrier:"Solstice Transport", plant:"Plant 3", imExTr:"EX", poNo:"PO-10099", skuNo:"SKU-2367", qtt:"460 pcs", contNo:"", sealNo:"", contType:"", closingDate:"", remark:"", details:"Filter cartridges", date:tm, eta:null, status:"scheduled", startedAt:null, finishedAt:null}
  ];
}
