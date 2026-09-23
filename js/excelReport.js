/* ---------- Excel report export (Round 40) ----------
   Theo, after seeing an existing MON report (an internal "OPL Skill
   Matrix" workbook someone else built): "je voulais un vrai fichier excel
   du type [attached]... je veux le meme type" (he wants a real, styled
   multi-sheet Excel workbook in that same corporate style — logo, colour,
   several sheets — not just the flat "Export CSV" already on this screen).

   Kept entirely separate from exportReportCsv() in reporting.js: CSV stays
   for "I just want the raw rows in a spreadsheet tool of my choice", this
   is the polished, presentation-ready version reusing the exact numbers
   ui.reportData/ui.reportRows/ui.reportTrend already hold from the last
   "Generate" click (no second Supabase round trip, same reasoning as the
   CSV export next to it) — a KPI summary sheet (MON logo + the same
   good/bad/warn colour semantics used everywhere else in this app), a
   carrier breakdown and a day/week trend sheet, both using Excel's own
   conditional formatting (data bars / threshold fills) for an at-a-glance
   visual read. Deliberately no native Excel chart object: no free
   browser-side library actually writes those, and a coloured data bar is a
   completely standard, fully "real Excel" way to show the same thing —
   arguably more useful than a static chart picture, since the numbers
   behind it stay sortable/filterable.

   ExcelJS (https://github.com/exceljs/exceljs, MIT) is loaded lazily on
   first click — same reasoning and the same lazy-<script>-tag pattern as
   loadJSZip() in js/photoDownload.js: most sessions never click this
   button, so there's no reason to make every page load fetch a second
   large library alongside SheetJS (which only the inbound-plan import
   needs). Any single cosmetic step (the logo image, a sheet's conditional
   formatting) is wrapped so it can fail on its own without losing the
   whole export — a manager still gets a correct workbook with the real
   numbers even if, say, the logo image couldn't be fetched. */
import { ui } from "./state.js";
import { tr } from "./i18n.js";
import { showToast } from "./actions.js";
import { computeCarrierStats } from "./reporting.js";
import { GRACE_MIN } from "./config.js";

var excelJsLoadPromise = null;
function loadExcelJS(){
  if(window.ExcelJS) return Promise.resolve();
  if(excelJsLoadPromise) return excelJsLoadPromise;
  excelJsLoadPromise = new Promise(function(resolve, reject){
    var s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js";
    s.onload = function(){ resolve(); };
    // Same "reset the cached promise on failure" reasoning as
    // loadJSZip() -- a transient network hiccup doesn't permanently
    // disable this button for the rest of the session.
    s.onerror = function(){ excelJsLoadPromise = null; reject(new Error("exceljs")); };
    document.head.appendChild(s);
  });
  return excelJsLoadPromise;
}

// The exact same MON corporate palette already used on screen (css/app.css
// --brand/--good/--bad/--warn and their *-soft tints), just in Excel's own
// ARGB format ("FF" + the site's hex) -- so a truck's late/damage/no-
// arrival flag reads as the same colour here as it does in the app.
var X_BRAND = "FF006EAF", X_BRAND_SOFT = "FFDDEBF4";
var X_GOOD = "FF008D36", X_GOOD_SOFT = "FFDFF1E6";
var X_BAD = "FFD31A2B", X_BAD_SOFT = "FFFAE4E6";
var X_WARN = "FF9E5F00", X_WARN_SOFT = "FFF4EEE3";
var X_INK = "FF0E1826", X_INK_DIM = "FF54617A";

function fillCell(cell, argb){
  cell.fill = { type:"pattern", pattern:"solid", fgColor:{argb:argb} };
}
function headerRowStyle(row){
  row.font = { bold:true, color:{argb:X_INK_DIM} };
  row.eachCell(function(c){ fillCell(c, X_BRAND_SOFT); });
}

// Small local copy of render.js's fmtHM() -- not exported there (kept
// private to that module), and duplicating four lines here is simpler and
// safer than reaching across module boundaries for one helper.
function fmtHM(mins){
  mins = Math.max(0, Math.round(mins));
  if(mins < 60) return mins + " " + tr("unit_min");
  var h = Math.floor(mins/60), m = mins%60;
  return h + "h" + (m<10?"0":"")+m;
}

/* Same "late" rule statsForRows() (js/reporting.js) already uses (arrival
   later than eta+GRACE_MIN), plus a damage remark and a still-"pending"
   truck with no arrival ever logged -- the same three things
   reportKpiTilesHtml() already flags on screen, just listed truck-by-truck
   here instead of only as a total count. */
