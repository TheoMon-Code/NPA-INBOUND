/* ---------- rendering ----------
   No framework: `render()` rebuilds the whole app's HTML from `state` + `ui`
   on every change and writes it into #app. Everything here is a pure
   function of those two objects (plus the current clock) — all the actual
   mutation happens in actions.js/importPlan.js, which call render() when
   they're done. */
import { state, ui } from "./state.js";
import { tr } from "./i18n.js";
import { derive, lateMinutes, isDueSoon, isCriticallyLate, STATUS_KEYS } from "./status.js";
import { esc, shortDate, fmtElapsed, dateTimeOf, clockStr, addDays, todayKey, hm } from "./dateUtils.js";
import { DAY_LABELS, MONTH_LABELS, DAY_LABELS_TH, MONTH_LABELS_TH, MONTH_LABELS_TH_SHORT, TV_SCROLL_PX_PER_SEC, MHE_DAY_WINDOW } from "./config.js";
import { loadSavedName } from "./storage.js";
import { supabaseEnabled } from "./api.js";
import { hasImportFile, importFileName, importSheetNames } from "./importPlan.js";
import { offlineQueueCount } from "./offlineQueue.js";
// Round 23: these two used to come straight from config.js; now an Admin can
// override them from the new settings screen (js/settings.js), so every
// place that read them as plain constants now calls the live getter instead.
// SETTINGS_DEFS/getDueSoonMin drive the settings screen itself and the
// status legend's "due soon" description below.
import { getMaxPhotosPerTruck, getMaxDayOffset, getDueSoonMin, SETTINGS_DEFS } from "./settings.js";
// Round 27: carrier on-time ranking shown at the bottom of the Reporting
// screen (see carrierRankingHtml() below) -- computed from the same rows
// (ui.reportRows) the KPI tiles and CSV export already use, just grouped
// differently.
import { computeCarrierStats } from "./reporting.js";

/* ---------- small bilingual text helpers (kept here since they're only
   ever used while building the sheet HTML below) ---------- */
// Round 25: three roles instead of one flat "admin" -- Admin MON IT is a
// strict superset of Admin MON (isAdmin() below returns true for it too,
// so every existing `isAdmin()`-gated feature keeps working for IT with no
// extra code); Nestlé is its own restricted role, checked separately at
// every gate below so nothing admin-only leaks to an external client.
function isAdmin(){ return ui.role === "admin" || ui.role === "admin_it"; }
function isAdminIt(){ return ui.role === "admin_it"; }
function isNestle(){ return ui.role === "nestle"; }
function roleLabel(r){
  if(r === "admin") return tr("roleAdmin");
  if(r === "admin_it") return tr("roleAdminIt");
  if(r === "nestle") return tr("roleNestle");
  return tr("roleDriver");
}
/* Round 36: one of the topbar's Admin/Nestlé icon buttons (Import/Reports/
   PIN/Settings/History/Archive/Logout) -- used to be an emoji with nothing
   visible next to it (only an aria-label, for screen readers). Splits the
   emoji into its own bigger ".rbicon" span and puts the existing label text
   (the same string already used as the aria-label, so this isn't a new
   translation) in ".rblabel" right beside it -- see the CSS for how these
   two are sized differently within the same pill. */
function iconBadge(dataAttr, icon, label){
  return '<button class="rolebadge" '+dataAttr+'="1" aria-label="'+esc(label)+'">'+
    '<span class="rbicon">'+icon+'</span><span class="rblabel">'+esc(label)+'</span></button>';
}
function lateHintAdminText(mins){ return ui.lang==="th" ? ("ล่าช้ากว่ากำหนด "+mins+" นาที") : ("Running "+mins+" min late against the scheduled time."); }
function lateHintDriverText(mins){ return ui.lang==="th" ? ("ล่าช้ากว่ากำหนด "+mins+" นาที") : ("Running "+mins+" min late."); }
function canStartOnText(dateStr){ return ui.lang==="th" ? ("เริ่มขนถ่ายได้ในวันที่ "+dateStr) : ("Unloading can start on "+dateStr+"."); }
function startedAtText(hhmm){ return ui.lang==="th" ? ("เริ่มเมื่อ "+hhmm) : ("Started at "+hhmm); }
function startedByText(name){ return ui.lang==="th" ? ("เริ่มโดย "+name) : ("Started by "+name); }
function finishedByText(name){ return ui.lang==="th" ? ("เสร็จสิ้นโดย "+name) : ("Finished by "+name); }
// Round 37: small inline pill shown next to a Start/End time that an Admin
// hand-corrected (see saveStartTime()/saveActualTimes() in actions.js) --
// distinguishes it from a time the chauffeur actually tapped live, which
// matters for anyone reading the productivity/waiting-time numbers.
function correctedBadge(flag){
  if(!flag) return "";
  return ' <span class="badge-corrected">'+tr("correctedBadge")+'</span>';
}

function longDate(d){
  if(ui.lang === "th"){
    return DAY_LABELS_TH[d.getDay()]+"ที่ "+d.getDate()+" "+MONTH_LABELS_TH[d.getMonth()]+" "+(d.getFullYear()+543);
  }
  return DAY_LABELS[d.getDay()]+" "+MONTH_LABELS[d.getMonth()]+" "+d.getDate();
}
function fmtHM(mins){
  mins = Math.max(0, Math.round(mins));
  if(mins < 60) return mins + " " + tr("unit_min");
  var h = Math.floor(mins/60), m = mins%60;
  return h + "h" + (m<10?"0":"")+m;
}

function markSvg(){
  // The real MON logo (Round 13 — replaces the generic placeholder
  // hexagon/diamond used since Round 1). icons/mark-full.png is Theo's own
  // logo file used whole (hexagon + "MON" wordmark), in its original
  // colors, unmodified — an earlier version used just the hexagon (to avoid
  // duplicating the "MON" text already shown next to it), but Theo asked
  // for the full logo image, so the adjacent "MON" text line was dropped
  // instead (see brandRow below) to avoid the duplication. Wrapped in a
  // small white rounded "badge" (`.mark-badge`) so it has proper contrast
  // sitting on the blue topbar — the same pattern Theo pointed to as a
  // reference (a white card behind a colored logo on a blue banner).
  return '<div class="mark-badge"><img class="mark" src="icons/mark-full.png" alt="MON"></div>';
}

// Round 36: client feedback (Khun Badeeson) -- "the actual shipment arrival
// may not always follow the planned date... MHE should be able to see and
// process the shipment when it is physically available... the MHE Worklist
// should not be restricted to the current day's planned shipments only."
// The MHE Driver used to be pinned to offset 0 no matter what (locked out
// of the same day tabs/arrows Admin and Nestlé already had) -- it now reads
// ui.dayOffset like every other role, just clamped to the +/-1 window
// MHE_DAY_WINDOW (js/config.js) describes (previous/current/next day,
// exactly what was asked for -- not the full multi-day history Admin can
// reach).
function effectiveDayOffset(){
  if(ui.role !== "driver") return ui.dayOffset;
  return Math.max(-MHE_DAY_WINDOW, Math.min(MHE_DAY_WINDOW, ui.dayOffset));
}
/* Whether a truck scheduled for dateKeyStr can be started/processed right
   now -- Round 22-35 this was strictly "only if it's scheduled for today",
   which is exactly what client feedback said didn't match reality: a truck
   planned for the 16th can genuinely show up on the 17th, or a truck
   planned for the 18th can arrive early on the 17th. Both are still within
   one day of today, so both should be startable -- a truck 4 days off
   (visible to Admin/Nestlé via the day-nav arrows, but never to MHE) still
   isn't, there's no feedback asking for that and it would make "late/no-
   show" tracking meaningless. Shared by both the Admin and driver/Nestlé
   branches of sheetBodyHtml() below so the same +/-1 day rule applies
   everywhere "start" is offered, not just on the MHE worklist. */
function canStartOnDate(dateKeyStr){
  var diffKey = dateKeyStr === todayKey() ? 0 : (dateKeyStr === addDays(todayKey(),-1) ? -1 : (dateKeyStr === addDays(todayKey(),1) ? 1 : null));
  return diffKey !== null;
}

function pill(derived, t, now){
  var txt = tr(STATUS_KEYS[derived]);
  var soon = derived === "scheduled" && isDueSoon(t, now);
  // Round 29: a "late" pill that's been late a good while longer gets a
  // subtle pulsing ring (css/app.css's .pill.late.critical) instead of
  // sitting visually identical to one that just tipped over a moment ago —
  // see isCriticallyLate() in js/status.js.
  var critical = derived === "late" && isCriticallyLate(t, now);
  if(derived === "scheduled") txt = (soon ? "⏰ " : "") + tr("pill_eta") + " " + t.eta;
  if(derived === "late") txt = tr("status_late") + " · " + lateMinutes(t, now) + " " + tr("unit_min");
  if(derived === "unloading") txt = tr("status_unloading") + " · " + fmtElapsed(now - new Date(t.startedAt));
  if(derived === "done" && t.startedAt && t.finishedAt){
    txt = tr("status_done") + " · " + fmtHM((new Date(t.finishedAt)-new Date(t.startedAt))/60000);
  }
  return '<span class="pill '+derived+(soon?" duesoon":"")+(critical?" critical":"")+'">'+esc(txt)+"</span>";
}
/* Round 35: the pill above already shows an elapsed counter while unloading
   ("Unloading · 00:45") and a duration once done ("Done · 1h05") -- useful
   for "how long has this taken", but it doesn't answer "at what time did
   this actually start/finish", which is what Theo asked for next ("faudra
   peut etre aussi voir l'heure a laquelle ca a commencer ou finit"). This
   reads the same t.startedAt/t.finishedAt (act_arrival/act_dept) the pill
   already uses, just formatted as a clock time instead of a duration.
   Deliberately ADDITIVE everywhere it's shown (card meta line, admin table,
   TV table) -- next to the scheduled ETA, never replacing it, same reasoning
   as cardHtml() keeping the ETA visible even once a truck goes late: the
   scheduled time and the actual time answer two different questions. Empty
   string (nothing rendered) for a truck that hasn't started yet, so a
   pending/scheduled/late row looks exactly as before this round. */
function actualTimesText(t){
  if(t.status === "unloading" && t.startedAt) return "▶ "+hm(t.startedAt);
  if(t.status === "done" && t.finishedAt){
    return (t.startedAt ? "▶ "+hm(t.startedAt)+" " : "")+"⏹ "+hm(t.finishedAt);
  }
  return "";
}
/* Small second line under the ETA cell -- cardHtml()'s meta line and
   tvRowHtml()'s ETA cell only as of Round 36 (the admin desktop table got
   its own dedicated Start/End/Duration columns instead, see below), same
   ".hint" style already used for the sibling-ref product/qty line in
   tableRowHtml(), so this doesn't need its own CSS rule. */
function actualTimeHtml(t){
  var txt = actualTimesText(t);
  return txt ? '<div class="hint" style="font-weight:400">'+esc(txt)+'</div>' : "";
}
/* Round 36: client feedback -- "For the Inbound Dashboard, please add:
   Start Time / End Time / Duration... If the process is still ongoing, the
   End Time can remain blank or show 'In Progress'." Three small helpers
   (rather than one that returns three values) so tableRowHtml() can put
   each in its own <td> -- see tableColStartTime/tableColEndTime/
   tableColDuration in js/i18n.js for the matching headers. */
function actualStartCellText(t){
  return t.startedAt ? hm(t.startedAt) : "—";
}
function actualEndCellText(t){
  if(t.status === "done" && t.finishedAt) return hm(t.finishedAt);
  if(t.status === "unloading") return tr("kpiInProgress");
  return "—";
}
function actualDurationCellText(t, now){
  if(t.status === "done" && t.startedAt && t.finishedAt){
    return fmtHM((new Date(t.finishedAt)-new Date(t.startedAt))/60000);
  }
  if(t.status === "unloading" && t.startedAt){
    return fmtElapsed(now - new Date(t.startedAt));
  }
  return "—";
}
/* Round 26: a truck with a damage/claim remark (t.damageRemark, entered via
   damageRemarkHtml()'s textarea below) used to be visible only by opening
   its detail sheet -- easy to miss on a busy day. This surfaces it as a
   small warning chip right on the card/row/TV board itself, so "something's
   not right with this one" is visible at a glance instead of buried in the
   sheet. Purely a display of the existing field -- no new column, no new
   status enum. */
function damageBadge(t){
  if(!t.damageRemark || !t.damageRemark.trim()) return "";
  return '<span class="chip" style="background:var(--bad-soft);color:var(--bad)" title="'+esc(t.damageRemark)+'">'+esc(tr("damageBadge"))+'</span>';
}
/* Round 29: a truck that's already unloading or finished but has zero
   photos attached -- easy to miss since photos only show once the truck's
   own detail sheet is opened. Deliberately says nothing for a truck that
   simply hasn't arrived yet (pending/scheduled/urgent) -- no photo is
   expected at that point, so flagging it there would just be noise on
   every single row. Same additive "read the existing field, no new status
   enum" pattern as damageBadge() above. */
function photoMissingBadge(t){
  if(t.status !== "unloading" && t.status !== "done") return "";
  if(t.photos && t.photos.length) return "";
  return '<span class="chip" style="background:var(--warn-soft);color:var(--warn)" title="'+esc(tr("photoMissingHint"))+'">'+esc(tr("photoMissingBadge"))+'</span>';
}
/* Round 28: small colored chip for a truck's material type (RM = raw
   material, PM = packaging material) -- read straight from trucks.mat_type
   (see supabase-schema.sql / importExtractRows() in importPlan.js). Only
   ever populated for rows imported from the "RM PM incoming" sheet -- the
   "Indirect incoming" sheet has no such column, and neither does a manually
   created truck, so those show nothing here (same "additive, never assumed"
   pattern as damageBadge() above). Reuses the app's own brand/accent
   palette (Theo's confirmed choice) rather than introducing new hues; see
   the matching row tint on the desktop table (css/app.css, .matrm/.matpm)
   for the same two colors applied to a whole row instead of a chip.
   Round 31/32: "FZ" (Frozen -- Call off import, importGroupCallOffRows() in
   importPlan.js) is a third material type, two letters like RM/PM on Theo's
   request. First shipped (Round 31) as a plain neutral chip since MON's
   corporate palette (Round 13) only defines blue/orange/green/red, all
   already carrying a status meaning elsewhere (late/done/grace-period) --
   Round 32: Theo asked for it to actually look "icy blue" instead, so a new
   teal/cyan pair (--frozen/--frozen-soft, css/app.css) was added rather than
   reusing a shade of --brand (already RM's own color) or of a status color.
   See .matfz below for the matching desktop-table row tint. */
function matTypeBadge(t){
  if(t.matType === "FZ") return '<span class="chip" style="background:var(--frozen-soft);color:var(--frozen-ink)">FZ</span>';
  if(t.matType !== "RM" && t.matType !== "PM") return "";
  var bg = t.matType === "RM" ? "var(--brand-soft)" : "var(--accent-soft)";
  var fg = t.matType === "RM" ? "var(--brand-ink)" : "var(--accent-ink)";
  return '<span class="chip" style="background:'+bg+';color:'+fg+'">'+esc(t.matType)+'</span>';
}
/* Round 33: Theo noticed that two trucks sharing a carrier+date+time slot
   but imported with DIFFERENT po_no values -- e.g. "4563428496#1"/"#2", a
   container-numbering convention some suppliers already write into their
   own PO reference in the source file -- never showed their product/qty,
   because the details line below only ever checked for an app-assigned
   truckLabel (which importAssignLabels() in importPlan.js only sets when
   the po_no is IDENTICAL across the shared slot, see its Round 26/30
   comments). Two "#1"/"#2" rows can easily carry different products or
   quantities per container, and looked identical at a glance without it.
   This treats a po_no ending in "#<n>" the same as an app-assigned
   truckLabel for that one purpose -- it does NOT touch importAssignLabels()
   itself, so truckLabel/dedupe/grouping for these rows is unchanged; only
   whether the details line renders. */
