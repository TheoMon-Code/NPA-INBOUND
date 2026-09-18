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
  // key (importCoreKey below, unchanged). "Indirect incoming"
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

/* Round 31: MON's separate weekly "Call off" sheet for frozen goods (Khun
   Badeeson, forwarded a new "2.CALL OFF FREOZEN 2026.xlsx" template) has
   nothing in common with the RM/PM headers above -- English column names,
   no PO, no carrier/supplier name at all. Its own matcher list, scored and
   detected the same way (importFindHeaderRow/importDetectColumnMap now take
   the matcher list as a parameter so both sheet shapes share that logic).
   Real header row inspected directly (openpyxl): "Week","Version","Route",
   "Trip","Day","Delivery date","Time arrive @ Nestle","Mat Code ",
   "Describtion " (sic -- the file really does misspell it, matched either
   way), "Pallet size","Call off Q'TY ","Q'TY (Pllt)","Batch number ",
   "Remark","Data Log","Complete","ใบเคลื่อนย้าย". */
var CALLOFF_FIELD_MATCHERS = [
  { field:"route", any:["route"], exact:true },
  { field:"trip", any:["trip"], exact:true },
  { field:"date", any:["delivery date"] },
  { field:"eta", any:["time arrive"] },
  { field:"matCode", any:["mat code"] },
  { field:"desc", any:["describtion","description"] },
  { field:"qty", any:["call off q"] }, /* "Call off Q'TY " -- apostrophe left out of the match pattern on purpose */
  { field:"qtyPllt", any:["pllt"] }, /* "Q'TY (Pllt)" -- distinct from the plain qty column above by this alone */
  { field:"batchNo", any:["batch number"] },
  { field:"remark", any:["remark"] }
];

