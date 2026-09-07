/* ---------- actions ----------
   Every user-triggered mutation (ETA, start/finish/cancel/reopen unload,
   add/delete truck, photos, PIN, role) lives here. Each one updates
   `state`/`ui` and then calls `render()` — either directly (local/no-backend
   mode) or through `runBackendCall`, which drives the Supabase round trip,
   shows a translated success/error/conflict toast, and re-syncs from
   Supabase afterwards so every phone stays consistent. */
import { pad2, addDays, todayKey } from "./dateUtils.js";
import { tr } from "./i18n.js";
import { MAX_PHOTOS_PER_TRUCK } from "./config.js";
import { state, ui } from "./state.js";
import {
  supabaseEnabled, sbRest, sbPatchTruckConditional, sbCreateTruck,
  sbDeleteTruck, sbUploadPhoto, sbDeletePhoto, loadFromSupabase
} from "./api.js";
import { loadSavedName, saveNameLocal, saveLocalData, saveRoleLocal } from "./storage.js";
import { render } from "./render.js";
import { buzz, readAndCompressImage } from "./photoUtils.js";

/* ---------- toast + persistence plumbing ---------- */
export function showToast(msg, sticky){
  ui.toast = msg;
  render();
  if(!sticky){
    var mine = msg;
    setTimeout(function(){ if(ui.toast === mine){ ui.toast = null; ui.retryAction = null; render(); } }, 2600);
  }
}
/* Local-only persistence (role, admin PIN, display language, and — when
   Supabase isn't configured yet — the trucks themselves) just writes this
   browser's localStorage. Nothing here needs a network round trip. */
export function persist(mutator){
  mutator();
  render();
  saveLocalData(state);
}
/* Truck lifecycle actions (ETA, start/finish/cancel/reopen unload, add/delete
   truck) go through here when Supabase is connected, so every phone reading
   the same project sees the same state. A conditional update that matches
   zero rows means someone else changed this truck first (two phones tapping
   "Start" at once, say) — retrying would just fail again, so instead we pull
   the real current state and show a translated explanation instead of
   silently overwriting whatever the other action just wrote. */
export function runBackendCall(promise, opts){
  opts = opts || {};
  ui.syncStatus = "saving";
  ui.retryAction = null;
  render();
  promise.then(function(result){
    ui.syncStatus = "synced";
    return loadFromSupabase().then(function(){
      if(opts.onSuccess) opts.onSuccess(result);
      if(opts.successMsg) showToast(opts.successMsg);
    });
  }).catch(function(err){
    if(err && err.conflict){
      ui.syncStatus = "synced";
      return loadFromSupabase().then(function(){
        var key = opts.conflictKeyFor ? opts.conflictKeyFor() : "conflictRefreshedDefault";
        showToast(tr(key));
      });
    }
    ui.syncStatus = "error";
    ui.retryAction = opts.retry || null;
    render();
    showToast((err && err.message) || (opts.errorMsg && tr(opts.errorMsg)) || tr("couldNotSaveSheet"), true);
  });
}
export function truckStateOf(t){
  if(!t) return null;
  return t.status === "done" ? "completed" : t.status === "unloading" ? "arrived" : "pending";
}

/* ---------- sheet / navigation ---------- */
export function findTruck(id){ return state.trucks.find(function(t){ return t.id === id; }); }
export function openSheet(id){ ui.openId = id; ui.addOpen = false; ui.confirmDelete = null; render(); }
export function closeSheet(){
  ui.openId = null; ui.addOpen = false; ui.pinSettingsOpen = false;
  ui.nameSettingsOpen = false; ui.importOpen = false; ui.confirmDelete = null;
  render();
}
export function openAdd(){
  // Default the new-truck date to whichever day is currently shown (falls
  // back to "today" for a driver, who never sees the day tabs at all).
  ui.addDefaultDate = addDays(todayKey(), ui.role === "driver" ? 0 : ui.dayOffset);
  ui.addOpen = true; ui.openId = null; render();
}

