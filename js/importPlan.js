/* ---------- inbound-plan import (Admin only) ----------
   Turns the planner's existing Excel/CSV file into trucks, entirely in the
   browser (SheetJS, loaded via CDN in index.html — see the <script> tag
   there — and available as the global `XLSX`). Nothing about the file
   itself is ever sent anywhere; only the trucks the admin reviews and
   confirms on the preview screen go to Supabase.

   The real files this was built against (MON's own "Incoming plan AMATA")
   have several quirks this is written to survive: the header row isn't
   always row 1 (some sheets have 2-3 title/date rows above it), header text
   is Thai and/or English and varies slightly between sheets, and the
   "master log" sheets keep growing forever (years of history in one tab) —
   so rather than trust row position or a fixed sheet name, every sheet is
   scored row-by-row to find its header, columns are matched by keyword, and
   a "from date" cutoff (default: today) throws away historical rows so a
   multi-year log doesn't get reimported as pending trucks every time.

   `importCtx` (the parsed workbook) is kept private to this module — the
   rest of the app never touches the SheetJS object directly, only the small
   read-only accessors below (hasImportFile/importFileName/importSheetNames),
   which is what keeps it safe to hold a large non-serializable object here
   without it leaking into `ui` (view state) or `state` (persisted data).

   The real files this was built against can run well past 100MB (a stray
   #REF! column recopied across a million-plus blank rows in one Excel
   version — see README) — reading and parsing that is genuinely slow, and
   doing it synchronously on the main thread used to freeze the whole page
   for the duration (nothing can repaint, not even the "Reading…" spinner,
   while JS is blocking the main thread). That work now runs in
   js/importWorker.js, a dedicated background Worker, so the page stays
   responsive while it happens; parseWorkbook() below falls back to doing
   the exact same parse on the main thread if Workers aren't available at
   all, so the feature still works either way — just without that
   responsiveness in the fallback case. */
import { pad2, todayKey } from "./dateUtils.js";
import { tr } from "./i18n.js";
import { ui } from "./state.js";
import { sbRest, loadFromSupabase, sbFetchTrucksInRange } from "./api.js";
import { render } from "./render.js";
import { showToast } from "./actions.js";
import { saveSavedPlant } from "./storage.js";
import { DEFAULT_PLANT } from "./config.js";

var importCtx = null; /* { sheetNames, sheetsData: {name: aoa}, fileName } — set once a file is parsed */

var importWorker = null;
var importWorkerReady = false; /* importScripts() inside it has confirmed success */
var importWorkerFailed = false;
/* Bounds only how long we wait to hear the worker's environment came up
   (importScripts() succeeding — a quick, one-time, usually-cached fetch) —
   never the parse itself, which runs after and can legitimately take much
   longer for a very large file. A network that silently drops the CDN
   request (rather than actively refusing it) would otherwise hang forever
   with no fallback at all. */
var IMPORT_WORKER_READY_TIMEOUT_MS = 6000;

/* header:1/raw:true/blankrows:false/defval:null — same options either way,
   whether this runs here (fallback) or inside importWorker.js. */
