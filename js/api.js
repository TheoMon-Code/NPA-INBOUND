/* ---------- Supabase backend (optional) ----------
   When SUPABASE_URL/SUPABASE_ANON_KEY (see config.js) are set, truck data +
   photos are read from / written to a Supabase project (see
   supabase-schema.sql) through its built-in REST (PostgREST) and Storage
   APIs directly — no server code of our own to deploy, no SDK to install.
   Everything else (role, admin PIN, display language) still uses this
   browser's localStorage (see storage.js). */
import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_BUCKET } from "./config.js";
import { todayKey, addDays } from "./dateUtils.js";
import { state, ui } from "./state.js";
import { render } from "./render.js";
import { setSettingsOverrides, getMaxDayOffset } from "./settings.js";

export function supabaseEnabled(){ return !!SUPABASE_URL && !!SUPABASE_ANON_KEY; }

function sbHeaders(extra){
  var h = { "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer "+SUPABASE_ANON_KEY };
  for(var k in extra) h[k] = extra[k];
  return h;
}

export function sbRest(path, opts){
  opts = opts || {};
  var headers = sbHeaders(opts.headers || {});
  if(opts.body) headers["Content-Type"] = "application/json";
  return fetch(SUPABASE_URL+"/rest/v1/"+path, {
    method: opts.method || "GET",
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  }).catch(function(){
    // fetch() itself rejected -- genuinely no network reachable (offline,
    // DNS failure, etc.), as opposed to the request reaching Supabase and
    // getting an error response (handled below, once res exists). Tagged
    // distinctly so callers (js/offlineQueue.js) can tell "no network, worth
    // queuing for later" apart from "reached the server, it said no".
    var e = new Error("network");
    e.networkFailure = true;
    throw e;
  }).then(function(res){
    if(res.status === 204) return null;
    return res.json().catch(function(){ return null; }).then(function(json){
      if(!res.ok){
        var e = new Error((json && (json.message || json.error)) || ("Supabase error "+res.status));
        throw e;
      }
      return json;
    });
  });
}

export function mapRowToTruck(row){
  var status = "scheduled";
  if(row.truck_state === "completed") status = "done";
  else if(row.truck_state === "arrived") status = "unloading";
  return {
    id: row.id,
    ref: row.reference_id || "",
    carrier: row.carrier || "",
    plant: row.plant || "",
    imExTr: row.im_ex_tr || "",
    poNo: row.po_no || "",
    skuNo: row.sku_no || "",
    qtt: row.qtt || "",
    contNo: row.cont_no || "",
    sealNo: row.seal_no || "",
    contType: row.cont_type || "",
    closingDate: row.closing_date || "",
    remark: row.remark || "",
    damageRemark: row.damage_remark || "",
    details: row.details || "",
    date: row.order_date || todayKey(),
    eta: row.eta ? row.eta.slice(11,16) : null,
    status: status,
    startedAt: row.act_arrival || null,
    finishedAt: row.act_dept || null,
    startedBy: row.started_by || "",
    finishedBy: row.finished_by || "",
    raw: row.raw || null,
    lots: row.lots || null,
    photos: (row.photos || []).map(function(p){
      return { id:p.id, url:p.url, storagePath:p.storage_path, uploadedBy:p.uploaded_by||"", createdAt:p.created_at };
    })
  };
}

/* Every screen in the app only ever shows ONE day at a time (Admin's day-nav
   is clamped to [-maxDayOffset, +maxDayOffset] from today, see
   js/settings.js/render.js — a driver is pinned to today only) — so nothing
   in render.js ever needs a truck dated further out than that window, no
   matter how much history has piled up in Supabase over months of real use.
   Before this, loadFromSupabase() fetched *every* truck ever imported, every
   single poll (every 15s) — fine while the table was small, but it would
   only get slower over time as more months of trucks accumulate, for data
   that was never going to be shown anyway. Scoping the query to that same
   window server-side (PostgREST supports two conditions on one column,
   ANDed together) keeps each poll's payload bounded regardless of how big
   the table gets, with no visible change to what the app displays.
   getMaxDayOffset() (Round 23) reads live, so if an Admin widens the day-nav
   range from the new settings screen, the very next poll starts fetching the
   wider window too — otherwise the day-nav could let someone scroll to a day
   this query never fetched, which would just look like an empty day. */
function defaultWindow(){
  var span = getMaxDayOffset();
  return { from: addDays(todayKey(), -span), to: addDays(todayKey(), span) };
}

