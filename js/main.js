/* ---------- entry point ----------
   Loaded from index.html as `<script type="module" src="js/main.js">`.
   Wires up event delegation, then either starts talking to Supabase or
   falls back to this browser's own saved copy, and starts the two
   timers (Supabase poll, 1s clock/tick) — exactly the same startup
   sequence as the original single-file app's bottom `<script>` block. */
import { replaceState } from "./state.js";
import { supabaseEnabled, loadFromSupabase } from "./api.js";
import { loadLocalData } from "./storage.js";
import { render } from "./render.js";
import { tick, isInputSheetOpen } from "./ticking.js";
import { initEvents } from "./events.js";
import { SUPABASE_POLL_MS } from "./config.js";

initEvents();

if(supabaseEnabled()){
  /* Supabase is the shared source of truth for truck data (and photos): load
     it now and keep polling it, skipping a refresh while someone has an input
     open (an ETA edit, the add form, PIN entry) so it doesn't get clobbered. */
  loadFromSupabase();
  setInterval(function(){
    if(!isInputSheetOpen()) loadFromSupabase();
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
