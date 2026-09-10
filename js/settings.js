/* ---------- admin-configurable operational settings (Round 23) ----------
   Theo, right after Round 22's TV mode: an Admin screen to adjust these five
   thresholds without a code change each time (first raised, and left aside,
   at Round 17). These aren't a per-device preference like the display
   language or the remembered import plant (js/storage.js) — they change what
   EVERY phone/screen calls "late" or "coming up soon", so keeping them only
   in this browser's localStorage would let two admins on two phones disagree
   about whether a given truck is actually late. Kept in Supabase instead (one
   shared `app_settings` row, id=1 — see supabase-schema.sql), fetched
   alongside the regular truck poll (js/api.js/main.js) so every device picks
   up a change within one poll cycle, same as a truck edit would.

   Graceful degradation follows the exact pattern already used for
   trucks.raw/lots/damage_remark (Rounds 7/10/13): `overrides` starts empty,
   every getter below falls back to the same hard-coded config.js default
   that shipped before this round, and a Supabase project that hasn't run the
   new SQL yet (missing table, missing row) just keeps using those defaults
   forever, silently — nothing else in the app needs to know the difference. */
import { GRACE_MIN, MAX_PHOTOS_PER_TRUCK, MAX_DAY_OFFSET, DUE_SOON_MIN, UNDO_DELETE_MS } from "./config.js";

var overrides = {};

export function setSettingsOverrides(obj){
  overrides = (obj && typeof obj === "object") ? obj : {};
}
export function getSettingsOverrides(){ return overrides; }

function get(key, def){
  var v = overrides[key];
  return (typeof v === "number" && isFinite(v)) ? v : def;
}
export function getGraceMin(){ return get("graceMin", GRACE_MIN); }
export function getMaxPhotosPerTruck(){ return get("maxPhotosPerTruck", MAX_PHOTOS_PER_TRUCK); }
export function getMaxDayOffset(){ return get("maxDayOffset", MAX_DAY_OFFSET); }
export function getDueSoonMin(){ return get("dueSoonMin", DUE_SOON_MIN); }
export function getUndoDeleteMs(){ return get("undoDeleteMs", UNDO_DELETE_MS); }

/* Drives both the settings screen's form (js/render.js) and its save logic
   (js/actions.js) from one list rather than five hand-written near-duplicate
   blocks — adding a 6th adjustable setting later means adding one entry here
   (plus its two i18n strings), nothing else. `min`/`max`/the value shown in
   the input are all in DISPLAY units; `divisor` converts to/from the actual
   stored unit (only undoDeleteMs differs — seconds on screen, milliseconds
   in code and in Supabase, since nobody thinks in milliseconds). */
export var SETTINGS_DEFS = [
  { key:"graceMin", min:0, max:180, divisor:1, labelKey:"settingGraceMin", hintKey:"settingGraceMinHint", get:getGraceMin },
  { key:"maxPhotosPerTruck", min:1, max:200, divisor:1, labelKey:"settingMaxPhotos", hintKey:"settingMaxPhotosHint", get:getMaxPhotosPerTruck },
  { key:"maxDayOffset", min:1, max:60, divisor:1, labelKey:"settingMaxDayOffset", hintKey:"settingMaxDayOffsetHint", get:getMaxDayOffset },
  { key:"dueSoonMin", min:0, max:180, divisor:1, labelKey:"settingDueSoonMin", hintKey:"settingDueSoonMinHint", get:getDueSoonMin },
  { key:"undoDeleteMs", min:1, max:60, divisor:1000, labelKey:"settingUndoDeleteSec", hintKey:"settingUndoDeleteSecHint", get:getUndoDeleteMs }
];
