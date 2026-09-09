/* ---------- event delegation ----------
   One click/keydown/change listener each on #app, routing on the clicked
   element's data-* attribute. Matches the original single-file app exactly
   (same attributes, same order, same behavior) — just calling into the
   split-out modules instead of local closures. */
import { ui } from "./state.js";
import { render } from "./render.js";
import { MAX_DAY_OFFSET } from "./config.js";
import { saveLangLocal } from "./storage.js";
import {
  pickRole, submitPin, focusPin, savePin, saveName,
  openSheet, openAdd, closeSheet, saveEta, startUnload, finishUnload,
  cancelUnload, reopenUnload, deleteTruck, undoDeleteTruck, createTruck,
  addPhotos, removePhoto, saveDamageRemark, findTruck
} from "./actions.js";
import { openImportPlan, runImportPreview, runImportConfirm, handleImportFile } from "./importPlan.js";
import { openReport, runReport, exportReportCsv } from "./reporting.js";
import { downloadTruckPhotos } from "./photoDownload.js";

export function initEvents(){
  var app = document.getElementById("app");

  app.addEventListener("click", function(e){
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
    if(el.closest("[data-open-pin-settings]")){
      ui.pinSettingsOpen = true; ui.pinSettingsError = null;
      ui.openId = null; ui.addOpen = false; render(); return;
    }
    if(el.closest("[data-open-name-settings]")){
      ui.nameSettingsOpen = true;
      ui.openId = null; ui.addOpen = false; render(); return;
    }
    if(el.closest("[data-open-import]")){ openImportPlan(); return; }
    if(el.closest("[data-open-report]")){ openReport(); return; }
    if(el.closest("[data-run-report]")){ runReport(); return; }
    if(el.closest("[data-export-report-csv]")){ exportReportCsv(); return; }
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
    var downloadPhotosEl = el.closest("[data-download-photos]");
    if(downloadPhotosEl){
      var dpTruck = findTruck(downloadPhotosEl.getAttribute("data-download-photos"));
      if(dpTruck) downloadTruckPhotos(dpTruck.id, dpTruck.photos, dpTruck.poNo || dpTruck.ref || dpTruck.id);
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
      var next = ui.dayOffset + delta;
      ui.dayOffset = Math.max(-MAX_DAY_OFFSET, Math.min(MAX_DAY_OFFSET, next));
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

  app.addEventListener("keydown", function(e){
    if(e.key === "Enter" && e.target && e.target.id === "pinInput"){ submitPin(); }
  });

  // Separate from the "change" listener below (which only fires on
  // blur/Enter for a text input) -- the search box needs to filter the list
  // on every keystroke, not just once focus leaves it. render() preserves
  // this input's focus/cursor position across the rebuild (see render.js),
  // which is what makes re-rendering on every character typed workable at
  // all given this app's whole-subtree render model.
  app.addEventListener("input", function(e){
    if(e.target && e.target.id === "searchInput"){
      ui.searchQuery = e.target.value;
      render();
    }
  });

  app.addEventListener("change", function(e){
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
  });
}
