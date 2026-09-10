/* ---------- shared app state ----------
   `state` (the trucks + admin PIN — persisted, either in Supabase or in
   this browser's localStorage) and `ui` (everything about what's on screen
   right now — never persisted) are the two mutable singletons every other
   module reads and writes. They are plain objects, imported by reference,
   so any module can do `ui.tab = "today"` and every other module sees it —
   exactly like the original single-file app's shared closure variables.

   The one thing a plain `export let` can't do across modules is a full
   *reassignment* of `state` itself (e.g. hydrating from localStorage on
   startup) — importers would keep pointing at the old object. `replaceState`
   below is the one place that happens, so it copies the new data onto the
   existing object instead of swapping the reference. */
import { loadRole, loadLang, loadSavedPlant } from "./storage.js";
import { todayKey, addDays } from "./dateUtils.js";
import { supabaseEnabled } from "./api.js";

const DEFAULT_STATE = { seq: 10, trucks: [], adminCode: "748231" };

const dataEl = document.getElementById("app-data");
const initialState = dataEl ? JSON.parse(dataEl.textContent) : DEFAULT_STATE;
if(initialState.adminCode == null) initialState.adminCode = "748231";

export const state = initialState;

export function replaceState(newState){
  if(!newState) return;
  Object.keys(state).forEach(function(k){ delete state[k]; });
  Object.keys(newState).forEach(function(k){ state[k] = newState[k]; });
}

export const ui = {
  // Which day is shown in the truck list (Admin only -- driver is always
  // pinned to "today", see effectiveDayOffset() in render.js), as an offset
  // in days from today: 0=today, -1=yesterday, +1=tomorrow. The three quick
  // tabs jump straight to -1/0/+1; the "-5"/"+5" nav arrows (Round 13, Theo's
  // request) shift by 5 days at a time, clamped to [-5, +5] overall.
  dayOffset: 0,
  openId: null,
  addOpen: false,
  addDefaultDate: null,
  confirmDelete: null,
  toast: null,
  role: loadRole(),
  roleGateOpen: false,
  roleGateStep: "choose",
  roleGateError: null,
  pinSettingsOpen: false,
  pinSettingsError: null,
  nameSettingsOpen: false,
  pendingPhotoTruckId: null,
  retryAction: null,
  lang: loadLang(),
  syncStatus: supabaseEnabled() ? "connecting" : "local",
  importOpen: false,
  importStep: "pick",
  importSelected: {},
  importFromDate: todayKey(),
  // Which site/plant new imported trucks get tagged with -- used to be
  // hard-coded to "AMATA" (Round 6); now editable on the import screen and
  // remembered per device (see storage.js) so another MON site can be
  // imported for without a code change.
  importPlant: loadSavedPlant(),
  importBusy: false,
  importError: null,
  importResult: null,
  // Admin reporting screen (Round 16) -- KPIs over a manager-picked date
  // range, separate from the day-by-day live view above.
  reportOpen: false,
  reportFrom: addDays(todayKey(), -6),
  reportTo: todayKey(),
  reportBusy: false,
  reportError: null,
  reportData: null,
  // Raw rows behind the last report run (Round 17), kept alongside the
  // aggregated reportData above purely so "Export CSV" has something to
  // write out without a second Supabase round trip.
  reportRows: null,
  // Quick list-level search (PO/reference/carrier/plant, case-insensitive)
  // and a one-tap "late only" filter (Round 17) -- both purely client-side,
  // filtering what's already loaded rather than re-querying Supabase; empty
  // by default so they never change what's shown until someone uses them.
  searchQuery: "",
  filterLateOnly: false,
  // Set for the few seconds between tapping "Delete" (after the existing
  // confirm step) and the deletion actually being sent -- see deleteTruck()
  // in actions.js. The truck is hidden from the list/KPIs immediately but
  // isn't actually gone yet, so an accidental delete (or a change of mind)
  // can still be undone.
  pendingDeleteId: null,
  pendingDeleteLabel: null,
  // Timestamp (ms) of the next scheduled Supabase poll (see main.js's
  // setInterval), shown as a live countdown next to the sync dot (Round 21
  // -- a manager compared this app to MON's Outbound admin tool, which
  // shows its own auto-refresh countdown). Updated directly by tick() every
  // second (js/ticking.js), the same lightweight pattern already used for
  // the header clock and an open truck's live "unloading" timer, rather
  // than through a full render() -- a full render every single second would
  // reintroduce the "violent refresh" problem fixed in Round 11. Stays null
  // (and the countdown simply isn't shown) in local-only mode, where there's
  // no poll to count down to.
  nextPollAt: null,
  // TV mode (Round 22): a fixed, read-only display for a screen mounted in
  // the warehouse/office (Theo, after seeing the Round 21 redesign: "Faudra
  // que tu mettes in mode TV") -- no role gate, no PIN, no search/filters/
  // KPI tiles/"+" button, nothing clickable, just today's trucks in a big
  // table that refreshes on the same 15s poll as everything else. Set once
  // in main.js from the URL (?tv=1), never persisted and never toggled from
  // within the app itself -- the one device permanently pointed at the
  // screen just always loads that URL. See renderTv() in render.js, which
  // is a completely separate render path from the normal admin/driver one
  // below (so nothing admin-only can ever leak onto a public screen through
  // a shared code path, and this stays unaffected by future changes there).
  tvMode: false,
  // Round 23: which page of today's trucks the TV board is currently showing
  // (0-based), advanced automatically by tvTick() in render.js every
  // TV_ROTATE_MS (js/config.js) so a busy day's full list is still readable
  // instead of running off the bottom of an unwatched screen. Meaningless
  // outside TV mode.
  tvPage: 0,
  // Fullscreen photo viewer (Round 23) — replaces the old "open the raw URL
  // in a new tab" behaviour with an in-app overlay that can step through a
  // truck's other photos and zoom in, without ever leaving the app. null
  // when closed; {truckId, index, zoomed} while a photo is open. See
  // photoViewerHtml() in render.js and the openPhotoViewer()/etc. actions.
  photoViewer: null,
  // Admin settings screen (Round 23) — lets an Admin adjust the operational
  // thresholds in js/settings.js (grace period, photo cap, day-nav range,
  // "due soon" window, undo-delete window) from inside the app instead of
  // editing js/config.js. Same open/error/busy shape as the other admin
  // sheets (pinSettingsOpen, importOpen, ...) above.
  settingsOpen: false,
  settingsError: null,
  settingsBusy: false
};
ui.roleGateOpen = !ui.role;

export let tickCount = 0;
export function incrementTickCount(){ tickCount++; return tickCount; }
