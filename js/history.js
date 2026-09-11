/* ---------- Admin truck-history screen (Round 26) ----------
   A simple append-only audit trail -- who did what to which truck, and
   when (created / arrived / completed / cancelled / reopened / ETA changed
   / remark updated / deleted). Each of those is logged by js/actions.js
   (sbLogTruckEvent(), js/api.js) right next to the action itself; this file
   is just the read side -- pick a date range, fetch, show -- same shape as
   js/reporting.js's KPI report, deliberately kept as its own separate
   screen/file since it answers a different question ("what happened") than
   that one ("how did we do"). Gated Admin-only in render.js/events.js
   (isAdmin() -- covers both Admin MON and Admin MON IT; Nestlé and the MHE
   Driver never see the entry point at all), same as the Reports icon. */
import { ui } from "./state.js";
import { tr } from "./i18n.js";
import { render } from "./render.js";
import { sbFetchTruckEvents } from "./api.js";

export function openHistory(){
  ui.historyOpen = true;
  ui.openId = null; ui.addOpen = false;
  ui.historyError = null; ui.historyRows = null;
  render();
}

function isMissingTableError(err){
  var msg = String((err && err.message) || "");
  return /truck_events/i.test(msg) && /(relation|schema cache|does not exist|not found)/i.test(msg);
}

export function runHistory(){
  var fromEl = document.getElementById("history-from");
  var toEl = document.getElementById("history-to");
  var from = (fromEl && fromEl.value) || ui.historyFrom;
  var to = (toEl && toEl.value) || ui.historyTo;
  if(from > to){ ui.historyError = tr("reportFromAfterTo"); render(); return; }
  ui.historyFrom = from; ui.historyTo = to;
  ui.historyBusy = true; ui.historyError = null; render();
  sbFetchTruckEvents(from, to).then(function(rows){
    ui.historyRows = rows;
    ui.historyBusy = false;
    render();
  }).catch(function(err){
    ui.historyBusy = false;
    // The "truck_events" table update (supabase-schema.sql) hasn't been run
    // on this Supabase project yet -- same graceful-degradation pattern as
    // the "raw"/"lots"/"damage_remark" columns elsewhere: tell the user
    // plainly rather than showing a generic/confusing error for what is
    // really just a missing migration step.
    ui.historyError = isMissingTableError(err) ? tr("historyTableMissing") : ((err && err.message) || tr("reportLoadFailed"));
    render();
  });
}