/* ---------- role / PIN ---------- */
export function pickRole(r){
  ui.role = r;
  ui.roleGateOpen = false;
  ui.roleGateStep = "choose";
  ui.roleGateError = null;
  saveRoleLocal(r);
  render();
}
export function focusPin(){
  setTimeout(function(){
    var el = document.getElementById("pinInput");
    if(el){ el.value = ""; el.focus(); }
  }, 30);
}
export function submitPin(){
  var el = document.getElementById("pinInput");
  var v = el ? el.value : "";
  if(v && v === state.adminCode){
    pickRole("admin");
  } else {
    ui.roleGateError = tr("incorrectPin");
    render();
    focusPin();
  }
}
export function savePin(){
  var cur = (document.getElementById("pin-current")||{}).value || "";
  var next = (document.getElementById("pin-new")||{}).value || "";
  var confirm = (document.getElementById("pin-confirm")||{}).value || "";
  if(cur !== state.adminCode){ ui.pinSettingsError = tr("pinErrCurrent"); render(); return; }
  if(!next || next.length < 6){ ui.pinSettingsError = tr("pinErrLength"); render(); return; }
  if(next !== confirm){ ui.pinSettingsError = tr("pinErrMismatch"); render(); return; }
  persist(function(){ state.adminCode = next; });
  ui.pinSettingsOpen = false;
  showToast(tr("pinUpdatedToast"));
}

/* ---------- truck lifecycle ---------- */
export function localNaiveTs(d){
  return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate())+"T"+pad2(d.getHours())+":"+pad2(d.getMinutes())+":"+pad2(d.getSeconds());
}
export function saveEta(id){
  var v = document.getElementById("etaInput").value;
  if(!v){ showToast(tr("chooseATime")); return; }
  var t = findTruck(id);
  if(!t) return;
  var etaValue = t.date+"T"+v+":00";
  ui.openId = null;
  if(supabaseEnabled()){
    runBackendCall(sbRest("trucks?id=eq."+encodeURIComponent(id), { method:"PATCH", headers:{"Prefer":"return=representation"}, body:{eta:etaValue} }), {
      successMsg: tr("timeSaved"),
      errorMsg: "couldNotSaveSheet",
      retry: function(){ saveEta_retry(id, etaValue); }
    });
    return;
  }
  persist(function(){ t.eta = v; t.status = "scheduled"; });
  showToast(tr("timeSaved"));
}
function saveEta_retry(id, etaValue){
  runBackendCall(sbRest("trucks?id=eq."+encodeURIComponent(id), { method:"PATCH", headers:{"Prefer":"return=representation"}, body:{eta:etaValue} }), {
    successMsg: tr("timeSaved"), errorMsg: "couldNotSaveSheet",
    retry: function(){ saveEta_retry(id, etaValue); }
  });
}
/* A single free-text remark per truck (not per photo) — requested to note,
   e.g., which layer of the container damaged product was found on, as
   evidence for a supplier claim. Editable by anyone, at any time, exactly
   like the ETA field above (not tied to the truck's start/finish lifecycle,
   so it's a plain unconditional PATCH, not sbPatchTruckConditional). Keeps
   the sheet open after saving (like photos) rather than closing it, since
   adding a remark is typically one step among several while looking at a
   truck, not a final action. */
