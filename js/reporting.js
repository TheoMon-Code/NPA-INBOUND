/* ---------- Admin reporting screen ----------
   Everyday use of the app is "what's happening today/this week" (the day
   tabs + KPI strip at the top, see render.js) -- this screen is the other
   direction: "how did we do over a stretch of time", for someone like a
   plant manager rather than whoever's watching the dock right now. Kept
   deliberately simple (a handful of numbers, no chart library) rather than
   trying to be a full analytics product on day one.

   Queries Supabase directly for the picked date range (sbFetchTrucksForReport,
   see api.js) instead of reading off state.trucks, which the server-side
   day-window added alongside this only ever keeps scoped to
   +/-MAX_DAY_OFFSET days -- a report over the last 30 or 90 days needs its
   own wider query, same reasoning as the import dedupe-check. */
import { ui } from "./state.js";
import { tr } from "./i18n.js";
import { render } from "./render.js";
import { sbFetchTrucksForReport } from "./api.js";
import { GRACE_MIN } from "./config.js";
import { showToast } from "./actions.js";

export function openReport(){
  ui.reportOpen = true;
  ui.openId = null; ui.addOpen = false;
  ui.reportError = null; ui.reportData = null; ui.reportRows = null;
  render();
}

/* A truck only counts toward "on time" / "late" once it actually has an
   arrival timestamp -- a truck still "pending" at the end of the picked
   range isn't late in any useful sense here, it just hasn't happened yet
   (or the arrival was never logged, which is a data-entry gap, not the same
   thing as running late -- kept as its own separate count rather than
   folded into "late" so the two aren't confused). */
function computeReportStats(rows){
  var total = rows.length;
  var completed = rows.filter(function(r){ return r.truckState === "completed"; });
  var arrived = rows.filter(function(r){ return !!r.actArrival; });
  var onTime = 0, late = 0;
  arrived.forEach(function(r){
    if(!r.eta){ return; } // no scheduled time to compare against -- not counted either way
    var etaMs = new Date(r.date+"T"+r.eta+":00").getTime();
    var arrMs = new Date(r.actArrival).getTime();
    if(arrMs <= etaMs + GRACE_MIN*60000) onTime++; else late++;
  });
  var onTimeRated = onTime + late;
  var durations = completed.filter(function(r){ return r.actArrival && r.actDept; })
    .map(function(r){ return (new Date(r.actDept) - new Date(r.actArrival)) / 60000; });
  var avgMin = durations.length ? (durations.reduce(function(a,b){ return a+b; }, 0) / durations.length) : null;
  var noArrivalLogged = rows.filter(function(r){ return r.truckState === "pending" && !r.actArrival; }).length;
  var damageCount = rows.filter(function(r){ return r.damageRemark && r.damageRemark.trim(); }).length;
  return {
    total: total,
    completed: completed.length,
    onTime: onTime, late: late, onTimeRated: onTimeRated,
    onTimePct: onTimeRated ? Math.round((onTime/onTimeRated)*100) : null,
    avgMin: avgMin,
    noArrivalLogged: noArrivalLogged,
    damageCount: damageCount
  };
}

export function runReport(){
  var fromEl = document.getElementById("report-from");
  var toEl = document.getElementById("report-to");
  var from = (fromEl && fromEl.value) || ui.reportFrom;
  var to = (toEl && toEl.value) || ui.reportTo;
  if(from > to){ ui.reportError = tr("reportFromAfterTo"); render(); return; }
  ui.reportFrom = from; ui.reportTo = to;
  ui.reportBusy = true; ui.reportError = null; render();
  sbFetchTrucksForReport(from, to).then(function(rows){
    ui.reportData = computeReportStats(rows);
    // Kept alongside the aggregated stats above purely so "Export CSV"
    // (below) has the actual rows to write out without a second Supabase
    // round trip for what was already just fetched.
    ui.reportRows = rows;
    ui.reportBusy = false;
    render();
  }).catch(function(err){
    ui.reportBusy = false;
    ui.reportError = (err && err.message) || tr("reportLoadFailed");
    render();
  });
}

/* One field wrapped in quotes (with any internal quote doubled) whenever it
   contains a comma, quote or newline -- the minimal correct CSV escaping,
   good enough for the plain date/time/text values these rows hold. */
function csvField(v){
  var s = v == null ? "" : String(v);
  if(/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/* Client-side CSV of whatever the last report run fetched (ui.reportRows) --
   the same rows the KPI tiles above were computed from, just laid out one
   per line instead of aggregated, for a manager who wants to work the
   numbers further in Excel rather than just read the on-screen totals. No
   server round trip: it's built from what's already in memory and handed to
   the browser as a download via a throwaway object URL. */
export function exportReportCsv(){
  // Wrapped end-to-end: this used to fail completely silently on anything
  // going wrong (a Blob/URL API throwing, a browser/extension blocking the
  // synthetic click) -- there was no feedback in the UI at all, just nothing
  // happening, which is indistinguishable from "I forgot to click the right
  // thing". Any failure now surfaces as a toast with the actual error instead.
  try {
    var rows = ui.reportRows || [];
    // po_no/carrier added right after eta (Round 24, Theo asked for both so
    // the export identifies which truck each row is without cross-referencing
    // the app) -- sbFetchTrucksForReport() (js/api.js) already returns them.
    var header = ["date","eta","po_no","carrier","truck_state","act_arrival","act_dept","damage_remark"];
    var lines = [header.join(",")];
    rows.forEach(function(r){
      lines.push([r.date, r.eta, r.poNo, r.carrier, r.truckState, r.actArrival, r.actDept, r.damageRemark].map(csvField).join(","));
    });
    // Leading BOM so Excel (still the default on a manager's laptop) opens the
    // file as UTF-8 rather than guessing a local codepage -- harmless for the
    // plain ASCII values here, but keeps this correct if a damage remark ever
    // has non-ASCII text in it.
    var csv = "\uFEFF" + lines.join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "mon-inbound-report_" + ui.reportFrom + "_" + ui.reportTo + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  } catch(err){
    console.error("CSV export failed:", err);
    showToast(tr("reportExportFailed").replace("{err}", (err && err.message) || String(err)), true);
  }
}
