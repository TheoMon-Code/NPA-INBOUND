/* ---------- ticking ----------
   A 1-second interval (started in main.js) that keeps the header clock and
   any open "unloading" live timer moving, and does a lightweight full
   re-render every ~15s so relative things (late minutes, elapsed time on
   cards not currently open) stay fresh — but never while an input sheet is
   open, so it can't wipe out something the admin/driver is mid-typing. */
import { state, ui, incrementTickCount } from "./state.js";
import { clockStr, fmtElapsed } from "./dateUtils.js";
import { render } from "./render.js";

export function isInputSheetOpen(){
  var truckInputOpen = ui.openId && ui.role === "admin" && (function(){
    var t = state.trucks.find(function(x){ return x.id === ui.openId; });
    return t && t.status !== "unloading" && t.status !== "done";
  })();
  // ui.pendingPhotoTruckId is set the instant the hidden file input is
  // clicked (see events.js) and only cleared once its native picker
  // returns a selection. That window can easily run past 15s — a camera
  // app in particular — and a render() in the meantime would replace the
  // whole #app subtree, orphaning that exact <input> element: the OS
  // picker still fires its "change" event on it, but the event can no
  // longer bubble up to the listener on #app (it's not attached to the
  // document anymore), so the picked photo silently never uploads. Treat a
  // pending pick like any other open input so it can't be wiped out.
  return !!(ui.addOpen || ui.pinSettingsOpen || ui.nameSettingsOpen || ui.importOpen || truckInputOpen ||
    ui.pendingPhotoTruckId ||
    (ui.roleGateOpen && ui.roleGateStep === "pin"));
}

export function tick(){
  var count = incrementTickCount();
  var clockEl = document.getElementById("clockEl");
  if(clockEl) clockEl.textContent = clockStr(new Date());
  var liveTimer = document.getElementById("liveTimer");
  if(liveTimer && ui.openId){
    var t = state.trucks.find(function(x){ return x.id === ui.openId; });
    if(t && t.status === "unloading"){
      liveTimer.textContent = fmtElapsed(new Date() - new Date(t.startedAt));
    }
  }
  if(!isInputSheetOpen() && count % 15 === 0){
    render();
  }
}
