/* ---------- actions ----------
   Every user-triggered mutation (ETA, start/finish/cancel/reopen unload,
   add/delete truck, photos, PIN, role) lives here. Each one updates
   `state`/`ui` and then calls `render()` — either directly (local/no-backend
   mode) or through `runBackendCall`, which drives the Supabase round trip,
   shows a translated success/error/conflict toast, and re-syncs from
   Supabase afterwards so every phone stays consistent. */
import { pad2, addDays, todayKey } from "./dateUtils.js";
import { tr } from "./i18n.js";
import { state, ui } from "./state.js";
import {
  supabaseEnabled, sbRest, sbPatchTruckConditional, sbCreateTruck,
  sbDeleteTruck, sbUploadPhoto, sbDeletePhoto, loadFromSupabase,
  sbSaveAppSettings, sbLogTruckEvent
} from "./api.js";
import { loadSavedName, saveNameLocal, saveLocalData, saveRoleLocal, clearRoleLocal } from "./storage.js";
import { render } from "./render.js";
import { buzz, readAndCompressImage } from "./photoUtils.js";
import { enqueueOfflineAction } from "./offlineQueue.js";
// Round 23: these two used to be plain config.js constants -- now
// admin-adjustable at runtime (see js/settings.js), so both call sites below
// read the live getter instead. SETTINGS_DEFS/setSettingsOverrides back the
// new app settings screen at the bottom of this file.
import { getMaxPhotosPerTruck, getUndoDeleteMs, SETTINGS_DEFS, setSettingsOverrides } from "./settings.js";

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
    // Genuinely no network reachable (not a server error -- see api.js) --
    // for the truck-lifecycle actions that supply a queueDescriptor, queue
    // it instead of just erroring: it'll replay automatically once the
    // connection is back (see js/offlineQueue.js), rather than being lost
    // the moment this toast disappears.
    if(err && err.networkFailure && opts.queueDescriptor){
      enqueueOfflineAction(opts.queueDescriptor);
      ui.syncStatus = "queued";
      render();
      showToast(tr("queuedOffline"));
      return;
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

/* ---------- truck history / audit log (Round 26) ---------- */
// Same 4 labels roleLabel() in render.js shows on the role badge -- kept as
// its own tiny copy here rather than importing from render.js, since
// render.js doesn't export that helper and this is the only other place
// that needs it.
function roleActorLabel(role){
  if(role === "admin") return tr("roleAdmin");
  if(role === "admin_it") return tr("roleAdminIt");
  if(role === "nestle") return tr("roleNestle");
  return tr("roleDriver");
}
function truckLabelFor(id){
  var t = findTruck(id);
  return t ? (t.truckLabel || t.poNo || t.ref || id) : id;
}
/* Appends one line to the audit trail the Admin-only History screen reads
   (js/history.js) -- best-effort only (see sbLogTruckEvent() in api.js,
   which swallows its own errors), never awaited, and never allowed to
   affect the action it's describing. No-ops outright in local-only mode
   (nothing shared to log to). `actor` is whichever device name is saved
   (js/storage.js's loadSavedName(), the same "who did this" used for
   started_by/finished_by) or, if none was ever set, the current role. */
function logTruckEvent(truckId, label, action, detail){
  if(!supabaseEnabled()) return;
  var actor = loadSavedName() || roleActorLabel(ui.role);
  sbLogTruckEvent({
    truck_id: truckId || null, truck_label: label || null,
    action: action, actor: actor || null, detail: detail || null
  });
}

/* ---------- sheet / navigation ---------- */
export function findTruck(id){ return state.trucks.find(function(t){ return t.id === id; }); }
export function openSheet(id){
  ui.openId = id; ui.addOpen = false; ui.confirmDelete = null;
  // Round 27: always start a freshly-opened sheet in "view" mode, not
  // whatever ui.signatureEditing happened to be left at from a previously
  // opened truck (a stray true here would show truck B's signature pad
  // instead of truck A's already-saved image the moment B is opened).
  ui.signatureEditing = false;
  render();
}
export function closeSheet(){
  ui.openId = null; ui.addOpen = false; ui.pinSettingsOpen = false;
  ui.nameSettingsOpen = false; ui.importOpen = false; ui.reportOpen = false;
  ui.settingsOpen = false; ui.settingsError = null; ui.historyOpen = false;
  ui.archiveListOpen = false; ui.archiveListError = null;
  ui.confirmDelete = null; ui.photoViewer = null; ui.signatureEditing = false;
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
/* Round 25 follow-up: "un bouton pour logout manuellement ca peut etre
   utile" (Theo, alongside the 30-minute inactivity auto-logout in
   ticking.js's tick(), which calls this same function). Unlike the
   "switch role" button (data-role-switch in events.js), which just opens
   the role-gate overlay while leaving the CURRENT role valid until a new
   one is actually picked, this clears the role outright -- whoever's next
   at this device must re-enter a PIN before anything role-gated is visible
   again. Shared cleanup with closeSheet() above so no sheet/overlay is left
   half-open behind the role gate. */
export function logout(){
  ui.role = null;
  clearRoleLocal();
  ui.roleGateOpen = true;
  ui.roleGateStep = "choose";
  ui.roleGateError = null;
  ui.openId = null; ui.addOpen = false; ui.pinSettingsOpen = false;
  ui.nameSettingsOpen = false; ui.importOpen = false; ui.reportOpen = false;
  ui.settingsOpen = false; ui.settingsError = null; ui.historyOpen = false;
  ui.archiveListOpen = false; ui.archiveListError = null;
  ui.confirmDelete = null; ui.photoViewer = null; ui.signatureEditing = false;
  render();
}
// Round 25: three roles now sit behind a PIN (Admin MON, Admin MON IT,
// Nestlé) instead of just Admin -- each with its own code in state (see
// state.js's DEFAULT_STATE / migration). This maps a role string to the
// state field that holds its PIN, used by both submitPin() (checking the
// PIN just typed) and savePin() (changing the PIN for whichever role is
// currently logged in).
function pinFieldForRole(role){
  if(role === "admin_it") return "adminItCode";
  if(role === "nestle") return "nestleCode";
  return "adminMonCode";
}
export function submitPin(){
  var el = document.getElementById("pinInput");
  var v = el ? el.value : "";
  // roleGateStep is set generically by events.js from whichever
  // data-role-step button was tapped (roleGateHtml() in render.js) -- "pin"
  // is Admin MON (unchanged since Round 14, for backward compatibility),
  // "pin_it" is Admin MON IT, "pin_nestle" is Nestlé.
  var role = ui.roleGateStep === "pin_it" ? "admin_it" : ui.roleGateStep === "pin_nestle" ? "nestle" : "admin";
  var field = pinFieldForRole(role);
  if(v && v === state[field]){
    pickRole(role);
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
  var field = pinFieldForRole(ui.role);
  if(cur !== state[field]){ ui.pinSettingsError = tr("pinErrCurrent"); render(); return; }
  if(!next || next.length < 6){ ui.pinSettingsError = tr("pinErrLength"); render(); return; }
  if(next !== confirm){ ui.pinSettingsError = tr("pinErrMismatch"); render(); return; }
  persist(function(){ state[field] = next; });
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
  var label = truckLabelFor(id);
  ui.openId = null;
  if(supabaseEnabled()){
    runBackendCall(sbRest("trucks?id=eq."+encodeURIComponent(id), { method:"PATCH", headers:{"Prefer":"return=representation"}, body:{eta:etaValue} }), {
      successMsg: tr("timeSaved"),
      errorMsg: "couldNotSaveSheet",
      onSuccess: function(){ logTruckEvent(id, label, "eta_changed", v); },
      retry: function(){ saveEta_retry(id, etaValue, label); },
      queueDescriptor: { kind:"patchPlain", id: id, patch: { eta: etaValue } }
    });
    return;
  }
  persist(function(){ t.eta = v; t.status = "scheduled"; });
  showToast(tr("timeSaved"));
}
function saveEta_retry(id, etaValue, label){
  runBackendCall(sbRest("trucks?id=eq."+encodeURIComponent(id), { method:"PATCH", headers:{"Prefer":"return=representation"}, body:{eta:etaValue} }), {
    successMsg: tr("timeSaved"), errorMsg: "couldNotSaveSheet",
    onSuccess: function(){ logTruckEvent(id, label, "eta_changed", etaValue.slice(11,16)); },
    retry: function(){ saveEta_retry(id, etaValue, label); },
    queueDescriptor: { kind:"patchPlain", id: id, patch: { eta: etaValue } }
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
  var label = truckLabelFor(id);
  sbRest("trucks?id=eq."+encodeURIComponent(id), { method:"PATCH", headers:{"Prefer":"return=representation"}, body:{damage_remark:v} })
    .then(function(){
      logTruckEvent(id, label, "remark_updated", v || null);
      return loadFromSupabase().then(function(){ showToast(tr("remarkSaved")); });
    })
    .catch(function(err){
      // No network at all (as opposed to reaching Supabase and getting an
      // error back, handled below) -- queue it like the other truck actions
      // (see js/offlineQueue.js) rather than losing the remark outright.
      if(err && err.networkFailure){
        enqueueOfflineAction({ kind:"patchPlain", id: id, patch: { damage_remark: v } });
        showToast(tr("queuedOffline"));
        return;
      }
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
/* An optional signature (driver or receiving-side confirmation) captured on
   the <canvas> in signatureHtml() (js/render.js) -- the drawing itself is
   handled directly by events.js's pointer listeners (never through render(),
   see that file's comment), this is only the "turn the finished drawing into
   a PNG and save it" step, called once someone taps "Save signature". Same
   plain-unconditional-PATCH shape as saveDamageRemark above (not tied to the
   truck's start/finish lifecycle, editable/re-signable any time). */
export function saveSignature(id){
  var canvas = document.getElementById("signatureCanvas");
  if(!canvas) return;
  var dataUrl = canvas.toDataURL("image/png");
  var t = findTruck(id);
  if(!t) return;
  if(supabaseEnabled()){
    saveSignature_send(id, dataUrl);
    return;
  }
  persist(function(){ t.signature = dataUrl; });
  ui.signatureEditing = false;
  showToast(tr("signatureSaved"));
}
function saveSignature_send(id, dataUrl){
  var label = truckLabelFor(id);
  sbRest("trucks?id=eq."+encodeURIComponent(id), { method:"PATCH", headers:{"Prefer":"return=representation"}, body:{signature:dataUrl} })
    .then(function(){
      // Kept short on purpose -- the audit trail logs THAT a signature was
      // saved, never the image data itself (truck_events.detail is a plain
      // text column, not meant to carry a data URL's worth of base64).
      logTruckEvent(id, label, "signature_saved", null);
      ui.signatureEditing = false;
      return loadFromSupabase().then(function(){ showToast(tr("signatureSaved")); });
    })
    .catch(function(err){
      if(err && err.networkFailure){
        enqueueOfflineAction({ kind:"patchPlain", id: id, patch: { signature: dataUrl } });
        ui.signatureEditing = false;
        showToast(tr("queuedOffline"));
        return;
      }
      // The "signature" column update (supabase-schema.sql) hasn't been run
      // on this Supabase project yet -- same graceful-degradation pattern as
      // "damage_remark" above: tell the user plainly, leave the drawing on
      // screen (don't flip back to view mode) so nothing is silently lost.
      if(isMissingColumnError(err, "signature")){
        showToast(tr("signatureColumnMissing"), true);
        return;
      }
      showToast((err && err.message) || tr("couldNotSaveSheet"), true);
    });
}
export function startUnload(id){
  var by = loadSavedName();
  var label = truckLabelFor(id);
  buzz();
  if(supabaseEnabled()){
    var patch = { truck_state:"arrived", act_arrival: localNaiveTs(new Date()), started_by: by || null };
    var go = function(){
      runBackendCall(sbPatchTruckConditional(id, "pending", patch), {
        conflictKeyFor: function(){ return "conflict_already_started"; },
        errorMsg: "couldNotSaveSheet",
        onSuccess: function(){ logTruckEvent(id, label, "arrived", null); },
        retry: go,
        queueDescriptor: { kind:"patchConditional", id: id, fromState:"pending", patch: patch }
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
  var label = truckLabelFor(id);
  buzz();
  if(supabaseEnabled()){
    var patch = { truck_state:"completed", act_dept: localNaiveTs(new Date()), finished_by: by || null };
    var go = function(){
      runBackendCall(sbPatchTruckConditional(id, "arrived", patch), {
        conflictKeyFor: function(){
          var t = findTruck(id);
          return (t && t.status === "done") ? "conflict_already_finished" : "conflict_not_started_yet";
        },
        errorMsg: "couldNotSaveSheet",
        onSuccess: function(){ logTruckEvent(id, label, "completed", null); },
        retry: go,
        queueDescriptor: { kind:"patchConditional", id: id, fromState:"arrived", patch: patch }
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
  var label = truckLabelFor(id);
  if(supabaseEnabled()){
    var patch = { truck_state:"pending", act_arrival:null, started_by:null };
    var go = function(){
      runBackendCall(sbPatchTruckConditional(id, "arrived", patch), {
        conflictKeyFor: function(){ return "conflict_not_in_started_state"; },
        errorMsg: "couldNotSaveSheet",
        onSuccess: function(){ logTruckEvent(id, label, "cancelled", null); },
        retry: go,
        queueDescriptor: { kind:"patchConditional", id: id, fromState:"arrived", patch: patch }
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
  var label = truckLabelFor(id);
  if(supabaseEnabled()){
    var patch = { truck_state:"arrived", act_dept:null, finished_by:null };
    var go = function(){
      runBackendCall(sbPatchTruckConditional(id, "completed", patch), {
        conflictKeyFor: function(){ return "conflict_not_in_completed_state"; },
        errorMsg: "couldNotSaveSheet",
        onSuccess: function(){ logTruckEvent(id, label, "reopened", null); },
        retry: go,
        queueDescriptor: { kind:"patchConditional", id: id, fromState:"completed", patch: patch }
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
/* Module-level (not on `ui`, which only ever holds plain/serializable-ish
   display state) -- the one live timer for whichever delete is currently
   pending. Only one truck can be mid-delete at a time (deleteTruck() itself
   is only reachable from a truck's own sheet, which closes when it's
   tapped), so a single variable is enough; a fresh delete before the
   previous one committed would just replace it, which can't happen in
   practice given the sheet closes immediately below. */
var pendingDeleteTimer = null;

/* Deleting a truck is easy to do by accident (one mis-tap past the existing
   confirm step, on a phone at a busy dock) and, until this round, permanent
   the instant it happened. Now it's a short "Undo" window instead: the truck
   is hidden from the list/KPIs right away (see ui.pendingDeleteId in
   render.js) but nothing is actually sent to Supabase (or removed from local
   storage) until UNDO_DELETE_MS later, unless undoDeleteTruck() cancels it
   first. */
export function deleteTruck(id){
  ui.openId = null; ui.confirmDelete = null;
  var t = findTruck(id);
  ui.pendingDeleteId = id;
  ui.pendingDeleteLabel = t ? (t.truckLabel || t.poNo || t.ref || id) : id;
  render();
  clearTimeout(pendingDeleteTimer);
  var label = ui.pendingDeleteLabel;
  pendingDeleteTimer = setTimeout(function(){ commitDelete(id, label); }, getUndoDeleteMs());
}
function commitDelete(id, label){
  ui.pendingDeleteId = null; ui.pendingDeleteLabel = null;
  if(supabaseEnabled()){
    runBackendCall(sbDeleteTruck(id), {
      successMsg: tr("truckDeleted"),
      errorMsg: "couldNotDeleteTruck",
      onSuccess: function(){ logTruckEvent(id, label, "deleted", null); },
      retry: function(){ commitDelete(id, label); },
      queueDescriptor: { kind:"deleteTruck", id: id }
    });
    return;
  }
  persist(function(){
    state.trucks = state.trucks.filter(function(t){ return t.id !== id; });
  });
  showToast(tr("truckDeleted"));
}
/* The Undo tap in the toast (see toastHtml() in render.js) -- cancels the
   pending commit outright, so the truck simply reappears; nothing was ever
   actually sent anywhere for this delete. */
export function undoDeleteTruck(){
  clearTimeout(pendingDeleteTimer);
  ui.pendingDeleteId = null; ui.pendingDeleteLabel = null;
  render();
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
      onSuccess: function(row){ logTruckEvent(row && row.id, (row && row.truck_label) || ref || carrier, "created", carrier || null); },
      retry: function(){ /* re-open the add form instead of blindly resubmitting stale field values */ ui.addOpen = true; render(); },
      queueDescriptor: { kind:"createTruck", fields: fields }
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
  var truckLabel = truck ? (truck.truckLabel || truck.poNo || truck.ref || truck.id) : "";
  var already = (truck && truck.photos) ? truck.photos.length : 0;
  var maxPhotos = getMaxPhotosPerTruck();
  var remaining = Math.max(0, maxPhotos - already);
  var accepted = list.slice(0, remaining);
  var skippedCount = list.length - accepted.length;
  if(!accepted.length){
    showToast(tr("photosLimitReached").replace("{max}", maxPhotos));
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
        msg += " " + tr("photosLimitSkipped").replace("{n}", skippedCount).replace("{max}", maxPhotos);
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

/* ---------- fullscreen photo viewer (Round 23) ----------
   Replaces the old "open the raw Storage URL in a new browser tab" behaviour
   (target="_blank" on the thumbnail, since Round 5) with an in-app overlay
   that can step through every other photo on the same truck and zoom in --
   without ever leaving the app, so a manager reviewing damage photos doesn't
   lose their place in the sheet behind a new tab. */
export function openPhotoViewer(truckId, index){
  ui.photoViewer = { truckId: truckId, index: index || 0, zoomed: false };
  render();
}
export function closePhotoViewer(){
  ui.photoViewer = null;
  render();
}
/* Wraps in both directions (last photo -> next goes to the first, and back)
   rather than stopping at the ends -- with the prev/next arrows only shown
   at all when there's more than one photo (see photoViewerHtml() in
   render.js), a truck with exactly 2 photos would otherwise need "prev" to
   do nothing at photo 1, which reads as broken rather than intentional. */
export function photoViewerStep(delta){
  if(!ui.photoViewer) return;
  var t = findTruck(ui.photoViewer.truckId);
  var photos = (t && t.photos) || [];
  if(!photos.length) return;
  var n = photos.length;
  ui.photoViewer.index = ((ui.photoViewer.index + delta) % n + n) % n;
  ui.photoViewer.zoomed = false;
  render();
}
export function togglePhotoZoom(){
  if(!ui.photoViewer) return;
  ui.photoViewer.zoomed = !ui.photoViewer.zoomed;
  render();
}

/* ---------- admin settings screen (Round 23) ----------
   Reads every SETTINGS_DEFS input by id (see settingsSheetHtml() in
   render.js, which names each one "setting-<key>"), validates it's a real
   number within that setting's range, converts it back from display units
   to stored units (only undoDeleteMs differs -- seconds on screen,
   milliseconds everywhere else, see settings.js), and either saves it to the
   shared Supabase row (every device converges within one poll cycle, see
   api.js/main.js) or, in local-only mode where there's no shared backend to
   write to, just applies it for this browser's current session and says so
   rather than pretending it was saved for everyone. */
export function saveAppSettings(){
  var vals = {};
  var invalid = false;
  SETTINGS_DEFS.forEach(function(defn){
    var el = document.getElementById("setting-"+defn.key);
    var raw = el ? parseInt(el.value, 10) : NaN;
    if(!isFinite(raw) || raw < defn.min || raw > defn.max){ invalid = true; return; }
    vals[defn.key] = raw * defn.divisor;
  });
  if(invalid){
    ui.settingsError = tr("settingsErrRange");
    render();
    return;
  }
  ui.settingsError = null;
  if(!supabaseEnabled()){
    setSettingsOverrides(vals);
    ui.settingsOpen = false;
    render();
    showToast(tr("settingsSavedLocalOnly"));
    return;
  }
  ui.settingsBusy = true;
  render();
  sbSaveAppSettings(vals).then(function(){
    setSettingsOverrides(vals);
    ui.settingsBusy = false;
    ui.settingsOpen = false;
    render();
    showToast(tr("settingsSaved"));
  }).catch(function(err){
    ui.settingsBusy = false;
    ui.settingsError = (err && err.message) || tr("settingsSaveFailed");
    render();
  });
}
