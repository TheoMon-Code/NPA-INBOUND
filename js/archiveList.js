/* ---------- Admin "Archive" screen (Round 27) ----------
   A manager compared this app to MON's Outbound admin tool, which has a
   separate Archive tab for looking back at past orders (see the Round 21
   design comparison) -- this is the Inbound equivalent: browse actual
   trucks (not just aggregated numbers, see js/reporting.js's KPI report)
   over a picked date range, further back than the live day-by-day view's
   +/-MAX_DAY_OFFSET window.

   Deliberately READ-ONLY, on purpose: a truck from weeks ago is very likely
   not currently loaded into state.trucks (loadFromSupabase() only ever
   fetches the live +/-MAX_DAY_OFFSET window, see api.js), so this screen
   can't safely open the normal truck detail sheet for a row it lists --
   there'd be nothing in state.trucks to find, and the sheet would either
   silently do nothing or need its own separate single-truck fetch. Simpler
   and safer to keep this screen "look, don't touch" for now (same shape as
   the History screen next to it) -- see the README for the follow-up note
   if editing an archived truck is ever actually needed. */
import { ui } from "./state.js";
import { tr } from "./i18n.js";
import { render } from "./render.js";
import { sbFetchArchiveListRows } from "./api.js";

export function openArchiveList(){
  ui.archiveListOpen = true;
  ui.openId = null; ui.addOpen = false;
  ui.archiveListError = null; ui.archiveListRows = null;
  render();
}

export function runArchiveList(){
  var fromEl = document.getElementById("archive-list-from");
  var toEl = document.getElementById("archive-list-to");
  var from = (fromEl && fromEl.value) || ui.archiveListFrom;
  var to = (toEl && toEl.value) || ui.archiveListTo;
  if(from > to){ ui.archiveListError = tr("reportFromAfterTo"); render(); return; }
  ui.archiveListFrom = from; ui.archiveListTo = to;
  ui.archiveListBusy = true; ui.archiveListError = null; render();
  sbFetchArchiveListRows(from, to).then(function(rows){
    ui.archiveListRows = rows;
    ui.archiveListBusy = false;
    render();
  }).catch(function(err){
    ui.archiveListBusy = false;
    ui.archiveListError = (err && err.message) || tr("reportLoadFailed");
    render();
  });
}