function attentionReasons(r){
  var reasons = [];
  if(r.actArrival && r.eta){
    var etaMs = new Date(r.date+"T"+r.eta+":00").getTime();
    var arrMs = new Date(r.actArrival).getTime();
    if(arrMs > etaMs + GRACE_MIN*60000) reasons.push(tr("reportExcelWhyLate"));
  }
  if(r.damageRemark && r.damageRemark.trim()) reasons.push(tr("reportExcelWhyDamage"));
  if(r.truckState === "pending" && !r.actArrival) reasons.push(tr("reportExcelWhyNoArrival"));
  return reasons;
}

// ExcelJS's browser build wants an image as a base64 data URI (its Node-side
// `buffer:` form expects a real Node Buffer, which doesn't exist here) --
// plain browser code to turn the fetched PNG's bytes into one, chunked so
// String.fromCharCode.apply doesn't blow the call stack on a larger image.
function arrayBufferToBase64(buf){
  var bytes = new Uint8Array(buf);
  var binary = "";
  var chunkSize = 0x8000;
  for(var i=0; i<bytes.length; i+=chunkSize){
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i+chunkSize));
  }
  return window.btoa(binary);
}

async function addLogo(workbook, worksheet){
  try {
    var res = await fetch("icons/mark-full.png");
    if(!res.ok) return;
    var buf = await res.arrayBuffer();
    var imageId = workbook.addImage({ base64: "data:image/png;base64,"+arrayBufferToBase64(buf), extension: "png" });
    worksheet.addImage(imageId, { tl:{col:0.15, row:0.3}, ext:{width:130, height:47} });
  } catch(e){
    // Cosmetic only -- never fails the export over a missing/blocked logo.
    console.error("Excel report logo failed to embed:", e);
  }
}

function reportSheet(workbook, d, rows){
  var ws = workbook.addWorksheet(tr("reportExcelTabReport"));
  ws.columns = [{width:3},{width:15},{width:15},{width:15},{width:15},{width:17},{width:17},{width:11}];
  var startCol = 2; // column B -- column A stays empty, a small left gutter
                     // the logo image also sits in, same as the reference
                     // report's own layout.

  ws.mergeCells("C2:H2");
  ws.getCell("C2").value = tr("reportTitle").toUpperCase();
  ws.getCell("C2").font = { bold:true, size:16, color:{argb:X_BRAND} };
  ws.mergeCells("C3:H3");
  ws.getCell("C3").value = ui.reportFrom + "  —  " + ui.reportTo;
  ws.getCell("C3").font = { color:{argb:X_INK_DIM}, size:11 };

  ws.getCell("B5").value = tr("reportExcelKeyFigures");
  ws.getCell("B5").font = { bold:true, size:10, color:{argb:X_INK_DIM} };

  var tiles = [
    { label:tr("reportKpiTotal"), value:d.total },
    { label:tr("reportKpiCompleted"), value:d.completed, argb:X_GOOD_SOFT, font:X_GOOD },
    { label:tr("reportKpiOnTime"), value:d.onTimePct==null?"—":(d.onTimePct+"%"),
      argb:(d.onTimePct!=null && d.onTimePct<80)?X_BAD_SOFT:X_GOOD_SOFT,
      font:(d.onTimePct!=null && d.onTimePct<80)?X_BAD:X_GOOD },
    { label:tr("reportKpiAvgTime"), value:d.avgMin==null?"—":fmtHM(d.avgMin) },
    { label:tr("reportKpiDamage"), value:d.damageCount, argb:d.damageCount?X_BAD_SOFT:null, font:d.damageCount?X_BAD:null },
    { label:tr("reportKpiNoLog"), value:d.noArrivalLogged, argb:d.noArrivalLogged?X_WARN_SOFT:null, font:d.noArrivalLogged?X_WARN:null },
    { label:tr("reportKpiCorrected"), value:d.correctedCount, argb:d.correctedCount?X_WARN_SOFT:null, font:d.correctedCount?X_WARN:null }
  ];
  tiles.forEach(function(t, i){
    var col = startCol + i;
    var labelCell = ws.getRow(6).getCell(col);
    labelCell.value = t.label;
    labelCell.font = { size:9, color:{argb:X_INK_DIM} };
    labelCell.alignment = { wrapText:true };
    var valueCell = ws.getRow(7).getCell(col);
    valueCell.value = t.value;
    valueCell.font = { bold:true, size:14, color:{argb: t.font || X_INK} };
    if(t.argb){ fillCell(labelCell, t.argb); fillCell(valueCell, t.argb); }
  });
  ws.getRow(6).height = 26;
  ws.getRow(7).height = 22;

  ws.getCell("B9").value = tr("reportExcelAttentionTitle");
  ws.getCell("B9").font = { bold:true, size:10, color:{argb:X_INK_DIM} };
  var headerRowNum = 10;
  ["reportExcelColPo","reportExcelColCarrier","reportExcelColDate","reportExcelColEta","reportExcelColWhy"].forEach(function(k, i){
    var c = ws.getRow(headerRowNum).getCell(startCol + i);
    c.value = tr(k);
    c.font = { bold:true, size:9, color:{argb:X_INK_DIM} };
  });
  var flagged = rows.map(function(r){ return { r:r, reasons:attentionReasons(r) }; })
    .filter(function(x){ return x.reasons.length; });
  // Capped the same way the KPI/carrier sections above are already a
  // summary, not the full detail -- every flagged truck is still in the
  // Trucks sheet regardless of this cap.
  var CAP = 25;
  flagged.slice(0, CAP).forEach(function(x, i){
    var rn = headerRowNum + 1 + i;
    var late = x.reasons.indexOf(tr("reportExcelWhyLate")) >= 0;
    var damage = x.reasons.indexOf(tr("reportExcelWhyDamage")) >= 0;
    var argb = (late || damage) ? X_BAD : X_WARN;
    ws.getRow(rn).getCell(startCol+0).value = x.r.poNo || "—";
    ws.getRow(rn).getCell(startCol+1).value = x.r.carrier || "—";
    ws.getRow(rn).getCell(startCol+2).value = x.r.date || "—";
    ws.getRow(rn).getCell(startCol+3).value = x.r.eta || "—";
    var whyCell = ws.getRow(rn).getCell(startCol+4);
    whyCell.value = x.reasons.join(", ");
    whyCell.font = { color:{argb:argb} };
  });
  if(!flagged.length){
    ws.getRow(headerRowNum+1).getCell(startCol).value = tr("reportExcelAttentionNone");
  } else if(flagged.length > CAP){
    ws.getRow(headerRowNum+1+CAP).getCell(startCol).value = tr("reportExcelAttentionMore").replace("{n}", flagged.length-CAP);
  }
  return ws;
}

