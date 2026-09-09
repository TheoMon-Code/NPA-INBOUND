/* ---------- entry point ----------
   Loaded from index.html as `<script type="module" src="js/main.js">`.
   Wires up event delegation, then either starts talking to Supabase or
   falls back to this browser's own saved copy, and starts the two
   timers (Supabase poll, 1s clock/tick) — exactly the same startup
   sequence as the original single-file app's bottom `<script>` block. */
import { replaceState, ui } from "./state.js";
import { supabaseEnabled, loadFromSupabase } from "./api.js";
import { loadLocalData } from "./storage.js";
import { render } from "./render.js";
import { tick, isInputSheetOpen } from "./ticking.js";
import { initEvents } from "./events.js";
import { SUPABASE_POLL_MS } from "./config.js";
import { flushOfflineQueue } from "./offlineQueue.js";

initEvents();

if(supabaseEnabled()){
  /* Supabase is the shared source of truth for truck data (and photos): load
     it now and keep polling it, skipping a refresh while someone has an input
     open (an ETA edit, the add form, PIN entry) so it doesn't get clobbered. */
  loadFromSupabase();
  // Anything queued from a previous session that ended offline (phone
  // killed/locked with no signal) gets one attempt right away; flushOfflineQueue()
  // is a no-op if the queue is empty, so this costs nothing on the common path.
  flushOfflineQueue();
  // Seeds the visible refresh countdown (Round 21) so it shows a real value
  // from the very first render rather than a blank/placeholder for the
  // first 15s -- reset again every time the interval below actually fires.
  ui.nextPollAt = Date.now() + SUPABASE_POLL_MS;
  // The 'online' event is the fast path back from a real connectivity drop,
  // but it isn't reliable on every mobile browser -- the periodic poll below
  // is the fallback net, checking again every SUPABASE_POLL_MS regardless.
  window.addEventListener("online", flushOfflineQueue);
  setInterval(function(){
    // Reset unconditionally (even on a cycle skipped below because an input
    // sheet is open) -- the countdown represents "when this timer next
    // fires", not "when data was last actually refreshed", so it stays a
    // steady, predictable clock rather than pausing/jumping around whatever
    // else is open on screen.
    ui.nextPollAt = Date.now() + SUPABASE_POLL_MS;
    if(!isInputSheetOpen()){ loadFromSupabase(); flushOfflineQueue(); }
  }, SUPABASE_POLL_MS);
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
