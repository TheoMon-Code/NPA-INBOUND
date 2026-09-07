/* ---------- Supabase backend (optional) ----------
   When SUPABASE_URL/SUPABASE_ANON_KEY (see config.js) are set, truck data +
   photos are read from / written to a Supabase project (see
   supabase-schema.sql) through its built-in REST (PostgREST) and Storage
   APIs directly — no server code of our own to deploy, no SDK to install.
   Everything else (role, admin PIN, display language) still uses this
   browser's localStorage (see storage.js). */
import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_BUCKET } from "./config.js";
import { todayKey } from "./dateUtils.js";
import { state, ui } from "./state.js";
import { render } from "./render.js";

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

export function loadFromSupabase(){
  return sbRest("trucks?select=*,photos(id,url,storage_path,uploaded_by,created_at)&order=order_date.asc,eta.asc.nullslast").then(function(rows){
    state.trucks = (rows || []).map(mapRowToTruck);
    ui.syncStatus = "synced";
    render();
  }).catch(function(err){
    ui.syncStatus = "error";
    render();
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