export function saveDamageRemark(id){
  var el = document.getElementById("damageRemarkInput");
  var v = el ? el.value : "";
  var t = findTruck(id);
  if(!t) return;
  if(supabaseEnabled()){
    saveDamageRemark_send(id, v);
    return;
  }
  persist(function(){ t.damageRemark = v; });
  showToast(tr("remarkSaved"));
}
function isMissingColumnError(err, col){
  var msg = String((err && err.message) || "");
  return new RegExp("\\b"+col+"\\b","i").test(msg) && /(column|schema cache|does not exist)/i.test(msg);
}
function saveDamageRemark_send(id, v){
  sbRest("trucks?id=eq."+encodeURIComponent(id), { method:"PATCH", headers:{"Prefer":"return=representation"}, body:{damage_remark:v} })
    .then(function(){
      return loadFromSupabase().then(function(){ showToast(tr("remarkSaved")); });
    })
    .catch(function(err){
      // The "damage_remark" column update (supabase-schema.sql) hasn't been
      // run on this Supabase project yet — same graceful-degradation pattern
      // as the "raw"/"lots" columns (Rounds 7/10): tell the user plainly
      // rather than showing a generic/confusing error for what is really
      // just a missing migration step.
      if(isMissingColumnError(err, "damage_remark")){
        showToast(tr("remarkColumnMissing"), true);
        return;
      }
      showToast((err && err.message) || tr("couldNotSaveSheet"), true);
    });
}
export function startUnload(id){
  var by = loadSavedName();
  buzz();
  if(supabaseEnabled()){
    var go = function(){
      runBackendCall(sbPatchTruckConditional(id, "pending", { truck_state:"arrived", act_arrival: localNaiveTs(new Date()), started_by: by || null }), {
        conflictKeyFor: function(){ return "conflict_already_started"; },
        errorMsg: "couldNotSaveSheet",
        retry: go
      });
    };
    go();
    return;
  }
  persist(function(){
    var t = findTruck(id);
    t.status = "unloading";
    t.startedAt = new Date().toISOString();
    if(by) t.startedBy = by;
  });
}
export function finishUnload(id){
  var by = loadSavedName();
  buzz();
  if(supabaseEnabled()){
    var go = function(){
      runBackendCall(sbPatchTruckConditional(id, "arrived", { truck_state:"completed", act_dept: localNaiveTs(new Date()), finished_by: by || null }), {
        conflictKeyFor: function(){
          var t = findTruck(id);
          return (t && t.status === "done") ? "conflict_already_finished" : "conflict_not_started_yet";
        },
        errorMsg: "couldNotSaveSheet",
        retry: go
      });
    };
    go();
    return;
  }
  var t = findTruck(id);
  persist(function(){
    t.status = "done";
    t.finishedAt = new Date().toISOString();
    if(by) t.finishedBy = by;
  });
}
export function cancelUnload(id){
  if(supabaseEnabled()){
    var go = function(){
      runBackendCall(sbPatchTruckConditional(id, "arrived", { truck_state:"pending", act_arrival:null, started_by:null }), {
        conflictKeyFor: function(){ return "conflict_not_in_started_state"; },
        errorMsg: "couldNotSaveSheet",
        retry: go
      });
    };
    go();
    return;
  }
  persist(function(){
    var t = findTruck(id);
    t.status = "scheduled";
    t.startedAt = null;
  });
}
export function reopenUnload(id){
  if(supabaseEnabled()){
    var go = function(){
      runBackendCall(sbPatchTruckConditional(id, "completed", { truck_state:"arrived", act_dept:null, finished_by:null }), {
        conflictKeyFor: function(){ return "conflict_not_in_completed_state"; },
        errorMsg: "couldNotSaveSheet",
        retry: go
      });
    };
    go();
    return;
  }
  persist(function(){
    var t = findTruck(id);
    t.status = "unloading";
    t.finishedAt = null;
  });
}
export function deleteTruck(id){
  ui.openId = null; ui.confirmDelete = null;
  if(supabaseEnabled()){
    runBackendCall(sbDeleteTruck(id), {
      successMsg: tr("truckDeleted"),
      errorMsg: "couldNotDeleteTruck",
      retry: function(){ deleteTruck(id); }
    });
    return;
  }
  persist(function(){
    state.trucks = state.trucks.filter(function(t){ return t.id !== id; });
  });
  showToast(tr("truckDeleted"));
}
export function createTruck(){
  var carrier = document.getElementById("f-carrier").value.trim();
  var plant = document.getElementById("f-plant").value.trim();
  var ref = document.getElementById("f-ref").value.trim();
  var date = document.getElementById("f-date").value;
  var eta = document.getElementById("f-eta").value;
  if(!carrier || !plant || !date){ showToast(tr("fillRequiredFields")); return; }
  ui.addOpen = false;
  if(supabaseEnabled()){
    var fields = {
      reference_id: "T-"+Date.now().toString(36).toUpperCase(),
      carrier: carrier, plant: plant, po_no: ref || null,
      order_date: date, eta: eta ? (date+"T"+eta+":00") : null,
      truck_state: "pending"
    };
    runBackendCall(sbCreateTruck(fields), {
      successMsg: tr("truckAdded"),
      errorMsg: "couldNotCreateTruck",
      retry: function(){ /* re-open the add form instead of blindly resubmitting stale field values */ ui.addOpen = true; render(); }
    });
    return;
  }
  persist(function(){
    state.seq += 1;
    state.trucks.push({
      id: "T-"+String(state.seq).padStart(4,"0"),
      carrier: carrier, plant: plant, poNo: ref || null,
      date: date, eta: eta || null,
      status: "scheduled",
      startedAt: null, finishedAt: null
    });
  });
  showToast(tr("truckAdded"));
}

