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
// Some trucks genuinely need more than a handful of proof photos — this is
// the only place that number lives, so raising it later is a one-line change.
export const MAX_PHOTOS_PER_TRUCK = 20;

/* localStorage keys (all per-device, never synced anywhere) */
export const ROLE_KEY = "mon-inbound-role";
export const LANG_KEY = "mon-inbound-lang";
export const NAME_KEY = "mon-inbound-name";
export const DATA_KEY = "mon-inbound-data";

export const DAY_LABELS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
export const MONTH_LABELS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
export const DAY_LABELS_TH = ["วันอาทิตย์","วันจันทร์","วันอังคาร","วันพุธ","วันพฤหัสบดี","วันศุกร์","วันเสาร์"];
export const MONTH_LABELS_TH = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