function trucksSheet(workbook, rows){
  var ws = workbook.addWorksheet(tr("reportExcelTabTrucks"));
  // Same column set/order as exportReportCsv() (js/reporting.js) -- a
  // manager who uses both exports sees matching column names.
  var headers = ["date","eta","po_no","carrier","truck_state","act_arrival","act_dept","damage_remark","truck_label","started_by","finished_by","arrival_corrected","departure_corrected"];
  ws.addRow(headers);
  headerRowStyle(ws.getRow(1));
  rows.forEach(function(r){
    ws.addRow([r.date, r.eta, r.poNo, r.carrier, r.truckState, r.actArrival, r.actDept, r.damageRemark, r.truckLabel, r.startedBy, r.finishedBy, r.arrivalCorrected?1:0, r.departureCorrected?1:0]);
  });
  ws.columns.forEach(function(c){ c.width = 15; });
  ws.views = [{ state:"frozen", ySplit:1 }];
  ws.autoFilter = "A1:M1";
  return ws;
}

function carriersSheet(workbook, rows){
  var ws = workbook.addWorksheet(tr("reportExcelTabCarriers"));
  var stats = computeCarrierStats(rows);
  ws.addRow([tr("reportExcelColCarrier"), tr("reportExcelColTotal"), tr("reportTrendColOnTime"), tr("reportExcelColLate"), tr("reportExcelColRated"), tr("reportTrendColDamage")]);
  headerRowStyle(ws.getRow(1));
  stats.forEach(function(s){
    ws.addRow([s.carrier, s.total, s.onTimePct==null?null:s.onTimePct/100, s.late, s.onTimeRated, s.damageCount]);
  });
  [22,10,12,10,10,10].forEach(function(w, i){ ws.getColumn(i+1).width = w; });
  ws.getColumn(3).numFmt = "0%";
  ws.views = [{ state:"frozen", ySplit:1 }];
  ws.autoFilter = "A1:F1";
  var lastRow = stats.length + 1;
  if(lastRow > 1){
    // Same >=80% good/bad threshold reportKpiTilesHtml()/carrierRankingHtml()
    // (render.js) already use on screen, plus a data bar for magnitude --
    // Excel's own standard way to make a column visually scannable while
    // keeping the numbers themselves sortable/filterable.
    ws.addConditionalFormatting({ ref:"C2:C"+lastRow, rules:[
      { type:"cellIs", operator:"lessThan", formulae:["0.8"], style:{ fill:{type:"pattern",pattern:"solid",bgColor:{argb:X_BAD_SOFT}}, font:{color:{argb:X_BAD}} } },
      { type:"cellIs", operator:"greaterThanOrEqual", formulae:["0.8"], style:{ fill:{type:"pattern",pattern:"solid",bgColor:{argb:X_GOOD_SOFT}}, font:{color:{argb:X_GOOD}} } },
      { type:"dataBar", cfvo:[{type:"min"},{type:"max"}], color:{argb:X_BRAND} }
    ]});
    ws.addConditionalFormatting({ ref:"F2:F"+lastRow, rules:[
      { type:"cellIs", operator:"greaterThan", formulae:["0"], style:{ fill:{type:"pattern",pattern:"solid",bgColor:{argb:X_BAD_SOFT}}, font:{color:{argb:X_BAD}} } }
    ]});
  }
  return ws;
}

