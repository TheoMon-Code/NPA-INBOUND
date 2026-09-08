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
        var wb = XLSX.read(data, { type:"array", cellDates:true });
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
  { field:"carrier", any:["supplier name","บริษัทขนส่ง","ชื่อภาษาไทย"] },
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
/* SheetJS (with cellDates:true at read time) hands back real JS Date objects
   for anything Excel formatted as a date or time — in UTC, regardless of
   this browser's own timezone, so UTC getters are what recover the intended
   wall-clock value. Older/plainer cells sometimes stay numeric (Excel's
   serial date/time encoding) or come through as a formatted string (e.g. an
   "08:00 - 17:00" window typed as text) — both are handled as a fallback. */
function importDateFromCell(v){
  if(v instanceof Date) return v.getUTCFullYear()+"-"+pad2(v.getUTCMonth()+1)+"-"+pad2(v.getUTCDate());
  if(typeof v === "number"){
    var d = XLSX.SSF.parse_date_code(v);
    if(d) return d.y+"-"+pad2(d.m)+"-"+pad2(d.d);
  }
  if(typeof v === "string"){
    var m = v.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if(m) return m[1]+"-"+pad2(+m[2])+"-"+pad2(+m[3]);
  }
  return null;
}
function importTimeFromCell(v){
  if(v instanceof Date) return pad2(v.getUTCHours())+":"+pad2(v.getUTCMinutes());
  if(typeof v === "number"){
    var d = XLSX.SSF.parse_date_code(v);
    if(d) return pad2(d.H)+":"+pad2(d.M);
  }
  if(typeof v === "string"){
    var m = v.match(/(\d{1,2}):(\d{2})/);
    if(m) return pad2(+m[1])+":"+pad2(+m[2]);
  }
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
   object that would serialize unpredictably. */
function importJsonSafeCell(v){
  if(v instanceof Date){
    var isDateOnly = v.getUTCHours()===0 && v.getUTCMinutes()===0 && v.getUTCSeconds()===0 && v.getUTCFullYear() > 1980;
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
    var matType = String(row[0]==null?"":row[0]).trim().toUpperCase();
    out.push({
      carrier: carrier || null,
      details: (/^(RM|PM)$/.test(matType) ? "["+matType+"] " : "") + desc,
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
function importDedupeKey(poNo, date, eta, carrier){
  return (poNo||"")+"|"+(date||"")+"|"+(eta||"")+"|"+String(carrier||"").trim().toLowerCase();
}
/* One physical truck can show up as several rows in the source file — same
   PO + date + time + carrier, but a different line item ("รายการ") for each
   product/lot it's carrying. Confirmed against a real "Incoming plan" file:
   e.g. one PO with two rows, "รายการ" 10 and 20, same delivery slot. Grouping
   by the same key already used for dedupe (rather than deduping row-by-row,
   which used to keep only the first row of a group and silently drop the
   rest as if they were duplicates) turns each such group into ONE truck
   carrying a `lots` array, so nothing from those extra rows is lost. A
   single-row group still produces a truck with a one-item `lots` array —
   same shape either way, so the rest of the app only has to special-case
   the "more than one lot" *display*, not the data model. */
function importGroupRows(rows){
  var order = [], byKey = {};
  rows.forEach(function(r){
    var key = importDedupeKey(r.po_no, r.order_date, r.eta, r.carrier);
    if(!byKey[key]){
      byKey[key] = {
        key: key,
        carrier: r.carrier, po_no: r.po_no, order_date: r.order_date, eta: r.eta,
        lots: []
      };
      order.push(byKey[key]);
    }
    byKey[key].lots.push({ details:r.details, qtt:r.qtt, sku_no:r.sku_no, remark:r.remark, raw:r.raw });
  });
  return order;
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
      existingKeys[importDedupeKey(t.poNo, t.date, t.eta, t.carrier)] = true;
    });
    // Group first (see importGroupRows), so several source rows for the same
    // physical truck become one entry with multiple lots, THEN dedupe against
    // already-imported trucks — one skip decision per truck, not per row. A
    // truck already imported has all of its rows (lots included) counted into
    // dupeCount, same total-rows meaning the count had before grouping existed.
    var groups = importGroupRows(kept);
    var dupeCount = 0, toImport = [];
    groups.forEach(function(g){
      if(existingKeys[g.key]){ dupeCount += g.lots.length; return; }
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
  // Each entry in r.toImport is now a *group* (one physical truck, possibly
  // several lots — see importGroupRows). The top-level details/qtt/sku_no/
  // remark/raw always mirror lots[0], so a single-lot truck (still the
  // common case) is stored exactly as before; `lots` carries the full list
  // and is what a multi-lot truck's detail sheet reads to show every lot,
  // not just the first.
  var rows = r.toImport.map(function(g, idx){
    var primary = g.lots[0] || {};
    return {
      reference_id: "T-"+Date.now().toString(36).toUpperCase()+idx.toString(36).toUpperCase(),
      carrier: g.carrier, plant: (ui.importPlant || DEFAULT_PLANT), im_ex_tr: "IM",
      po_no: g.po_no, sku_no: primary.sku_no, qtt: primary.qtt,
      remark: primary.remark, details: primary.details,
      order_date: g.order_date,
      eta: g.eta ? (g.order_date+"T"+g.eta+":00") : null,
      truck_state: "pending",
      raw: primary.raw || null, /* every source column, verbatim — see supabase-schema.sql */
      lots: g.lots.length > 1 ? g.lots : null
    };
  });
  var totalLots = r.toImport.reduce(function(sum,g){ return sum + g.lots.length; }, 0);
  var CHUNK = 40, i = 0;
  var rawColumnMissing = false, lotsColumnMissing = false;
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
      if(!lotsColumnMissing && isMissingColumnError(err, "lots")){
        lotsColumnMissing = true;
        return attemptInsert(stripKeys(chunk, ["lots"]));
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
        if(lotsColumnMissing && totalLots > rows.length) msg += " " + tr("importLotsColumnMissing");
        showToast(msg);
      });
    }
    var already = [];
    if(rawColumnMissing) already.push("raw");
    if(lotsColumnMissing) already.push("lots");
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