function importNormHeader(v){
  return String(v==null?"":v).replace(/\s+/g," ").trim().toLowerCase();
}
function importDetectColumnMap(headerRow, matchers){
  var map = {};
  (headerRow||[]).forEach(function(cell, idx){
    var norm = importNormHeader(cell);
    if(!norm) return;
    (matchers || IMPORT_FIELD_MATCHERS).forEach(function(m){
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
function importFindHeaderRow(aoa, matchers){
  var bestIdx = -1, bestScore = 0;
  for(var i=0; i<Math.min(20, aoa.length); i++){
    var score = Object.keys(importDetectColumnMap(aoa[i], matchers)).length;
    if(score > bestScore){ bestScore = score; bestIdx = i; }
  }
  return bestScore >= 3 ? bestIdx : -1;
}
/* "Call off" is a dedicated tab in Badeeson's workbook, always under this
   exact name (confirmed against the real file) -- detected by sheet name
   rather than by header content, since its headers are English/generic
   enough ("Route", "Trip", "Remark"...) that scoring them against every
   sheet risked a false match on an unrelated tab somewhere in a 60-sheet
   workbook. A stray space or dash ("Call-off", "Call  off") still matches. */
function isCallOffSheetName(name){
  return /call\s*-?\s*off/i.test(String(name||"").trim());
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
      _source: sheetLabel,
      _kind: "generic"
    });
  });
  return out;
}
/* Round 31: "Call off" rows for the *return* leg ("AM > Mon" -- MON's own
   truck heading back from the plant) aren't a delivery to track/unload here
   -- only "Mon > AM" (arriving at the plant) becomes a truck. Compared
   case-insensitively after trimming since the real file has no consistent
   spacing around "&gt;". Recommended to Theo (no existing carrier/PO to
   anchor a decision on either way) rather than confirmed against a real
   on-site process -- flag to Khun Badeeson if "AM > Mon" turns out to need
   tracking too. */
function isCallOffArrivalRoute(route){
  return String(route||"").trim().toLowerCase() === "mon > am";
}
/* One row here is one BATCH (a pallet group with its own batch/traceability
   number), never a truck on its own -- importGroupCallOffRows() below folds
   every batch sharing a Route+Trip+Delivery date+Time-arrive into one truck.
   Unlike the RM/PM sheet (Round 30: confirmed distinct PO rows can be
   genuinely separate trucks), the real file shows several batch numbers,
   and often several different Mat Codes/products, under the exact same
   trip -- e.g. WK02 Mon>AM Trip 1, Wed 07/01 11:00 carries Tuna, Salmon AND
   Chicken batches together, unmistakably one physical truck's mixed load,
   not several trucks that happen to share a timestamp. */
function importExtractCallOffRows(dataRows, colMap, sheetLabel, headerRow){
  var out = [];
  (dataRows||[]).forEach(function(row){
    if(!row) return;
    var orderDate = colMap.date!=null ? importDateFromCell(row[colMap.date]) : null;
    if(!orderDate) return; /* no usable date = a blank/spacer row below the real data */
    var route = colMap.route!=null ? importCleanText(row[colMap.route]) : "";
    if(!isCallOffArrivalRoute(route)) return;
    var trip = colMap.trip!=null && row[colMap.trip]!=null ? String(row[colMap.trip]).trim() : "";
    var matCode = colMap.matCode!=null && row[colMap.matCode]!=null ? String(row[colMap.matCode]).trim() : "";
    var desc = colMap.desc!=null ? importCleanText(row[colMap.desc]) : "";
    if(!matCode && !desc) return; /* nothing usable on this row either */
    var qtyRaw = colMap.qty!=null ? row[colMap.qty] : null;
    var qtyPllt = colMap.qtyPllt!=null && row[colMap.qtyPllt]!=null ? String(row[colMap.qtyPllt]).trim() : "";
    var batchNo = colMap.batchNo!=null && row[colMap.batchNo]!=null ? String(row[colMap.batchNo]).trim() : "";
    var remarkTxt = colMap.remark!=null ? importCleanText(row[colMap.remark]) : "";
    // Batch number folded into the remark text (there's no dedicated
    // trucks.* column for it) -- same reasoning as carrierTh not existing
    // for "Indirect incoming": rather than add a schema column for a field
    // only this one sheet type has, it rides along with whatever free-text
    // remark the file already carries, and the batch number is separately
    // still there verbatim in `raw` either way.
    var remark = (batchNo ? "Batch "+batchNo : "") + (remarkTxt ? ((batchNo?" — ":"")+remarkTxt) : "");
    out.push({
      route: route, trip: trip || "1",
      details: "[FZ] " + desc,
      qtt: (qtyRaw!=null && qtyRaw!=="") ? (importFormatQty(qtyRaw)+" KG"+(qtyPllt?(" ("+qtyPllt+" plt)"):"")) : "",
      sku_no: matCode || null,
      remark: remark,
      order_date: orderDate,
      eta: colMap.eta!=null ? importTimeFromCell(row[colMap.eta]) : null,
      raw: importBuildRaw(row, headerRow),
      _source: sheetLabel,
      _kind: "calloff"
    });
  });
  return out;
}
function importParseSheet(sheetsData, sheetName){
  var aoa = (sheetsData && sheetsData[sheetName]) || [];
  if(!aoa.length) return { rows:[], error:null };
  var matchers = isCallOffSheetName(sheetName) ? CALLOFF_FIELD_MATCHERS : IMPORT_FIELD_MATCHERS;
  var headerIdx = importFindHeaderRow(aoa, matchers);
  if(headerIdx === -1) return { rows:[], error:"noHeader" };
  var colMap = importDetectColumnMap(aoa[headerIdx], matchers);
  var rows = isCallOffSheetName(sheetName)
    ? importExtractCallOffRows(aoa.slice(headerIdx+1), colMap, sheetName, aoa[headerIdx])
    : importExtractRows(aoa.slice(headerIdx+1), colMap, sheetName, aoa[headerIdx]);
  return { rows: rows, error:null };
}
/* Core identity of a delivery *slot* — PO + date + time + carrier. Used
   only to decide which rows share a slot for display purposes (the
   "<PO> - Truck N" label below) — no longer the dedupe/merge key on its
   own, see importRowKey(). */
function importCoreKey(poNo, date, eta, carrier){
  return (poNo||"")+"|"+(date||"")+"|"+(eta||"")+"|"+String(carrier||"").trim().toLowerCase();
}
/* Round 30 (reverts Round 28, restores the Round 26 model): Round 28's
   "same PO + same slot = same truck" rule, confirmed on PO 4563895042, does
   NOT generalize — Theo flagged a later PO (4563428496, M C Croker) with two
   source rows that are genuinely separate trucks/containers (the remark
   column even carries distinct container numbers per row, e.g. CSGU2538526
   vs CSGU2235812), and folding them into one truck's `lots` array was
   hiding real, separately-arriving trucks again. Back to one truck per
   source row. Rows that DO share a PO+date+time+carrier slot still get a
   "<PO> - Truck N" label for display (truckLabel), exactly the Round 26
   behavior — but they are separate trucks/separate DB rows, not lots on one
   truck. */
function importRowKey(poNo, date, eta, carrier, skuNo, details, qtt){
  return "row:"+importCoreKey(poNo, date, eta, carrier)+"|"+(skuNo||"")+"|"+(details||"")+"|"+(qtt||"");
}
/* Round 31: identity of a "Call off" TRIP (one physical truck, see
   importGroupCallOffRows below) -- carrier+date+eta+truckLabel rather than
   importRowKey's po/sku/details/qtt, because a trip's product mix (which
   Mat Codes/quantities are on it) can legitimately change between re-imports
   of an updated plan while it's still the same truck run; keying on those
   would dedupe unreliably. truckLabel ("<Route> - Trip N") already encodes
   route+trip uniquely for a given date+eta, so nothing else is needed. A
   distinct "trip:" prefix keeps this key space from ever colliding with
   importRowKey's "row:" one even if the underlying text happened to match. */
function importTripKey(carrier, date, eta, truckLabel){
  return "trip:"+String(carrier||"").trim().toLowerCase()+"|"+(date||"")+"|"+(eta||"")+"|"+(truckLabel||"");
}
/* Round 36: client feedback -- "if the exact same shipment row appears more
   than once in the same uploaded file (a pasted-twice row, a re-saved sheet
   that duplicated a line), it should be deduped within that one upload, not
   turned into two trucks." Only a BYTE-IDENTICAL row (same PO+date+time+
   carrier *and* same sku/details/qty) is collapsed here -- two rows that
   share a slot but differ on any of those (Round 30's confirmed case: two
   genuinely separate containers under one PO) still produce two trucks,
   unchanged. Runs before importAssignLabels() below, on the flat row list,
   so its "Truck N" labeling never even sees the removed duplicate. */
function dedupeExactRows(rows){
  var seen = {}, out = [];
  rows.forEach(function(r){
    var k = importRowKey(r.po_no, r.order_date, r.eta, r.carrier, r.sku_no, r.details, r.qtt);
    if(seen[k]) return;
    seen[k] = true;
    out.push(r);
  });
  return out;
}
function importAssignLabels(rows){
  var order = [], groups = {};
  rows.forEach(function(r){
    var ck = importCoreKey(r.po_no, r.order_date, r.eta, r.carrier);
    if(!groups[ck]){ groups[ck] = []; order.push(ck); }
    groups[ck].push(r);
  });
  var out = [];
  order.forEach(function(ck){
    var list = groups[ck];
    list.forEach(function(r, idx){
      out.push({
        key: importRowKey(r.po_no, r.order_date, r.eta, r.carrier, r.sku_no, r.details, r.qtt),
        carrier: r.carrier, carrierTh: r.carrierTh, matType: r.matType,
        po_no: r.po_no, order_date: r.order_date, eta: r.eta,
        details: r.details, qtt: r.qtt, sku_no: r.sku_no, remark: r.remark, raw: r.raw,
        truckLabel: list.length > 1 ? ((r.po_no||"")+" - Truck "+(idx+1)) : null,
        _kind: "generic"
      });
    });
  });
  return out;
}
/* Round 31: one "Call off" TRUCK per Route+Trip+Delivery date+Time-arrive
   (a trip), folding every batch row that shares it into the truck's `lots`
   array -- the merge behavior Round 30 removed for RM/PM, reinstated here
   because the underlying data genuinely supports it (see
   importExtractCallOffRows' comment above: several batches, sometimes
   several different products, is the normal shape of ONE trip, not a sign
   of several trucks). carrier is always "MON" (an internal shuttle, no
   external transporter named in the file) and truckLabel ("<Route> - Trip
   N") stands in for the missing PO as this truck's own identity, always
   set (not only when it collides with another truck, unlike importAssignLabels
   above) since there's nothing else to label it with. */
function importGroupCallOffRows(rows){
  var order = [], groups = {};
  rows.forEach(function(r){
    var gk = r.route+"|"+r.trip+"|"+r.order_date+"|"+r.eta;
    if(!groups[gk]){ groups[gk] = []; order.push(gk); }
    groups[gk].push(r);
  });
  return order.map(function(gk){
    var list = groups[gk];
    var first = list[0];
    var truckLabel = first.route+" - Trip "+first.trip;
    var lots = list.length > 1 ? list.map(function(r){
      return { details:r.details, qtt:r.qtt, sku_no:r.sku_no, remark:r.remark, raw:r.raw };
    }) : null;
    return {
      key: importTripKey("MON", first.order_date, first.eta, truckLabel),
      carrier: "MON", carrierTh: null, matType: "FZ",
      po_no: null, order_date: first.order_date, eta: first.eta,
      details: first.details, qtt: first.qtt, sku_no: first.sku_no, remark: first.remark, raw: first.raw,
      truckLabel: truckLabel, lots: lots,
      // Round 36: tagged (unlike importAssignLabels' "generic") so the
      // update-instead-of-duplicate matching in runImportPreview only
      // applies to the PO-based RM/PM/Indirect importer below, which is
      // what the client's feedback actually described -- a "Call off" trip
      // still only skips an exact re-import, same as before this round.
      _kind: "calloff"
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
        // Round 31: "Call off" (frozen goods) pre-checked the same way as
        // any "incoming" sheet -- see isCallOffSheetName().
        ui.importSelected[n] = (/incoming/i.test(n) && !/รปภ/.test(n)) || isCallOffSheetName(n);
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
    // Round 36: existing generic (RM/PM/Indirect) trucks also indexed by
    // their PO-based *core* identity (po+date+time+carrier, no sku/qtt/
    // details) -- client feedback: "detect an already-uploaded shipment by
    // its PO/Shipment/Delivery No and update it with the latest data
    // instead of creating a duplicate." Only collected when exactly one
    // existing truck occupies that slot -- two DO legitimately share a slot
    // (Round 30's confirmed separate-container case), and guessing which of
    // two which a changed row belongs to would risk overwriting the wrong
    // one, so that case is left exactly as before (skip only, no update).
    var existingCoreMap = {};
    existingTrucks.forEach(function(t){
      // Both key shapes computed for every existing truck, regardless of
      // which importer originally created it — cheap, and each shape only
      // ever matches a freshly-parsed group built the same way (Round 31:
      // importTripKey needs t.truckLabel, so sbFetchTrucksInRange now
      // selects truck_label too — see api.js).
      existingKeys[importRowKey(t.poNo, t.date, t.eta, t.carrier, t.skuNo, t.details, t.qtt)] = true;
      existingKeys[importTripKey(t.carrier, t.date, t.eta, t.truckLabel)] = true;
      if(t.poNo){
        var coreKey = importCoreKey(t.poNo, t.date, t.eta, t.carrier);
        (existingCoreMap[coreKey] = existingCoreMap[coreKey] || []).push(t);
      }
    });
    // Round 30 (reverts Round 28, restores Round 26): one skip decision per
    // source ROW again for the generic RM/PM importer (see
    // importRowKey/importAssignLabels above) — a lot added to the source
    // file after its slot was first imported is picked up as its own new
    // truck, rather than being silently missed the way a whole-slot dedupe
    // key would miss it. Round 31: "Call off" rows are grouped by TRIP
    // instead (importGroupCallOffRows) — see importTripKey's own comment for
    // why that one still dedupes per-trip rather than per-row.
    // Round 36: genericRows also passed through dedupeExactRows() first —
    // client feedback: two byte-identical rows pasted twice in the same
    // uploaded file must collapse into one truck, not two (see its comment).
    var genericRows = dedupeExactRows(kept.filter(function(r){ return r._kind !== "calloff"; }));
    var calloffRows = kept.filter(function(r){ return r._kind === "calloff"; });
    var groups = importAssignLabels(genericRows).concat(importGroupCallOffRows(calloffRows));
    var dupeCount = 0, updateCount = 0, toImport = [], toUpdate = [];
    groups.forEach(function(g){
      if(existingKeys[g.key]){ dupeCount++; return; } // byte-identical to what's already there -- nothing to do
      if(g._kind === "generic" && g.po_no){
        var coreKey = importCoreKey(g.po_no, g.order_date, g.eta, g.carrier);
        var candidates = existingCoreMap[coreKey];
        if(candidates && candidates.length === 1){
          if(candidates[0].truckState === "pending"){
            // Same shipment (PO+date+time+carrier), something about it
            // changed (qty/remark/sku/etc) -- update that truck in place
            // instead of importing a second one for it.
            toUpdate.push({ id: candidates[0].id, g: g });
            updateCount++;
          } else {
            // Already started or completed elsewhere -- the shipment has
            // clearly already arrived and is/was being handled; don't
            // silently rewrite its real (in-progress/finished) record with
            // stale plan data, and don't duplicate it either.
            dupeCount++;
          }
          return;
        }
      }
      toImport.push(g);
    });
    toImport.sort(function(a,b){
      if(a.order_date !== b.order_date) return a.order_date < b.order_date ? -1 : 1;
      var ae = a.eta || "99:99", be = b.eta || "99:99";
      return ae < be ? -1 : (ae > be ? 1 : 0);
    });
    ui.importResult = { toImport: toImport, toUpdate: toUpdate, dupeCount: dupeCount, updateCount: updateCount, pastCount: pastCount };
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
  var updates = (r && r.toUpdate) || [];
  if(!r || (!r.toImport.length && !updates.length)) return;
  ui.importBusy = true; ui.syncStatus = "saving"; render();
  // Round 30 (reverts Round 28, restores Round 26): one entry in r.toImport
  // is one truck again for the generic RM/PM importer, no `lots` merging —
  // truck_label carries the "<PO> - Truck N" display suffix for rows that
  // share a slot. Round 31: a "Call off" entry DOES carry `lots` again
  // (importGroupCallOffRows) -- g.lots is simply undefined/null for every
  // other importer, so this stays a no-op for them.
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
      truck_label: g.truckLabel || null,
      lots: g.lots || null
    };
  });
  var CHUNK = 40, i = 0;
  var rawColumnMissing = false, truckLabelColumnMissing = false, lotsColumnMissing = false;
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
      if(!lotsColumnMissing && isMissingColumnError(err, "lots")){
        lotsColumnMissing = true;
        return attemptInsert(stripKeys(chunk, ["lots"]));
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
  // Round 36: PATCH for a shipment already imported once, whose details
  // changed on re-upload (runImportPreview's existingCoreMap match) --
  // reuses the exact same missing-column flags/fallback as attemptInsert
  // above, since it's the same schema either way. One request per truck
  // (each has its own `id` and its own changed fields -- there's no bulk
  // "update N different rows with N different bodies" in PostgREST), which
  // is fine at the scale a single re-imported plan realistically updates.
  function updateFields(g){
    return {
      carrier_th: g.carrierTh || null, mat_type: g.matType || null,
      sku_no: g.sku_no, qtt: g.qtt, remark: g.remark, details: g.details,
      truck_label: g.truckLabel || null
    };
  }
  function attemptUpdate(u){
    var already = [];
    if(truckLabelColumnMissing) already.push("truck_label");
    if(carrierThColumnMissing) already.push("carrier_th");
    if(matTypeColumnMissing) already.push("mat_type");
    var body = stripKeys([updateFields(u.g)], already)[0];
    return sbRest("trucks?id=eq."+encodeURIComponent(u.id), { method:"PATCH", headers:{ "Prefer":"return=minimal" }, body: body }).catch(function(err){
      if(!truckLabelColumnMissing && isMissingColumnError(err, "truck_label")){
        truckLabelColumnMissing = true;
        return attemptUpdate(u);
      }
      if(!carrierThColumnMissing && isMissingColumnError(err, "carrier_th")){
        carrierThColumnMissing = true;
        return attemptUpdate(u);
      }
      if(!matTypeColumnMissing && isMissingColumnError(err, "mat_type")){
        matTypeColumnMissing = true;
        return attemptUpdate(u);
      }
      throw err;
    });
  }
  function runUpdates(){
    var j = 0;
    function nextUpdate(){
      if(j >= updates.length) return Promise.resolve();
      var u = updates[j]; j += 1;
      return attemptUpdate(u).then(nextUpdate);
    }
    return nextUpdate();
  }
  function finish(){
    return loadFromSupabase().then(function(){
      ui.importBusy = false;
      ui.importOpen = false;
      importCtx = null;
      var msg = rows.length ? tr("importDoneToast").replace("{n}", rows.length) : "";
      if(updates.length){
        var updMsg = tr("importUpdatedToast").replace("{n}", updates.length);
        msg = msg ? (msg + " " + updMsg) : updMsg;
      }
      if(rawColumnMissing) msg += " " + tr("importRawColumnMissing");
      if(truckLabelColumnMissing) msg += " " + tr("importTruckLabelColumnMissing");
      if(lotsColumnMissing) msg += " " + tr("importLotsColumnMissing");
      // Round 28: cosmetic-only columns (Thai carrier name, RM/PM type) --
      // never worth their own toast on top of the two above; a silent
      // fallback (raw still captures them under their original Thai
      // header text either way) is enough until ISD migrates the schema.
      showToast(msg);
    });
  }
  function next(){
    if(i >= rows.length) return runUpdates().then(finish);
    var already = [];
    if(rawColumnMissing) already.push("raw");
    if(truckLabelColumnMissing) already.push("truck_label");
    if(lotsColumnMissing) already.push("lots");
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