function looksLikeSiblingRef(t){
  return !!(t.truckLabel || /#\d+$/.test(t.poNo||""));
}
/* One row of the wide-screen table view (see listTableHtml() below) --
   reuses pill() as-is for the status cell so the exact same live text
   (ETA/late-minutes/elapsed/duration) shows in both views without
   duplicating that logic. Clicking anywhere on the row opens the truck
   sheet: events.js's click delegation walks up via el.closest("[data-open]"),
   so putting data-open directly on the <tr> works with zero JS changes. */
function tableRowHtml(t, now){
  var d = derive(t, now);
  // Round 26 (restored Round 30): when this truck shares its PO+date+time+
  // carrier slot with others (t.truckLabel set — see importAssignLabels()
  // in importPlan.js), show
  // its product + qty right under the label so the several "Truck 1/2/3"
  // rows for the same PO can still be told apart at a glance, per Theo's
  // confirmed choice. Left off entirely for the common single-truck case so
  // this table doesn't grow a column that's "—" almost every row (the same
  // reasoning Round 24 removed the old lots column for).
  var detailsLine = (looksLikeSiblingRef(t) && (t.details || t.qtt)) ?
    '<div class="hint" style="font-weight:400">'+esc(t.details||"")+(t.qtt?(" ("+esc(t.qtt)+")"):"")+'</div>' : "";
  var matCls = t.matType === "RM" ? " matrm" : (t.matType === "PM" ? " matpm" : (t.matType === "FZ" ? " matfz" : ""));
  // Round 33: the RM/PM/FZ badge (matTypeBadge(), already shown on the
  // mobile cards) gets its own leftmost column here too -- Theo pointed out
  // that on the wide table it was only ever hinted at by the faint row tint
  // (matCls above), which wasn't distinct enough to read at a glance,
  // especially between .matrm and the old .matfz teal. "—" for a manually
  // added truck or a sheet with no material type, same fallback style as
  // the carrier-Thai-name/plant columns below.
  // Round 34: same muting as .card.completed above, for the desktop table.
  var completedCls = d === "done" ? " completed-row" : "";
  return '<tr class="truckrow'+matCls+completedCls+'" data-open="'+esc(t.id)+'">'+
    '<td>'+(matTypeBadge(t) || "—")+'</td>'+
    '<td>'+pill(d,t,now)+damageBadge(t)+photoMissingBadge(t)+'</td>'+
    '<td class="mono">'+esc(t.truckLabel || t.poNo || t.ref || t.id)+detailsLine+'</td>'+
    '<td>'+esc(t.carrier||"—")+'</td>'+
    // Round 28 (follow-up): the Thai name/note captured alongside the
    // carrier (api.js's mapRowToTruck) -- Theo asked for its own column
    // here instead of a smaller second line under the carrier, simpler to
    // scan on a wide screen. "—" when a truck has none (imported from a
    // sheet with no such column, or created manually).
    '<td>'+(t.carrierTh ? esc(t.carrierTh) : "—")+'</td>'+
    '<td>'+(t.plant ? esc(t.plant) : "—")+'</td>'+
    '<td>'+shortDate(t.date)+'</td>'+
    // Round 24: was the multi-lot badge (Round 10) -- "—" for the ~90% of
    // trucks with only one lot, so it wasn't pulling its weight as a column
    // Theo scans on every row. ETA is useful for every truck instead, and
    // mirrors what the TV table already shows (tvColEta, its own separate
    // key/column since renderTv() is a different render path with its own
    // wording to tweak independently).
    '<td>'+(t.eta || "—")+'</td>'+
    // Round 36: three dedicated columns (client feedback) instead of Round
    // 35's second line under ETA on this table specifically -- see
    // actualStartCellText()/actualEndCellText()/actualDurationCellText()
    // below. Cards/TV keep Round 35's compact inline marker unchanged
    // (there's no room here for three more columns on a phone or from
    // across a room).
    '<td>'+actualStartCellText(t)+'</td>'+
    '<td>'+actualEndCellText(t)+'</td>'+
    '<td>'+actualDurationCellText(t, now)+'</td>'+
  '</tr>';
}
/* Table-shaped view of the same day's trucks as listHtml()'s cards, for a
   wide (desktop/web) screen -- a manager compared this app to MON's
   Outbound admin tool, which lists its LOAD orders as a dense table rather
   than cards (Round 21). Always rendered alongside the card markup; which
   one is actually visible is decided purely by CSS (see .list-cards/
   .list-table in css/app.css), so a phone never pays for or sees the denser
   table layout -- Theo was explicit that whatever changed here had to stay
   simple to read on both phone and web, not just look more like Outbound
   on desktop at the cost of mobile. */
function listTableHtml(filtered, now){
  // Round 34: same ongoing/completed split as listHtml() below -- see its
  // comment for why the header only appears when the day actually has both.
  var ongoing = filtered.filter(function(t){ return t.status !== "done"; });
  var completed = filtered.filter(function(t){ return t.status === "done"; });
  var rows;
  if(ongoing.length && completed.length){
    // colspan must span every <th> below (11 as of Round 36 -- Start Time/
    // End Time/Duration added three columns to the 8 from Round 33/34).
    rows = '<tr class="tablesectionrow"><td colspan="11">'+tr("sectionOngoing")+'</td></tr>'+
      ongoing.map(function(t){ return tableRowHtml(t, now); }).join("")+
      '<tr class="tablesectionrow"><td colspan="11">'+tr("sectionCompleted")+'</td></tr>'+
      completed.map(function(t){ return tableRowHtml(t, now); }).join("");
  } else {
    rows = filtered.map(function(t){ return tableRowHtml(t, now); }).join("");
  }
  return '<table class="trucktable"><thead><tr>'+
    '<th>'+tr("tableColType")+'</th>'+
    '<th>'+tr("tableColStatus")+'</th>'+
    '<th>'+tr("tableColPo")+'</th>'+
    '<th>'+tr("tableColCarrier")+'</th>'+
    '<th>'+tr("tableColCarrierTh")+'</th>'+
    '<th>'+tr("tableColPlant")+'</th>'+
    '<th>'+tr("tableColDate")+'</th>'+
    '<th>'+tr("tableColEta")+'</th>'+
    // Round 36: client feedback -- dedicated Start Time/End Time/Duration
    // columns (see actualStartCellText()/actualEndCellText()/
    // actualDurationCellText() above) rather than folded into the ETA cell.
    '<th>'+tr("tableColStartTime")+'</th>'+
    '<th>'+tr("tableColEndTime")+'</th>'+
    '<th>'+tr("tableColDuration")+'</th>'+
  '</tr></thead><tbody>'+rows+'</tbody></table>';
}
function sortWeight(t, now){
  var d = derive(t, now);
  if(d==="urgent"||d==="late") return 0;
  if(d==="unloading") return 1;
  if(d==="scheduled") return 2 + (t.eta ? dateTimeOf(t.date,t.eta).getTime()/1e15 : 0);
  if(d==="pending") return 3;
  return 4;
}
function cardHtml(t, now){
  var d = derive(t, now);
  var soon = d === "scheduled" && isDueSoon(t, now);
  var critical = d === "late" && isCriticallyLate(t, now);
  // Round 34: a finished truck's card gets visually muted (see .card.completed
  // in css/app.css) on top of the section split in listHtml() below -- Theo
  // wanted a done truck to actually recede once it's no longer something
  // anyone needs to act on, not keep the same visual weight (and a cheerful
  // green stripe/pill) as a truck still being worked.
  return '<button class="card'+(d==="done"?" completed":"")+'" data-open="'+esc(t.id)+'">'+
    '<span class="stripe '+d+(soon?" duesoon":"")+(critical?" critical":"")+'"></span>'+
    '<span class="card-body">'+
      '<span class="card-top"><span class="card-id mono">'+esc(t.truckLabel || t.poNo || t.ref || t.id)+"</span>"+matTypeBadge(t)+pill(d,t,now)+"</span>"+
      '<span class="card-carrier">'+esc(t.carrier)+(t.carrierTh?(' · '+esc(t.carrierTh)):"")+"</span>"+
      '<span class="card-meta">'+
      (t.plant ? "<span>"+esc(t.plant)+"</span>" : "")+
      "<span>"+shortDate(t.date)+"</span>"+
      (t.imExTr ? "<span>"+esc(t.imExTr)+"</span>" : "")+
      // Once a truck goes "Late" the pill above stops showing the scheduled
      // time (it switches to how many minutes late instead) — repeating the
      // ETA here means it's never hidden, however late the truck gets.
      (t.eta ? "<span>"+tr("pill_eta")+" "+esc(t.eta)+"</span>" : "")+
      // Round 35: actual start/finish clock time, next to the scheduled ETA
      // above rather than instead of it -- see actualTimesText() for why.
      (actualTimesText(t) ? "<span>"+esc(actualTimesText(t))+"</span>" : "")+
      (t.lots && t.lots.length > 1 ? "<span>"+esc(tr("multiLotBadge").replace("{n}", t.lots.length))+"</span>" : "")+
      // Round 26 (Round 33: also a "#N"-suffixed po_no, see
      // looksLikeSiblingRef() above) -- product + qty shown only for a
      // truck that shares its slot with others, so the "Truck 1/2/3" cards
      // for one PO are distinguishable without opening each one.
      (looksLikeSiblingRef(t) && (t.details || t.qtt) ? "<span>"+esc(t.details||"")+(t.qtt?(" ("+esc(t.qtt)+")"):"")+"</span>" : "")+
      "</span>"+
      damageBadge(t)+photoMissingBadge(t)+
    "</span>"+
  "</button>";
}
function kpiHtml(trucks, now){
  var today = trucks.filter(function(t){ return t.date === todayKey(); });
  var done = today.filter(function(t){ return t.status === "done"; });
  var working = today.filter(function(t){ return t.status === "unloading"; }).length;
  var late = today.filter(function(t){ return derive(t, now) === "late" || derive(t, now) === "urgent"; }).length;
  var avg = done.length ? done.reduce(function(sum,t){ return sum + (new Date(t.finishedAt)-new Date(t.startedAt))/60000; }, 0)/done.length : null;
  var items = [
    {v: today.length, l:tr("kpiToday"), cls:""},
    {v: done.length, l:tr("kpiCompleted"), cls:"good"},
    {v: working, l:tr("kpiInProgress"), cls: working ? "warn" : ""},
    {v: late, l:tr("kpiLate"), cls: late ? "bad" : ""},
    {v: avg==null ? "—" : fmtHM(avg), l:tr("kpiAvgTime"), cls:""}
  ];
  return items.map(function(k){
    return '<div class="kpi '+k.cls+'"><div class="v mono">'+k.v+'</div><div class="l">'+k.l+"</div></div>";
  }).join("");
}
/* Round 36: client feedback -- "please change the current date tabs from
   Yesterday/Today/Tomorrow to display the actual date, for example 16 Sep
   2026... the selected date should be clearly highlighted... the date
   displayed on the tab and the data shown below must always be
   synchronized". Reads a plain "YYYY-MM-DD" dateKey (never a Date object --
   see the rest of this file's date handling) and formats it the same short
   day+month(+year) shape in both languages, just with the language's own
   month form (MONTH_LABELS_TH_SHORT for Thai, see config.js for why that's
   its own array rather than truncating MONTH_LABELS_TH). */
function tabDateLabel(dateKeyStr){
  var p = dateKeyStr.split("-").map(Number);
  var day = p[2], monthIdx = p[1]-1, year = p[0];
  if(ui.lang === "th") return day+" "+MONTH_LABELS_TH_SHORT[monthIdx]+" "+(year+543);
  return day+" "+MONTH_LABELS[monthIdx].slice(0,3)+" "+year;
}
function tabsHtml(trucks){
  // Three quick tabs (still offsets -1/0/+1 -- "yesterday/today/tomorrow"
  // relative to the actual selected day, Round 36 just changed what each
  // tab DISPLAYS, not which days exist) plus two nav arrows that step ONE
  // day at a time (Round 15 -- the first version jumped straight to +/-5,
  // which skipped every day in between; Theo pointed out he needed access
  // to those in-between dates too, not just the two extremes), clamped to
  // [-MAX_DAY_OFFSET, +MAX_DAY_OFFSET] overall. When the current offset
  // lands outside -1/0/+1 none of the three quick tabs is "active", so a
  // small date pill (using the same tabDateLabel() shape) shows which day
  // is actually selected -- this keeps the tab/data-below sync the client
  // asked for even that far out.
  var quick = [ {o:-1}, {o:0}, {o:1} ];
  // Round 36: MHE (driver) reads through effectiveDayOffset() -- clamped to
  // +/-MHE_DAY_WINDOW there -- rather than the raw ui.dayOffset every other
  // role uses directly, and its own cap here instead of the Admin-configurable
  // getMaxDayOffset() (a truck 4 days out was never what this feedback asked
  // for; see effectiveDayOffset()/canStartOnDate() above).
  var cur = effectiveDayOffset();
  var maxOffset = ui.role === "driver" ? MHE_DAY_WINDOW : getMaxDayOffset();
  var atMin = cur <= -maxOffset, atMax = cur >= maxOffset;
  var quickHtml = quick.map(function(q){
    var key = addDays(todayKey(), q.o);
    var n = trucks.filter(function(t){ return t.date === key; }).length;
    return '<button class="tab'+(cur===q.o?" active":"")+'" data-tab="'+q.o+'">'+
      '<span class="n mono">'+n+'</span><span class="tab-datelabel">'+tabDateLabel(key)+'</span></button>';
  }).join("");
  var isQuickDay = quick.some(function(q){ return q.o === cur; });
  var dateInfo = isQuickDay ? "" :
    '<div class="tab-dateinfo">'+tabDateLabel(addDays(todayKey(), cur))+'</div>';
  return '<div class="tabs-row">'+
    '<button class="tab tab-nav" data-day-nav="-1" aria-label="'+tr("navPrevDay")+'"'+(atMin?" disabled":"")+'>◀</button>'+
    '<div class="tabs">'+quickHtml+'</div>'+
    '<button class="tab tab-nav" data-day-nav="1" aria-label="'+tr("navNextDay")+'"'+(atMax?" disabled":"")+'>▶</button>'+
  '</div>'+dateInfo;
}
/* Quick client-side search (PO/reference/carrier/plant) + a one-tap "late
   only" filter (Round 17) -- both narrow what's shown in the list below,
   never what kpiHtml() counts (those stay "today's real totals" regardless
   of what's currently typed in the search box). Default state (empty query,
   filter off) matches every truck, same as before this round. */
function matchesListFilters(t, now){
  if(ui.filterLateOnly){
    var d = derive(t, now);
    if(d !== "late" && d !== "urgent") return false;
  }
  // Round 27: structured carrier/plant filters, additional to (and combined
  // with, same AND logic as filterLateOnly above) the free-text search below
  // -- picking an exact value from a dropdown rather than typing a substring
  // that might match several similarly-named carriers/plants at once.
  if(ui.filterCarrier && (t.carrier || "") !== ui.filterCarrier) return false;
  if(ui.filterPlant && (t.plant || "") !== ui.filterPlant) return false;
  var q = (ui.searchQuery || "").trim().toLowerCase();
  if(q){
    // Round 26 (restored Round 30): product + qty (t.details/t.qtt) and the
    // "<PO> - Truck N" label added to the match text -- now that several
    // trucks can share a PO (see importAssignLabels() in importPlan.js),
    // typing the product name or "Truck 2" is often how someone finds the
    // specific one they mean.
    var hay = ((t.poNo||"")+" "+(t.truckLabel||"")+" "+(t.ref||"")+" "+(t.carrier||"")+" "+(t.plant||"")+" "+(t.details||"")+" "+(t.qtt||"")).toLowerCase();
    if(hay.indexOf(q) === -1) return false;
  }
  return true;
}
/* Round 27: one <select> of the distinct carriers (or plants) present among
   the day's own trucks, plus a leading "All" option -- built from `dayTrucks`
   (the same set listHtml() below is about to filter/display), so the choices
   offered are always exactly what's actually on this day, never a stale or
   unrelated list. Kept selected even if it stops matching anything (e.g. the
   day changes) -- same "leave it as typed" behavior as the free-text search. */
function filterOptionsHtml(dayTrucks, field, current, id, allLabel){
  var seen = {};
  var values = [];
  dayTrucks.forEach(function(t){
    var v = (t[field] || "").trim();
    if(v && !seen[v]){ seen[v] = true; values.push(v); }
  });
  values.sort();
  var opts = '<option value="">'+esc(allLabel)+'</option>'+
    values.map(function(v){ return '<option value="'+esc(v)+'"'+(v===current?" selected":"")+'>'+esc(v)+'</option>'; }).join("");
  return '<select class="field filterselect" id="'+id+'">'+opts+'</select>';
}
function searchRowHtml(dayTrucks){
  return '<div class="searchrow">'+
    '<input class="field" type="text" id="searchInput" placeholder="'+tr("searchPlaceholder")+'" value="'+esc(ui.searchQuery)+'">'+
    '<button class="filterchip'+(ui.filterLateOnly?" active":"")+'" data-toggle-late-filter="1">'+tr("filterLateOnly")+'</button>'+
  '</div>'+
  '<div class="searchrow">'+
    filterOptionsHtml(dayTrucks, "carrier", ui.filterCarrier, "filterCarrierSelect", tr("filterAllCarriers"))+
    filterOptionsHtml(dayTrucks, "plant", ui.filterPlant, "filterPlantSelect", tr("filterAllPlants"))+
  '</div>';
}
function listHtml(trucks, now){
  var dayTrucks = trucks.filter(function(t){ return t.date === addDays(todayKey(), effectiveDayOffset()); });
  var filtered = dayTrucks.filter(function(t){ return matchesListFilters(t, now); });
  filtered.sort(function(a,b){ return sortWeight(a,now) - sortWeight(b,now); });
  if(!filtered.length){
    // Distinguish "nothing scheduled at all today" from "there ARE trucks
    // today, just none matching the current search/filter" -- the second
    // one needs a different message (and icon) so it doesn't read as an
    // empty day when it's really just a narrow search.
    if(dayTrucks.length){
      return '<div class="empty"><span class="empty-icon">🔍</span><div>'+tr("noSearchResults")+'</div></div>';
    }
    return '<div class="empty"><span class="empty-icon">🚚</span><div>'+tr("noTrucksToday")+'</div></div>';
  }
  // Round 34: Theo wanted finished trucks visually set apart from the ones
  // still needing attention, not just quietly sorted to the bottom
  // (sortWeight() below already did that, but with nothing marking where
  // "today's work" ends and "already handled" begins). Two real sections
  // with their own header -- only when the day actually HAS both kinds;
  // a day that's all-pending or all-done gets no header, since there's
  // nothing to separate it from. Each completed card also gets muted on
  // its own (.card.completed, css/app.css) regardless of whether the
  // header shows, so a single finished truck on an otherwise-open day
  // still reads as "done" at a glance.
  var ongoing = filtered.filter(function(t){ return t.status !== "done"; });
  var completed = filtered.filter(function(t){ return t.status === "done"; });
  var cardsHtml;
  if(ongoing.length && completed.length){
    cardsHtml = '<div class="section-label">'+tr("sectionOngoing")+'</div>'+
      ongoing.map(function(t){ return cardHtml(t, now); }).join("")+
      '<div class="section-label">'+tr("sectionCompleted")+'</div>'+
      completed.map(function(t){ return cardHtml(t, now); }).join("");
  } else {
    cardsHtml = filtered.map(function(t){ return cardHtml(t, now); }).join("");
  }
  // A short list on a tall phone screen (especially standalone/home-screen
  // mode, which has no browser chrome eating into the viewport) can leave a
  // large blank area below the cards that reads as broken rather than
  // intentional. This closing line turns that empty space into a deliberate
  // "end of list" instead of an unexplained void.
  var cards = cardsHtml+'<div class="list-end">'+tr("endOfList")+'</div>';
  // Both views are built from the exact same `filtered`/sorted array and
  // both always end up in the DOM -- see listTableHtml() above for why only
  // one is ever visible at a time (a pure CSS media-query toggle, so this
  // never has to guess the viewport width itself).
  return '<div class="list-cards">'+cards+'</div>'+
    '<div class="list-table">'+listTableHtml(filtered, now)+'</div>';
}

function sheetHtml(now){
  if(ui.importOpen) return importSheetHtml();
  if(ui.reportOpen) return reportSheetHtml();
  if(ui.historyOpen) return historySheetHtml();
  if(ui.archiveListOpen) return archiveListSheetHtml();
  if(ui.pinSettingsOpen) return pinSettingsHtml();
  if(ui.nameSettingsOpen) return nameSettingsHtml();
  if(ui.settingsOpen) return settingsSheetHtml();
  if(ui.addOpen) return addSheetHtml();
  if(!ui.openId) return "";
  var t = state.trucks.find(function(x){ return x.id === ui.openId; });
  if(!t) return "";
  var d = derive(t, now);
  var body = "";
  // Round 25: renamed from the old local `isAdmin` (which shadowed the new
  // module-level isAdmin() below) to avoid a naming collision, and split
  // into three branches everywhere in this sheet -- Admin (edit), Nestlé
  // (read-only: "view + import + download only", no
  // ETA edit / start / finish / cancel / reopen / delete), Driver
  // (unchanged: no ETA edit, but can start/finish since that's their job).
  var adminMode = isAdmin();
  var nestleMode = isNestle();

  if(d==="pending" || d==="urgent" || d==="scheduled" || d==="late"){
    if(adminMode){
      body += '<div class="sheet-section"><div class="label">'+tr("etaLabel")+'</div>'+
        '<input class="field" type="time" id="etaInput" value="'+(t.eta||"")+'">'+
        '<button class="btn primary" data-save-eta="'+esc(t.id)+'">'+(t.eta?tr("updateTime"):tr("saveTime"))+'</button></div>';
      if(d==="late") body += '<div class="hint" style="color:var(--bad);text-align:center;margin-top:10px">'+lateHintAdminText(lateMinutes(t,now))+'</div>';
      if(canStartOnDate(t.date) && t.eta){
        body += '<button class="btn go" data-start="'+esc(t.id)+'">'+tr("startUnloading")+'</button>';
      } else if(!canStartOnDate(t.date)){
        body += '<div class="hint" style="text-align:center;margin-top:12px">'+canStartOnText(shortDate(t.date))+'</div>';
      }
    } else {
      if(!t.eta){
        body += '<div class="hint" style="text-align:center;margin-top:10px">'+tr("waitingEta")+'</div>';
      } else {
        body += '<div class="timer" style="font-size:30px">'+t.eta+'</div><div class="timer-sub">'+tr("scheduledArrivalTime")+'</div>';
        if(d==="late") body += '<div class="hint" style="color:var(--bad);text-align:center;margin-top:6px">'+lateHintDriverText(lateMinutes(t,now))+'</div>';
        // Nestlé is consultation-only here -- no "Start unloading" button
        // (that stays Admin's and the MHE Driver's job), just the same
        // informational text the driver view already shows.
        if(!nestleMode && canStartOnDate(t.date)){
          body += '<button class="btn go" data-start="'+esc(t.id)+'">'+tr("startUnloading")+'</button>';
        } else if(nestleMode && canStartOnDate(t.date)){
          body += '<div class="hint" style="text-align:center;margin-top:12px">'+tr("scheduledArrivalTime")+'</div>';
        } else {
          body += '<div class="hint" style="text-align:center;margin-top:12px">'+canStartOnText(shortDate(t.date))+'</div>';
        }
      }
    }
  } else if(d==="unloading"){
    var elapsed = now - new Date(t.startedAt);
    body += '<div class="timer big-work" id="liveTimer">'+fmtElapsed(elapsed)+'</div>'+
      '<div class="timer-sub">'+startedAtText(new Date(t.startedAt).toTimeString().slice(0,5))+correctedBadge(t.arrivalCorrected)+'</div>';
    if(!nestleMode){
      body += '<button class="btn stop" data-finish="'+esc(t.id)+'">'+tr("finishUnloading")+'</button>'+
        '<button class="linklike" data-cancel="'+esc(t.id)+'">'+tr("cancelStartLink")+'</button>';
    }
    if(t.startedBy) body += '<div class="hint" style="text-align:center;margin-top:8px">'+esc(startedByText(t.startedBy))+'</div>';
    // Round 37: client feedback -- a chauffeur can forget to tap "Start
    // unloading", leaving act_arrival wrong/late; Admin can hand-correct it
    // here without needing to cancel and redo the whole start step.
    if(adminMode){
      body += '<div class="sheet-section"><div class="label">'+tr("editStartTimeLabel")+'</div>'+
        '<input class="field" type="time" id="startTimeInput" value="'+esc(hm(t.startedAt))+'">'+
        '<button class="btn primary" data-save-start="'+esc(t.id)+'">'+tr("updateTime")+'</button></div>';
    }
  } else if(d==="done"){
    var durMin = (new Date(t.finishedAt)-new Date(t.startedAt))/60000;
    body += '<div class="done-summary">'+
      '<div><b>'+new Date(t.startedAt).toTimeString().slice(0,5)+'</b><span>'+tr("lblStart")+correctedBadge(t.arrivalCorrected)+'</span></div>'+
      '<div><b>'+new Date(t.finishedAt).toTimeString().slice(0,5)+'</b><span>'+tr("lblEnd")+correctedBadge(t.departureCorrected)+'</span></div>'+
      '<div><b>'+fmtHM(durMin)+'</b><span>'+tr("lblDuration")+'</span></div>'+
      '</div>';
    if(t.finishedBy) body += '<div class="hint" style="text-align:center;margin-top:2px">'+esc(finishedByText(t.finishedBy))+'</div>';
    // Round 37: same client feedback as above -- once a truck is fully
    // done, Admin can still go back and correct either (or both) actual
    // times by hand, e.g. after noticing a wrong one on the Reporting
    // screen's productivity numbers.
    if(adminMode){
      body += '<div class="sheet-section"><div class="label">'+tr("editActualTimesLabel")+'</div>'+
        '<div class="timeeditrow">'+
          '<div><input class="field" type="time" id="startTimeInput" value="'+esc(hm(t.startedAt))+'"></div>'+
          '<div><input class="field" type="time" id="endTimeInput" value="'+esc(hm(t.finishedAt))+'"></div>'+
        '</div>'+
        '<button class="btn primary" data-save-actual="'+esc(t.id)+'">'+tr("updateTime")+'</button></div>';
      body += '<button class="linklike" data-reopen="'+esc(t.id)+'">'+tr("reopenUnloading")+'</button>';
    }
  }

  body += deleteControl(t.id);

  return '<div class="scrim" data-scrim="1"><div class="sheet">'+
    '<div class="sheet-handle"></div>'+
    '<div class="sheet-head"><div><div class="sheet-id mono">'+esc(t.truckLabel || t.poNo || t.ref || t.id)+'</div>'+
    '<div class="sheet-carrier">'+esc(t.carrier)+(t.carrierTh?(' · '+esc(t.carrierTh)):"")+'</div></div>'+
    '<button class="sheet-close" data-close="1">✕</button></div>'+
    '<div class="sheet-meta">'+
    (t.plant?'<span class="chip">'+esc(t.plant)+'</span>':"")+
    '<span class="chip">'+shortDate(t.date)+'</span>'+
    (t.imExTr?'<span class="chip">'+esc(t.imExTr)+'</span>':"")+
    '</div>'+
    shipmentDetailsHtml(t)+
    lotsHtml(t)+
    rawDetailsHtml(t)+
    photosHtml(t)+
    damageRemarkHtml(t)+
    signatureHtml(t)+
    body+
  '</div></div>';
}
function detailRow(label, val){
  if(val == null || val === "") return "";
  return '<div class="detailrow"><span class="detailkey">'+esc(label)+'</span><span class="detailval">'+esc(val)+'</span></div>';
}
function shipmentDetailsHtml(t){
  var rows =
    detailRow(tr("detProduct"), t.details)+
    detailRow(tr("detPoNo"), t.poNo)+
    detailRow(tr("detSkuNo"), t.skuNo)+
    detailRow(tr("detQuantity"), t.qtt)+
    detailRow(tr("detContNo"), t.contNo)+
    detailRow(tr("detSealNo"), t.sealNo)+
    detailRow(tr("detContType"), t.contType)+
    detailRow(tr("detClosingDate"), t.closingDate)+
    detailRow(tr("detRemark"), t.remark);
  if(!rows) return "";
  return '<div class="sheet-section"><div class="label">'+tr("shipmentDetails")+'</div><div class="detailgrid">'+rows+'</div></div>';
}
/* Every column the "Import inbound plan" feature saw for this truck in the
   source file, including ones nothing above has a dedicated field for
   (weighing, gross weight, on-time flags, penalties…) — see trucks.raw in
   supabase-schema.sql. Collapsed by default (native <details>, no JS) since
   it's a lot of text and most people only need it occasionally. Manually
   created trucks have no raw data, so this section simply doesn't appear. */
/* Round 30: importPlan.js no longer writes `lots` (each source row is its
   own truck again, see importAssignLabels there) — this stays only so a
   truck imported while Round 28's merge-into-lots behavior was live still
   renders its saved lots correctly instead of silently dropping data. A
   single-lot truck has no `lots` array at all (or a one-item one), so this
   section simply doesn't appear for the common case. */
function lotsHtml(t){
  if(!t.lots || !Array.isArray(t.lots) || t.lots.length < 2) return "";
  var items = t.lots.map(function(lot, idx){
    var label = lot.details || tr("lotUnnamed");
    var qty = lot.qtt ? (" — "+lot.qtt) : "";
    return detailRow("#"+(idx+1), label+qty);
  }).join("");
  return '<div class="sheet-section"><div class="label">'+esc(tr("lotsSectionTitle").replace("{n}", t.lots.length))+'</div><div class="detailgrid">'+items+'</div></div>';
}
function rawDetailsHtml(t){
  if(!t.raw || typeof t.raw !== "object") return "";
  var rows = Object.keys(t.raw).map(function(k){ return detailRow(k, t.raw[k]); }).join("");
  if(!rows) return "";
  return '<details class="sheet-section"><summary class="label" style="cursor:pointer">'+tr("allSourceFields")+'</summary><div class="detailgrid" style="margin-top:8px">'+rows+'</div></details>';
}
function deleteControl(id){
  if(!isAdmin()) return "";
  // Round 36: client feedback -- a third step now sits between "Confirm
  // delete?" and the actual deletion, a small inline PIN input
  // (promptDeletePin()/confirmDeleteWithPin() in js/actions.js) that blocks
  // the delete outright on a wrong PIN (ui.deletePinError below).
  if(ui.deletePinPrompt === id){
    return '<div class="deletepinbox">'+
      '<div class="label" style="margin-bottom:6px">'+tr("deletePinPromptLabel")+'</div>'+
      '<input class="field" type="password" inputmode="numeric" id="deletePinInput">'+
      (ui.deletePinError ? '<div class="hint" style="color:var(--bad);margin-top:6px">'+esc(ui.deletePinError)+'</div>' : '')+
      '<div style="display:flex; gap:8px; margin-top:8px">'+
        '<button class="btn primary" style="flex:1" data-delete-pin-confirm="'+esc(id)+'">'+tr("deletePinConfirmBtn")+'</button>'+
        '<button class="btn" style="flex:1" data-delete-pin-cancel="1">'+tr("deletePinCancelBtn")+'</button>'+
      '</div>'+
    '</div>';
  }
  if(ui.confirmDelete === id){
    return '<button class="linklike danger" data-delete-confirm="'+esc(id)+'">'+tr("confirmDeleteQ")+'</button>';
  }
  return '<button class="linklike danger" data-delete="'+esc(id)+'">'+tr("deleteThisTruck")+'</button>';
}
function addSheetHtml(){
  var d = ui.addDefaultDate || todayKey();
  return '<div class="scrim" data-scrim="1"><div class="sheet">'+
    '<div class="sheet-handle"></div>'+
    '<div class="sheet-head"><div><div class="sheet-id title-lg">'+tr("newTruck")+'</div></div>'+
    '<button class="sheet-close" data-close="1">✕</button></div>'+
    '<div class="formgrid">'+
      '<div><div class="label">'+tr("fieldCarrier")+'</div><input class="field" id="f-carrier" placeholder="'+tr("phCarrier")+'"></div>'+
      '<div><div class="label">'+tr("fieldPlant")+'</div><input class="field" id="f-plant" placeholder="'+tr("phPlant")+'"></div>'+
      '<div><div class="label">'+tr("fieldPoRef")+'</div><input class="field" id="f-ref" placeholder="'+tr("phRef")+'"></div>'+
      '<div><div class="label">'+tr("fieldArrivalDate")+'</div><input class="field" type="date" id="f-date" value="'+d+'"></div>'+
      '<div><div class="label">'+tr("fieldEta")+'</div><input class="field" type="time" id="f-eta"></div>'+
    '</div>'+
    '<button class="btn primary" data-create="1">'+tr("addTruckBtn")+'</button>'+
  '</div></div>';
}
function roleGateHtml(){
  if(!ui.roleGateOpen) return "";
  var canClose = !!ui.role;
  var closeBtn = canClose ? '<button class="sheet-close" data-role-close="1">✕</button>' : '';
  // The role gate sits above everything, including the header's own EN/TH
  // pill, so it needs its own reachable language toggle too — this matters
  // most on first launch, before a role (and its default language) is set.
  var langBtn = '<button class="langtoggle-card" data-toggle-lang="1" aria-label="Language / ภาษา">'+(ui.lang==="th"?"EN":"TH")+'</button>';
  // Round 25: three PIN-gated roles now share this same sub-screen shape
  // (Admin MON's "pin" step is unchanged from Round 14 for backward
  // compatibility with existing devices/tests) -- pinStepTitles maps each
  // step name (set generically by events.js from whichever data-role-step
  // button was tapped below) to its title key.
  var pinStepTitles = { pin: "adminPinTitle", pin_it: "adminItPinTitle", pin_nestle: "nestlePinTitle" };
  if(pinStepTitles[ui.roleGateStep]){
    return '<div class="rolegate"><div class="rolecard">'+langBtn+closeBtn+
      '<div class="rolecard-title">'+tr(pinStepTitles[ui.roleGateStep])+'</div>'+
      '<div class="rolecard-sub">'+tr("enterPinSub")+'</div>'+
      '<input class="field" style="margin-top:14px;text-align:center;letter-spacing:6px;font-family:\'IBM Plex Mono\';font-size:20px" type="password" inputmode="numeric" autocomplete="off" maxlength="8" id="pinInput" placeholder="••••••">'+
      (ui.roleGateError ? '<div class="hint" style="color:var(--bad);text-align:center;margin-top:8px">'+esc(ui.roleGateError)+'</div>' : '')+
      '<button class="btn primary" data-pin-submit="1">'+tr("unlockBtn")+'</button>'+
      '<button class="linklike" data-role-back="1">'+tr("back")+'</button>'+
    '</div></div>';
  }
  return '<div class="rolegate"><div class="rolecard">'+langBtn+closeBtn+
    '<div class="rolecard-title">'+tr("whoUsingDevice")+'</div>'+
    '<div class="rolecard-sub">'+tr("chooseRoleSub")+'</div>'+
    '<button class="roleopt" data-role-step="pin"><b>'+tr("roleAdmin")+'</b><span>'+tr("roleAdminDesc")+'</span></button>'+
    '<button class="roleopt" data-role-step="pin_it"><b>'+tr("roleAdminIt")+'</b><span>'+tr("roleAdminItDesc")+'</span></button>'+
    '<button class="roleopt" data-role-step="pin_nestle"><b>'+tr("roleNestle")+'</b><span>'+tr("roleNestleDesc")+'</span></button>'+
    '<button class="roleopt" data-pick-role="driver"><b>'+tr("roleDriver")+'</b><span>'+tr("roleDriverDesc")+'</span></button>'+
  '</div></div>';
}
function pinSettingsHtml(){
  return '<div class="scrim" data-scrim="1"><div class="sheet">'+
    '<div class="sheet-handle"></div>'+
    '<div class="sheet-head"><div><div class="sheet-id title-lg">'+tr("changePinTitle")+'</div></div>'+
    '<button class="sheet-close" data-close="1">✕</button></div>'+
    '<div class="formgrid">'+
      '<div><div class="label">'+tr("curPin")+'</div><input class="field" type="password" inputmode="numeric" autocomplete="off" id="pin-current" placeholder="••••••"></div>'+
      '<div><div class="label">'+tr("newPin")+'</div><input class="field" type="password" inputmode="numeric" autocomplete="off" id="pin-new" placeholder="••••••"></div>'+
      '<div><div class="label">'+tr("confirmNewPin")+'</div><input class="field" type="password" inputmode="numeric" autocomplete="off" id="pin-confirm" placeholder="••••••"></div>'+
    '</div>'+
    (ui.pinSettingsError ? '<div class="hint" style="color:var(--bad);text-align:center;margin-top:8px">'+esc(ui.pinSettingsError)+'</div>' : '')+
    '<button class="btn primary" data-save-pin="1">'+tr("updatePinBtn")+'</button>'+
  '</div></div>';
}
/* Round 26: names already used on this project's own trucks (started_by/
   finished_by, whatever previous devices have saved here — see
   loadSavedName()/saveNameLocal() in storage.js), offered as native browser
   autocomplete (<datalist>) rather than a hard dropdown -- there's no
   maintained driver roster anywhere in this app, so forcing a fixed list
   would either be empty on day one or need its own new admin screen to
   maintain. This gets most of the same benefit (picking a name already used
   instead of retyping a slightly different spelling of it) with zero new
   data model. */
function driverNamesDatalistHtml(){
  var seen = {};
  var names = [];
  state.trucks.forEach(function(t){
    [t.startedBy, t.finishedBy].forEach(function(n){
      n = (n||"").trim();
      if(n && !seen[n]){ seen[n] = true; names.push(n); }
    });
  });
  if(!names.length) return "";
  names.sort();
  return '<datalist id="driverNamesList">'+names.map(function(n){ return '<option value="'+esc(n)+'">'; }).join("")+'</datalist>';
}
function nameSettingsHtml(){
  return '<div class="scrim" data-scrim="1"><div class="sheet">'+
    '<div class="sheet-handle"></div>'+
    '<div class="sheet-head"><div><div class="sheet-id title-lg">'+tr("yourName")+'</div></div>'+
    '<button class="sheet-close" data-close="1">✕</button></div>'+
    '<div class="hint" style="margin-top:6px">'+tr("yourNameSub")+'</div>'+
    '<div class="formgrid" style="margin-top:8px">'+
      '<input class="field" id="name-input" list="driverNamesList" placeholder="'+tr("namePlaceholder")+'" value="'+esc(loadSavedName())+'">'+
      driverNamesDatalistHtml()+
    '</div>'+
    '<button class="btn primary" data-save-name="1">'+tr("saveNameBtn")+'</button>'+
  '</div></div>';
}
/* Admin settings screen (Round 23) -- one numeric field per entry in
   SETTINGS_DEFS (js/settings.js), so adding a 6th adjustable threshold later
   is a one-line addition there, not a change here. Each field shows the
   CURRENT effective value (an override already in place, or the config.js
   default if none) in display units -- see settings.js for why undoDeleteMs
   is the one exception (seconds here, milliseconds everywhere else). */
function settingsSheetHtml(){
  var rows = SETTINGS_DEFS.map(function(defn){
    var current = Math.round(defn.get() / defn.divisor);
    return '<div><div class="label">'+tr(defn.labelKey)+'</div>'+
      '<input class="field" type="number" inputmode="numeric" id="setting-'+defn.key+'" min="'+defn.min+'" max="'+defn.max+'" value="'+current+'">'+
      '<div class="hint">'+tr(defn.hintKey)+'</div></div>';
  }).join("");
  return '<div class="scrim" data-scrim="1"><div class="sheet">'+
    '<div class="sheet-handle"></div>'+
    '<div class="sheet-head"><div><div class="sheet-id title-lg">'+tr("appSettingsTitle")+'</div></div>'+
    '<button class="sheet-close" data-close="1">✕</button></div>'+
    '<div class="hint" style="margin-top:6px">'+tr("appSettingsIntro")+'</div>'+
    '<div class="formgrid" style="margin-top:12px">'+rows+'</div>'+
    (ui.settingsError ? '<div class="hint" style="color:var(--bad);margin-top:8px">'+esc(ui.settingsError)+'</div>' : '')+
    '<button class="btn primary" data-save-settings="1" '+(ui.settingsBusy?"disabled":"")+'>'+(ui.settingsBusy?tr("reportLoading"):tr("appSettingsSaveBtn"))+'</button>'+
  '</div></div>';
}
/* KPI grid over a picked date range, for a manager rather than whoever's
   watching the dock right now (see js/reporting.js). Reuses the same
   .kpi tile look as the everyday "today" strip at the top of the app,
   rather than inventing a second visual language for numbers. */
function reportKpiTilesHtml(d){
  var pctStr = d.onTimePct==null ? "—" : (d.onTimePct+"%");
  var items = [
    {v:d.total, l:tr("reportKpiTotal"), cls:""},
    {v:d.completed, l:tr("reportKpiCompleted"), cls:"good"},
    {v:pctStr, l:tr("reportKpiOnTime"), cls: d.onTimePct!=null && d.onTimePct<80 ? "bad" : "good"},
    {v:d.avgMin==null?"—":fmtHM(d.avgMin), l:tr("reportKpiAvgTime"), cls:""},
    {v:d.damageCount, l:tr("reportKpiDamage"), cls: d.damageCount ? "bad" : ""},
    {v:d.noArrivalLogged, l:tr("reportKpiNoLog"), cls: d.noArrivalLogged ? "warn" : ""},
    // Round 37: client feedback -- how many Start/End times in this range
    // were hand-corrected by an Admin rather than tapped live (see
    // statsForRows() in js/reporting.js), so a manager reading the on-time/
    // avg-duration numbers above can tell how much of the range's data was
    // touched by hand.
    {v:d.correctedCount, l:tr("reportKpiCorrected"), cls: d.correctedCount ? "warn" : ""}
  ];
  return items.map(function(k){
    return '<div class="kpi '+k.cls+'"><div class="v mono">'+k.v+'</div><div class="l">'+k.l+"</div></div>";
  }).join("");
}
/* Round 39: Theo -- "ca reprennes toute la DA de ma compagnie + logo" (this
   needs to fully carry my company's visual identity + logo). Arial and the
   official corporate palette are already app-wide (see css/app.css); the
   Reports screen specifically has no logo visible at all, since it's a
   fullscreen .sheet that covers the .topbar (and its markSvg() logo)
   underneath it. Reuses that same logo + the topbar's own blue gradient,
   see .report-brand-band in css/app.css. */
function reportBrandBandHtml(){
  return '<div class="report-brand-band">'+markSvg()+
    '<div><div class="report-brand-name">MON LOGISTICS</div><div class="report-brand-sub">'+tr("reportTitle")+'</div></div>'+
  '</div>';
}

/* ---------- Round 39: inbound trend charts ----------
   Theo: "un rapport detaillé des ibounds... avec des trends pour observer
   les trends, improvments etc." (a real report with trends to watch
   trends/improvements). The KPI tiles above are one aggregate number per
   metric for the whole picked range; these plot the same four metrics
   (Theo's own list, confirmed via the clarifying question: truck volume,
   on-time rate, avg. unloading time, damage incidents) bucket-by-bucket
   over that range instead -- see computeTrendBuckets() in reporting.js for
   how rows are grouped into the buckets these read.

   Four separate small-multiple charts, never one combined chart -- the
   measures are on different scales (trucks/day, a %, minutes), and mixing
   them onto one dual-axis chart is the #1 chart mistake per the dataviz
   skill. Plain inline SVG (viewBox-scaled, no chart library), consistent
   with this whole screen's "kept deliberately simple" design. Color
   choices reuse this app's own existing conventions rather than inventing
   a new palette: --brand (neutral/informational) for volume and the
   duration line, the same onTimePct>=80 good/bad split reportKpiTilesHtml()/
   carrierRankingHtml() already use for on-time, and --bad reserved for
   buckets that actually had a damage incident (a bucket with zero stays a
   neutral, recessive bar -- red is a status colour, not a chart series
   colour, so it's never used for "no incidents"). A muted flat stub marks
   a bucket with no ratable data at all (e.g. no arrivals yet, so no
   on-time%%), distinct from a real measured zero. */
var TREND_W = 600, TREND_H = 150, TREND_PAD = 14, TREND_TOP_Y = 12, TREND_BASE_Y = 116, TREND_LABEL_Y = 138;

function trendSlotCenters(n){
  var usable = TREND_W - TREND_PAD*2;
  var slot = usable / n;
  var centers = [];
  for(var i=0;i<n;i++) centers.push(TREND_PAD + slot*i + slot/2);
  return centers;
}
// Thins x-axis labels to at most ~7 so they never overlap on a long range
// (a 90-day daily-turned-weekly report can still be a dozen+ buckets).
function trendLabelIndexes(n){
  var maxLabels = 7;
  if(n <= maxLabels){
    var all = []; for(var i=0;i<n;i++) all.push(i); return all;
  }
  var step = Math.ceil(n/maxLabels);
  var idxs = [];
  for(var i=0;i<n;i+=step) idxs.push(i);
  var last = n-1;
  if(idxs[idxs.length-1] !== last){
    // The last bucket always gets a label (so the range's own end is
    // always visible) -- but if the regular step already left it within
    // one step of the final regular tick, appending a 9th label there
    // would crowd right up against its neighbour, so it replaces that
    // last regular tick instead of sitting beside it.
    if(idxs.length > 1 && (last - idxs[idxs.length-1]) < step){
      idxs[idxs.length-1] = last;
    } else {
      idxs.push(last);
    }
  }
  return idxs;
}
function trendAxisLabelsHtml(buckets){
  var centers = trendSlotCenters(buckets.length);
  return trendLabelIndexes(buckets.length).map(function(i){
    return '<text x="'+centers[i]+'" y="'+TREND_LABEL_Y+'" text-anchor="middle" class="trendaxislabel">'+esc(buckets[i].label)+'</text>';
  }).join("");
}
function trendBaselineHtml(){
  return '<line x1="'+TREND_PAD+'" y1="'+TREND_BASE_Y+'" x2="'+(TREND_W-TREND_PAD)+'" y2="'+TREND_BASE_Y+'" class="trendbaseline"/>';
}
// A bar's far end is rounded (4px), the end anchored to the baseline stays
// square -- per the dataviz skill's mark spec -- built as an explicit path
// (arcs on the top two corners only) rather than a plain rounded <rect>,
// which would round the baseline corners too.
function roundedTopBarPath(cx, w, base, top){
  var x = cx - w/2;
  var r = Math.min(4, (base-top)/2, w/2);
  if(r <= 0.5){
    return 'M'+x+','+base+' L'+x+','+top+' L'+(x+w)+','+top+' L'+(x+w)+','+base+' Z';
  }
  return 'M'+x+','+base+
    ' L'+x+','+(top+r)+
    ' Q'+x+','+top+' '+(x+r)+','+top+
    ' L'+(x+w-r)+','+top+
    ' Q'+(x+w)+','+top+' '+(x+w)+','+(top+r)+
    ' L'+(x+w)+','+base+' Z';
}
/* valueFn(bucket) -> a number, or null for "no data at all" (drawn as a
   short muted stub instead of a coloured bar). colorFn(bucket, value) picks
   the fill for a real value. opts.maxVal fixes the scale (e.g. 100 for a
   percentage) instead of auto-scaling from the tallest bar in view. */
function trendBarChartSvg(buckets, valueFn, colorFn, titleFn, opts){
  opts = opts || {};
  var n = buckets.length;
  var centers = trendSlotCenters(n);
  var barW = Math.max(3, Math.min(22, (TREND_W - TREND_PAD*2)/n * 0.6));
  var autoMax = Math.max.apply(null, [1].concat(buckets.map(function(b){ var v=valueFn(b); return v==null?0:v; })));
  var maxVal = opts.maxVal || autoMax;
  var plotH = TREND_BASE_Y - TREND_TOP_Y;
  var bars = buckets.map(function(b,i){
    var v = valueFn(b);
    var title = titleFn(b);
    if(v == null){
      return '<rect x="'+(centers[i]-barW/2)+'" y="'+(TREND_BASE_Y-2)+'" width="'+barW+'" height="2" rx="1" class="trendbarzero"><title>'+esc(title)+'</title></rect>';
    }
    var h = Math.max(2, (v/maxVal) * plotH);
    var top = TREND_BASE_Y - h;
    return '<path d="'+roundedTopBarPath(centers[i], barW, TREND_BASE_Y, top)+'" fill="'+colorFn(b,v)+'"><title>'+esc(title)+'</title></path>';
  }).join("");
  return '<svg viewBox="0 0 '+TREND_W+' '+TREND_H+'" class="trendchart" role="img">'+trendBaselineHtml()+bars+trendAxisLabelsHtml(buckets)+'</svg>';
}
// Line chart for avg. unloading time -- breaks into a fresh subpath at any
// bucket with no completed trucks, instead of drawing a misleading straight
// line across a gap in the data.
function trendLineChartSvg(buckets, valueFn, titleFn){
  var n = buckets.length;
  var centers = trendSlotCenters(n);
  var vals = buckets.map(valueFn);
  var known = vals.filter(function(v){ return v != null; });
  var maxVal = known.length ? Math.max.apply(null, known) : 1;
  if(maxVal <= 0) maxVal = 1;
  var plotH = TREND_BASE_Y - TREND_TOP_Y;
  var paths = [];
  var current = "";
  vals.forEach(function(v, i){
    if(v == null){
      if(current){ paths.push(current); current = ""; }
      return;
    }
    var y = TREND_BASE_Y - (v/maxVal)*plotH;
    current += (current ? " L" : "M") + centers[i] + "," + y;
  });
  if(current) paths.push(current);
  var lines = paths.map(function(d){ return '<path d="'+d+'" fill="none" class="trendline"/>'; }).join("");
  var dots = vals.map(function(v, i){
    if(v == null) return "";
    var y = TREND_BASE_Y - (v/maxVal)*plotH;
    return '<circle cx="'+centers[i]+'" cy="'+y+'" r="4" class="trenddot"><title>'+esc(titleFn(buckets[i]))+'</title></circle>';
  }).join("");
  return '<svg viewBox="0 0 '+TREND_W+' '+TREND_H+'" class="trendchart" role="img">'+trendBaselineHtml()+lines+dots+trendAxisLabelsHtml(buckets)+'</svg>';
}

function reportTrendVolumeChartHtml(buckets){
  return trendBarChartSvg(buckets,
    function(b){ return b.stats.total; },
    function(){ return "var(--brand)"; },
    function(b){ return tr("reportTrendTipVolume").replace("{period}", b.label).replace("{n}", b.stats.total); }
  );
}
function reportTrendOnTimeChartHtml(buckets){
  return trendBarChartSvg(buckets,
    function(b){ return b.stats.onTimePct; },
    function(b, v){ return v < 80 ? "var(--bad)" : "var(--good)"; },
    function(b){
      return b.stats.onTimePct == null
        ? tr("reportTrendTipOnTimeNoData").replace("{period}", b.label)
        : tr("reportTrendTipOnTime").replace("{period}", b.label).replace("{pct}", b.stats.onTimePct).replace("{on}", b.stats.onTime).replace("{rated}", b.stats.onTimeRated);
    },
    { maxVal: 100 }
  );
}
function reportTrendAvgDurationChartHtml(buckets){
  return trendLineChartSvg(buckets,
    function(b){ return b.stats.avgMin; },
    function(b){
      return b.stats.avgMin == null
        ? tr("reportTrendTipAvgDurationNoData").replace("{period}", b.label)
        : tr("reportTrendTipAvgDuration").replace("{period}", b.label).replace("{v}", fmtHM(b.stats.avgMin));
    }
  );
}
function reportTrendDamageChartHtml(buckets){
  return trendBarChartSvg(buckets,
    function(b){ return b.stats.damageCount; },
    function(b, v){ return v > 0 ? "var(--bad)" : "var(--line-strong)"; },
    function(b){ return tr("reportTrendTipDamage").replace("{period}", b.label).replace("{n}", b.stats.damageCount); }
  );
}
function reportTrendChartCardHtml(titleKey, svgHtml){
  return '<div class="trendcard"><div class="trendcard-title">'+tr(titleKey)+'</div>'+svgHtml+'</div>';
}
// Accessible alternative to the four charts above -- same raw numbers, one
// row per bucket, collapsed behind a <details> disclosure (same pattern
// already used for "all source fields" elsewhere on this screen).
function reportTrendTableHtml(buckets){
  var rows = buckets.map(function(b){
    var s = b.stats;
    return '<tr><td>'+esc(b.label)+'</td>'+
      '<td>'+s.total+'</td>'+
      '<td>'+(s.onTimePct==null?"—":s.onTimePct+"%")+'</td>'+
      '<td>'+(s.avgMin==null?"—":fmtHM(s.avgMin))+'</td>'+
      '<td>'+s.damageCount+'</td></tr>';
  }).join("");
  return '<details class="trendtable-details">'+
    '<summary class="label" style="cursor:pointer">'+tr("reportTrendTableToggle")+'</summary>'+
    '<div style="overflow-x:auto;margin-top:10px"><table class="trendtable"><thead><tr>'+
      '<th>'+tr("reportTrendColPeriod")+'</th>'+
      '<th>'+tr("reportTrendColVolume")+'</th>'+
      '<th>'+tr("reportTrendColOnTime")+'</th>'+
      '<th>'+tr("reportTrendColAvgDuration")+'</th>'+
      '<th>'+tr("reportTrendColDamage")+'</th>'+
    '</tr></thead><tbody>'+rows+'</tbody></table></div>'+
  '</details>';
}
function reportTrendChartsHtml(trend){
  if(!trend || !trend.buckets || !trend.buckets.length) return "";
  var buckets = trend.buckets;
  var hint = trend.granularity === "week" ? tr("reportTrendHintWeek") : tr("reportTrendHintDay");
  return '<div class="sheet-section" style="border-top:1px solid var(--line);margin-top:16px;padding-top:16px">'+
    '<div class="label">'+tr("reportTrendTitle")+'</div>'+
    '<div class="hint" style="margin-top:4px">'+esc(hint)+'</div>'+
    '<div class="trendgrid" style="margin-top:10px">'+
      reportTrendChartCardHtml("reportTrendVolume", reportTrendVolumeChartHtml(buckets))+
      reportTrendChartCardHtml("reportTrendOnTime", reportTrendOnTimeChartHtml(buckets))+
      reportTrendChartCardHtml("reportTrendAvgDuration", reportTrendAvgDurationChartHtml(buckets))+
      reportTrendChartCardHtml("reportTrendDamage", reportTrendDamageChartHtml(buckets))+
    '</div>'+
    reportTrendTableHtml(buckets)+
  '</div>';
}

function reportSheetHtml(){
  var busy = !!ui.reportBusy;
  var errHtml = ui.reportError ? '<div class="hint" style="color:var(--bad);margin-top:10px">'+esc(ui.reportError)+'</div>' : "";
  var d = ui.reportData;
  var resultsHtml = "";
  if(d){
    resultsHtml = '<div class="hint" style="margin-top:14px">'+
        tr("reportRatedNote").replace("{n}", d.onTimeRated)+
      '</div>'+
      '<div class="kpis" style="margin-top:8px">'+reportKpiTilesHtml(d)+'</div>'+
      '<button class="btn ghost" data-export-report-csv="1">⬇️ '+tr("reportExportCsvBtn")+'</button>'+
      reportTrendChartsHtml(ui.reportTrend)+
      carrierRankingHtml(ui.reportRows);
  }
  return '<div class="scrim" data-scrim="1"><div class="sheet">'+
    reportBrandBandHtml()+
    '<div class="sheet-handle"></div>'+
    '<div class="sheet-head"><div><div class="sheet-id title-lg">'+tr("reportTitle")+'</div></div>'+
    '<button class="sheet-close" data-close="1">✕</button></div>'+
    '<div class="hint" style="margin-top:6px">'+tr("reportIntro")+'</div>'+
    '<div class="formgrid" style="margin-top:12px">'+
      '<div><div class="label">'+tr("reportFrom")+'</div><input class="field" type="date" id="report-from" value="'+esc(ui.reportFrom)+'"></div>'+
      '<div><div class="label">'+tr("reportTo")+'</div><input class="field" type="date" id="report-to" value="'+esc(ui.reportTo)+'"></div>'+
    '</div>'+
    errHtml+
    '<button class="btn primary" data-run-report="1" '+(busy?"disabled":"")+'>'+(busy?tr("reportLoading"):tr("reportRunBtn"))+'</button>'+
    resultsHtml+
    archiveBlockHtml()+
  '</div></div>';
}
/* ---------- Admin truck-history screen (Round 26) ----------
   Read side of the audit trail js/actions.js writes to (logTruckEvent() ->
   sbLogTruckEvent() in api.js) next to every meaningful truck action. Same
   "pick a date range, Generate, show a list" shape as the Reports screen
   just above, driven by js/history.js's openHistory()/runHistory(). */
function historyActionLabel(action){
  var map = {
    created: tr("histActionCreated"),
    arrived: tr("histActionArrived"),
    completed: tr("histActionCompleted"),
    cancelled: tr("histActionCancelled"),
    reopened: tr("histActionReopened"),
    eta_changed: tr("histActionEtaChanged"),
    remark_updated: tr("histActionRemarkUpdated"),
    deleted: tr("histActionDeleted"),
    signature_saved: tr("histActionSignatureSaved"),
    start_time_corrected: tr("histActionStartTimeCorrected"),
    end_time_corrected: tr("histActionEndTimeCorrected")
  };
  return map[action] || action;
}
function historyRowHtml(r){
  var when = "";
  if(r.createdAt){
    var dt = new Date(r.createdAt);
    if(!isNaN(dt.getTime())) when = shortDate(dt.toISOString().slice(0,10)) + " " + dt.toTimeString().slice(0,5);
  }
  return '<div class="importrow">'+
    '<b>'+esc(when)+'</b> · '+esc(historyActionLabel(r.action))+
    (r.truckLabel ? ' · <span class="mono">'+esc(r.truckLabel)+'</span>' : '')+
    (r.actor ? ' · '+esc(r.actor) : '')+
    (r.detail ? ' — '+esc(r.detail) : '')+
  '</div>';
}
function historySheetHtml(){
  var busy = !!ui.historyBusy;
  var errHtml = ui.historyError ? '<div class="hint" style="color:var(--bad);margin-top:10px">'+esc(ui.historyError)+'</div>' : "";
  var rows = ui.historyRows;
  var resultsHtml = "";
  if(rows){
    resultsHtml = rows.length
      ? '<div class="importpreview" style="margin-top:12px">'+rows.map(historyRowHtml).join("")+'</div>'
      : '<div class="hint" style="margin-top:12px">'+tr("historyNoRows")+'</div>';
  }
  return '<div class="scrim" data-scrim="1"><div class="sheet">'+
    '<div class="sheet-handle"></div>'+
    '<div class="sheet-head"><div><div class="sheet-id title-lg">'+tr("historyTitle")+'</div></div>'+
    '<button class="sheet-close" data-close="1">✕</button></div>'+
    '<div class="hint" style="margin-top:6px">'+tr("historyIntro")+'</div>'+
    '<div class="formgrid" style="margin-top:12px">'+
      '<div><div class="label">'+tr("reportFrom")+'</div><input class="field" type="date" id="history-from" value="'+esc(ui.historyFrom)+'"></div>'+
      '<div><div class="label">'+tr("reportTo")+'</div><input class="field" type="date" id="history-to" value="'+esc(ui.historyTo)+'"></div>'+
    '</div>'+
    errHtml+
    '<button class="btn primary" data-run-history="1" '+(busy?"disabled":"")+'>'+(busy?tr("reportLoading"):tr("reportRunBtn"))+'</button>'+
    resultsHtml+
  '</div></div>';
}
/* ---------- Admin "Archive" screen (Round 27) ----------
   Read-only browse of actual trucks (not aggregated numbers) over a picked
   date range, driven by js/archiveList.js's openArchiveList()/
   runArchiveList() -- same "pick a date range, Generate, show a list" shape
   as Reporting/History just above, see js/archiveList.js's own top comment
   for why this stays look-only rather than opening the normal truck sheet. */
function archiveListStateLabel(s){
  if(s === "completed") return tr("status_done");
  if(s === "arrived") return tr("status_unloading");
  return tr("status_pending");
}
function archiveListRowHtml(r){
  var productLine = r.details ? (' · '+esc(r.details)+(r.qtt?(' ('+esc(r.qtt)+')'):'')) : "";
  var damage = (r.damageRemark && r.damageRemark.trim())
    ? ' · <span style="color:var(--bad)">⚠ '+esc(tr("damageBadge"))+'</span>' : "";
  // Round 29: a checkbox per row for the bulk plant/carrier reassignment
  // toolbar below (archiveBulkToolbarHtml()) -- wrapped in a <label> so
  // tapping the row text also toggles it, same as importsheetrow's own
  // checkbox rows on the import screen. Purely additive to the existing
  // read-only line: nothing here opens the normal truck sheet (see
  // js/archiveList.js's top comment for why that stays out of scope).
  var checked = ui.archiveListSelected[r.id] ? " checked" : "";
  return '<label class="importrow" style="display:flex;align-items:flex-start;gap:8px;cursor:pointer">'+
    '<input type="checkbox" data-archive-row-select="'+esc(r.id)+'"'+checked+' style="margin-top:2px;flex:none">'+
    '<span>'+
    '<b>'+shortDate(r.date)+(r.eta?(' '+esc(r.eta)):'')+'</b> · '+esc(r.truckLabel||r.poNo||"—")+
    (r.carrier?(' · '+esc(r.carrier)):'')+
    (r.plant?(' · '+esc(r.plant)):'')+
    productLine+
    ' · '+esc(archiveListStateLabel(r.truckState))+
    damage+
    '</span>'+
  '</label>';
}
/* Round 29: bulk-reassign plant/carrier across every selected row -- the one
   deliberate exception to this screen's "look, don't touch" design (see
   js/archiveList.js's top comment): editing a truck's plant/carrier metadata
   doesn't need it loaded into state.trucks the way opening its detail sheet
   would, so it stays safe to do straight from this list. Only rendered once
   a search has actually returned rows; hidden entirely otherwise so the
   screen looks exactly as before until Generate is run. */
function archiveBulkToolbarHtml(rows){
  var selectedCount = rows.filter(function(r){ return ui.archiveListSelected[r.id]; }).length;
  var allChecked = selectedCount > 0 && selectedCount === rows.length;
  var busy = !!ui.archiveBulkBusy;
  var errHtml = ui.archiveBulkError ? '<div class="hint" style="color:var(--bad);margin-top:6px">'+esc(ui.archiveBulkError)+'</div>' : "";
  return '<div style="margin-top:12px;padding:11px 12px;background:var(--surface-2);border-radius:10px">'+
    '<label style="display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;cursor:pointer">'+
      '<input type="checkbox" data-archive-select-all="1"'+(allChecked?" checked":"")+'>'+
      (selectedCount ? esc(tr("archiveBulkSelectedCount").replace("{n}", selectedCount)) : esc(tr("archiveSelectAll")))+
    '</label>'+
    '<div class="formgrid" style="margin-top:8px">'+
      '<div><div class="label">'+tr("fieldPlant")+'</div><input class="field" type="text" id="archive-bulk-plant" placeholder="'+esc(tr("phPlant"))+'" value="'+esc(ui.archiveBulkPlant)+'"></div>'+
      '<div><div class="label">'+tr("fieldCarrier")+'</div><input class="field" type="text" id="archive-bulk-carrier" placeholder="'+esc(tr("phCarrier"))+'" value="'+esc(ui.archiveBulkCarrier)+'"></div>'+
    '</div>'+
    '<button class="btn primary" data-archive-bulk-apply="1" style="margin-top:8px;width:100%" '+((selectedCount && !busy) ? "" : "disabled")+'>'+(busy?tr("reportLoading"):tr("archiveBulkApplyBtn"))+'</button>'+
    '<div class="hint" style="margin-top:6px">'+tr("archiveBulkHint")+'</div>'+
    errHtml+
  '</div>';
}
function archiveListSheetHtml(){
  var busy = !!ui.archiveListBusy;
  var errHtml = ui.archiveListError ? '<div class="hint" style="color:var(--bad);margin-top:10px">'+esc(ui.archiveListError)+'</div>' : "";
  var rows = ui.archiveListRows;
  var resultsHtml = "";
  if(rows){
    if(rows.length){
      resultsHtml = archiveBulkToolbarHtml(rows)+
        '<div class="importpreview" style="margin-top:12px">'+rows.map(archiveListRowHtml).join("")+'</div>';
      if(rows.length >= 1000){
        resultsHtml += '<div class="hint" style="margin-top:6px">'+tr("archiveListTooMany")+'</div>';
      }
    } else {
      resultsHtml = '<div class="hint" style="margin-top:12px">'+tr("archiveListNoRows")+'</div>';
    }
  }
  return '<div class="scrim" data-scrim="1"><div class="sheet">'+
    '<div class="sheet-handle"></div>'+
    '<div class="sheet-head"><div><div class="sheet-id title-lg">'+tr("archiveListTitle")+'</div></div>'+
    '<button class="sheet-close" data-close="1">✕</button></div>'+
    '<div class="hint" style="margin-top:6px">'+tr("archiveListIntro")+'</div>'+
    '<div class="formgrid" style="margin-top:12px">'+
      '<div><div class="label">'+tr("reportFrom")+'</div><input class="field" type="date" id="archive-list-from" value="'+esc(ui.archiveListFrom)+'"></div>'+
      '<div><div class="label">'+tr("reportTo")+'</div><input class="field" type="date" id="archive-list-to" value="'+esc(ui.archiveListTo)+'"></div>'+
    '</div>'+
    errHtml+
    '<button class="btn primary" data-run-archive-list="1" '+(busy?"disabled":"")+'>'+(busy?tr("reportLoading"):tr("reportRunBtn"))+'</button>'+
    resultsHtml+
  '</div></div>';
}
/* ---------- Carrier on-time ranking (Round 27) ----------
   A small always-relative (never a second axis) horizontal-bar ranking under
   the Reporting screen's own KPI tiles -- same rows (ui.reportRows), grouped
   per carrier by computeCarrierStats() (js/reporting.js) instead of summed
   into one total. Sorted worst-on-time-first so the carrier most worth a
   conversation is the first thing seen, not something to hunt for. Bar color
   reuses the exact same good/bad threshold (>=80% good) the KPI tile above
   already uses (reportKpiTilesHtml) -- one consistent meaning for that color
   across this whole screen, not a second palette to learn. No dual axis, one
   measure per bar, direct label (name + %) -- kept deliberately as simple as
   every other number on this screen (no tooltip/hover), consistent with the
   fact that nothing else in this app is an interactive chart either. */
function carrierRankingHtml(rows){
  if(!rows || !rows.length) return "";
  var stats = computeCarrierStats(rows);
  if(!stats.length) return "";
  var items = stats.map(function(s){
    var known = s.onTimePct != null;
    var barColor = known && s.onTimePct < 80 ? "var(--bad)" : "var(--good)";
    var bar = known
      ? '<div class="carrierbar-track"><div class="carrierbar-fill" style="width:'+s.onTimePct+'%;background:'+barColor+'"></div></div>'
      : '';
    return '<div class="carrierrow">'+
      '<div class="carrierrow-head"><b>'+esc(s.carrier)+'</b><span class="mono">'+(known?(s.onTimePct+"%"):"—")+'</span></div>'+
      bar+
      '<div class="hint">'+tr("reportCarrierMeta").replace("{total}", s.total).replace("{damage}", s.damageCount)+'</div>'+
    '</div>';
  }).join("");
  return '<div class="sheet-section" style="border-top:1px solid var(--line);margin-top:16px;padding-top:16px">'+
    '<div class="label">'+tr("reportCarrierTitle")+'</div>'+
    '<div class="hint" style="margin-top:4px">'+tr("reportCarrierHint")+'</div>'+
    '<div class="carrierranking" style="margin-top:10px">'+items+'</div>'+
  '</div>';
}
/* Round 25: "Bon pour les archives on peut ajouter un bouton et ca
   download tout mais ca supprimes rien. Mon departement IT s en occupera
   eux meme de cela" -- Theo's final, locked-in spec. Admin MON IT only
   (isAdminIt() -- the one capability that sets it apart from Admin MON),
   reuses this same screen's own report-from/report-to date fields rather
   than duplicating them. Purely a bulk download: see
   downloadPhotosArchive() in photoDownload.js and runPhotoArchive() in
   reporting.js -- neither one calls any delete endpoint. Any retention/
   cleanup decision is entirely MON IT's own manual responsibility outside
   this app. */
function archiveBlockHtml(){
  if(!isAdminIt()) return "";
  var busy = !!ui.archiveBusy;
  return '<div class="sheet-section" style="border-top:1px solid var(--line);margin-top:16px;padding-top:16px">'+
    '<div class="label">'+tr("archiveTitle")+'</div>'+
    '<div class="hint" style="margin-top:6px">'+tr("archiveHint")+'</div>'+
    '<button class="btn ghost" data-download-archive="1" style="margin-top:10px" '+(busy?"disabled":"")+'>'+
      (busy ? tr("archiveBusy") : "⬇️ "+tr("archiveDownloadBtn"))+
    '</button>'+
  '</div>';
}
function importSheetHtml(){
  var busy = !!ui.importBusy;
  var errHtml = ui.importError ? '<div class="hint" style="color:var(--bad);margin-top:10px">'+esc(ui.importError)+'</div>' : "";
  var body;
  if(!hasImportFile()){
    body = '<div class="hint" style="margin-top:6px">'+tr("importIntro")+'</div>'+
      '<div class="formgrid" style="margin-top:12px">'+
        '<input class="field" type="file" id="importFileInput" accept=".xlsx,.xls,.csv" '+(busy?"disabled":"")+'>'+
      '</div>'+errHtml;
  } else if(ui.importStep === "preview"){
    var r = ui.importResult || { toImport:[], toUpdate:[], dupeCount:0, updateCount:0, pastCount:0 };
    var toUpdateList = r.toUpdate || [];
    // Round 30 (reverts Round 28, restores Round 26): each entry is its own
    // truck again (importAssignLabels in importPlan.js) — rows sharing a
    // PO+date+time+carrier slot show their "<PO> - Truck N" label instead of
    // a merged "N lots" badge, so it's clear at a glance they'll import as
    // separate trucks.
    function importRowLine(g, isUpdate){
      var label = g.truckLabel ? (' <span class="chip">'+esc(g.truckLabel)+'</span>') : "";
      // Round 31: "Call off" entries carry `lots` again (importGroupCallOffRows)
      // -- shown here the same way the old Round 28 preview badge did, since
      // it's genuinely useful to see at a glance that a trip bundles several
      // batches before confirming the import.
      var lotsBadge = (g.lots && g.lots.length > 1) ? (' <span class="chip">'+esc(tr("multiLotBadge").replace("{n}", g.lots.length))+'</span>') : "";
      // Round 36: a matched "will be updated instead of duplicated" row gets
      // its own chip, so the admin can see which entries in the preview are
      // brand-new trucks and which are corrections to something already
      // imported, before confirming either.
      var updChip = isUpdate ? (' <span class="chip">'+esc(tr("importUpdateChip"))+'</span>') : "";
      return '<div class="importrow"><b>'+esc(g.order_date)+(g.eta?(" "+esc(g.eta)):"")+'</b> · '+esc(g.carrier||"—")+
        (g.details?(' · '+esc(g.details)):"")+(g.qtt?(' ('+esc(g.qtt)+')'):"")+label+lotsBadge+updChip+'</div>';
    }
    var rows = r.toImport.slice(0,12).map(function(g){ return importRowLine(g, false); }).join("")+
      toUpdateList.slice(0,12).map(function(u){ return importRowLine(u.g, true); }).join("");
    var moreNew = r.toImport.length > 12 ? '<div class="hint" style="margin-top:4px">'+tr("importMoreRows").replace("{n}", r.toImport.length-12)+'</div>' : "";
    var moreUpd = toUpdateList.length > 12 ? '<div class="hint" style="margin-top:4px">'+tr("importMoreRows").replace("{n}", toUpdateList.length-12)+'</div>' : "";
    var more = moreNew + moreUpd;
    var updateNotice = r.updateCount ? '<div class="hint" style="margin-top:4px">'+tr("importUpdateNotice").replace("{n}", r.updateCount)+'</div>' : "";
    var totalCount = r.toImport.length + toUpdateList.length;
    body = '<div class="hint" style="margin-top:6px">'+
        tr("importSummary").replace("{n}", r.toImport.length).replace("{dupe}", r.dupeCount).replace("{past}", r.pastCount)+
      '</div>'+updateNotice+
      '<div class="importpreview">'+(rows || '<div class="hint">'+tr("importNothingToImport")+'</div>')+'</div>'+more+
      errHtml+
      '<button class="btn primary" data-import-confirm="1" '+(busy || !totalCount ? "disabled" : "")+'>'+
        (busy ? tr("importSaving") : tr("importConfirmBtn").replace("{n}", totalCount))+
      '</button>'+
      '<button class="linklike" data-import-back="1" '+(busy?"disabled":"")+'>'+tr("back")+'</button>';
  } else {
    var rowsHtml = importSheetNames().map(function(name){
      var checked = ui.importSelected[name] ? "checked" : "";
      return '<label class="importsheetrow"><input type="checkbox" data-import-sheet-toggle="'+esc(name)+'" '+checked+'> '+esc(name)+'</label>';
    }).join("");
    body = '<div class="hint" style="margin-top:6px">'+esc(importFileName())+'</div>'+
      '<div class="formgrid" style="margin-top:12px">'+
        '<div><div class="label">'+tr("importFromDate")+'</div><input class="field" type="date" id="import-from-date" value="'+esc(ui.importFromDate)+'"></div>'+
        '<div><div class="label">'+tr("importPlant")+'</div><input class="field" id="import-plant" value="'+esc(ui.importPlant)+'"></div>'+
      '</div>'+
      '<div class="label" style="margin-top:16px">'+tr("importPickSheets")+'</div>'+
      '<div class="importsheetlist">'+rowsHtml+'</div>'+
      errHtml+
      '<button class="btn primary" data-import-preview="1" '+(busy?"disabled":"")+'>'+(busy?tr("importParsing"):tr("importPreviewBtn"))+'</button>';
  }
  return '<div class="scrim" data-scrim="1"><div class="sheet">'+
    '<div class="sheet-handle"></div>'+
    '<div class="sheet-head"><div><div class="sheet-id title-lg">'+tr("importPlanTitle")+'</div></div>'+
    '<button class="sheet-close" data-close="1">✕</button></div>'+
    body+
  '</div></div>';
}
function photosHtml(t){
  if(!supabaseEnabled()){
    return '<div class="sheet-section"><div class="label">'+tr("photosTitle")+'</div>'+
      '<div class="hint" style="margin-top:6px">'+tr("photosNeedSupabase")+'</div></div>';
  }
  var photos = t.photos || [];
  var maxPhotos = getMaxPhotosPerTruck();
  // Round 23: each thumbnail used to be a plain <a target="_blank"> straight
  // to the raw Storage URL -- taps it now instead of navigating away (see
  // photoViewerHtml() below). The admin-only remove "✕" stays a sibling
  // button, not nested inside the view button, so tapping it can never also
  // open the viewer (see events.js's click delegation).
  var slots = photos.map(function(p, idx){
    var rm = isAdmin() ? '<button class="photoslot-rm" data-photo-remove="'+esc(p.id)+'" data-photo-truck="'+esc(t.id)+'" data-photo-path="'+esc(p.storagePath)+'" aria-label="Remove">✕</button>' : "";
    return '<div class="photoslot"><button class="photoslot-view" data-view-photo="'+esc(t.id)+'" data-view-index="'+idx+'"><img src="'+esc(p.url)+'" loading="lazy"></button>'+rm+'</div>';
  }).join("");
  // Round 25: Nestlé can view and download photos but doesn't add any --
  // Theo's own phrasing ("upload le fichier") was about the inbound-plan
  // import, not photo uploads, so the two add-photo tiles stay hidden here.
  if(photos.length < maxPhotos && !isNestle()){
    // Two separate tiles rather than one generic "+" (pre-Round 19): on a
    // real Android phone, the single file input below has no `capture`
    // attribute (removed at Round 9 so `multiple` could enable picking
    // several existing photos at once) — but Android's own file/photo
    // chooser, when `multiple` is set, frequently drops the "Camera" shortcut
    // from that generic chooser entirely (a single camera shot can't satisfy
    // "pick several", so many devices/OEM pickers just omit it), leaving only
    // Gallery/Files. Reported by a manager on site: "can't take a photo from
    // android mobile phone". A single input can't have it both ways
    // (`capture` forces the camera open directly and can only ever return
    // one file, `multiple` needs no `capture` to allow a multi-pick) — so
    // this is two distinct tiles backed by two distinct hidden inputs
    // instead: one that always launches the camera directly (`capture`,
    // single shot), one that always opens the gallery/file chooser
    // (`multiple`, no capture) for picking several at once. Guarantees camera
    // access regardless of what any given device's generic chooser offers.
    slots += '<button class="photoslot add" data-photo-add-camera="'+esc(t.id)+'"><span style="font-size:20px;line-height:1">📷</span><span>'+tr("addPhotoCamera")+'</span></button>'+
      '<button class="photoslot add" data-photo-add-gallery="'+esc(t.id)+'"><span style="font-size:20px;line-height:1">🖼️</span><span>'+tr("addPhotoGallery")+'</span></button>';
  }
  // Download-all button, only once there's at least one photo to bundle —
  // requested by a manager on site who compared it to an existing "FG
  // export" download elsewhere in MON's tools (see js/photoDownload.js for
  // how the zip itself is built). Same `.btn.ghost` treatment as the CSV
  // export button (Round 17.1's lesson: a real button, not a discreet text
  // link, for anything meant to be reliably noticed and clicked).
  var downloadBtn = photos.length
    ? '<button class="btn ghost" data-download-photos="'+esc(t.id)+'" style="margin-top:8px">⬇️ '+tr("downloadPhotosBtn")+'</button>'
    : "";
  return '<div class="sheet-section"><div class="label">'+tr("photosTitle")+'</div>'+
    '<div class="hint">'+tr("photosHint").replace("{n}", maxPhotos)+'</div>'+
    '<div class="photogrid">'+slots+'</div>'+downloadBtn+'</div>';
}

/* Fullscreen photo viewer (Round 23) -- opened by tapping any thumbnail in
   photosHtml() above. Looks the photo up fresh from state.trucks (rather
   than trusting ui.photoViewer to have cached a copy) so a photo removed by
   someone else mid-view (Supabase poll) is handled gracefully -- see the
   empty-photos guard below, which just closes the viewer instead of
   crashing on an out-of-range index. */
function photoViewerHtml(){
  if(!ui.photoViewer) return "";
  var t = state.trucks.find(function(x){ return x.id === ui.photoViewer.truckId; });
  var photos = (t && t.photos) || [];
  if(!photos.length) return "";
  var idx = Math.max(0, Math.min(ui.photoViewer.index, photos.length-1));
  var p = photos[idx];
  var multi = photos.length > 1;
  return '<div class="photoviewer">'+
    '<button class="photoviewer-close" data-photo-viewer-close="1" aria-label="'+tr("closeViewerAria")+'">✕</button>'+
    (multi ? '<button class="photoviewer-nav prev" data-photo-viewer-prev="1" aria-label="'+tr("prevPhotoAria")+'">‹</button>' : '')+
    '<img class="photoviewer-img'+(ui.photoViewer.zoomed?" zoomed":"")+'" src="'+esc(p.url)+'" data-photo-viewer-zoom="1" alt="">'+
    (multi ? '<button class="photoviewer-nav next" data-photo-viewer-next="1" aria-label="'+tr("nextPhotoAria")+'">›</button>' : '')+
    (multi ? '<div class="photoviewer-count mono">'+(idx+1)+' / '+photos.length+'</div>' : '')+
  '</div>';
}
/* A single free-text remark per truck (not per photo, per Theo's choice) —
   e.g. noting which layer of the container damaged product was found on,
   used as evidence for a supplier claim (Round 13 request from Khun
   Badeeson). Editable by anyone at any time, saved via saveDamageRemark()
   in actions.js — same "plain field + button" pattern as the ETA input
   above, just always visible instead of only while a truck is still
   schedulable. Needs Supabase (nothing to sync otherwise) exactly like
   photos, so it's hidden in local-only mode for the same reason. */
function damageRemarkHtml(t){
  if(!supabaseEnabled()) return "";
  // Round 25: locked in via AskUserQuestion -- Nestlé never sees the damage
  // remark (list + ETA + photos + import only).
  if(isNestle()) return "";
  return '<div class="sheet-section"><div class="label">'+tr("damageRemarkTitle")+'</div>'+
    '<div class="hint">'+tr("damageRemarkHint")+'</div>'+
    '<textarea class="field" rows="3" id="damageRemarkInput" placeholder="'+tr("damageRemarkPlaceholder")+'" style="margin-top:8px;resize:vertical">'+esc(t.damageRemark||"")+'</textarea>'+
    '<button class="btn primary" data-save-remark="'+esc(t.id)+'" style="margin-top:8px">'+tr("saveRemarkBtn")+'</button></div>';
}
/* Round 27: an optional signature (driver or receiving-side confirmation),
   captured on whatever device is at hand (phone or the Windows PC some
   managers use, see Round 17.1) -- same "plain field + button", edit-any-
   time shape as the damage remark above rather than being tied to the
   truck's start/finish lifecycle. Needs Supabase (nothing to sync locally,
   and since Round 29 the drawing itself is uploaded to Supabase Storage --
   see sbUploadSignature() in js/api.js -- with trucks.signature just
   holding that file's URL) and stays out of Nestlé's view, both for the
   same reasons damageRemarkHtml() above does.
   The actual drawing happens on a <canvas> via direct pointer-event
   delegation in events.js, deliberately bypassing render() for every single
   stroke (rebuilding #app mid-stroke would wipe the canvas clean) -- this
   function only ever renders one of two states (blank canvas to draw a new
   one, or the already-saved image), toggled by ui.signatureEditing. */
function signatureHtml(t){
  if(!supabaseEnabled()) return "";
  if(isNestle()) return "";
  var editing = ui.signatureEditing || !t.signature;
  var body;
  if(editing){
    body = '<canvas id="signatureCanvas" class="signature-canvas" width="300" height="140"></canvas>'+
      '<div class="signature-actions">'+
        '<button class="linklike" data-clear-signature="1">'+tr("signatureClearBtn")+'</button>'+
        '<button class="btn primary" data-save-signature="'+esc(t.id)+'">'+tr("signatureSaveBtn")+'</button>'+
      '</div>';
  } else {
    body = '<img class="signature-preview" src="'+esc(t.signature)+'" alt="'+esc(tr("signatureTitle"))+'">'+
      '<button class="linklike" data-edit-signature="1">'+tr("signatureRedoBtn")+'</button>';
  }
  return '<div class="sheet-section"><div class="label">'+tr("signatureTitle")+'</div>'+
    '<div class="hint">'+tr("signatureHint")+'</div>'+
    '<div style="margin-top:8px">'+body+'</div>'+
  '</div>';
}
function toastHtml(){
  // A pending delete (see deleteTruck() in actions.js) pre-empts whatever
  // ui.toast would otherwise show -- there's normally nothing else to show
  // at that exact moment anyway (deleteTruck doesn't call showToast()), and
  // this guarantees the Undo button is never accidentally covered by an
  // unrelated toast racing in during the undo window.
  if(ui.pendingDeleteId){
    return '<div class="toast"><span>'+esc(tr("truckDeletedUndo").replace("{label}", ui.pendingDeleteLabel||""))+'</span>'+
      '<button class="toast-retry" data-undo-delete="1">'+tr("undo")+'</button></div>';
  }
  if(!ui.toast) return "";
  var retry = ui.retryAction ? '<button class="toast-retry" data-toast-retry="1">'+tr("retry")+'</button>' : "";
  return '<div class="toast"><span>'+esc(ui.toast)+"</span>"+retry+"</div>";
}
function syncDotClass(){
  return { local:"local", connecting:"local", saving:"saving", synced:"", error:"err", queued:"warn" }[ui.syncStatus] || "";
}
function syncLabel(){
  return { local:tr("sync_local"), connecting:tr("sync_connecting"), saving:tr("sync_saving"), synced:tr("sync_synced"), error:tr("sync_error"), queued:tr("sync_queued") }[ui.syncStatus] || "";
}
/* Small "N pending" badge next to the sync dot, shown whenever the offline
   action queue (js/offlineQueue.js) has anything in it -- independent of
   ui.syncStatus, which only reflects the *last* call's outcome. A driver who
   queued a Start five minutes ago and then successfully saved a photo just
   after should still see that the Start is still waiting to go out. */
function offlineQueueBadgeHtml(){
  var n = offlineQueueCount();
  if(!n) return "";
  return '<span class="queuebadge">'+esc(tr("offlineQueuePending").replace("{n}", n))+'</span>';
}
/* Visible "next refresh in…" countdown next to the sync dot (Round 21,
   mirroring MON's Outbound admin tool) -- absent entirely in local-only
   mode (nothing to poll, so ui.nextPollAt stays null, see main.js/state.js).
   Only the initial text comes from here; every second after that, tick()
   (js/ticking.js) updates #pollCountdownEl directly without a full
   render() -- see the comment there for why. */
function pollCountdownHtml(now){
  if(!supabaseEnabled() || ui.nextPollAt == null) return "";
  return '<span class="pollcountdown mono" id="pollCountdownEl" aria-label="'+tr("nextRefreshAria")+'">'+
    fmtElapsed(ui.nextPollAt - now)+'</span>';
}
/* Collapsed-by-default legend explaining every status color/badge (Round
   21) -- Outbound's admin tool has an always-open one at the foot of its
   order list ("คำอธิบายสถานะ / Status Legend"); kept as a native <details>
   here instead of always-open so it doesn't cost a driver any screen space
   on a phone until they actually want it (Theo's condition on this whole
   round: stay simple to look at on both phone and web). "duesoon" is
   additive to "scheduled" everywhere else in this file (see isDueSoon() in
   js/status.js) and has no entry of its own in STATUS_KEYS, so it gets its
   own title string here rather than reusing one meant for something else. */
function legendRowsHtml(){
  var entries = [
    {cls:"pending", title:tr("status_pending"), desc:tr("legendDesc_pending")},
    {cls:"urgent", title:tr("status_urgent"), desc:tr("legendDesc_urgent")},
    {cls:"scheduled", title:tr("status_scheduled"), desc:tr("legendDesc_scheduled")},
    // Round 23: "due soon" used to hard-code "15 minutes" -- now that
    // dueSoonMin is admin-adjustable (js/settings.js), the legend has to
    // read the live value too, or it would start lying the moment someone
    // changes it from the new settings screen.
    {cls:"duesoon", title:tr("legendDueSoonTitle"), desc:tr("legendDesc_duesoon").replace("{n}", getDueSoonMin())},
    {cls:"late", title:tr("status_late"), desc:tr("legendDesc_late")},
    {cls:"unloading", title:tr("status_unloading"), desc:tr("legendDesc_unloading")},
    {cls:"done", title:tr("status_done"), desc:tr("legendDesc_done")}
  ];
  return entries.map(function(e){
    return '<div class="legendrow"><span class="legendswatch '+e.cls+'"></span>'+
      '<div class="legendtext"><b>'+esc(e.title)+'</b><span>'+esc(e.desc)+'</span></div></div>';
  }).join("");
}
function statusLegendHtml(){
  return '<details class="statuslegend"><summary>📊 '+tr("legendTitle")+'</summary>'+
    '<div class="legendgrid">'+legendRowsHtml()+'</div></details>';
}
/* Same legend content as statusLegendHtml() above, but NOT collapsible --
   for TV mode only (Round 22). Theo, right after seeing the collapsible
   version deployed: "le status description doit etre obligatoirement
   visible c est plus simple" -- on a screen nobody is there to tap open,
   a <details> that starts shut would just never get seen, so this is a
   plain always-visible block instead, matching how Outbound's own board
   shows its legend permanently at the foot of the list. The normal
   admin/driver view (statusLegendHtml() above) is untouched -- collapsed by
   default there remains Theo's explicit condition for that view ("simple
   a regarder pour Phone + Web"), this is additive only for the TV board. */
function tvLegendHtml(){
  return '<div class="statuslegend tvlegend"><div class="tvlegend-title">📊 '+tr("legendTitle")+'</div>'+
    '<div class="legendgrid">'+legendRowsHtml()+'</div></div>';
}

/* Round 34: Theo asked for the status legend to live in the top blue banner
   instead of its own block below the table ("tu peux pas mettre dans le
   bandeau bleu en haut"). The full descriptive version (title + sentence per
   status, see legendRowsHtml() above) doesn't fit next to the brand/clock
   row without the banner growing very tall, so this is a condensed version
   for the banner only: one colored dot + short label per status, no
   description -- same idea as the sync-status dot already in this banner,
   just one per status. tvLegendHtml()/legendRowsHtml() above stay as they
   are and stay unused now that renderTv() no longer calls tvLegendHtml() --
   left in place rather than deleted in case a future round wants the
   detailed version back somewhere. */
function tvBannerLegendHtml(){
  var entries = [
    {cls:"pending", title:tr("status_pending")},
    {cls:"urgent", title:tr("status_urgent")},
    {cls:"scheduled", title:tr("status_scheduled")},
    {cls:"duesoon", title:tr("legendDueSoonTitle")},
    {cls:"late", title:tr("status_late")},
    {cls:"unloading", title:tr("status_unloading")},
    {cls:"done", title:tr("status_done")}
  ];
  return '<div class="tvbannerlegend">'+entries.map(function(e){
    return '<span class="tvbannerlegend-item"><span class="tvbannerdot '+e.cls+'"></span>'+esc(e.title)+'</span>';
  }).join("")+'</div>';
}

/* Round 34: the board's main, rotating/paginated table -- strictly today's
   trucks. Shared by renderTv() and tvTick() so both agree on what's
   paginated and how many pages that makes -- two different filters here
   would desync the page count from what's actually rendered.
   Round 34 briefly tried carrying forward an earlier day's still-open truck
   too (so a truck someone forgot to mark finished wouldn't just vanish),
   first mixed into this same list, then pulled into its own separate strip
   after Theo found either version confusing/cluttering -- he was clear he
   only ever wants today's trucks on this board, full stop. Both attempts
   were reverted; this board is strictly today, exactly like Round 22-33. */
function tvTodayTrucks(){
  return state.trucks.filter(function(t){ return t.date === todayKey(); });
}

/* One row of the TV-mode board (see renderTv() below) -- deliberately NOT
   tableRowHtml() from the wide-screen admin table above: that one carries
   data-open (opens the truck sheet) and a "truckrow" class styled to look
   clickable, neither of which belongs on a public, unmanned screen. Reuses
   pill() for the same live status text as everywhere else, and shows the
   ETA instead of the date column (every row here is already "today"). */
function tvRowHtml(t, now){
  var d = derive(t, now);
  // Round 23: a persistent pulsing highlight on any row that's late or
  // urgent (needs an ETA at all), rather than a one-off flash the instant a
  // truck crosses over -- Theo's ask was to make a late truck noticeable on
  // a screen nobody is actively watching, and a brief flash could easily be
  // missed by whoever glances at the board a minute later. A continuous cue
  // is visible however long ago the truck actually went late. See
  // body.tvmode tr.tvalert in css/app.css.
  var alertCls = (d === "late" || d === "urgent") ? " tvalert" : "";
  // Round 34: same muted treatment as the admin table/cards for a completed
  // truck -- it can still show up here for the rest of the day (sortWeight()
  // keeps it at the bottom), but shouldn't visually compete with what's
  // still open.
  var completedCls = t.status === "done" ? " tv-completed" : "";
  // Round 38: client feedback -- a truck with a damage/claim remark gets the
  // same kind of persistent, glanceable highlight as a late/urgent truck
  // (tvalert above), just its own color (see .tvproblem in css/app.css), so
  // a problem is noticeable on an unwatched board without relying on anyone
  // reading the small chip text in the status cell. Same damageRemark field
  // damageBadge() already reads below -- no new "problem" flag, just a
  // second, bigger way of showing the same thing.
  var problemCls = (t.damageRemark && t.damageRemark.trim()) ? " tvproblem" : "";
  var rowCls = (alertCls+completedCls+problemCls).trim();
  // Round 34 (carry-forward): a row for a truck from an earlier day needs its
  // date next to the time, or it would silently look like a same-day truck
  // running late -- shortDate() gives the compact "DD/MM" already used
  // elsewhere in the app rather than a full date.
  var etaText = t.eta ? ((t.date !== todayKey() ? shortDate(t.date)+" " : "")+t.eta) : "—";
  return '<tr'+(rowCls ? ' class="'+rowCls+'"' : '')+'>'+
    '<td>'+pill(d,t,now)+damageBadge(t)+'</td>'+
    '<td class="mono">'+esc(t.truckLabel || t.poNo || t.ref || t.id)+'</td>'+
    '<td>'+esc(t.carrier||"—")+'</td>'+
    // Round 34 follow-up: Theo asked for the Thai carrier name as its own
    // column here too, same as the desktop admin table's tableColCarrierTh
    // (this used to only show inline on the card view, "Carrier · ชื่อไทย" --
    // never on the TV board at all).
    '<td>'+(t.carrierTh ? esc(t.carrierTh) : "—")+'</td>'+
    '<td>'+(t.plant ? esc(t.plant) : "—")+'</td>'+
    '<td>'+etaText+'</td>'+
    // Round 38: client feedback -- dedicated Start Time / End Time columns,
    // same actualStartCellText()/actualEndCellText() helpers the admin
    // desktop table already uses (Round 36) rather than reinventing a
    // display for the same data -- replaces the small "▶ HH:MM ⏹ HH:MM"
    // subtext this board used to show under the ETA cell (actualTimeHtml()),
    // which is now redundant with these two columns.
    '<td>'+esc(actualStartCellText(t))+'</td>'+
    '<td>'+esc(actualEndCellText(t))+'</td>'+
    // Round 26 (Round 33: also a "#N"-suffixed po_no, see
    // looksLikeSiblingRef() above): this column used to show a "N lots"
    // badge (only ever populated for the old merged-lots trucks); now shows
    // product + qty whenever the truck shares its slot with others so the
    // "Truck 1/2/3" rows for one PO stay distinguishable on the TV board
    // too. Old data that still has an un-migrated `lots` array falls back
    // to the old badge.
    '<td>'+(looksLikeSiblingRef(t) && (t.details || t.qtt) ? esc(t.details||"")+(t.qtt?(" ("+esc(t.qtt)+")"):"") :
      (t.lots && t.lots.length > 1 ? esc(tr("multiLotBadge").replace("{n}", t.lots.length)) : "—"))+'</td>'+
  '</tr>';
}
/* TV mode (Round 22) -- a completely separate render path from the normal
   render() below, on purpose: a screen nobody is meant to touch should
   never be able to accidentally end up showing an admin control just
   because some future change to the shared render() forgot to gate it.
   This function only ever reads state.trucks (never ui.role, ui.openId,
   ui.searchQuery, etc.) and only ever builds today's table -- there is no
   card view here at all, and no click affordance on any row. */
function tvTableHeadHtml(){
  return '<tr>'+
    '<th>'+tr("tableColStatus")+'</th>'+
    '<th>'+tr("tableColPo")+'</th>'+
    '<th>'+tr("tableColCarrier")+'</th>'+
    '<th>'+tr("tableColCarrierTh")+'</th>'+
    '<th>'+tr("tableColPlant")+'</th>'+
    '<th>'+tr("tvColEta")+'</th>'+
    '<th>'+tr("tableColStartTime")+'</th>'+
    '<th>'+tr("tableColEndTime")+'</th>'+
    '<th>'+tr("tableColLots")+'</th>'+
  '</tr>';
}
// Round 38: number of columns tvTableHeadHtml() prints above -- kept as one
// constant rather than a literal "9" repeated at every colspan below, so the
// two can never quietly drift apart again the way they would have if this
// round's two new columns had only been added in one of the two places.
var TV_TABLE_COLS = 9;
// Round 38 follow-up: Theo saw the auto-scroll loop and flagged it as odd --
// "quand tu arrives a la fin de la liste ca devrait juste remonter au debut"
// (should just jump back to the start). The first cut duplicated the WHOLE
// <table> (thead included) to make the -50% loop seamless, so the column
// header row itself scrolled past a second time in the middle of every
// cycle, right before the list restarted -- reads as a stray/duplicate row
// dropping in mid-list, not a clean wrap. Fix: the header now lives in its
// own small, non-scrolling table sitting above .tvscrollviewport; only the
// BODY table (just <tbody>, no header) is inside .tvscrollcontent and gets
// duplicated for the loop -- so the loop only ever shows rows repeating,
// never the header. A shared <colgroup> (percentages, sums to 100) keeps the
// two tables' columns aligned since they're no longer one table that could
// auto-size its columns together; table-layout:fixed (css/app.css) makes
// both respect it. Order matches tvTableHeadHtml() above.
var TV_COL_WIDTHS = [11, 12, 15, 10, 8, 8, 8, 8, 20];
function tvColgroupHtml(){
  return '<colgroup>'+TV_COL_WIDTHS.map(function(w){ return '<col style="width:'+w+'%">'; }).join("")+'</colgroup>';
}
function renderTv(){
  var now = new Date();
  document.documentElement.setAttribute("lang", ui.lang === "th" ? "th" : "en");
  // Strictly today's trucks -- see tvTodayTrucks() above for why Round 34's
  // two attempts at also carrying forward an earlier day's truck were both
  // reverted.
  var boardTrucks = tvTodayTrucks();
  boardTrucks.sort(function(a,b){ return sortWeight(a,now) - sortWeight(b,now); });
  var bodyHtml;
  if(boardTrucks.length){
    // Round 34: same ongoing/completed split as the admin table/cards
    // (listTableHtml()/listHtml() above) -- sortWeight() already keeps every
    // "done" truck at the bottom of the sorted list, so this is a plain
    // split of that one list, not a per-page one anymore (Round 38 dropped
    // pagination -- see setupTvAutoScroll() below). Only shown when there
    // actually is both kinds today, same "never a header with nothing to
    // separate" rule as the admin views.
    var ongoing = boardTrucks.filter(function(t){ return t.status !== "done"; });
    var completed = boardTrucks.filter(function(t){ return t.status === "done"; });
    var rows;
    if(ongoing.length && completed.length){
      rows = '<tr class="tablesectionrow"><td colspan="'+TV_TABLE_COLS+'">'+tr("sectionOngoing")+'</td></tr>'+
        ongoing.map(function(t){ return tvRowHtml(t, now); }).join("")+
        '<tr class="tablesectionrow"><td colspan="'+TV_TABLE_COLS+'">'+tr("sectionCompleted")+'</td></tr>'+
        completed.map(function(t){ return tvRowHtml(t, now); }).join("");
    } else {
      rows = boardTrucks.map(function(t){ return tvRowHtml(t, now); }).join("");
    }
    // Header table: fixed above the scroll viewport, never duplicated/
    // animated -- see the TV_COL_WIDTHS comment above for why this is a
    // separate table rather than the old single table's <thead>.
    var colgroup = tvColgroupHtml();
    var headTable = '<table class="trucktable tvheadtable">'+colgroup+'<thead>'+tvTableHeadHtml()+'</thead></table>';
    var bodyTable = '<table class="trucktable tvbodytable">'+colgroup+'<tbody>'+rows+'</tbody></table>';
    // Round 38: client feedback -- replaces the old fixed-size page
    // rotation (Rounds 23-37) with a continuous auto-scroll, so the whole
    // list is visible without waiting for a page flip. .tvscrollviewport is
    // the fixed-height clipping window (CSS gives it the space left under
    // the banner, below the fixed header table above); .tvscrollcontent is
    // what actually gets animated -- see setupTvAutoScroll(), called once
    // this HTML is in the DOM below, which decides whether today's list is
    // even tall enough to need scrolling at all (a quiet day just sits
    // still, exactly like before this round).
    bodyHtml = headTable+'<div class="tvscrollviewport"><div class="tvscrollcontent">'+bodyTable+'</div></div>';
  } else {
    bodyHtml = '<div class="empty"><span class="empty-icon">🚚</span><div>'+tr("noTrucksToday")+'</div></div>';
  }
  var html =
    '<div class="topbar tvtopbar">'+
      // Round 38: client feedback -- the banner was taking up too much of
      // the screen. brand-row and clockbox used to each sit on their own
      // full-width row (this whole element is flex-direction:column, see
      // .topbar); reusing .topbar-row1 (the exact same "logo left, clock/
      // date right, one line" wrapper the normal mobile/admin header
      // already uses for the same two pieces) puts them side by side here
      // too, instead of introducing a new layout just for this screen.
      '<div class="topbar-row1">'+
        '<div class="brand-row">'+markSvg()+
          '<div class="brand-word"><span class="tagline">INBOUND</span></div></div>'+
        '<div class="clockbox"><div class="clock" id="clockEl">'+clockStr(now)+'</div>'+
        '<div class="clockdate">'+longDate(now)+'</div>'+
        // Same #pollCountdownEl id as the normal view -- tick() (js/ticking.js)
        // updates it by id with no idea which render path built it, so the
        // countdown keeps working here for free.
        '<div class="syncrow"><span class="syncdot '+syncDotClass()+'"></span>'+syncLabel()+pollCountdownHtml(now)+'</div></div>'+
      '</div>'+
    // Round 34: the legend used to be its own block below the table
    // (tvLegendHtml()) -- Theo asked for it in the top banner instead, in a
    // condensed dot+label form (see tvBannerLegendHtml() above), as the last
    // row of this same banner rather than its own top-level block.
    tvBannerLegendHtml()+
    '</div>'+
    '<div class="tvtable">'+bodyHtml+'</div>';
  document.body.classList.add("tvmode");
  document.getElementById("app").innerHTML = html;
  setupTvAutoScroll();
}

/* Round 38: replaces the old page-rotation timer (tvTick(), driven every
   second from tick() in js/ticking.js) with a plain CSS animation -- no per-
   second JS needed to keep it moving. Called once at the end of every
   renderTv() (every ~15s periodic refresh, every poll, and on first load).
   A no-op outside TV mode implicitly (renderTv() is the only caller), and a
   no-op whenever today's list already fits the screen -- same "a quiet day
   looks exactly like before" guarantee the old pagination gave.
   Round 38 follow-up: the first cut duplicated the content once (so a CSS
   translateY(0)->-50% animation could loop with no visible seam) -- but
   Theo saw that as the board showing "Ongoing / Completed / Ongoing /
   Completed" back to back and said the opposite: once it finishes
   Completed, it should go back to the top ("apres completed faut que ca
   remonte en haut"), not carry straight on into a second copy of Ongoing.
   That's a plain "scroll to the bottom, then jump back to the top" loop,
   which is simpler than the seamless version: animate translateY(0) to
   -<scrollDistance>px (exactly far enough that the last row clears the
   bottom of the viewport, no more), with no content duplication at all --
   a native CSS animation on animation-iteration-count:infinite already
   snaps straight back to its "from" state the instant one pass finishes,
   which IS the top-of-list jump Theo asked for. The distance is only known
   at render time (depends on today's row count), so it's passed to the
   shared @keyframes (css/app.css) via a CSS custom property rather than a
   hardcoded percentage. */
var tvScrollStartedAt = null;
var tvScrollLastDistance = 0;
function setupTvAutoScroll(){
  var viewport = document.querySelector(".tvscrollviewport");
  var content = document.querySelector(".tvscrollcontent");
  if(!viewport || !content) return;
  var naturalHeight = content.scrollHeight;
  var viewportHeight = viewport.clientHeight;
  // How far the content needs to move up for its last row to just clear the
  // bottom of the viewport -- not the full content height, or the list would
  // keep scrolling well past the point everything's already been shown.
  var scrollDistance = naturalHeight - viewportHeight;
  if(scrollDistance <= 0){
    tvScrollStartedAt = null;
    tvScrollLastDistance = 0;
    content.classList.remove("tvscrolling");
    content.style.removeProperty("--tv-scroll-distance");
    return;
  }
  var pxPerSec = ui.tvScrollSpeedOverride || TV_SCROLL_PX_PER_SEC;
  var durationMs = (scrollDistance / pxPerSec) * 1000;
  var now = Date.now();
  // render() rebuilds this whole table from scratch on every periodic
  // refresh/poll (see the top comment on render() below) -- restarting the
  // CSS animation from 0 each time would make the board visibly jump back
  // to the top every ~15 seconds instead of ever completing a full pass.
  // Keeping a running start time across renders and resuming with a
  // matching *negative* animation-delay (mod the cycle length, so it never
  // grows unbounded) makes each rebuild pick up exactly where the last one
  // left off, invisibly. Only reset when the scroll distance actually
  // changed by more than a couple pixels (a truck was added/finished/
  // removed today), not on every trivial sub-pixel layout difference
  // between two otherwise-identical renders.
  if(tvScrollStartedAt == null || Math.abs(scrollDistance - tvScrollLastDistance) > 2){
    tvScrollStartedAt = now;
  }
  tvScrollLastDistance = scrollDistance;
  var elapsedMs = (now - tvScrollStartedAt) % durationMs;
  content.style.setProperty("--tv-scroll-distance", scrollDistance+"px");
  content.style.animationDuration = (durationMs/1000)+"s";
  content.style.animationDelay = (-elapsedMs/1000)+"s";
  content.classList.add("tvscrolling");
}

export function render(){
  if(ui.tvMode){ renderTv(); return; }
  // Every render() replaces the *entire* #app subtree (no framework, no
  // diffing — see Round 8) — cheap to reason about, but on its own that
  // also resets the page's scroll position on every single call, including
  // the periodic background refresh (every ~15s) that isn't guarded by
  // isInputSheetOpen(). Someone reading partway down the truck list would
  // otherwise get yanked back to the top every 15 seconds, which is the
  // "violent" jump users reported. Capturing/restoring window scroll around
  // the swap costs nothing and fixes that without touching the render
  // model itself.
  var scrollY = window.scrollY;
  // The search box (Round 17) re-renders on every keystroke so the list can
  // filter live -- but render() rebuilds the whole #app subtree from
  // scratch, which would otherwise recreate the input and drop focus/cursor
  // position after each character typed. Captured here and restored at the
  // end, the same way scrollY above already is for the periodic refresh.
  var activeEl = document.activeElement;
  var focusInfo = null;
  if(activeEl && activeEl.id && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA")){
    focusInfo = { id: activeEl.id, start: null, end: null };
    try{ focusInfo.start = activeEl.selectionStart; focusInfo.end = activeEl.selectionEnd; }catch(e){}
  }
  var now = new Date();
  // Round 25: Nestlé gets the same day-by-day navigation as Admin
  // ("view + import + download only" -- confirmed via
  // AskUserQuestion), just none of the admin-only actions below.
  // Round 36: MHE (driver) now gets the same tabs too, per client feedback
  // ("the MHE Worklist should not be restricted to the current day's
  // planned shipments only... date navigation should be simple and easy
  // for MHE users to operate") -- tabsHtml() below caps how far the arrows
  // can go to +/-MHE_DAY_WINDOW for this role specifically, so the "simple"
  // part holds: previous/current/next day, not Admin's full history reach.
  var showTabs = isAdmin() || isNestle() || ui.role === "driver";
  // A truck pending deletion (tapped "Delete", inside the undo window --
  // see deleteTruck() in actions.js) is hidden from both the KPI strip and
  // the list right away, even though it hasn't actually been deleted yet.
  var visibleTrucks = ui.pendingDeleteId
    ? state.trucks.filter(function(t){ return t.id !== ui.pendingDeleteId; })
    : state.trucks;
  document.documentElement.setAttribute("lang", ui.lang === "th" ? "th" : "en");
  var html =
    // Round 24: Theo found the mobile topbar cramped -- logo, tagline, role
    // switch, four admin icons, lang toggle, clock, date and sync status all
    // fighting for one row. Split into two explicit rows: row 1 is "who/when"
    // (logo + role + clock/date), row 2 is "settings" (the admin/driver
    // icons, lang toggle, sync status) -- his own suggested split ("en haut
    // logo + la date + ADMIN ou MHE, en dessous tous les settings"). Applied
    // at every width, not just mobile, so desktop matches rather than having
    // two different topbar shapes to maintain. Every existing class/id/data-
    // attr is kept exactly (rolebadgerow, rolebadge, clockbox, clock#clockEl,
    // clockdate, syncrow, syncdot, brand-row, brand-word) -- only which
    // wrapper they sit in changed -- so click delegation (events.js) and the
    // safe-area-top test (which only checks .topbar/.brand-word bounding
    // rects, not their nesting) are unaffected. New wrappers: .topbar-row1,
    // .topbar-row2, .idline.
    '<div class="topbar">'+
      '<div class="topbar-row1">'+
        '<div class="brand-row">'+markSvg()+
          // "MON" is no longer repeated as text here -- it's now baked into
          // markSvg()'s full logo image (hexagon + wordmark), so only the
          // app-specific "INBOUND" tagline remains, to avoid showing "MON"
          // twice side by side.
          '<div class="brand-word"><span class="tagline">INBOUND</span></div>'+
        '</div>'+
        '<div class="idline">'+
          '<button class="rolebadge" data-role-switch="1">'+(ui.role?roleLabel(ui.role):tr("selectRole"))+' ⇵</button>'+
          '<div class="clockbox"><div class="clock" id="clockEl">'+clockStr(now)+'</div>'+
          '<div class="clockdate">'+longDate(now)+'</div></div>'+
        '</div>'+
      '</div>'+
      '<div class="topbar-row2">'+
        '<div class="rolebadgerow">'+
          // Round 36: Khun Badeeson's client feedback ("the current icons
          // are quite small and may not be easily recognizable... please
          // also display the function/menu name together with each icon")
          // -- these used to be emoji-only buttons (an aria-label existed
          // for screen readers, but nothing was ever visible on screen).
          // iconBadge() below now renders a bigger emoji plus its existing
          // tr() string as a visible label right next to it, reusing the
          // exact same aria-label text so nothing here is newly translated.
          //
          // Round 25 capability matrix (locked in via AskUserQuestion):
          // Nestlé gets import + PIN self-service alongside Admin/Admin IT;
          // Reporting (KPIs/CSV) and the app-settings screen stay
          // Admin-only (isAdmin() covers both admin and admin_it).
          ((isAdmin()||isNestle()) ? iconBadge("data-open-import", "📥", tr("importPlanAria")) : '')+
          (isAdmin() ? iconBadge("data-open-report", "📊", tr("reportTitle")) : '')+
          ((isAdmin()||isNestle()) ? iconBadge("data-open-pin-settings", "⚙", tr("changePin")) : '')+
          (isAdmin() ? iconBadge("data-open-app-settings", "🔧", tr("appSettingsTitle")) : '')+
          // Round 26: audit trail (who created/started/finished/cancelled/
          // reopened/edited/deleted which truck, and when) -- Admin-only,
          // same gate as Reports/app-settings above (isAdmin() covers both
          // Admin MON and Admin MON IT).
          (isAdmin() ? iconBadge("data-open-history", "📜", tr("historyTitle")) : '')+
          // Round 27: browse actual past trucks over a picked date range
          // (read-only, see js/archiveList.js) -- Admin-only, same gate as
          // Reports/History/app-settings above.
          (isAdmin() ? iconBadge("data-open-archive-list", "🗄️", tr("archiveListTitle")) : '')+
          (ui.role==="driver" ? '<button class="rolebadge" data-open-name-settings="1">'+tr("setNamePill")+'</button>' : '')+
          // Round 25 follow-up: manual logout, alongside the 30-minute
          // inactivity auto-logout (js/ticking.js) -- available to every
          // role (unlike "switch role" ⇵ above, which leaves the current
          // role valid until a new PIN is entered, this ends the session
          // outright). Only shown once a role is actually picked -- nothing
          // to log out of otherwise, and the role gate would already be
          // covering everything underneath it in that case anyway.
          (ui.role ? iconBadge("data-logout", "🚪", tr("logoutAria")) : '')+
          '<button class="rolebadge langtoggle" data-toggle-lang="1" aria-label="Language / ภาษา">'+(ui.lang==="th"?"EN":"TH")+'</button>'+
        '</div>'+
        '<div class="syncrow"><span class="syncdot '+syncDotClass()+'"></span>'+syncLabel()+offlineQueueBadgeHtml()+pollCountdownHtml(now)+'</div>'+
      '</div>'+
    '</div>'+
    (showTabs ? tabsHtml(visibleTrucks) : '<div class="dayheading">'+tr("todaysTrucks")+'</div>')+
    '<div class="kpis">'+kpiHtml(visibleTrucks, now)+'</div>'+
    // Round 27: the carrier/plant filter dropdowns need the same day-scoped
    // subset listHtml() below filters/displays (so their options are always
    // exactly what's on this day) -- computed once here and passed in,
    // rather than recomputed a second, slightly different way.
    searchRowHtml(visibleTrucks.filter(function(t){ return t.date === addDays(todayKey(), effectiveDayOffset()); }))+
    '<div class="list">'+listHtml(visibleTrucks, now)+'</div>'+
    statusLegendHtml()+
    // Manual "add truck" stays Admin-only (Admin MON + Admin MON IT) -- a
    // judgment call: Theo described Nestlé's write capability only as
    // "upload le fichier" (the import flow), never manual creation.
    (isAdmin() ? '<button class="fab" data-add="1" aria-label="'+tr("addTruckAria")+'">+</button>' : '')+
    sheetHtml(now)+
    photoViewerHtml()+
    roleGateHtml()+
    toastHtml()+
    // Two hidden inputs, one per photo tile above (Round 19) — see the long
    // comment in photosHtml() for why one input can't safely serve both
    // jobs on every real Android device. `capture="environment"` forces the
    // rear camera open directly (guaranteed camera access, one shot at a
    // time); no `capture` on the other lets `multiple` grab several existing
    // photos from the gallery/file chooser at once, same as before.
    '<input type="file" accept="image/*" capture="environment" id="photoAddCameraInput" style="display:none">'+
    '<input type="file" accept="image/*" multiple id="photoAddGalleryInput" style="display:none">';
  document.getElementById("app").innerHTML = html;
  if(scrollY) window.scrollTo(0, scrollY);
  if(focusInfo){
    var restored = document.getElementById(focusInfo.id);
    if(restored){
      restored.focus();
      if(focusInfo.start != null && typeof restored.setSelectionRange === "function"){
        try{ restored.setSelectionRange(focusInfo.start, focusInfo.end); }catch(e){}
      }
    }
  }
}
