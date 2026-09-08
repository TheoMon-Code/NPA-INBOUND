/* ---------- derived truck status ----------
   A truck's displayed status is computed from its stored status + the
   current time (rather than stored directly), so "late" appears/disappears
   automatically as the clock ticks without any extra bookkeeping. */
import { GRACE_MIN, DUE_SOON_MIN } from "./config.js";
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

/* A truck that's still "scheduled" (has an ETA today, not started, not yet
   late) but whose ETA is coming up within DUE_SOON_MIN minutes -- a proactive
   heads-up distinct from "late", which only fires once the grace period is
   already blown. Deliberately additive: it's read alongside derive()'s
   result (see render.js), never instead of it, so nothing that keys off the
   derived status string (KPI counts, sort order, the sheet body) needs to
   know this exists. */
export function isDueSoon(t, now){
  if(!t.eta || t.date !== todayKey()) return false;
  if(derive(t, now) !== "scheduled") return false;
  var eta = dateTimeOf(t.date, t.eta);
  var diffMin = (eta.getTime() - now.getTime()) / 60000;
  return diffMin >= 0 && diffMin <= DUE_SOON_MIN;
}

export function lateMinutes(t, now){
  var eta = dateTimeOf(t.date, t.eta);
  return Math.floor((now.getTime()-eta.getTime())/60000);
}

export var STATUS_KEYS = {
  pending:"status_pending", urgent:"status_urgent", scheduled:"status_scheduled",
  late:"status_late", unloading:"status_unloading", done:"status_done"
};
