/* ---------- inbound-plan import — background parsing worker ----------
   The manager's real "Incoming plan" files run well past 100MB (see
   importPlan.js's header comment and README — a stray #REF! column
   recopied across a million-plus blank rows in one Excel version). Reading
   and parsing that synchronously on the main thread (XLSX.read(), then
   sheet_to_json() per sheet) is exactly what was freezing the page for
   ~30s on import: JavaScript on the main thread blocks all rendering, so
   nothing — not even the "Reading…" spinner — can update while it runs.

   Moving that same work into this dedicated Worker doesn't make the parse
   itself faster, but it takes it off the thread that draws the page: the
   spinner keeps animating, the clock keeps ticking, and the tab doesn't
   look hung. importPlan.js falls back to doing this same work on the main
   thread (same functions, same result shape) if Workers aren't available
   at all — so this file is a pure performance/UX improvement, never a hard
   dependency.

   Not an ES module on purpose: classic (non-module) workers have far
   broader mobile browser support for importScripts(), and this worker's
   job is narrow enough (parse bytes in, plain arrays out) that it doesn't
   need import/export or anything else from the rest of the app. */
importScripts("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js");
// Reaching this line means importScripts() above actually succeeded (a
// failed fetch throws synchronously, before any of this runs) — the "ready"
// ping is what lets the main thread apply a short, safe timeout to just the
// "did the worker's environment even come up" question (see importPlan.js's
// parseWorkbook), without that timeout ever applying to the parse itself,
// which is legitimately slow for a large file and must be allowed to run as
// long as it needs to once we know the worker is actually alive.
self.postMessage({ type: "ready" });

self.onmessage = function(e){
  if(!e.data || e.data.type !== "parse") return;
  try{
    var wb = XLSX.read(e.data.buffer, { type: "array", cellDates: true });
    var sheetNames = wb.SheetNames || [];
    var sheets = {};
    sheetNames.forEach(function(name){
      var ws = wb.Sheets[name];
      sheets[name] = ws
        ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false, defval: null })
        : [];
    });
    self.postMessage({ type: "result", ok: true, sheetNames: sheetNames, sheets: sheets });
  }catch(err){
    self.postMessage({ type: "result", ok: false, error: String((err && err.message) || err) });
  }
};