/* ---------- photos ----------
   Uploads one photo, end to end (compress -> Storage -> photos row ->
   re-sync). Returns a promise so addPhotos() below can chain several of
   these one after another instead of firing them all at once. */
function uploadOnePhoto(truckId, file, truckLabel){
  var by = loadSavedName();
  return readAndCompressImage(file, 1280, 0.72).then(function(dataUrl){
    return fetch(dataUrl).then(function(r){ return r.blob(); });
  }).then(function(blob){
    return sbUploadPhoto(truckId, blob, by, truckLabel);
  }).then(function(){
    return loadFromSupabase();
  });
}

/* Takes whatever the file picker returned — one photo or several picked at
   once (the input has `multiple` set, see render.js) — and uploads them one
   at a time, capped at MAX_PHOTOS_PER_TRUCK total for that truck. Extra
   files beyond the cap are silently skipped with a toast explaining why,
   rather than uploaded and then hidden by the UI. */
export function addPhotos(truckId, files){
  var list = Array.prototype.slice.call(files || []);
  if(!list.length) return;
  var truck = findTruck(truckId);
  // Same identifier shown on the truck's card (PO number, falling back to
  // the generated reference/id) — passed through so each photo's filename
  // in Supabase Storage is recognizable, not just a random string.
  var truckLabel = truck ? (truck.poNo || truck.ref || truck.id) : "";
  var already = (truck && truck.photos) ? truck.photos.length : 0;
  var remaining = Math.max(0, MAX_PHOTOS_PER_TRUCK - already);
  var accepted = list.slice(0, remaining);
  var skippedCount = list.length - accepted.length;
  if(!accepted.length){
    showToast(tr("photosLimitReached").replace("{max}", MAX_PHOTOS_PER_TRUCK));
    return;
  }
  showToast(tr("uploadingPhoto"), true);
  function next(i){
    if(i >= accepted.length){
      buzz(30);
      var msg = accepted.length > 1
        ? tr("photosUploadedMulti").replace("{n}", accepted.length)
        : tr("photoUploaded");
      if(skippedCount > 0){
        msg += " " + tr("photosLimitSkipped").replace("{n}", skippedCount).replace("{max}", MAX_PHOTOS_PER_TRUCK);
      }
      showToast(msg);
      return Promise.resolve();
    }
    return uploadOnePhoto(truckId, accepted[i], truckLabel).then(function(){ return next(i+1); });
  }
  next(0).catch(function(){
    showToast(tr("photoUploadFailed"));
  });
}
export function removePhoto(photoId, storagePath){
  showToast(tr("removingPhoto"), true);
  sbDeletePhoto(photoId, storagePath).then(function(){
    return loadFromSupabase();
  }).then(function(){
    showToast(tr("photoDeleted"));
  }).catch(function(){
    showToast(tr("photoRemoveFailed"));
  });
}

/* ---------- name settings (driver "who am I" pill) ---------- */
export function saveName(){
  var nameVal = (document.getElementById("name-input")||{}).value || "";
  saveNameLocal(nameVal.trim());
  ui.nameSettingsOpen = false;
  showToast(tr("nameSavedToast"));
}
