/* ---------- rendering ----------
   No framework: `render()` rebuilds the whole app's HTML from `state` + `ui`
   on every change and writes it into #app. Everything here is a pure
   function of those two objects (plus the current clock) — all the actual
   mutation happens in actions.js/importPlan.js, which call render() when
   they're done. */
import { state, ui } from "./state.js";
import { tr } from "./i18n.js";
import { derive, lateMinutes, isDueSoon, STATUS_KEYS } from "./status.js";
import { esc, shortDate, fmtElapsed, dateTimeOf, clockStr, addDays, todayKey } from "./dateUtils.js";
import { DAY_LABELS, MONTH_LABELS, DAY_LABELS_TH, MONTH_LABELS_TH, TV_ROWS_PER_PAGE, TV_ROTATE_MS } from "./config.js";
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

/* ---------- small bilingual text helpers (kept here since they're only
   ever used while building the sheet HTML below) ---------- */
function roleLabel(r){ return r === "admin" ? tr("roleAdmin") : tr("roleDriver"); }
function lateHintAdminText(mins){ return ui.lang==="th" ? ("ล่าช้ากว่ากำหนด "+mins+" นาที") : ("Running "+mins+" min late against the scheduled time."); }
function lateHintDriverText(mins){ return ui.lang==="th" ? ("ล่าช้ากว่ากำหนด "+mins+" นาที") : ("Running "+mins+" min late."); }
function canStartOnText(dateStr){ return ui.lang==="th" ? ("เริ่มขนถ่ายได้ในวันที่ "+dateStr) : ("Unloading can start on "+dateStr+"."); }
function startedAtText(hhmm){ return ui.lang==="th" ? ("เริ่มเมื่อ "+hhmm) : ("Started at "+hhmm); }
function startedByText(name){ return ui.lang==="th" ? ("เริ่มโดย "+name) : ("Started by "+name); }
function finishedByText(name){ return ui.lang==="th" ? ("เสร็จสิ้นโดย "+name) : ("Finished by "+name); }

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

function effectiveDayOffset(){ return ui.role === "driver" ? 0 : ui.dayOffset; }

function pill(derived, t, now){
  var txt = tr(STATUS_KEYS[derived]);
  var soon = derived === "scheduled" && isDueSoon(t, now);
  if(derived === "scheduled") txt = (soon ? "⏰ " : "") + tr("pill_eta") + " " + t.eta;
  if(derived === "late") txt = tr("status_late") + " · " + lateMinutes(t, now) + " " + tr("unit_min");
  if(derived === "unloading") txt = tr("status_unloading") + " · " + fmtElapsed(now - new Date(t.startedAt));
  if(derived === "done" && t.startedAt && t.finishedAt){
    txt = tr("status_done") + " · " + fmtHM((new Date(t.finishedAt)-new Date(t.startedAt))/60000);
  }
  return '<span class="pill '+derived+(soon?" duesoon":"")+'">'+esc(txt)+"</span>";
}
/* One row of the wide-screen table view (see listTableHtml() below) --
   reuses pill() as-is for the status cell so the exact same live text
   (ETA/late-minutes/elapsed/duration) shows in both views without
   duplicating that logic. Clicking anywhere on the row opens the truck
   sheet: events.js's click delegation walks up via el.closest("[data-open]"),
   so putting data-open directly on the <tr> works with zero JS changes. */