export function loadFromSupabase(){
  var w = defaultWindow();
  var q = "trucks?select=*,photos(id,url,storage_path,uploaded_by,created_at)"+
    "&order_date=gte."+w.from+"&order_date=lte."+w.to+
    "&order=order_date.asc,eta.asc.nullslast";
  return sbRest(q).then(function(rows){
    state.trucks = (rows || []).map(mapRowToTruck);
    ui.syncStatus = "synced";
    render();
  }).catch(function(err){
    ui.syncStatus = "error";
    render();
  });
}

/* Used only by the Admin reporting screen (js/reporting.js) -- a deliberately
   separate, explicitly-ranged query, same reasoning as sbFetchTrucksInRange
   below: a manager might ask for stats over the last 30 or 90 days, well
   outside the +/-MAX_DAY_OFFSET window loadFromSupabase() keeps state.trucks
   scoped to for everyday display. Selects only the columns the report's KPIs
   actually use, rather than the full row (photos, raw, lots, ...). */
export function sbFetchTrucksForReport(fromDate, toDate){
  // po_no/carrier appended at the END of the select list (Round 24, Theo
  // asked for both in the CSV export) rather than inserted earlier in it --
  // keeps the "order_date,eta,truck_state" prefix this query has always had
  // intact, which is what tests/test_v2_reporting.py's date-window check
  // matches against.
  var q = "trucks?select=order_date,eta,truck_state,act_arrival,act_dept,damage_remark,po_no,carrier"+
    "&order_date=gte."+fromDate+"&order_date=lte."+toDate;
  return sbRest(q).then(function(rows){
    return (rows || []).map(function(row){
      return {
        date: row.order_date || "",
        eta: row.eta ? row.eta.slice(11,16) : null,
        truckState: row.truck_state || "pending",
        actArrival: row.act_arrival || null,
        actDept: row.act_dept || null,
        damageRemark: row.damage_remark || "",
        poNo: row.po_no || "",
        carrier: row.carrier || ""
      };
    });
  });
}

/* Used only by the inbound-plan import (js/importPlan.js) to check which
   trucks already exist for the exact dates found in the source file being
   imported — which can be any range, including well outside the display
   window above (a manager might re-import an older file for record-keeping).
   Deliberately separate from loadFromSupabase(): it does NOT touch
   state.trucks or call render(), it just answers "what's already there for
   these dates" for the dedupe check. */
export function sbFetchTrucksInRange(fromDate, toDate){
  var q = "trucks?select=po_no,order_date,eta,carrier"+
    "&order_date=gte."+fromDate+"&order_date=lte."+toDate;
  return sbRest(q).then(function(rows){
    return (rows || []).map(function(row){
      return { poNo: row.po_no || "", date: row.order_date || "", eta: row.eta ? row.eta.slice(11,16) : null, carrier: row.carrier || "" };
    });
  });
}

/* Round 25: backs the Admin MON IT-only "photo archive" button (Reporting
   screen, see reportSheetHtml()/archiveBlockHtml() in render.js) --
   deliberately its own query rather than reusing sbFetchTrucksForReport()
   above (which doesn't embed photos at all) or loadFromSupabase() (which
   embeds photos but is scoped to the +/-MAX_DAY_OFFSET display window, not
   an arbitrary manager-picked range). Selects only what
   downloadPhotosArchive() (js/photoDownload.js) needs to name each zip
   entry -- nothing here writes anything, and nothing downstream of it
   deletes anything either, per Theo's explicit "ca supprimes rien". */
export function sbFetchTrucksForArchive(fromDate, toDate){
  var q = "trucks?select=id,po_no,reference_id,order_date,eta,photos(id,url,storage_path)"+
    "&order_date=gte."+fromDate+"&order_date=lte."+toDate+
    "&order=order_date.asc,eta.asc.nullslast";
  return sbRest(q).then(function(rows){
    return (rows || []).map(function(row){
      return {
        id: row.id,
        label: row.po_no || row.reference_id || row.id,
        date: row.order_date || "",
        eta: row.eta ? row.eta.slice(11,16) : null,
        photos: (row.photos || []).map(function(p){ return { id:p.id, url:p.url, storagePath:p.storage_path }; })
      };
    });
  });
}

/* Conditional update: only applies if the truck is still in fromState — this
   is what protects against two phones acting on the same truck at once (see
   README). An empty result means someone else changed it first: the caller
   re-syncs from Supabase and shows a translated conflict message instead of
   silently overwriting whatever the other action just wrote. */
