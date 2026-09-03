/* ---------- derived truck status ----------
   A truck's displayed status is computed from its stored status + the
   current time (rather than stored directly), so "late" appears/disappears
   automatically as the clock ticks without any extra bookkeeping. */
import { GRACE_MIN } from "./config.js";
import { todayKey, dateTimeOf } from "./dateUtils.js";

export function derive(t, now){
  if(t.status === "done") return "done";
  if(t.status === "unloading") return "unloading";
  if(!t.eta){
    return (t.date <= todayKey()) ? "urgent" : "pending";
  }
  if(t.date === todayKey()){
    var eta = dateTimeOf(t.date, t.eta);
    if(now.getTime() > eta.getTime() + GRACE_MIN*60000) return "late";
  }
  return "scheduled";
}

export function lateMinutes(t, now){
  var eta = dateTimeOf(t.date, t.eta);
  return Math.floor((now.getTime()-eta.getTime())/60000);
}

export var STATUS_KEYS = {
  pending:"status_pending", urgent:"status_urgent", scheduled:"status_scheduled",
  late:"status_late", unloading:"status_unloading", done:"status_done"
};
