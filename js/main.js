/* ---------- entry point ----------
   Loaded from index.html as `<script type="module" src="js/main.js">`.
   Wires up event delegation, then either starts talking to Supabase or
   falls back to this browser's own saved copy, and starts the two
   timers (Supabase poll, 1s clock/tick) — exactly the same startup
   sequence as the original single-file app's bottom `<script>` block. */
import { replaceState, ui } from "./state.js";
import { supabaseEnabled, loadFromSupabase, loadAppSettings } from "./api.js";
import { loadLocalData } from "./storage.js";
import { render } from "./render.js";
import { tick, isInputSheetOpen } from "./ticking.js";
import { initEvents } from "./events.js";
import { SUPABASE_POLL_MS } from "./config.js";
import { flushOfflineQueue } from "./offlineQueue.js";

/* TV mode (Round 22): a fixed, read-only display for a screen mounted in
   the warehouse/office, closer to what MON's Outbound admin tool already
   has -- Theo asked for this right after seeing the Round 21 redesign
   deployed. Enabled purely by a URL flag (?tv=1) rather than any stored
   per-device setting, so the one browser permanently pointed at that
   screen just always opens this URL and every other device is completely
   unaffected. ui.roleGateOpen is forced closed here too -- belt and braces
   for isInputSheetOpen()'s periodic-refresh guard below, in case this
   happens to run in a browser profile that remembers an old role/PIN state
   (renderTv() in render.js never reads ui.role/ui.openId/etc. at all, so
   nothing admin-only can leak into what's actually shown either way). */
ui.tvMode = new URLSearchParams(window.location.search).get("tv") === "1";
if(ui.tvMode) ui.roleGateOpen = false;

// Round 33: SUPABASE_POLL_MS went from 15s to 120s (Theo's request -- 15s
// made the app re-render "under your thumb" too often). The automated test
// suite has several tests that specifically wait out real poll cycles
// (test_v2_refresh_guard.py, test_v2_scroll_preserve.py) -- at 120s each,
// those waits would balloon from ~1 minute total to several minutes, which
// is a real cost every time ISD or Theo runs the suite. Rather than slow
// every test run down, a `?pollMs=<n>` URL override (same pattern as ?tv=1
// above) lets those tests ask for a short interval explicitly; anyone just
// opening the app normally never adds this param, so production behavior
// (120s) is unaffected.
var pollMsOverride = parseInt(new URLSearchParams(window.location.search).get("pollMs"), 10);
var POLL_MS = (pollMsOverride > 0) ? pollMsOverride : SUPABASE_POLL_MS;

initEvents();

if(supabaseEnabled()){
  /* Supabase is the shared source of truth for truck data (and photos): load
     it now and keep polling it, skipping a refresh while someone has an input
     open (an ETA edit, the add form, PIN entry) so it doesn't get clobbered. */
  loadFromSupabase();
  // Shared admin-configurable thresholds (Round 23, js/settings.js) -- fetched
  // once now and again every poll below, same cadence as the trucks
  // themselves, so a change an Admin saves from one device shows up
  // everywhere else within one poll cycle.
  loadAppSettings();
  // Anything queued from a previous session that ended offline (phone
  // killed/locked with no signal) gets one attempt right away; flushOfflineQueue()
  // is a no-op if the queue is empty, so this costs nothing on the common path.
  flushOfflineQueue();
  // Seeds the visible refresh countdown (Round 21) so it shows a real value
  // from the very first render rather than a blank/placeholder for the
  // first cycle -- reset again every time the interval below actually fires.
  ui.nextPollAt = Date.now() + POLL_MS;
  // The 'online' event is the fast path back from a real connectivity drop,
  // but it isn't reliable on every mobile browser -- the periodic poll below
  // is the fallback net, checking again every POLL_MS regardless.
  window.addEventListener("online", flushOfflineQueue);
  setInterval(function(){
    // Reset unconditionally (even on a cycle skipped below because an input
    // sheet is open) -- the countdown represents "when this timer next
    // fires", not "when data was last actually refreshed", so it stays a
    // steady, predictable clock rather than pausing/jumping around whatever
    // else is open on screen.
    ui.nextPollAt = Date.now() + POLL_MS;
    if(!isInputSheetOpen()){ loadFromSupabase(); loadAppSettings(); flushOfflineQueue(); }
  }, POLL_MS);
  /* Also refresh right away when someone comes back to the app (phone woken
     up, tab switched back to) instead of waiting for the next poll tick —
     a driver reopening the app should see the latest state immediately. */
  var lastVisRefresh = 0;
  document.addEventListener("visibilitychange", function(){
    if(document.visibilityState !== "visible") return;
    if(isInputSheetOpen()) return;
    if(Date.now() - lastVisRefresh < 3000) return;
    lastVisRefresh = Date.now();
    loadFromSupabase();
  });
} else {
  /* Supabase isn't configured yet — hydrate from this browser's own saved
     copy, if any, so a page refresh doesn't wipe out what was entered. */
  var cachedAtStart = loadLocalData();
  if(cachedAtStart){ replaceState(cachedAtStart); }
}
render();
setInterval(tick, 1000);
