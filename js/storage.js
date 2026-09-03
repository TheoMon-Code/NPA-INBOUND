/* ---------- per-device local storage ----------
   Role, display language, remembered name, and (only when Supabase isn't
   configured) the trucks themselves — all kept in this browser's
   localStorage, never sent anywhere. Wrapped in try/catch throughout since
   localStorage can throw (private browsing, storage disabled by policy,
   etc.) and none of this is essential enough to crash the app over. */
import { ROLE_KEY, LANG_KEY, NAME_KEY, DATA_KEY } from "./config.js";

export function loadRole(){ try{ return localStorage.getItem(ROLE_KEY); }catch(e){ return null; } }
export function saveRoleLocal(r){ try{ localStorage.setItem(ROLE_KEY, r); }catch(e){} }

/* Most of the floor staff read Thai only, so Thai is the default; management
   can switch to English with the small EN/TH pill in the header. Not a
   login — purely a display choice, remembered per phone. */
export function loadLang(){ try{ return localStorage.getItem(LANG_KEY) || "th"; }catch(e){ return "th"; } }
export function saveLangLocal(l){ try{ localStorage.setItem(LANG_KEY, l); }catch(e){} }

/* Optional "who did this" field on start/finish — not a login, just saves
   retyping it every time. */
export function loadSavedName(){ try{ return localStorage.getItem(NAME_KEY) || ""; }catch(e){ return ""; } }
export function saveNameLocal(n){ try{ localStorage.setItem(NAME_KEY, n); }catch(e){} }

/* Standalone fallback for when Supabase isn't configured yet: truck data is
   kept in THIS browser's localStorage instead, purely so a page refresh
   doesn't lose it. Never consulted once Supabase is the source of truth. */
export function loadLocalData(){ try{ var raw = localStorage.getItem(DATA_KEY); return raw ? JSON.parse(raw) : null; }catch(e){ return null; } }
export function saveLocalData(s){ try{ localStorage.setItem(DATA_KEY, JSON.stringify(s)); }catch(e){} }
