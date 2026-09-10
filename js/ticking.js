/* ---------- ticking ----------
   A 1-second interval (started in main.js) that keeps the header clock and
   any open "unloading" live timer moving, and does a lightweight full
   re-render every ~15s so relative things (late minutes, elapsed time on
   cards not currently open) stay fresh — but never while an input sheet is
   open, so it can't wipe out something the admin/driver is mid-typing. */
import { state, ui, incrementTickCount, lastActivityAt } from "./state.js";
import { clockStr, fmtElapsed } from "./dateUtils.js";
import { render, tvTick } from "./render.js";
import { logout } from "./actions.js";
import { INACTIVITY_LOGOUT_MS } from "./config.js";

export function isInputSheetOpen(){
  // Any open truck sheet — regardless of role or the truck's current status
  // — pauses the periodic background refresh. This used to be narrower
  // (admin only, and only while the truck was still editable), on the
  // theory that a "done"/"unloading" sheet has nothing left that a refresh
  // could overwrite. But a full re-render (see render.js — no framework, no
  // diffing, the whole #app subtree is rebuilt) is disruptive to *read*,
  // not just to edit: it collapses any open <details> ("Lots on this
  // truck", "All imported fields") back shut and can reset scroll position
  // inside the sheet — reported as the refresh feeling "too violent" mid-
  // read. Pausing for any open sheet and letting the next poll/tick catch
  // up the instant it's closed is simpler and safer than trying to guess
  // which sheets are still "safe" to disrupt.
  var truckSheetOpen = !!ui.openId;
  // ui.pendingPhotoTruckId is set the instant the hidden file input is
  // clicked (see events.js) and only cleared once its native picker
  // returns a selection. That window can easily run past 15s — a camera
  // app in particular — and a render() in the meantime would replace the
  // whole #app subtree, orphaning that exact <input> element: the OS
  // picker still fires its "change" event on it, but the event can no
  // longer bubble up to the listener on #app (it's not attached to the
  // document anymore), so the picked photo silently never uploads. Treat a
  // pending pick like any other open input so it can't be wiped out.
  // Round 25: three PIN sub-screens now share this pause condition (typing
  // a PIN for any of Admin MON / Admin MON IT / Nestlé, not just "pin").
  return !!(ui.addOpen || ui.pinSettingsOpen || ui.nameSettingsOpen || ui.importOpen || truckSheetOpen ||
    ui.pendingPhotoTruckId ||
    (ui.roleGateOpen && (ui.roleGateStep === "pin" || ui.roleGateStep === "pin_it" || ui.roleGateStep === "pin_nestle")));
}

export function tick(){
  // Round 25 follow-up: auto-logout after INACTIVITY_LOGOUT_MS (config.js,
  // 30 minutes) with no click/keydown/input anywhere in the app -- see
  // touchActivity() in state.js (called from every listener in events.js).
  // Checked every tick (every second) rather than with its own setTimeout so
  // it self-corrects immediately if the device's clock or the tab's
  // background-throttling makes ticks land late, instead of drifting.
  // Guarded on ui.role so this is a no-op for a device that hasn't picked a
  // role yet (nothing to log out of) and for TV mode (which never sets
  // ui.role at all -- see main.js). logout() itself clears ui.role, so this
  // can't re-fire on the next tick once it's already happened.
  if(ui.role && (Date.now() - lastActivityAt) >= INACTIVITY_LOGOUT_MS){
    logout();
    return;
  }
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
  // Visible "next refresh" countdown (Round 21), updated directly every
  // second like the two timers above -- deliberately NOT routed through the
  // once-every-15-ticks render() below, which would make the countdown
  // itself the thing forcing a full re-render every second (undoing the
  // whole reason Round 11 moved to a periodic-only refresh in the first
  // place). ui.nextPollAt is null in local-only mode (see main.js), so the
  // element (rendered only when Supabase is enabled, see render.js) is
  // simply absent and this is a no-op.
  var pollEl = document.getElementById("pollCountdownEl");
  if(pollEl && ui.nextPollAt != null){
    pollEl.textContent = fmtElapsed(ui.nextPollAt - Date.now());
  }
  // TV board page rotation (Round 23) -- a no-op outside TV mode, and a
  // no-op whenever today's trucks all fit on one page, so this costs nothing
  // on every other screen/day. See tvTick() in render.js.
  tvTick(Date.now());
  if(!isInputSheetOpen() && count % 15 === 0){
    render();
  }
}
