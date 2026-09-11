/* ---------- event delegation ----------
   One click/keydown/change listener each on #app, routing on the clicked
   element's data-* attribute. Matches the original single-file app exactly
   (same attributes, same order, same behavior) — just calling into the
   split-out modules instead of local closures. */
import { ui, touchActivity } from "./state.js";
import { render } from "./render.js";
import { getMaxDayOffset } from "./settings.js";
import { saveLangLocal } from "./storage.js";
import {
  pickRole, submitPin, focusPin, savePin, saveName,
  openSheet, openAdd, closeSheet, saveEta, startUnload, finishUnload,
  cancelUnload, reopenUnload, deleteTruck, undoDeleteTruck, createTruck,
  addPhotos, removePhoto, saveDamageRemark, findTruck,
  openPhotoViewer, closePhotoViewer, photoViewerStep, togglePhotoZoom,
  saveAppSettings, logout, saveSignature
} from "./actions.js";
import { openImportPlan, runImportPreview, runImportConfirm, handleImportFile } from "./importPlan.js";
import { openReport, runReport, exportReportCsv, runPhotoArchive } from "./reporting.js";
import { openHistory, runHistory } from "./history.js";
import { openArchiveList, runArchiveList } from "./archiveList.js";
import { downloadTruckPhotos } from "./photoDownload.js";

