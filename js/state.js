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
import { loadRole, loadLang } from "./storage.js";
import { todayKey } from "./dateUtils.js";
import { supabaseEnabled } from "./api.js";

const DEFAULT_STATE = { seq: 10, trucks: [], adminCode: "1234" };

const dataEl = document.getElementById("app-data");
const initialState = dataEl ? JSON.parse(dataEl.textContent) : DEFAULT_STATE;
if(initialState.adminCode == null) initialState.adminCode = "1234";

export const state = initialState;

export function replaceState(newState){
  if(!newState) return;
  Object.keys(state).forEach(function(k){ delete state[k]; });
  Object.keys(newState).forEach(function(k){ state[k] = newState[k]; });
}

export const ui = {
  tab: "today",
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
  importBusy: false,
  importError: null,
  importResult: null
};
ui.roleGateOpen = !ui.role;

export let tickCount = 0;
export function incrementTickCount(){ tickCount++; return tickCount; }
