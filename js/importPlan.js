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
   without it leaking into `ui` (view state) or `state` (persisted data). */
import { pad2, todayKey } from "./dateUtils.js";
import { tr } from "./i18n.js";
import { ui, state } from "./state.js";
import { sbRest, loadFromSupabase } from "./api.js";
import { render } from "./render.js";
import { showToast } from "./actions.js";

var importCtx = null; /* { workbook, sheetNames, fileName } — set once a file is parsed */

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
function importParseSheet(workbook, sheetName){
  var ws = workbook.Sheets[sheetName];
  if(!ws) return { rows:[], error:null };
  var aoa = XLSX.utils.sheet_to_json(ws, { header:1, raw:true, blankrows:false, defval:null });
  var headerIdx = importFindHeaderRow(aoa);
  if(headerIdx === -1) return { rows:[], error:"noHeader" };
  var colMap = importDetectColumnMap(aoa[headerIdx]);
  return { rows: importExtractRows(aoa.slice(headerIdx+1), colMap, sheetName, aoa[headerIdx]), error:null };
}
function importDedupeKey(poNo, date, eta, carrier){
  return (poNo||"")+"|"+(date||"")+"|"+(eta||"")+"|"+String(carrier||"").trim().toLowerCase();
}

export function handleImportFile(file){
  ui.importError = null;
  ui.importBusy = true;
  render();
  var reader = new FileReader();
  reader.onload = function(){
    try{
      var data = new Uint8Array(reader.result);
      var wb = XLSX.read(data, { type:"array", cellDates:true });
      var names = wb.SheetNames || [];
      importCtx = { workbook: wb, sheetNames: names, fileName: file.name };
      ui.importSelected = {};
      names.forEach(function(n){
        ui.importSelected[n] = /incoming/i.test(n) && !/รปภ/.test(n);
      });
      ui.importBusy = false;
      ui.importStep = "pick";
      render();
    }catch(err){
      importCtx = null;
      ui.importBusy = false;
      ui.importError = tr("importParseFailed");
      render();
    }
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
  var selectedNames = Object.keys(ui.importSelected).filter(function(n){ return ui.importSelected[n]; });
  if(!selectedNames.length){ ui.importError = tr("importPickAtLeastOne"); render(); return; }
  ui.importBusy = true; ui.importError = null; render();
  var allRows = [], hadHeaderError = false;
  selectedNames.forEach(function(name){
    var res = importParseSheet(importCtx.workbook, name);
    if(res.error) hadHeaderError = true;
    allRows = allRows.concat(res.rows);
  });
  var fromDate = ui.importFromDate;
  var pastCount = 0;
  var kept = allRows.filter(function(r){
    if(r.order_date < fromDate){ pastCount++; return false; }
    return true;
  });
  var existingKeys = {};
  state.trucks.forEach(function(t){
    existingKeys[importDedupeKey(t.poNo, t.date, t.eta, t.carrier)] = true;
  });
  var seen = {}, dupeCount = 0, toImport = [];
  kept.forEach(function(r){
    var key = importDedupeKey(r.po_no, r.order_date, r.eta, r.carrier);
    if(existingKeys[key] || seen[key]){ dupeCount++; return; }
    seen[key] = true;
    toImport.push(r);
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
}

export function runImportConfirm(){
  var r = ui.importResult;
  if(!r || !r.toImport.length) return;
  ui.importBusy = true; ui.syncStatus = "saving"; render();
  var rows = r.toImport.map(function(row, idx){
    return {
      reference_id: "T-"+Date.now().toString(36).toUpperCase()+idx.toString(36).toUpperCase(),
      carrier: row.carrier, plant: "AMATA", im_ex_tr: "IM",
      po_no: row.po_no, sku_no: row.sku_no, qtt: row.qtt,
      remark: row.remark, details: row.details,
      order_date: row.order_date,
      eta: row.eta ? (row.order_date+"T"+row.eta+":00") : null,
      truck_state: "pending",
      raw: row.raw || null /* every source column, verbatim — see supabase-schema.sql */
    };
  });
  var CHUNK = 40, i = 0;
  var rawColumnMissing = false;
  function stripRaw(chunk){ return chunk.map(function(r2){ var c = {}; for(var k in r2) if(k !== "raw") c[k]=r2[k]; return c; }); }
  function isMissingRawColumnError(err){
    var msg = String((err && err.message) || "");
    return /\braw\b/i.test(msg) && /(column|schema cache|does not exist)/i.test(msg);
  }
  function next(){
    if(i >= rows.length){
      return loadFromSupabase().then(function(){
        ui.importBusy = false;
        ui.importOpen = false;
        importCtx = null;
        var msg = tr("importDoneToast").replace("{n}", rows.length);
        if(rawColumnMissing) msg += " " + tr("importRawColumnMissing");
        showToast(msg);
      });
    }
    var chunk = rows.slice(i, i+CHUNK);
    i += CHUNK;
    return sbRest("trucks", { method:"POST", headers:{ "Prefer":"return=minimal" }, body: chunk }).catch(function(err){
      if(!rawColumnMissing && isMissingRawColumnError(err)){
        rawColumnMissing = true;
        return sbRest("trucks", { method:"POST", headers:{ "Prefer":"return=minimal" }, body: stripRaw(chunk) });
      }
      throw err;
    }).then(next);
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
