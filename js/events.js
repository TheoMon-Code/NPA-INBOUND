/* ---------- event delegation ----------
   One click/keydown/change listener each on #app, routing on the clicked
   element's data-* attribute. Matches the original single-file app exactly
   (same attributes, same order, same behavior) — just calling into the
   split-out modules instead of local closures. */
import { ui } from "./state.js";
import { render } from "./render.js";
import { saveLangLocal } from "./storage.js";
import {
  pickRole, submitPin, focusPin, savePin, saveName,
  openSheet, openAdd, closeSheet, saveEta, startUnload, finishUnload,
  cancelUnload, reopenUnload, deleteTruck, createTruck,
  addPhoto, removePhoto
} from "./actions.js";
import { openImportPlan, runImportPreview, runImportConfirm, handleImportFile } from "./importPlan.js";

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
    var startEl = el.closest("[data-start]");
    if(startEl){ startUnload(startEl.getAttribute("data-start")); return; }
    var finishEl = el.closest("[data-finish]");
    if(finishEl){ finishUnload(finishEl.getAttribute("data-finish")); return; }
    var photoAddEl = el.closest("[data-photo-add]");
    if(photoAddEl){
      ui.pendingPhotoTruckId = photoAddEl.getAttribute("data-photo-add");
      var input = document.getElementById("photoAddInput");
      if(input) input.click();
      return;
    }
    var photoRmEl = el.closest("[data-photo-remove]");
    if(photoRmEl){
      removePhoto(photoRmEl.getAttribute("data-photo-remove"), photoRmEl.getAttribute("data-photo-path"));
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
    var createEl = el.closest("[data-create]");
    if(createEl){ createTruck(); return; }
    var tabEl = el.closest("[data-tab]");
    if(tabEl){ ui.tab = tabEl.getAttribute("data-tab"); render(); return; }
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

  app.addEventListener("change", function(e){
    if(e.target && e.target.id === "photoAddInput"){
      var file = e.target.files && e.target.files[0];
      var truckId = ui.pendingPhotoTruckId;
      e.target.value = "";
      ui.pendingPhotoTruckId = null;
      if(file && truckId) addPhoto(truckId, file);
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
