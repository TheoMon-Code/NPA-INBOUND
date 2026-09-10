/* ---------- bulk "download all photos" (zip) ----------
   A manager on site asked for a button to grab every photo on a truck at
   once, comparing it to an existing "FG export" download she already uses
   elsewhere in MON's tools -- rather than opening/saving each photo one at
   a time from the grid in the truck sheet. Bundles them into a single .zip
   client-side via JSZip (https://stuk.github.io/jszip/), the same idea as
   SheetJS for Excel import (js/importPlan.js) but loaded lazily on first
   use rather than eagerly in index.html: unlike SheetJS, which every import
   needs, most sessions never click this button at all, so there's no
   reason to make everyone pay for it on every page load. */
import { tr } from "./i18n.js";
import { showToast } from "./actions.js";

var jszipLoadPromise = null;
function loadJSZip(){
  if(window.JSZip) return Promise.resolve();
  if(jszipLoadPromise) return jszipLoadPromise;
  jszipLoadPromise = new Promise(function(resolve, reject){
    var s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = function(){ resolve(); };
    // Reset the cached promise on failure (unlike a successful load, which
    // stays cached forever via window.JSZip itself) so a transient network
    // hiccup doesn't permanently disable the feature for the rest of the
    // session -- the next click gets a fresh attempt.
    s.onerror = function(){ jszipLoadPromise = null; reject(new Error("jszip")); };
    document.head.appendChild(s);
  });
  return jszipLoadPromise;
}

// Round 24: Theo asked that a downloaded photo's filename lead with the
// truck's date, then its scheduled time, then the PO -- easier to sort/scan
// once photos from several trucks end up side by side outside the app (a
// downloads folder, an email attachment) than the previous "PO first" naming
// (still used, unchanged, for the file's actual name in Supabase Storage --
// this only renames the copy that lands in the zip). Falls back to
// placeholders when a truck has no ETA yet (still possible right up until a
// truck is marked "Done") rather than producing a name with a bare colon or
// trailing underscore.
function extOf(storagePath){
  var m = /\.([A-Za-z0-9]+)$/.exec(storagePath || "");
  return m ? m[1] : "jpg";
}
function zipEntryName(truckDate, truckEta, truckLabel, index, storagePath){
  var datePart = truckDate || "no-date";
  var timePart = truckEta ? truckEta.replace(":", "h") : "no-time";
  var safeLabel = String(truckLabel || "truck").replace(/[^A-Za-z0-9_-]+/g, "-");
  return datePart + "_" + timePart + "_" + safeLabel + "-" + (index + 1) + "." + extOf(storagePath);
}

/* truckLabel is used for both the outer zip's filename and (now, Round 24)
   as one part of each photo's name inside it -- sanitized since it ends up
   in a filesystem path on whatever device downloads it. truckDate/truckEta
   are the truck's own order_date/eta (js/state.js shape), used as-is. */
export function downloadTruckPhotos(truckId, photos, truckLabel, truckDate, truckEta){
  var list = photos || [];
  if(!list.length) return;
  showToast(tr("preparingPhotosZip"), true);
  loadJSZip().then(function(){
    var zip = new window.JSZip();
    var failedCount = 0;
    var fetches = list.map(function(p, i){
      return fetch(p.url).then(function(res){
        if(!res.ok) throw new Error("http " + res.status);
        return res.blob();
      }).then(function(blob){
        var name = zipEntryName(truckDate, truckEta, truckLabel, i, p.storagePath);
        zip.file(name, blob);
      }).catch(function(){ failedCount++; });
    });
    return Promise.all(fetches).then(function(){
      var fileCount = list.length - failedCount;
      if(!fileCount) throw new Error("all photos failed to download");
      return zip.generateAsync({ type: "blob" }).then(function(blob){
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        var safeLabel = String(truckLabel || "truck").replace(/[^A-Za-z0-9_-]+/g, "-");
        a.download = safeLabel + "-photos.zip";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
        if(failedCount > 0){
          showToast(tr("photosZipPartial").replace("{n}", failedCount));
        } else {
          showToast(tr("photosZipReady"));
        }
      });
    });
  }).catch(function(err){
    console.error("Photo zip download failed:", err);
    showToast(tr("photosDownloadFailed"), true);
  });
}