function tableRowHtml(t, now){
  var d = derive(t, now);
  return '<tr class="truckrow" data-open="'+esc(t.id)+'">'+
    '<td>'+pill(d,t,now)+'</td>'+
    '<td class="mono">'+esc(t.poNo || t.ref || t.id)+'</td>'+
    '<td>'+esc(t.carrier||"—")+'</td>'+
    '<td>'+(t.plant ? esc(t.plant) : "—")+'</td>'+
    '<td>'+shortDate(t.date)+'</td>'+
    '<td>'+(t.lots && t.lots.length > 1 ? esc(tr("multiLotBadge").replace("{n}", t.lots.length)) : "—")+'</td>'+
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
  var rows = filtered.map(function(t){ return tableRowHtml(t, now); }).join("");
  return '<table class="trucktable"><thead><tr>'+
    '<th>'+tr("tableColStatus")+'</th>'+
    '<th>'+tr("tableColPo")+'</th>'+
    '<th>'+tr("tableColCarrier")+'</th>'+
    '<th>'+tr("tableColPlant")+'</th>'+
    '<th>'+tr("tableColDate")+'</th>'+
    '<th>'+tr("tableColLots")+'</th>'+
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
  return '<button class="card" data-open="'+esc(t.id)+'">'+
    '<span class="stripe '+d+(soon?" duesoon":"")+'"></span>'+
    '<span class="card-body">'+
      '<span class="card-top"><span class="card-id mono">'+esc(t.poNo || t.ref || t.id)+"</span>"+pill(d,t,now)+"</span>"+
      '<span class="card-carrier">'+esc(t.carrier)+"</span>"+
      '<span class="card-meta">'+
      (t.plant ? "<span>"+esc(t.plant)+"</span>" : "")+
      "<span>"+shortDate(t.date)+"</span>"+
      (t.imExTr ? "<span>"+esc(t.imExTr)+"</span>" : "")+
      // Once a truck goes "Late" the pill above stops showing the scheduled
      // time (it switches to how many minutes late instead) — repeating the
      // ETA here means it's never hidden, however late the truck gets.
      (t.eta ? "<span>"+tr("pill_eta")+" "+esc(t.eta)+"</span>" : "")+
      (t.lots && t.lots.length > 1 ? "<span>"+esc(tr("multiLotBadge").replace("{n}", t.lots.length))+"</span>" : "")+
      "</span>"+
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
function tabsHtml(trucks){
  // Three quick tabs (yesterday/today/tomorrow, offsets -1/0/+1) plus two
  // nav arrows that step ONE day at a time (Round 15 -- the first version
  // jumped straight to +/-5, which skipped every day in between; Theo
  // pointed out he needed access to those in-between dates too, not just
  // the two extremes), clamped to [-MAX_DAY_OFFSET, +MAX_DAY_OFFSET]
  // overall. When the current offset lands outside -1/0/+1 none of the
  // three quick tabs is "active", so a small date pill shows which day is
  // actually selected.
  var quick = [ {o:-1, label:tr("tabYesterday")}, {o:0, label:tr("tabToday")}, {o:1, label:tr("tabTomorrow")} ];
  var cur = ui.dayOffset;
  var maxOffset = getMaxDayOffset();
  var atMin = cur <= -maxOffset, atMax = cur >= maxOffset;
  var quickHtml = quick.map(function(q){
    var key = addDays(todayKey(), q.o);
    var n = trucks.filter(function(t){ return t.date === key; }).length;
    return '<button class="tab'+(cur===q.o?" active":"")+'" data-tab="'+q.o+'">'+
      '<span class="n mono">'+n+'</span>'+q.label+"</button>";
  }).join("");
  var isQuickDay = quick.some(function(q){ return q.o === cur; });
  var dateInfo = isQuickDay ? "" :
    '<div class="tab-dateinfo">'+shortDate(addDays(todayKey(), cur))+'</div>';
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
  var q = (ui.searchQuery || "").trim().toLowerCase();
  if(q){
    var hay = ((t.poNo||"")+" "+(t.ref||"")+" "+(t.carrier||"")+" "+(t.plant||"")).toLowerCase();
    if(hay.indexOf(q) === -1) return false;
  }
  return true;
}
function searchRowHtml(){
  return '<div class="searchrow">'+
    '<input class="field" type="text" id="searchInput" placeholder="'+tr("searchPlaceholder")+'" value="'+esc(ui.searchQuery)+'">'+
    '<button class="filterchip'+(ui.filterLateOnly?" active":"")+'" data-toggle-late-filter="1">'+tr("filterLateOnly")+'</button>'+
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
  // A short list on a tall phone screen (especially standalone/home-screen
  // mode, which has no browser chrome eating into the viewport) can leave a
  // large blank area below the cards that reads as broken rather than
  // intentional. This closing line turns that empty space into a deliberate
  // "end of list" instead of an unexplained void.
  var cards = filtered.map(function(t){ return cardHtml(t, now); }).join("")+
    '<div class="list-end">'+tr("endOfList")+'</div>';
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
  if(ui.pinSettingsOpen) return pinSettingsHtml();
  if(ui.nameSettingsOpen) return nameSettingsHtml();
  if(ui.settingsOpen) return settingsSheetHtml();
  if(ui.addOpen) return addSheetHtml();
  if(!ui.openId) return "";
  var t = state.trucks.find(function(x){ return x.id === ui.openId; });
  if(!t) return "";
  var d = derive(t, now);
  var body = "";
  var isAdmin = ui.role === "admin";

  if(d==="pending" || d==="urgent" || d==="scheduled" || d==="late"){
    if(isAdmin){
      body += '<div class="sheet-section"><div class="label">'+tr("etaLabel")+'</div>'+
        '<input class="field" type="time" id="etaInput" value="'+(t.eta||"")+'">'+
        '<button class="btn primary" data-save-eta="'+esc(t.id)+'">'+(t.eta?tr("updateTime"):tr("saveTime"))+'</button></div>';
      if(d==="late") body += '<div class="hint" style="color:var(--bad);text-align:center;margin-top:10px">'+lateHintAdminText(lateMinutes(t,now))+'</div>';
      if(t.date === todayKey() && t.eta){
        body += '<button class="btn go" data-start="'+esc(t.id)+'">'+tr("startUnloading")+'</button>';
      } else if(t.date !== todayKey()){
        body += '<div class="hint" style="text-align:center;margin-top:12px">'+canStartOnText(shortDate(t.date))+'</div>';
      }
    } else {
      if(!t.eta){
        body += '<div class="hint" style="text-align:center;margin-top:10px">'+tr("waitingEta")+'</div>';
      } else {
        body += '<div class="timer" style="font-size:30px">'+t.eta+'</div><div class="timer-sub">'+tr("scheduledArrivalTime")+'</div>';
        if(d==="late") body += '<div class="hint" style="color:var(--bad);text-align:center;margin-top:6px">'+lateHintDriverText(lateMinutes(t,now))+'</div>';
        if(t.date === todayKey()){
          body += '<button class="btn go" data-start="'+esc(t.id)+'">'+tr("startUnloading")+'</button>';
        } else {
          body += '<div class="hint" style="text-align:center;margin-top:12px">'+canStartOnText(shortDate(t.date))+'</div>';
        }
      }
    }
  } else if(d==="unloading"){
    var elapsed = now - new Date(t.startedAt);
    body += '<div class="timer big-work" id="liveTimer">'+fmtElapsed(elapsed)+'</div>'+
      '<div class="timer-sub">'+startedAtText(new Date(t.startedAt).toTimeString().slice(0,5))+'</div>'+
      '<button class="btn stop" data-finish="'+esc(t.id)+'">'+tr("finishUnloading")+'</button>'+
      '<button class="linklike" data-cancel="'+esc(t.id)+'">'+tr("cancelStartLink")+'</button>';
    if(t.startedBy) body += '<div class="hint" style="text-align:center;margin-top:8px">'+esc(startedByText(t.startedBy))+'</div>';
  } else if(d==="done"){
    var durMin = (new Date(t.finishedAt)-new Date(t.startedAt))/60000;
    body += '<div class="done-summary">'+
      '<div><b>'+new Date(t.startedAt).toTimeString().slice(0,5)+'</b><span>'+tr("lblStart")+'</span></div>'+
      '<div><b>'+new Date(t.finishedAt).toTimeString().slice(0,5)+'</b><span>'+tr("lblEnd")+'</span></div>'+
      '<div><b>'+fmtHM(durMin)+'</b><span>'+tr("lblDuration")+'</span></div>'+
      '</div>';
    if(t.finishedBy) body += '<div class="hint" style="text-align:center;margin-top:2px">'+esc(finishedByText(t.finishedBy))+'</div>';
    if(isAdmin) body += '<button class="linklike" data-reopen="'+esc(t.id)+'">'+tr("reopenUnloading")+'</button>';
  }

  body += deleteControl(t.id);

  return '<div class="scrim" data-scrim="1"><div class="sheet">'+
    '<div class="sheet-handle"></div>'+
    '<div class="sheet-head"><div><div class="sheet-id mono">'+esc(t.poNo || t.ref || t.id)+'</div>'+
    '<div class="sheet-carrier">'+esc(t.carrier)+'</div></div>'+
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
/* When a truck was imported from a source row that had siblings sharing the
   same PO+date+time+carrier (several lots on one physical truck — see
   importGroupRows in importPlan.js), this lists every lot, not just the
   first (which shipmentDetailsHtml above already shows on its own). A
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
  if(ui.role !== "admin") return "";
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
  if(ui.roleGateStep === "pin"){
    return '<div class="rolegate"><div class="rolecard">'+langBtn+closeBtn+
      '<div class="rolecard-title">'+tr("adminPinTitle")+'</div>'+
      '<div class="rolecard-sub">'+tr("enterPinSub")+'</div>'+
      '<input class="field" style="margin-top:14px;text-align:center;letter-spacing:6px;font-family:\'IBM Plex Mono\';font-size:20px" type="password" inputmode="numeric" autocomplete="off" maxlength="8" id="pinInput" placeholder="••••••">'+
      (ui.roleGateError ? '<div class="hint" style="color:var(--bad);text-align:center;margin-top:8px">'+esc(ui.roleGateError)+'</div>' : '')+
      '<button class="btn primary" data-pin-submit="1">'+tr("unlockAdmin")+'</button>'+
      '<button class="linklike" data-role-back="1">'+tr("back")+'</button>'+
    '</div></div>';
  }
  return '<div class="rolegate"><div class="rolecard">'+langBtn+closeBtn+
    '<div class="rolecard-title">'+tr("whoUsingDevice")+'</div>'+
    '<div class="rolecard-sub">'+tr("chooseRoleSub")+'</div>'+
    '<button class="roleopt" data-role-step="pin"><b>'+tr("roleAdmin")+'</b><span>'+tr("roleAdminDesc")+'</span></button>'+
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
function nameSettingsHtml(){
  return '<div class="scrim" data-scrim="1"><div class="sheet">'+
    '<div class="sheet-handle"></div>'+
    '<div class="sheet-head"><div><div class="sheet-id title-lg">'+tr("yourName")+'</div></div>'+
    '<button class="sheet-close" data-close="1">✕</button></div>'+
    '<div class="hint" style="margin-top:6px">'+tr("yourNameSub")+'</div>'+
    '<div class="formgrid" style="margin-top:8px">'+
      '<input class="field" id="name-input" placeholder="'+tr("namePlaceholder")+'" value="'+esc(loadSavedName())+'">'+
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
    {v:d.noArrivalLogged, l:tr("reportKpiNoLog"), cls: d.noArrivalLogged ? "warn" : ""}
  ];
  return items.map(function(k){
    return '<div class="kpi '+k.cls+'"><div class="v mono">'+k.v+'</div><div class="l">'+k.l+"</div></div>";
  }).join("");
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
      '<button class="btn ghost" data-export-report-csv="1">⬇️ '+tr("reportExportCsvBtn")+'</button>';
  }
  return '<div class="scrim" data-scrim="1"><div class="sheet">'+
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
  '</div></div>';
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
    var r = ui.importResult || { toImport:[], dupeCount:0, pastCount:0 };
    // Each entry is a truck (a group of one or more lots — see
    // importGroupRows in importPlan.js); show the first lot's product/qty
    // like before, plus a "+N lots" badge when the truck actually has more,
    // so a multi-lot truck doesn't look identical to a single-lot one here.
    var rows = r.toImport.slice(0,12).map(function(g){
      var primary = g.lots[0] || {};
      var extra = g.lots.length > 1 ? (' <span class="chip">'+esc(tr("multiLotBadge").replace("{n}", g.lots.length))+'</span>') : "";
      return '<div class="importrow"><b>'+esc(g.order_date)+(g.eta?(" "+esc(g.eta)):"")+'</b> · '+esc(g.carrier||"—")+
        (primary.details?(' · '+esc(primary.details)):"")+(primary.qtt?(' ('+esc(primary.qtt)+')'):"")+extra+'</div>';
    }).join("");
    var more = r.toImport.length > 12 ? '<div class="hint" style="margin-top:4px">'+tr("importMoreRows").replace("{n}", r.toImport.length-12)+'</div>' : "";
    body = '<div class="hint" style="margin-top:6px">'+
        tr("importSummary").replace("{n}", r.toImport.length).replace("{dupe}", r.dupeCount).replace("{past}", r.pastCount)+
      '</div>'+
      '<div class="importpreview">'+(rows || '<div class="hint">'+tr("importNothingToImport")+'</div>')+'</div>'+more+
      errHtml+
      '<button class="btn primary" data-import-confirm="1" '+(busy || !r.toImport.length ? "disabled" : "")+'>'+
        (busy ? tr("importSaving") : tr("importConfirmBtn").replace("{n}", r.toImport.length))+
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
    var rm = ui.role === "admin" ? '<button class="photoslot-rm" data-photo-remove="'+esc(p.id)+'" data-photo-truck="'+esc(t.id)+'" data-photo-path="'+esc(p.storagePath)+'" aria-label="Remove">✕</button>' : "";
    return '<div class="photoslot"><button class="photoslot-view" data-view-photo="'+esc(t.id)+'" data-view-index="'+idx+'"><img src="'+esc(p.url)+'" loading="lazy"></button>'+rm+'</div>';
  }).join("");
  if(photos.length < maxPhotos){
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
  return '<div class="sheet-section"><div class="label">'+tr("damageRemarkTitle")+'</div>'+
    '<div class="hint">'+tr("damageRemarkHint")+'</div>'+
    '<textarea class="field" rows="3" id="damageRemarkInput" placeholder="'+tr("damageRemarkPlaceholder")+'" style="margin-top:8px;resize:vertical">'+esc(t.damageRemark||"")+'</textarea>'+
    '<button class="btn primary" data-save-remark="'+esc(t.id)+'" style="margin-top:8px">'+tr("saveRemarkBtn")+'</button></div>';
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
  var alertCls = (d === "late" || d === "urgent") ? ' class="tvalert"' : '';
  return '<tr'+alertCls+'>'+
    '<td>'+pill(d,t,now)+'</td>'+
    '<td class="mono">'+esc(t.poNo || t.ref || t.id)+'</td>'+
    '<td>'+esc(t.carrier||"—")+'</td>'+
    '<td>'+(t.plant ? esc(t.plant) : "—")+'</td>'+
    '<td>'+(t.eta || "—")+'</td>'+
    '<td>'+(t.lots && t.lots.length > 1 ? esc(tr("multiLotBadge").replace("{n}", t.lots.length)) : "—")+'</td>'+
  '</tr>';
}
/* TV mode (Round 22) -- a completely separate render path from the normal
   render() below, on purpose: a screen nobody is meant to touch should
   never be able to accidentally end up showing an admin control just
   because some future change to the shared render() forgot to gate it.
   This function only ever reads state.trucks (never ui.role, ui.openId,
   ui.searchQuery, etc.) and only ever builds today's table -- there is no
   card view here at all, and no click affordance on any row. */
function renderTv(){
  var now = new Date();
  document.documentElement.setAttribute("lang", ui.lang === "th" ? "th" : "en");
  var todayTrucks = state.trucks.filter(function(t){ return t.date === todayKey(); });
  todayTrucks.sort(function(a,b){ return sortWeight(a,now) - sortWeight(b,now); });
  // Round 23: a busy day (30-40 trucks) would otherwise just run off the
  // bottom of a screen nobody is there to scroll -- rotate through
  // fixed-size pages instead (see tvTick() below, which advances ui.tvPage
  // every TV_ROTATE_MS). Clamped here too, defensively, in case the truck
  // count shrank (fewer pages now than ui.tvPage points at) between the last
  // page-flip and this particular render -- e.g. a render triggered by the
  // regular Supabase poll rather than by tvTick() itself.
  var totalPages = Math.max(1, Math.ceil(todayTrucks.length / TV_ROWS_PER_PAGE));
  if(ui.tvPage >= totalPages) ui.tvPage = 0;
  var pageTrucks = todayTrucks.slice(ui.tvPage*TV_ROWS_PER_PAGE, ui.tvPage*TV_ROWS_PER_PAGE + TV_ROWS_PER_PAGE);
  var tableHtml;
  if(todayTrucks.length){
    var rows = pageTrucks.map(function(t){ return tvRowHtml(t, now); }).join("");
    tableHtml = '<table class="trucktable"><thead><tr>'+
      '<th>'+tr("tableColStatus")+'</th>'+
      '<th>'+tr("tableColPo")+'</th>'+
      '<th>'+tr("tableColCarrier")+'</th>'+
      '<th>'+tr("tableColPlant")+'</th>'+
      '<th>'+tr("tvColEta")+'</th>'+
      '<th>'+tr("tableColLots")+'</th>'+
    '</tr></thead><tbody>'+rows+'</tbody></table>';
  } else {
    tableHtml = '<div class="empty"><span class="empty-icon">🚚</span><div>'+tr("noTrucksToday")+'</div></div>';
  }
  // Only shown once there's more than one page -- on a normal/quiet day
  // (the common case) this stays entirely absent, exactly like before this
  // round. data-tv-page/data-tv-total-pages give tests (and any future
  // debugging) a language-agnostic hook, since the visible text is
  // translated and the numbers alone aren't enough to search for reliably.
  var pageInfoHtml = totalPages > 1
    ? '<div class="tvpageinfo" data-tv-page="'+(ui.tvPage+1)+'" data-tv-total-pages="'+totalPages+'">'+
        esc(tr("tvPageIndicator").replace("{cur}", ui.tvPage+1).replace("{total}", totalPages))+
      '</div>'
    : '';
  var html =
    '<div class="topbar tvtopbar">'+
      '<div class="brand-row">'+markSvg()+
        '<div class="brand-word"><span class="tagline">INBOUND</span></div></div>'+
      '<div class="clockbox"><div class="clock" id="clockEl">'+clockStr(now)+'</div>'+
      '<div class="clockdate">'+longDate(now)+'</div>'+
      // Same #pollCountdownEl id as the normal view -- tick() (js/ticking.js)
      // updates it by id with no idea which render path built it, so the
      // countdown keeps working here for free.
      '<div class="syncrow"><span class="syncdot '+syncDotClass()+'"></span>'+syncLabel()+pollCountdownHtml(now)+'</div></div>'+
    '</div>'+
    '<div class="tvtable">'+pageInfoHtml+tableHtml+'</div>'+
    tvLegendHtml();
  document.body.classList.add("tvmode");
  document.getElementById("app").innerHTML = html;
}

/* Advances the TV board to its next page every TV_ROTATE_MS (js/config.js),
   wrapping back to the first page after the last -- called once a second
   from tick() (js/ticking.js), the same lightweight pattern already used for
   the header clock, an open truck's live timer, and the refresh countdown.
   A no-op outside TV mode, and a no-op whenever today's trucks all fit on
   one page (nothing to rotate to), so this costs nothing on every other
   screen or on a quiet day. */
var tvPageChangedAt = 0;
export function tvTick(now){
  if(!ui.tvMode) return;
  var total = state.trucks.filter(function(t){ return t.date === todayKey(); }).length;
  var totalPages = Math.max(1, Math.ceil(total / TV_ROWS_PER_PAGE));
  if(ui.tvPage >= totalPages) ui.tvPage = 0;
  if(totalPages <= 1){ tvPageChangedAt = now; return; }
  if(!tvPageChangedAt) tvPageChangedAt = now;
  if(now - tvPageChangedAt >= TV_ROTATE_MS){
    ui.tvPage = (ui.tvPage + 1) % totalPages;
    tvPageChangedAt = now;
    render();
  }
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
  var showTabs = ui.role === "admin";
  // A truck pending deletion (tapped "Delete", inside the undo window --
  // see deleteTruck() in actions.js) is hidden from both the KPI strip and
  // the list right away, even though it hasn't actually been deleted yet.
  var visibleTrucks = ui.pendingDeleteId
    ? state.trucks.filter(function(t){ return t.id !== ui.pendingDeleteId; })
    : state.trucks;
  document.documentElement.setAttribute("lang", ui.lang === "th" ? "th" : "en");
  var html =
    '<div class="topbar">'+
      '<div class="brand-row">'+markSvg()+
        // "MON" is no longer repeated as text here -- it's now baked into
        // markSvg()'s full logo image (hexagon + wordmark), so only the
        // app-specific "INBOUND" tagline remains, to avoid showing "MON"
        // twice side by side.
        '<div class="brand-word"><span class="tagline">INBOUND</span>'+
        '<div class="rolebadgerow">'+
          '<button class="rolebadge" data-role-switch="1">'+(ui.role?roleLabel(ui.role):tr("selectRole"))+' ⇵</button>'+
          (ui.role==="admin" ? '<button class="rolebadge" data-open-import="1" aria-label="'+tr("importPlanAria")+'">📥</button>' : '')+
          (ui.role==="admin" ? '<button class="rolebadge" data-open-report="1" aria-label="'+tr("reportTitle")+'">📊</button>' : '')+
          (ui.role==="admin" ? '<button class="rolebadge" data-open-pin-settings="1" aria-label="'+tr("changePin")+'">⚙</button>' : '')+
          (ui.role==="admin" ? '<button class="rolebadge" data-open-app-settings="1" aria-label="'+tr("appSettingsTitle")+'">🔧</button>' : '')+
          (ui.role==="driver" ? '<button class="rolebadge" data-open-name-settings="1">'+tr("setNamePill")+'</button>' : '')+
          '<button class="rolebadge langtoggle" data-toggle-lang="1" aria-label="Language / ภาษา">'+(ui.lang==="th"?"EN":"TH")+'</button>'+
        '</div>'+
        '</div></div>'+
      '<div class="clockbox"><div class="clock" id="clockEl">'+clockStr(now)+'</div>'+
      '<div class="clockdate">'+longDate(now)+'</div>'+
      '<div class="syncrow"><span class="syncdot '+syncDotClass()+'"></span>'+syncLabel()+offlineQueueBadgeHtml()+pollCountdownHtml(now)+'</div></div>'+
    '</div>'+
    (showTabs ? tabsHtml(visibleTrucks) : '<div class="dayheading">'+tr("todaysTrucks")+'</div>')+
    '<div class="kpis">'+kpiHtml(visibleTrucks, now)+'</div>'+
    searchRowHtml()+
    '<div class="list">'+listHtml(visibleTrucks, now)+'</div>'+
    statusLegendHtml()+
    (ui.role === "admin" ? '<button class="fab" data-add="1" aria-label="'+tr("addTruckAria")+'">+</button>' : '')+
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