function extractAllSheets(wb){
  var sheets = {};
  (wb.SheetNames || []).forEach(function(name){
    var ws = wb.Sheets[name];
    sheets[name] = ws ? XLSX.utils.sheet_to_json(ws, { header:1, raw:true, blankrows:false, defval:null }) : [];
  });
  return sheets;
}
function parseWorkbookMainThread(data){
  return new Promise(function(resolve, reject){
    // A setTimeout(0) at least lets the "Reading…" spinner (already
    // rendered by the caller before this runs) paint once before the
    // synchronous parse below blocks the main thread — doesn't shorten a
    // slow parse, but stops the very first frame from looking like the
    // app just hung the instant a file was chosen.
    setTimeout(function(){
      try{
        // cellDates:false (the default, spelled out here) is deliberate --
        // see the long comment above importDateFromCell()/importTimeFromCell()
        // for why letting SheetJS hand back JS Date objects for a pure
        // time-of-day cell is NOT safe: cells stay as raw numeric Excel
        // serials, parsed by hand below with pure arithmetic instead.
        var wb = XLSX.read(data, { type:"array", cellDates:false });
        resolve({ sheetNames: wb.SheetNames || [], sheets: extractAllSheets(wb) });
      }catch(err){ reject(err); }
    }, 0);
  });
}
function parseWorkbook(data){
  if(importWorkerFailed || typeof Worker === "undefined") return parseWorkbookMainThread(data);
  return new Promise(function(resolve, reject){
    function fallbackToMainThread(){
      importWorkerFailed = true;
      if(importWorker){ try{ importWorker.terminate(); }catch(err){} importWorker = null; }
      parseWorkbookMainThread(data).then(resolve, reject);
    }
    function sendParseRequest(){
      importWorker.onmessage = function(e){
        var msg = e.data;
        if(!msg || msg.type !== "result") return;
        if(msg.ok) resolve({ sheetNames: msg.sheetNames, sheets: msg.sheets });
        // The worker itself came up fine but the parse failed (e.g.
        // genuinely not a spreadsheet) — a real error to surface, not an
        // environment limitation, so this does NOT fall back to a
        // main-thread retry (which would just fail the exact same way).
        else reject(new Error(msg.error || "worker parse failed"));
      };
      // No transfer list on purpose: transferring `data.buffer` would
      // detach it on the main thread, and it may still be needed for
      // fallbackToMainThread() above if something goes wrong later. The
      // one-time copy this costs is negligible next to the parse itself.
      importWorker.postMessage({ type: "parse", buffer: data.buffer });
    }
    if(importWorkerReady && importWorker){ sendParseRequest(); return; }
    if(!importWorker){
      try{ importWorker = new Worker("js/importWorker.js"); }
      catch(err){ fallbackToMainThread(); return; }
    }
    var readyTimer = setTimeout(fallbackToMainThread, IMPORT_WORKER_READY_TIMEOUT_MS);
    importWorker.onerror = function(){
      clearTimeout(readyTimer);
      fallbackToMainThread();
    };
    importWorker.onmessage = function(e){
      if(!e.data || e.data.type !== "ready") return;
      clearTimeout(readyTimer);
      importWorkerReady = true;
      sendParseRequest();
    };
  });
}

export function hasImportFile(){ return !!importCtx; }
export function importFileName(){ return importCtx ? importCtx.fileName : ""; }
export function importSheetNames(){ return importCtx ? importCtx.sheetNames : []; }

/* Resets the import screen to its opening state — called when the admin
   taps the 📥 icon in the header. */
export function openImportPlan(){
  ui.importOpen = true; ui.importStep = "pick"; ui.importError = null; ui.importBusy = false;
  ui.importSelected = {}; ui.importFromDate = todayKey(); ui.importResult = null;
  importCtx = null;
  ui.openId = null; ui.addOpen = false;
  render();
}

var IMPORT_FIELD_MATCHERS = [
  { field:"po", any:["po"], exact:true },
  { field:"carrier", any:["supplier name","บริษัทขนส่ง"] },
  // Round 28: "RM PM incoming" carries a second column, "ชื่อภาษาไทย"
  // ("Thai name") -- confirmed with Theo (real file inspected) that this is
  // NOT reliably a translation of the carrier/supplier name: sometimes it
  // is (e.g. "S&D Industries Co Ltd" -> "เอส แอน ดี"), but sometimes it names
  // the actual physical trucking company instead ("Sarval Limited",
  // "Novosana", "Pesquera Fiordo Austral" all show "รถบริษัทมนต์" = "MON's
  // own truck" here). Folding it into `carrier` would have silently
  // collapsed distinct suppliers onto the same displayed name. Kept as its
  // own field (carrierTh) instead, shown as a second line under the
  // carrier's own name (see render.js) -- never part of the identity/dedupe
  // key (importCoreKey/importRowKey below, unchanged). "Indirect incoming"
  // has no such column, so trucks from that sheet just have carrierTh=null.
  { field:"carrierTh", any:["ชื่อภาษาไทย"] },
  { field:"desc", any:["ประเภทสินค้าหรืองานที่ขนส่ง"] },
  { field:"qty", any:["จำนวนที่ขนส่ง"] },
  { field:"unit", any:["หน่วย"], exact:true },
  { field:"date", any:["วันที่ขนส่ง","วันส่งสินค้า"] },
  { field:"eta", any:["เวลาเข้าโรงงาน"] },
  { field:"code", any:["โค้ดของที่มาส่ง"] },
  { field:"remark", any:["remark","หมายเหตุ"] }
];