function trendSheet(workbook, trend){
  var ws = workbook.addWorksheet(tr("reportExcelTabTrend"));
  ws.addRow([tr("reportTrendColPeriod"), tr("reportTrendColVolume"), tr("reportTrendColOnTime"), tr("reportTrendColAvgDuration"), tr("reportTrendColDamage")]);
  headerRowStyle(ws.getRow(1));
  var buckets = (trend && trend.buckets) || [];
  buckets.forEach(function(b){
    var s = b.stats;
    ws.addRow([b.label, s.total, s.onTimePct==null?null:s.onTimePct/100, s.avgMin==null?null:Math.round(s.avgMin), s.damageCount]);
  });
  [16,10,12,14,10].forEach(function(w, i){ ws.getColumn(i+1).width = w; });
  ws.getColumn(3).numFmt = "0%";
  ws.views = [{ state:"frozen", ySplit:1 }];
  var lastRow = buckets.length + 1;
  if(lastRow > 1){
    ws.addConditionalFormatting({ ref:"B2:B"+lastRow, rules:[{ type:"dataBar", cfvo:[{type:"min"},{type:"max"}], color:{argb:X_BRAND} }] });
    ws.addConditionalFormatting({ ref:"C2:C"+lastRow, rules:[
      { type:"cellIs", operator:"lessThan", formulae:["0.8"], style:{ fill:{type:"pattern",pattern:"solid",bgColor:{argb:X_BAD_SOFT}}, font:{color:{argb:X_BAD}} } },
      { type:"cellIs", operator:"greaterThanOrEqual", formulae:["0.8"], style:{ fill:{type:"pattern",pattern:"solid",bgColor:{argb:X_GOOD_SOFT}}, font:{color:{argb:X_GOOD}} } }
    ]});
    ws.addConditionalFormatting({ ref:"D2:D"+lastRow, rules:[{ type:"dataBar", cfvo:[{type:"min"},{type:"max"}], color:{argb:X_BRAND} }] });
    ws.addConditionalFormatting({ ref:"E2:E"+lastRow, rules:[
      { type:"cellIs", operator:"greaterThan", formulae:["0"], style:{ fill:{type:"pattern",pattern:"solid",bgColor:{argb:X_BAD_SOFT}}, font:{color:{argb:X_BAD}} } }
    ]});
  }
  return ws;
}

export function exportReportExcel(){
  var rows = ui.reportRows;
  var d = ui.reportData;
  var trend = ui.reportTrend;
  if(!rows || !d){
    showToast(tr("reportExcelFailed"), true);
    return;
  }
  showToast(tr("reportExcelPreparing"), true);
  loadExcelJS().then(function(){
    var workbook = new window.ExcelJS.Workbook();
    workbook.creator = "MON Logistics";
    workbook.created = new Date();
    var ws1 = reportSheet(workbook, d, rows);
    return addLogo(workbook, ws1).then(function(){
      trucksSheet(workbook, rows);
      try { carriersSheet(workbook, rows); } catch(e){ console.error("Excel report: carriers sheet styling failed:", e); }
      try { if(trend) trendSheet(workbook, trend); } catch(e){ console.error("Excel report: trend sheet styling failed:", e); }
      return workbook.xlsx.writeBuffer();
    });
  }).then(function(buffer){
    var blob = new Blob([buffer], { type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "mon-inbound-report_" + ui.reportFrom + "_" + ui.reportTo + ".xlsx";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
    showToast(tr("reportExcelReady"));
  }).catch(function(err){
    console.error("Excel report export failed:", err);
    showToast(tr("reportExcelFailed"), true);
  });
}
