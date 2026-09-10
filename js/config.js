/* ---------- config ----------
   All the values someone from ISD is likely to need to change live at the
   top of one small file: the Supabase project to talk to, how often to poll
   it, the grace period before a truck counts as "late", and the
   localStorage keys/calendar labels used across the app.

   Fill SUPABASE_URL/SUPABASE_ANON_KEY in once the Supabase project is ready
   (see supabase-schema.sql and the README for the exact steps). Leave them
   empty to keep using this browser's local storage as a fallback while the
   project is being set up. */
export const SUPABASE_URL = "https://wezkonqnlkmkthbfimai.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndlemtvbnFubGtta3RoYmZpbWFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwNjc2MjEsImV4cCI6MjA5ODY0MzYyMX0.BmijFqbAo8SICix5dTyYIQl9gSJplmEV4fMTNNABgYo";
export const SUPABASE_BUCKET = "inbound-photos";
export const SUPABASE_POLL_MS = 15000;
export const GRACE_MIN = 20;
// A truck still "scheduled" (not late, not started) whose ETA falls within
// this many minutes is flagged with a small "coming up soon" cue on its
// card -- a heads-up before it tips over into "late", rather than only
// finding out after the fact. Purely a visual nudge: it doesn't change the
// truck's actual derived status, KPI counts, or sort order (see
// isDueSoon() in js/status.js).
export const DUE_SOON_MIN = 15;
// How long an Admin has to tap "Undo" after deleting a truck before the
// deletion is actually sent (Supabase or local storage) -- see deleteTruck()
// in js/actions.js. A plain safety net against a mis-tap or a second thought,
// not meant to be a long grace period.
export const UNDO_DELETE_MS = 5000;
// Some trucks genuinely need more than a handful of proof photos — this is
// the only place that number lives, so raising it later is a one-line change.
export const MAX_PHOTOS_PER_TRUCK = 40;
// How far the Admin day-nav arrows ("◀"/"▶", one day per click) can go from
// today, in either direction (Round 13/15, Theo's request). The 3 quick tabs
// (yesterday/today/tomorrow) always work regardless of this.
export const MAX_DAY_OFFSET = 5;
// TV mode (Round 22) shows every one of today's trucks in a single table with
// nothing clickable and no scrollbar anyone will ever use — fine on a quiet
// day, but a busy one (30-40 trucks) would just run off the bottom of a
// screen nobody is there to scroll. Round 23: rotate through fixed-size pages
// automatically instead, like a real airport departures board, rather than
// try to shrink everything to fit (which would fight the whole point of a
// board meant to be read from across the room).
export const TV_ROWS_PER_PAGE = 10;
export const TV_ROTATE_MS = 8000;
// Round 25 follow-up: auto-logout after this long with no click/keydown/
// input anywhere in the app (see js/state.js's touchActivity() and the check
// in js/ticking.js's tick()) -- applies to every role (Admin MON, Admin MON
// IT, Nestlé, Driver) alike. A manual "🚪" logout button (render.js/
// events.js/actions.js's logout()) works regardless of this timer, for
// anyone who wants to log out immediately rather than wait it out.
export const INACTIVITY_LOGOUT_MS = 30 * 60 * 1000;

/* localStorage keys (all per-device, never synced anywhere) */
export const ROLE_KEY = "mon-inbound-role";
export const LANG_KEY = "mon-inbound-lang";
export const NAME_KEY = "mon-inbound-name";
export const DATA_KEY = "mon-inbound-data";
export const PLANT_KEY = "mon-inbound-import-plant";
// A phone that loses signal mid-warehouse shouldn't lose the action itself
// (Start/Finish, ETA, a damage remark, add/delete truck) -- see
// js/offlineQueue.js. Kept in localStorage (not just memory) so it survives
// the phone locking or the browser being killed in the background, both
// routine on a phone used on a factory floor all day.
export const OFFLINE_QUEUE_KEY = "mon-inbound-offline-queue";
// The import screen used to hard-code plant="AMATA" for every imported
// truck, which was fine while AMATA was the only site anyone imported for.
// It's now an editable field (remembered per device, like the admin's PIN or
// display language) so the app can cover another MON site later without
// touching code — this is just what a blank/never-used device falls back to.
export const DEFAULT_PLANT = "AMATA";

export const DAY_LABELS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
export const MONTH_LABELS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
export const DAY_LABELS_TH = ["วันอาทิตย์","วันจันทร์","วันอังคาร","วันพุธ","วันพฤหัสบดี","วันศุกร์","วันเสาร์"];
export const MONTH_LABELS_TH = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