function importNormHeader(v){
  return String(v==null?"":v).replace(/\s+/g," ").trim().toLowerCase();
}
function importDetectColumnMap(headerRow){
  var map = {};
  (headerRow||[]).forEach(function(cell, idx){
    var norm = importNormHeader(cell);
    if(!norm) return;
    IMPORT_FIELD_MATCHERS.forEach(function(m){
      if(map[m.field] != null) return; /* first (leftmost) matching column wins */
      var hit = m.any.some(function(pat){
        pat = pat.toLowerCase();
        return m.exact ? norm === pat : norm.indexOf(pat) !== -1;
      });
      if(hit) map[m.field] = idx;
    });
  });
  return map;
}
function importFindHeaderRow(aoa){
  var bestIdx = -1, bestScore = 0;
  for(var i=0; i<Math.min(20, aoa.length); i++){
    var score = Object.keys(importDetectColumnMap(aoa[i])).length;
    if(score > bestScore){ bestScore = score; bestIdx = i; }
  }
  return bestScore >= 3 ? bestIdx : -1;
}
/* Cells are read with cellDates:false (see parseWorkbookMainThread()/
   importWorker.js) — the raw Excel numeric serial, never a JS Date object —
   and converted below with XLSX.SSF.parse_date_code(), pure arithmetic with
   no timezone involved anywhere.

   This used to ask SheetJS for cellDates:true and read the resulting Date
   objects back with UTC getters, on the (reasonable-sounding, and correct
   for a genuine calendar date) theory that "SheetJS hands back dates in UTC
   regardless of the browser's own timezone". That held for the `date`
   column, but NOT for `eta`, a pure time-of-day value: Excel has no native
   "time with no date" type, so any bare time serial (e.g. 0.2917 for 07:00)
   is anchored on Excel's day-zero pseudo-date, 1899-12-30. SheetJS builds
   that Date via the LOCAL multi-arg constructor -- so on a machine whose
   system timezone is Asia/Bangkok (every real user of this app), the
   JS/ICU timezone database resolves "Dec 30 1899, Bangkok" using Bangkok's
   historical local time from BEFORE it standardized on UTC+7 in 1920 --
   LMT +06:42:04 -- not the modern +07:00. Reading that Date back with UTC
   getters then recovers a time shifted by the ~17m56s difference between
   those two offsets (07:00 real becomes "00:17", 09:00 becomes "02:17", and
   so on) -- silently, consistently, and invisibly in this cloud sandbox
   (system timezone UTC, no such historical quirk, so every test and every
   import run from here looked correct) until a real import ran on a real
   Bangkok-timezone machine and produced exactly this pattern. Found by
   comparing a real "Incoming plan" import against the source file's raw
   XML cell values directly (07:00 in the file, "00:17" in the app) -- the
   17m56s gap is an exact match for Bangkok's documented pre-1920 LMT
   offset, not a rounding artifact. cellDates:false plus manual arithmetic
   below never constructs a Date object for these cells at all, so this
   whole timezone-database question never arises. Cells that stay a plain
   string (e.g. an "08:00 - 17:00" window typed as text) are handled as a
   fallback, same as before. */