export function sbPatchTruckConditional(id, fromState, patch){
  var q = "trucks?id=eq."+encodeURIComponent(id)+(fromState ? "&truck_state=eq."+encodeURIComponent(fromState) : "");
  return sbRest(q, { method:"PATCH", headers:{ "Prefer":"return=representation" }, body: patch }).then(function(rows){
    if(!rows || !rows.length){
      var e = new Error("conflict");
      e.conflict = true;
      throw e;
    }
    return rows[0];
  });
}

export function sbCreateTruck(fields){
  return sbRest("trucks", { method:"POST", headers:{ "Prefer":"return=representation" }, body: fields }).then(function(rows){
    return rows && rows[0];
  });
}

export function sbDeleteTruck(id){
  return sbRest("trucks?id=eq."+encodeURIComponent(id), { method:"DELETE" });
}

/* Turns a truck's PO/reference number into something safe to put in a
   storage path: ASCII letters/digits/hyphens only (Thai text and other
   symbols become hyphens rather than being rejected outright), collapsed
   and capped so one long/messy source value can't produce a huge path. */
function slugifyForPath(s){
  return String(s==null?"":s)
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export function sbUploadPhoto(truckId, blob, uploadedBy, truckLabel){
  // truckId (a Supabase UUID) stays the folder — it's the only thing
  // guaranteed unique per truck, so grouping/deleting photos never breaks
  // even when two different truck visits share the same PO number (see
  // README). truckLabel (the PO/reference shown in the app) is only added
  // to the filename, purely so photos are recognizable when browsed
  // directly in the Supabase Storage dashboard or downloaded in bulk.
  var safeLabel = slugifyForPath(truckLabel);
  var path = truckId+"/"+(safeLabel ? safeLabel+"-" : "")+Date.now()+"-"+Math.random().toString(36).slice(2,8)+".jpg";
  return fetch(SUPABASE_URL+"/storage/v1/object/"+SUPABASE_BUCKET+"/"+path, {
    method: "POST",
    headers: sbHeaders({ "Content-Type":"image/jpeg" }),
    body: blob
  }).then(function(res){
    if(!res.ok) throw new Error("Upload failed ("+res.status+")");
    var publicUrl = SUPABASE_URL+"/storage/v1/object/public/"+SUPABASE_BUCKET+"/"+path;
    return sbRest("photos", {
      method:"POST", headers:{ "Prefer":"return=representation" },
      body: { truck_id: truckId, url: publicUrl, storage_path: path, uploaded_by: uploadedBy || null }
    });
  }).then(function(rows){ return rows && rows[0]; });
}

export function sbDeletePhoto(photoId, storagePath){
  return fetch(SUPABASE_URL+"/storage/v1/object/"+SUPABASE_BUCKET+"/"+storagePath, {
    method: "DELETE", headers: sbHeaders({})
  }).catch(function(){ /* ignore storage-delete errors, still remove the row */ }).then(function(){
    return sbRest("photos?id=eq."+encodeURIComponent(photoId), { method:"DELETE" });
  });
}

/* ---------- shared admin settings (Round 23) ----------
   One row (id=1) holding every adjustable threshold from js/settings.js as a
   single jsonb blob — simpler than one column per setting, and it means
   adding a 6th setting later never needs another supabase-schema.sql ALTER.
   Fetched once at startup and again on every regular poll (see main.js), so
   every phone/screen converges on the same values within one poll cycle,
   the same way a truck edit does. */
export function sbFetchAppSettings(){
  return sbRest("app_settings?id=eq.1&select=settings").then(function(rows){
    return (rows && rows[0] && rows[0].settings) || {};
  });
}
/* Called at startup and every poll interval (main.js) -- errors (table/row
   missing on a project that hasn't run the Round 23 SQL yet, or no network)
   are swallowed on purpose: every getter in settings.js already falls back
   to its config.js default when there's no override, so there is nothing
   more useful to do here than just leave those defaults in place. */
export function loadAppSettings(){
  return sbFetchAppSettings().then(function(settings){
    setSettingsOverrides(settings);
  }).catch(function(){ /* keep whatever overrides (or defaults) were already in effect */ });
}
/* Upsert via PostgREST's "on_conflict" + merge-duplicates preference, so this
   works whether or not the row already exists yet on a given project. */
export function sbSaveAppSettings(obj){
  return sbRest("app_settings?on_conflict=id", {
    method:"POST",
    headers:{ "Prefer":"resolution=merge-duplicates,return=representation" },
    body:{ id:1, settings: obj, updated_at: new Date().toISOString() }
  });
}