export function initEvents(){
  var app = document.getElementById("app");

  app.addEventListener("click", function(e){
    // Round 25 follow-up: any real interaction resets the 30-minute
    // inactivity auto-logout timer (js/ticking.js) -- see touchActivity() in
    // state.js. Deliberately at the very top, before any of the branches
    // below, so it always runs regardless of which one (if any) matches.
    touchActivity();
    var el = e.target;
    var pickEl = el.closest("[data-pick-role]");
    if(pickEl){ pickRole(pickEl.getAttribute("data-pick-role")); return; }
    var stepEl = el.closest("[data-role-step]");
    if(stepEl){ ui.roleGateStep = stepEl.getAttribute("data-role-step"); ui.roleGateError = null; render(); focusPin(); return; }
    if(el.closest("[data-role-back]")){ ui.roleGateStep = "choose"; ui.roleGateError = null; render(); return; }
    if(el.closest("[data-pin-submit]")){ submitPin(); return; }
    if(el.closest("[data-role-close]")){ ui.roleGateOpen = false; render(); return; }
    if(el.closest("[data-toggle-lang]")){
      ui.lang = ui.lang === "th" ? "en" : "th";
      saveLangLocal(ui.lang);
      render();
      return;
    }
    if(el.closest("[data-role-switch]")){
      ui.roleGateOpen = true; ui.roleGateStep = "choose"; ui.roleGateError = null;
      ui.openId = null; ui.addOpen = false; render(); return;
    }
    // Round 25 follow-up: manual logout (see actions.js's logout() for how
    // this differs from "switch role" above -- this clears the role
    // outright instead of just opening the picker while it stays valid).
    if(el.closest("[data-logout]")){ logout(); return; }
    if(el.closest("[data-open-pin-settings]")){
      ui.pinSettingsOpen = true; ui.pinSettingsError = null;
      ui.openId = null; ui.addOpen = false; render(); return;
    }
    if(el.closest("[data-open-name-settings]")){
      ui.nameSettingsOpen = true;
      ui.openId = null; ui.addOpen = false; render(); return;
    }
    if(el.closest("[data-open-app-settings]")){
      ui.settingsOpen = true; ui.settingsError = null;
      ui.openId = null; ui.addOpen = false; render(); return;
    }
    if(el.closest("[data-save-settings]")){ saveAppSettings(); return; }
    if(el.closest("[data-open-import]")){ openImportPlan(); return; }
    if(el.closest("[data-open-report]")){ openReport(); return; }
    if(el.closest("[data-run-report]")){ runReport(); return; }
    if(el.closest("[data-export-report-csv]")){ exportReportCsv(); return; }
    // Round 25: Admin MON IT-only bulk photo download (see archiveBlockHtml()
    // in render.js -- the button itself only ever renders for that role, so
    // no extra role check is needed here).
    if(el.closest("[data-download-archive]")){ runPhotoArchive(); return; }
    if(el.closest("[data-open-history]")){ openHistory(); return; }
    if(el.closest("[data-run-history]")){ runHistory(); return; }
    if(el.closest("[data-open-archive-list]")){ openArchiveList(); return; }
    if(el.closest("[data-run-archive-list]")){ runArchiveList(); return; }
    var importSheetToggleEl = el.closest("[data-import-sheet-toggle]");
    if(importSheetToggleEl){
      var importSheetName = importSheetToggleEl.getAttribute("data-import-sheet-toggle");
      ui.importSelected[importSheetName] = !ui.importSelected[importSheetName];
      render();
      return;
    }
    if(el.closest("[data-import-preview]")){ runImportPreview(); return; }
    if(el.closest("[data-import-confirm]")){ runImportConfirm(); return; }
    if(el.closest("[data-import-back]")){ ui.importStep = "pick"; ui.importResult = null; ui.importError = null; render(); return; }
    var savePinEl = el.closest("[data-save-pin]");
    if(savePinEl){ savePin(); return; }
    var saveNameEl = el.closest("[data-save-name]");
    if(saveNameEl){ saveName(); return; }
    var open = el.closest("[data-open]");
    if(open){ openSheet(open.getAttribute("data-open")); return; }
    if(el.closest("[data-add]")){ openAdd(); return; }
    if(el.closest("[data-close]") || el === el.closest(".scrim")){
      if(el.classList.contains("scrim") || el.closest("[data-close]")) closeSheet();
      return;
    }
    var saveEl = el.closest("[data-save-eta]");
    if(saveEl){ saveEta(saveEl.getAttribute("data-save-eta")); return; }
    var saveRemarkEl = el.closest("[data-save-remark]");
    if(saveRemarkEl){ saveDamageRemark(saveRemarkEl.getAttribute("data-save-remark")); return; }
    // Round 27: signature pad -- "Redo" switches the sheet from showing the
    // already-saved image to a blank canvas; "Clear" wipes the canvas
    // in-place (no render() -- see the long comment above clearSignatureCanvas
    // below for why); "Save" reads the canvas pixels back out as a PNG.
    if(el.closest("[data-edit-signature]")){ ui.signatureEditing = true; render(); return; }
    if(el.closest("[data-clear-signature]")){ clearSignatureCanvas(); return; }
    var saveSigEl = el.closest("[data-save-signature]");
    if(saveSigEl){ saveSignature(saveSigEl.getAttribute("data-save-signature")); return; }
    var startEl = el.closest("[data-start]");
    if(startEl){ startUnload(startEl.getAttribute("data-start")); return; }
    var finishEl = el.closest("[data-finish]");
    if(finishEl){ finishUnload(finishEl.getAttribute("data-finish")); return; }
    var photoAddCameraEl = el.closest("[data-photo-add-camera]");
    if(photoAddCameraEl){
      ui.pendingPhotoTruckId = photoAddCameraEl.getAttribute("data-photo-add-camera");
      var cameraInput = document.getElementById("photoAddCameraInput");
      if(cameraInput) cameraInput.click();
      return;
    }
    var photoAddGalleryEl = el.closest("[data-photo-add-gallery]");
    if(photoAddGalleryEl){
      ui.pendingPhotoTruckId = photoAddGalleryEl.getAttribute("data-photo-add-gallery");
      var galleryInput = document.getElementById("photoAddGalleryInput");
      if(galleryInput) galleryInput.click();
      return;
    }
    var photoRmEl = el.closest("[data-photo-remove]");
    if(photoRmEl){
      removePhoto(photoRmEl.getAttribute("data-photo-remove"), photoRmEl.getAttribute("data-photo-path"));
      return;
    }
    // Fullscreen photo viewer (Round 23) -- data-view-photo sits on the
    // thumbnail button itself (see photosHtml() in render.js); the small
    // admin-only remove "✕" is a sibling, not a descendant, of that button,
    // so tapping it can never also open the viewer.
    var viewPhotoEl = el.closest("[data-view-photo]");
    if(viewPhotoEl){
      openPhotoViewer(viewPhotoEl.getAttribute("data-view-photo"), parseInt(viewPhotoEl.getAttribute("data-view-index"), 10) || 0);
      return;
    }
    if(el.closest("[data-photo-viewer-close]")){ closePhotoViewer(); return; }
    if(el.closest("[data-photo-viewer-prev]")){ photoViewerStep(-1); return; }
    if(el.closest("[data-photo-viewer-next]")){ photoViewerStep(1); return; }
    if(el.closest("[data-photo-viewer-zoom]")){ togglePhotoZoom(); return; }
    var downloadPhotosEl = el.closest("[data-download-photos]");
    if(downloadPhotosEl){
      var dpTruck = findTruck(downloadPhotosEl.getAttribute("data-download-photos"));
      if(dpTruck) downloadTruckPhotos(dpTruck.id, dpTruck.photos, dpTruck.truckLabel || dpTruck.poNo || dpTruck.ref || dpTruck.id, dpTruck.date, dpTruck.eta);
      return;
    }
    var cancelEl = el.closest("[data-cancel]");
    if(cancelEl){ cancelUnload(cancelEl.getAttribute("data-cancel")); return; }
    var reopenEl = el.closest("[data-reopen]");
    if(reopenEl){ reopenUnload(reopenEl.getAttribute("data-reopen")); return; }
    var delEl = el.closest("[data-delete]");
    if(delEl){ ui.confirmDelete = delEl.getAttribute("data-delete"); render(); return; }
    var delConfirmEl = el.closest("[data-delete-confirm]");
    if(delConfirmEl){ deleteTruck(delConfirmEl.getAttribute("data-delete-confirm")); return; }
    if(el.closest("[data-undo-delete]")){ undoDeleteTruck(); return; }
    var createEl = el.closest("[data-create]");
    if(createEl){ createTruck(); return; }
    var tabEl = el.closest("[data-tab]");
    if(tabEl){ ui.dayOffset = parseInt(tabEl.getAttribute("data-tab"), 10); render(); return; }
    var dayNavEl = el.closest("[data-day-nav]");
    if(dayNavEl){
      var delta = parseInt(dayNavEl.getAttribute("data-day-nav"), 10);
      var maxOffset = getMaxDayOffset();
      var next = ui.dayOffset + delta;
      ui.dayOffset = Math.max(-maxOffset, Math.min(maxOffset, next));
      render();
      return;
    }
    if(el.closest("[data-toggle-late-filter]")){
      ui.filterLateOnly = !ui.filterLateOnly;
      render();
      return;
    }
    if(el.closest("[data-toast-retry]")){
      var retry = ui.retryAction;
      ui.toast = null; ui.retryAction = null;
      render();
      if(retry) retry();
      return;
    }
  });

  // Round 23: attached to window, not `app` -- the photo viewer's own image
  // is deliberately clickable (tap-to-zoom) but isn't a focusable element,
  // and clicking a non-focusable element moves focus to <body> (outside
  // #app) in every browser tested. An `app`-scoped listener would then stop
  // seeing key presses the instant someone zoomed a photo, which defeats the
  // very desktop-keyboard use case the comment below is about. Every branch
  // already checks its own ui.xxx flag before acting, so listening on the
  // whole window is exactly as safe and never fires when it shouldn't.
  window.addEventListener("keydown", function(e){
    touchActivity();
    if(e.key === "Enter" && e.target && e.target.id === "pinInput"){ submitPin(); }
    // Photo viewer (Round 23) -- a manager reviewing photos on a desktop
    // (see Round 17.1: this app is also used from a Windows PC, not just a
    // phone) will reach for the keyboard before tapping tiny arrow buttons.
    if(ui.photoViewer){
      if(e.key === "Escape"){ closePhotoViewer(); }
      else if(e.key === "ArrowLeft"){ photoViewerStep(-1); }
      else if(e.key === "ArrowRight"){ photoViewerStep(1); }
    }
  });

  // Separate from the "change" listener below (which only fires on
  // blur/Enter for a text input) -- the search box needs to filter the list
  // on every keystroke, not just once focus leaves it. render() preserves
  // this input's focus/cursor position across the rebuild (see render.js),
  // which is what makes re-rendering on every character typed workable at
  // all given this app's whole-subtree render model.
  app.addEventListener("input", function(e){
    touchActivity();
    if(e.target && e.target.id === "searchInput"){
      ui.searchQuery = e.target.value;
      render();
    }
  });

  app.addEventListener("change", function(e){
    touchActivity();
    if(e.target && (e.target.id === "photoAddCameraInput" || e.target.id === "photoAddGalleryInput")){
      // input.files is a *live* FileList tied to the input's value: clearing
      // e.target.value below (needed so picking the same file twice in a row
      // still fires "change") empties this exact same object in place, not
      // just future reads of it. Snapshotting into a plain array first is
      // what makes the files survive that reset -- capturing the reference
      // alone is not enough, since it's the same underlying object.
      var files = Array.prototype.slice.call(e.target.files || []);
      var truckId = ui.pendingPhotoTruckId;
      e.target.value = "";
      ui.pendingPhotoTruckId = null;
      if(files.length && truckId) addPhotos(truckId, files);
    }
    if(e.target && e.target.id === "importFileInput"){
      var importFile = e.target.files && e.target.files[0];
      if(importFile) handleImportFile(importFile);
    }
    if(e.target && e.target.id === "import-from-date"){
      ui.importFromDate = e.target.value || ui.importFromDate;
    }
    // Round 27: carrier/plant filter dropdowns (see filterOptionsHtml() in
    // render.js) -- plain client-side re-filtering, same shape as the
    // existing "late only" toggle chip just above.
    if(e.target && e.target.id === "filterCarrierSelect"){
      ui.filterCarrier = e.target.value; render();
    }
    if(e.target && e.target.id === "filterPlantSelect"){
      ui.filterPlant = e.target.value; render();
    }
  });

  /* ---------- signature pad (Round 27) ---------- */
  // Deliberately three RAW pointer listeners on #app, not routed through the
  // click delegation above: drawing a signature is a continuous drag
  // (pointerdown -> many pointermove -> pointerup), and every stroke must
  // paint straight onto the canvas's own 2D context WITHOUT ever calling
  // render() -- render() rebuilds the entire #app subtree from a fresh HTML
  // string (see render.js), which would both wipe out whatever was drawn so
  // far and destroy/recreate the very <canvas> element mid-stroke. This is
  // safe from the periodic background refresh for the same reason the photo
  // viewer's keyboard shortcuts are: isInputSheetOpen() (js/ticking.js)
  // pauses ALL background rendering for as long as any truck sheet is open,
  // so nothing outside a deliberate user action (Clear/Save/Redo, all of
  // which the click handler above already guards) can call render() while
  // someone is mid-signature. Pointer Events (not separate mouse/touch
  // listeners) work uniformly across mouse, touch and pen with one code
  // path -- see css/app.css's `touch-action:none` on .signature-canvas,
  // which is what stops a finger-drag from also scrolling the sheet behind
  // it on a phone.
  var signatureDrawing = false;
  var signatureLastX = 0, signatureLastY = 0;
  function signaturePoint(e, canvas){
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  app.addEventListener("pointerdown", function(e){
    if(!e.target || e.target.id !== "signatureCanvas") return;
    touchActivity();
    var canvas = e.target;
    try{ canvas.setPointerCapture(e.pointerId); }catch(err){}
    var p = signaturePoint(e, canvas);
    signatureDrawing = true;
    signatureLastX = p.x; signatureLastY = p.y;
    var ctx = canvas.getContext("2d");
    // A dot for a single tap (no drag at all) -- otherwise a tap-only
    // signature would save a blank image.
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.2, 0, Math.PI*2);
    ctx.fillStyle = "#0E1826";
    ctx.fill();
  });
  app.addEventListener("pointermove", function(e){
    if(!signatureDrawing || !e.target || e.target.id !== "signatureCanvas") return;
    var canvas = e.target;
    var p = signaturePoint(e, canvas);
    var ctx = canvas.getContext("2d");
    ctx.strokeStyle = "#0E1826";
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(signatureLastX, signatureLastY);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    signatureLastX = p.x; signatureLastY = p.y;
  });
  function stopSignatureDrawing(){ signatureDrawing = false; }
  app.addEventListener("pointerup", stopSignatureDrawing);
  app.addEventListener("pointercancel", stopSignatureDrawing);
  app.addEventListener("pointerleave", stopSignatureDrawing);
}
/* "Clear" button -- wipes the canvas pixels directly (never through
   render(), same reasoning as the drawing itself above) so the drawing
   surface empties out without disturbing anything else on screen. */
function clearSignatureCanvas(){
  var canvas = document.getElementById("signatureCanvas");
  if(!canvas) return;
  var ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