function importDateFromCell(v){
  if(typeof v === "number"){
    var d = XLSX.SSF.parse_date_code(v);
    if(d) return d.y+"-"+pad2(d.m)+"-"+pad2(d.d);
  }
  if(typeof v === "string"){
    var m = v.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if(m) return m[1]+"-"+pad2(+m[2])+"-"+pad2(+m[3]);
  }
  // Defensive only: a real Date object should never reach here now that
  // cells are read with cellDates:false, but if one ever does (some other
  // caller, a future refactor), local getters are the safe choice -- see
  // the long comment above for why UTC getters are the ones that break.
  if(v instanceof Date) return v.getFullYear()+"-"+pad2(v.getMonth()+1)+"-"+pad2(v.getDate());
  return null;
}
function importTimeFromCell(v){
  if(typeof v === "number"){
    var d = XLSX.SSF.parse_date_code(v);
    if(d) return pad2(d.H)+":"+pad2(d.M);
  }
  if(typeof v === "string"){
    var m = v.match(/(\d{1,2}):(\d{2})/);
    if(m) return pad2(+m[1])+":"+pad2(+m[2]);
  }
  if(v instanceof Date) return pad2(v.getHours())+":"+pad2(v.getMinutes());
  return null;
}
function importFormatQty(v){
  if(typeof v !== "number") return String(v).trim();
  return String(Math.round(v*100)/100);
}
function importCleanText(v){
  return String(v==null?"":v).replace(/\s+/g," ").trim();
}
/* JSON-safe copy of a raw cell value — used only for the catch-all `raw`
   column (see below), so a Date becomes a plain string rather than an
   object that would serialize unpredictably.

   Cells are read with cellDates:false now (see importDateFromCell()'s
   comment above for why), so a date/time-formatted cell arrives here as a
   plain Excel serial number, same as any other numeric column (a quantity,
   a code) — nothing here can safely tell those apart by value alone (a real
   quantity like 20000 or 30000 KG, seen in real files, sits squarely inside
   the same numeric range as a 2026 date serial, so guessing "this number
   looks like a date" would misfire and corrupt an ordinary quantity into a
   fake date). Rather than guess, unmapped date/time columns swept into this
   catch-all now show their raw serial number instead of a formatted string
   — a behavior change from before, but `raw`'s whole point (Round 7) is
   never silently losing a value, not necessarily pretty-printing it; the
   number is right there, just not formatted. The two fields that DO need to
   be formatted and matter functionally — `date`/`eta` — go through
   importDateFromCell()/importTimeFromCell() directly (see importExtractRows
   below), not through here. */
