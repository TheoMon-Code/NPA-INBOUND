/* ---------- rendering ----------
   No framework: `render()` rebuilds the whole app's HTML from `state` + `ui`
   on every change and writes it into #app. Everything here is a pure
   function of those two objects (plus the current clock) — all the actual
   mutation happens in actions.js/importPlan.js, which call render() when
   they're done. */
import { state, ui } from "./state.js";
import { tr } from "./i18n.js";
import { derive, lateMinutes, STATUS_KEYS } from "./status.js";
import { esc, shortDate, fmtElapsed, dateTimeOf, clockStr, addDays, todayKey } from "./dateUtils.js";
import { DAY_LABELS, MONTH_LABELS, DAY_LABELS_TH, MONTH_LABELS_TH, MAX_PHOTOS_PER_TRUCK, MAX_DAY_OFFSET } from "./config.js";
import { loadSavedName } from "./storage.js";
import { supabaseEnabled } from "./api.js";
import { hasImportFile, importFileName, importSheetNames } from "./importPlan.js";

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
  if(derived === "scheduled") txt = tr("pill_eta") + " " + t.eta;
  if(derived === "late") txt = tr("status_late") + " · " + lateMinutes(t, now) + " " + tr("unit_min");
  if(derived === "unloading") txt = tr("status_unloading") + " · " + fmtElapsed(now - new Date(t.startedAt));
  if(derived === "done" && t.startedAt && t.finishedAt){
    txt = tr("status_done") + " · " + fmtHM((new Date(t.finishedAt)-new Date(t.startedAt))/60000);
  }
  return '<span class="pill '+derived+'">'+esc(txt)+"</span>";
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
  return '<button class="card" data-open="'+esc(t.id)+'">'+
    '<span class="stripe '+d+'"></span>'+
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
  // nav arrows that jump 5 days at a time (Round 13, Theo's request: "un
  // bouton pour revenir 5 jours avant et 5 jours après"), clamped to
  // [-MAX_DAY_OFFSET, +MAX_DAY_OFFSET] overall. When the arrows land outside
  // -1/0/+1 none of the three quick tabs is "active", so a small date pill
  // shows which day is actually selected.
  var quick = [ {o:-1, label:tr("tabYesterday")}, {o:0, label:tr("tabToday")}, {o:1, label:tr("tabTomorrow")} ];
  var cur = ui.dayOffset;
  var atMin = cur <= -MAX_DAY_OFFSET, atMax = cur >= MAX_DAY_OFFSET;
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
    '<button class="tab tab-nav" data-day-nav="-5" aria-label="'+tr("navBack5Days")+'"'+(atMin?" disabled":"")+'>◀ 5</button>'+
    '<div class="tabs">'+quickHtml+'</div>'+
    '<button class="tab tab-nav" data-day-nav="5" aria-label="'+tr("navForward5Days")+'"'+(atMax?" disabled":"")+'>5 ▶</button>'+
  '</div>'+dateInfo;
}
function listHtml(trucks, now){
  var dayTrucks = trucks.filter(function(t){ return t.date === addDays(todayKey(), effectiveDayOffset()); });
  dayTrucks.sort(function(a,b){ return sortWeight(a,now) - sortWeight(b,now); });
  if(!dayTrucks.length){
    return '<div class="empty"><span class="empty-icon">🚚</span><div>'+tr("noTrucksToday")+'</div></div>';
  }
  // A short list on a tall phone screen (especially standalone/home-screen
  // mode, which has no browser chrome eating into the viewport) can leave a
  // large blank area below the cards that reads as broken rather than
  // intentional. This closing line turns that empty space into a deliberate
  // "end of list" instead of an unexplained void.
  return dayTrucks.map(function(t){ return cardHtml(t, now); }).join("")+
    '<div class="list-end">'+tr("endOfList")+'</div>';
}

function sheetHtml(now){
  if(ui.importOpen) return importSheetHtml();
  if(ui.pinSettingsOpen) return pinSettingsHtml();
  if(ui.nameSettingsOpen) return nameSettingsHtml();
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
  var slots = photos.map(function(p){
    var rm = ui.role === "admin" ? '<button class="photoslot-rm" data-photo-remove="'+esc(p.id)+'" data-photo-truck="'+esc(t.id)+'" data-photo-path="'+esc(p.storagePath)+'" aria-label="Remove">✕</button>' : "";
    return '<div class="photoslot"><a href="'+esc(p.url)+'" target="_blank" rel="noopener"><img src="'+esc(p.url)+'" loading="lazy"></a>'+rm+'</div>';
  }).join("");
  if(photos.length < MAX_PHOTOS_PER_TRUCK){
    slots += '<button class="photoslot add" data-photo-add="'+esc(t.id)+'"><span style="font-size:22px;line-height:1">+</span><span>'+tr("addPhoto")+'</span></button>';
  }
  return '<div class="sheet-section"><div class="label">'+tr("photosTitle")+'</div>'+
    '<div class="hint">'+tr("photosHint").replace("{n}", MAX_PHOTOS_PER_TRUCK)+'</div>'+
    '<div class="photogrid">'+slots+'</div></div>';
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
  if(!ui.toast) return "";
  var retry = ui.retryAction ? '<button class="toast-retry" data-toast-retry="1">'+tr("retry")+'</button>' : "";
  return '<div class="toast"><span>'+esc(ui.toast)+"</span>"+retry+"</div>";
}
function syncDotClass(){
  return { local:"local", connecting:"local", saving:"saving", synced:"", error:"err" }[ui.syncStatus] || "";
}
function syncLabel(){
  return { local:tr("sync_local"), connecting:tr("sync_connecting"), saving:tr("sync_saving"), synced:tr("sync_synced"), error:tr("sync_error") }[ui.syncStatus] || "";
}

export function render(){
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
  var now = new Date();
  var showTabs = ui.role === "admin";
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
          (ui.role==="admin" ? '<button class="rolebadge" data-open-pin-settings="1" aria-label="'+tr("changePin")+'">⚙</button>' : '')+
          (ui.role==="driver" ? '<button class="rolebadge" data-open-name-settings="1">'+tr("setNamePill")+'</button>' : '')+
          '<button class="rolebadge langtoggle" data-toggle-lang="1" aria-label="Language / ภาษา">'+(ui.lang==="th"?"EN":"TH")+'</button>'+
        '</div>'+
        '</div></div>'+
      '<div class="clockbox"><div class="clock" id="clockEl">'+clockStr(now)+'</div>'+
      '<div class="clockdate">'+longDate(now)+'</div>'+
      '<div class="syncrow"><span class="syncdot '+syncDotClass()+'"></span>'+syncLabel()+'</div></div>'+
    '</div>'+
    (showTabs ? tabsHtml(state.trucks) : '<div class="dayheading">'+tr("todaysTrucks")+'</div>')+
    '<div class="kpis">'+kpiHtml(state.trucks, now)+'</div>'+
    '<div class="list">'+listHtml(state.trucks, now)+'</div>'+
    (ui.role === "admin" ? '<button class="fab" data-add="1" aria-label="'+tr("addTruckAria")+'">+</button>' : '')+
    sheetHtml(now)+
    roleGateHtml()+
    toastHtml()+
    // No `capture` attribute: that hint forces the camera open directly and
    // only ever allows one shot, which rules out picking several existing
    // photos at once. Without it, phones show their normal chooser (camera
    // vs. gallery) and `multiple` lets a gallery pick grab several at a time.
    '<input type="file" accept="image/*" multiple id="photoAddInput" style="display:none">';
  document.getElementById("app").innerHTML = html;
  if(scrollY) window.scrollTo(0, scrollY);
}