function importJsonSafeCell(v){
  if(v instanceof Date){
    // Defensive only — see importDateFromCell()'s comment for why local
    // (not UTC) getters are the safe choice if a Date object ever reaches
    // here despite cellDates:false.
    var isDateOnly = v.getHours()===0 && v.getMinutes()===0 && v.getSeconds()===0 && v.getFullYear() > 1980;
    return isDateOnly ? importDateFromCell(v) : importTimeFromCell(v);
  }
  if(typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  return v == null ? null : String(v);
}
/* Every column in the sheet, keyed by its own header text (not just the
   handful of fields mapped to trucks.* columns) — so nothing the source
   file contains is silently dropped, even columns this importer doesn't
   know what to do with yet (weighing, gross weight, on-time flags, the
   late-penalty figure, etc). Stored as trucks.raw (jsonb); see
   supabase-schema.sql. Columns with no header text are skipped rather
   than keyed by a meaningless "col_7". */
function importBuildRaw(row, headerRow){
  var raw = {};
  var any = false;
  (headerRow||[]).forEach(function(h, idx){
    var key = importCleanText(h);
    if(!key) return;
    var val = row[idx];
    if(val == null || val === "") return;
    raw[key] = importJsonSafeCell(val);
    any = true;
  });
  return any ? raw : null;
}
function importExtractRows(dataRows, colMap, sheetLabel, headerRow){
  var out = [];
  (dataRows||[]).forEach(function(row){
    if(!row) return;
    var orderDate = colMap.date!=null ? importDateFromCell(row[colMap.date]) : null;
    if(!orderDate) return; /* no usable date = a blank/spacer/title row, not a truck */
    var carrier = colMap.carrier!=null ? importCleanText(row[colMap.carrier]) : "";
    var desc = colMap.desc!=null ? importCleanText(row[colMap.desc]) : "";
    var po = colMap.po!=null && row[colMap.po]!=null ? String(row[colMap.po]).trim() : "";
    if(!carrier && !desc && !po) return; /* nothing usable on this row either */
    var qtyRaw = colMap.qty!=null ? row[colMap.qty] : null;
    var unit = colMap.unit!=null && row[colMap.unit]!=null ? String(row[colMap.unit]).trim() : "";
    var code = colMap.code!=null && row[colMap.code]!=null ? String(row[colMap.code]).trim() : "";
    var remark = colMap.remark!=null ? importCleanText(row[colMap.remark]) : "";
    var carrierTh = colMap.carrierTh!=null ? importCleanText(row[colMap.carrierTh]) : "";
    var matTypeRaw = String(row[0]==null?"":row[0]).trim().toUpperCase();
    var matType = /^(RM|PM)$/.test(matTypeRaw) ? matTypeRaw : null;
    out.push({
      carrier: carrier || null,
      carrierTh: carrierTh || null,
      matType: matType,
      details: (matType ? "["+matType+"] " : "") + desc,
      po_no: po || null,
      qtt: (qtyRaw!=null && qtyRaw!=="") ? (importFormatQty(qtyRaw)+(unit?(" "+unit):"")) : "",
      sku_no: code || null,
      remark: remark,
      order_date: orderDate,
      eta: colMap.eta!=null ? importTimeFromCell(row[colMap.eta]) : null,
      raw: importBuildRaw(row, headerRow),
      _source: sheetLabel
    });
  });
  return out;
}
function importParseSheet(sheetsData, sheetName){
  var aoa = (sheetsData && sheetsData[sheetName]) || [];
  if(!aoa.length) return { rows:[], error:null };
  var headerIdx = importFindHeaderRow(aoa);
  if(headerIdx === -1) return { rows:[], error:"noHeader" };
  var colMap = importDetectColumnMap(aoa[headerIdx]);
  return { rows: importExtractRows(aoa.slice(headerIdx+1), colMap, sheetName, aoa[headerIdx]), error:null };
}
/* Core identity of a delivery *slot* — PO + date + time + carrier — with NO
   product/qty in it. Used only to spot when several source rows share the
   same slot, so they can be numbered "Truck 1", "Truck 2", ... (see
   importGroupRows below). Deliberately NOT used anymore to decide "is this
   row already imported" — see importRowKey(). */
function importCoreKey(poNo, date, eta, carrier){
  return (poNo||"")+"|"+(date||"")+"|"+(eta||"")+"|"+String(carrier||"").trim().toLowerCase();
}
/* Full dedupe key for one row: core slot key + product/qty, so two distinct
   trucks that happen to share a PO+date+time+carrier (see importGroupRows'
   comment below) are never mistaken for the same already-imported row just
   because they share that slot. Used both for rows freshly read from the
   source file and for rows already sitting in Supabase (sbFetchTrucksInRange
   now returns sku_no/details/qtt too, purely so this function can be applied
   the same way on both sides). */
function importRowKey(poNo, date, eta, carrier, skuNo, details, qtt){
  return importCoreKey(poNo, date, eta, carrier)+"|"+
    String(skuNo||"").trim().toLowerCase()+"|"+
    String(details||"").replace(/\s+/g," ").trim().toLowerCase()+"|"+
    String(qtt||"").trim().toLowerCase();
}
/* Round 26: MON confirmed (real "Incoming plan" rows for PO 4563895042, four
   rows, four different products/quantities/line numbers, identical date+
   time+carrier) that several rows sharing a PO+date+time+carrier are
   genuinely SEPARATE trucks, not several lots on one truck — reversing the
   Round 10 decision to merge them into a single truck with a `lots` array.
   Every row is now its own truck. The only thing importCoreKey() is still
   used for is counting: when more than one row in this file shares the same
   slot, each gets a `truckLabel` ("<PO> - Truck 1", "- Truck 2", ...) in
   file order, so they still read as related in the dashboard; a row that
   doesn't share its slot with anything else gets no label at all, same as
   before this change. */
function importGroupRows(rows){
  var coreCounts = {};
  rows.forEach(function(r){
    var ck = importCoreKey(r.po_no, r.order_date, r.eta, r.carrier);
    coreCounts[ck] = (coreCounts[ck]||0) + 1;
  });
  var seen = {};
  return rows.map(function(r){
    var ck = importCoreKey(r.po_no, r.order_date, r.eta, r.carrier);
    var truckLabel = null;
    if(coreCounts[ck] > 1){
      seen[ck] = (seen[ck]||0) + 1;
      truckLabel = (r.po_no || "PO") + " - Truck " + seen[ck];
    }
    return {
      key: importRowKey(r.po_no, r.order_date, r.eta, r.carrier, r.sku_no, r.details, r.qtt),
      truckLabel: truckLabel,
      carrier: r.carrier, carrierTh: r.carrierTh, matType: r.matType,
      po_no: r.po_no, order_date: r.order_date, eta: r.eta,
      details: r.details, qtt: r.qtt, sku_no: r.sku_no, remark: r.remark, raw: r.raw
    };
  });
}

export function handleImportFile(file){
  ui.importError = null;
  ui.importBusy = true;
  render();
  var reader = new FileReader();
  reader.onload = function(){
    var data = new Uint8Array(reader.result);
    parseWorkbook(data).then(function(result){
      importCtx = { sheetNames: result.sheetNames, sheetsData: result.sheets, fileName: file.name };
      ui.importSelected = {};
      result.sheetNames.forEach(function(n){
        ui.importSelected[n] = /incoming/i.test(n) && !/รปภ/.test(n);
      });
      ui.importBusy = false;
      ui.importStep = "pick";
      render();
    }).catch(function(){
      importCtx = null;
      ui.importBusy = false;
      ui.importError = tr("importParseFailed");
      render();
    });
  };
  reader.onerror = function(){
    ui.importBusy = false;
    ui.importError = tr("importParseFailed");
    render();
  };
  reader.readAsArrayBuffer(file);
}

export function runImportPreview(){
  if(!importCtx) return;
  var fromDateEl = document.getElementById("import-from-date");
  if(fromDateEl && fromDateEl.value) ui.importFromDate = fromDateEl.value;
  var plantEl = document.getElementById("import-plant");
  if(plantEl && plantEl.value.trim()){ ui.importPlant = plantEl.value.trim(); saveSavedPlant(ui.importPlant); }
  var selectedNames = Object.keys(ui.importSelected).filter(function(n){ return ui.importSelected[n]; });
  if(!selectedNames.length){ ui.importError = tr("importPickAtLeastOne"); render(); return; }
  ui.importBusy = true; ui.importError = null; render();
  var allRows = [], hadHeaderError = false;
  selectedNames.forEach(function(name){
    var res = importParseSheet(importCtx.sheetsData, name);
    if(res.error) hadHeaderError = true;
    allRows = allRows.concat(res.rows);
  });
  var fromDate = ui.importFromDate;
  var pastCount = 0;
  var kept = allRows.filter(function(r){
    if(r.order_date < fromDate){ pastCount++; return false; }
    return true;
  });
  // Which trucks already exist for these exact dates? Deliberately queried
  // fresh from Supabase (sbFetchTrucksInRange), scoped to the actual min/max
  // dates found in the file being imported -- NOT read off state.trucks,
  // which (since the server-side day-window added alongside this) only ever
  // holds the +/-MAX_DAY_OFFSET days the UI can display. A manager
  // re-importing an older file (say, a few months back, for record-keeping)
  // would otherwise have every one of those already-imported trucks look
  // "new" and get duplicated, since state.trucks wouldn't contain them
  // anymore. Querying the exact date range in the file sidesteps that
  // entirely, and is more correct than the old approach even for a same-day
  // import (it no longer depends on state.trucks having finished loading).
  var minDate = null, maxDate = null;
  kept.forEach(function(r){
    if(minDate === null || r.order_date < minDate) minDate = r.order_date;
    if(maxDate === null || r.order_date > maxDate) maxDate = r.order_date;
  });
  var existingLookup = (minDate === null) ? Promise.resolve([]) : sbFetchTrucksInRange(minDate, maxDate);
  return existingLookup.then(function(existingTrucks){
    var existingKeys = {};
    existingTrucks.forEach(function(t){
      existingKeys[importRowKey(t.poNo, t.date, t.eta, t.carrier, t.skuNo, t.details, t.qtt)] = true;
    });
    // Round 26: each source row is now its own truck (see importGroupRows) —
    // one skip decision per row, keyed on the full product-aware
    // importRowKey(), not just the PO+date+time+carrier slot (several rows
    // can legitimately share that slot — see the comment above
    // importGroupRows).
    var groups = importGroupRows(kept);
    var dupeCount = 0, toImport = [];
    groups.forEach(function(g){
      if(existingKeys[g.key]){ dupeCount++; return; }
      toImport.push(g);
    });
    toImport.sort(function(a,b){
      if(a.order_date !== b.order_date) return a.order_date < b.order_date ? -1 : 1;
      var ae = a.eta || "99:99", be = b.eta || "99:99";
      return ae < be ? -1 : (ae > be ? 1 : 0);
    });
    ui.importResult = { toImport: toImport, dupeCount: dupeCount, pastCount: pastCount };
    ui.importBusy = false;
    ui.importError = hadHeaderError ? tr("importSomeSheetsSkipped") : null;
    ui.importStep = "preview";
    render();
  }).catch(function(){
    // Dedupe-check query failed (network hiccup, missing table, etc.) --
    // fail safe rather than silently importing possible duplicates: show the
    // same error path as any other Supabase failure and let the admin retry.
    ui.importBusy = false;
    ui.importError = tr("importSaveFailed");
    render();
  });
}

export function runImportConfirm(){
  var r = ui.importResult;
  if(!r || !r.toImport.length) return;
  ui.importBusy = true; ui.syncStatus = "saving"; render();
  // Round 26: each entry in r.toImport is now its own truck (one source row
  // = one truck — see importGroupRows), carrying its own details/qtt/sku_no/
  // remark/raw directly, plus truck_label when it shares its PO+date+time+
  // carrier slot with other rows in this file ("<PO> - Truck 2", ...).
  var rows = r.toImport.map(function(g, idx){
    return {
      reference_id: "T-"+Date.now().toString(36).toUpperCase()+idx.toString(36).toUpperCase(),
      carrier: g.carrier, carrier_th: g.carrierTh || null, mat_type: g.matType || null,
      plant: (ui.importPlant || DEFAULT_PLANT), im_ex_tr: "IM",
      po_no: g.po_no, sku_no: g.sku_no, qtt: g.qtt,
      remark: g.remark, details: g.details,
      order_date: g.order_date,
      eta: g.eta ? (g.order_date+"T"+g.eta+":00") : null,
      truck_state: "pending",
      raw: g.raw || null, /* every source column, verbatim — see supabase-schema.sql */
      truck_label: g.truckLabel || null
    };
  });
  var labeledCount = rows.filter(function(rw){ return !!rw.truck_label; }).length;
  var CHUNK = 40, i = 0;
  var rawColumnMissing = false, truckLabelColumnMissing = false;
  var carrierThColumnMissing = false, matTypeColumnMissing = false;
  function stripKeys(chunk, keys){
    return chunk.map(function(r2){
      var c = {};
      for(var k in r2) if(keys.indexOf(k) === -1) c[k] = r2[k];
      return c;
    });
  }
  function isMissingColumnError(err, col){
    var msg = String((err && err.message) || "");
    return new RegExp("\\b"+col+"\\b","i").test(msg) && /(column|schema cache|does not exist)/i.test(msg);
  }
  function attemptInsert(chunk){
    return sbRest("trucks", { method:"POST", headers:{ "Prefer":"return=minimal" }, body: chunk }).catch(function(err){
      if(!rawColumnMissing && isMissingColumnError(err, "raw")){
        rawColumnMissing = true;
        return attemptInsert(stripKeys(chunk, ["raw"]));
      }
      if(!truckLabelColumnMissing && isMissingColumnError(err, "truck_label")){
        truckLabelColumnMissing = true;
        return attemptInsert(stripKeys(chunk, ["truck_label"]));
      }
      if(!carrierThColumnMissing && isMissingColumnError(err, "carrier_th")){
        carrierThColumnMissing = true;
        return attemptInsert(stripKeys(chunk, ["carrier_th"]));
      }
      if(!matTypeColumnMissing && isMissingColumnError(err, "mat_type")){
        matTypeColumnMissing = true;
        return attemptInsert(stripKeys(chunk, ["mat_type"]));
      }
      throw err;
    });
  }
  function next(){
    if(i >= rows.length){
      return loadFromSupabase().then(function(){
        ui.importBusy = false;
        ui.importOpen = false;
        importCtx = null;
        var msg = tr("importDoneToast").replace("{n}", rows.length);
        if(rawColumnMissing) msg += " " + tr("importRawColumnMissing");
        if(truckLabelColumnMissing && labeledCount > 0) msg += " " + tr("importTruckLabelColumnMissing");
        // Round 28: cosmetic-only columns (Thai carrier name, RM/PM type) --
        // never worth their own toast on top of the two above; a silent
        // fallback (raw still captures them under their original Thai
        // header text either way) is enough until ISD migrates the schema.
        showToast(msg);
      });
    }
    var already = [];
    if(rawColumnMissing) already.push("raw");
    if(truckLabelColumnMissing) already.push("truck_label");
    if(carrierThColumnMissing) already.push("carrier_th");
    if(matTypeColumnMissing) already.push("mat_type");
    var chunk = stripKeys(rows.slice(i, i+CHUNK), already);
    i += CHUNK;
    return attemptInsert(chunk).then(next);
  }
  next().catch(function(){
    return loadFromSupabase().then(function(){
      ui.importBusy = false;
      ui.syncStatus = "error";
      ui.importError = tr("importSaveFailed");
      render();
    });
  });
}
