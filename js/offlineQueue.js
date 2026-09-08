/* ---------- offline action queue ----------
   A phone on the warehouse floor can lose signal mid-action -- Start/Finish,
   an ETA edit, a damage remark, adding or deleting a truck. Before this, a
   network failure on any of those just showed a "couldn't save, tap to
   retry" toast (still true for a real server error, e.g. a validation
   problem or a missing column) -- but for a genuine "no network at all"
   failure, that meant the action was silently lost the moment the person
   moved on, unless they noticed the toast and manually retried before it
   disappeared.

   Now: when sbRest() can't reach the network at all (tagged `networkFailure`
   on the error -- see api.js), the action's *inputs* (not a live promise --
   a plain JSON-serializable description of what to redo) are queued to
   localStorage instead, so it survives the phone locking, the tab being
   backgrounded, or even the browser being killed and reopened later.
   flushQueue() below replays them, in order, once the network is back.

   Deliberately scoped to the trucks-table mutations that go through
   sbRest/sbPatchTruckConditional/sbCreateTruck/sbDeleteTruck (all
   JSON-body PostgREST calls) -- NOT photo uploads, which post a binary blob
   straight to Supabase Storage (see sbUploadPhoto in api.js). Queuing a
   multi-megabyte photo blob in localStorage risks blowing the browser's
   storage quota outright (a phone might have several pending), so photo
   uploads keep today's existing "failed, tap to retry" behavior instead --
   a known, deliberate limitation, see the README. */
import { loadOfflineQueue, saveOfflineQueue } from "./storage.js";
import { sbRest, sbPatchTruckConditional, sbCreateTruck, sbDeleteTruck, loadFromSupabase } from "./api.js";
import { render } from "./render.js";
import { tr } from "./i18n.js";
import { showToast } from "./actions.js";

// In-memory mirror of the same array persisted in localStorage -- avoids
// re-parsing JSON on every render() just to show the "N pending" count, and
// is always kept in sync (every mutation below immediately persists it too).
var queue = loadOfflineQueue();
var flushing = false;

export function offlineQueueCount(){ return queue.length; }

export function enqueueOfflineAction(descriptor){
  queue.push({ descriptor: descriptor, createdAt: Date.now() });
  saveOfflineQueue(queue);
}

/* Replays one descriptor exactly the way its original action would have
   called Supabase -- reusing sbPatchTruckConditional/sbCreateTruck/
   sbDeleteTruck/sbRest as-is, so all the existing conflict-detection and
   payload logic applies identically to a queued replay as to a live call. */
function replayOne(item){
  var d = item.descriptor;
  if(d.kind === "patchConditional"){
    return sbPatchTruckConditional(d.id, d.fromState, d.patch);
  }
  if(d.kind === "patchPlain"){
    return sbRest("trucks?id=eq."+encodeURIComponent(d.id), { method:"PATCH", headers:{"Prefer":"return=representation"}, body: d.patch });
  }
  if(d.kind === "createTruck"){
    return sbCreateTruck(d.fields);
  }
  if(d.kind === "deleteTruck"){
    return sbDeleteTruck(d.id);
  }
  return Promise.reject(new Error("unknown queued action kind: "+d.kind));
}

/* Processes the queue strictly in order, one item at a time (order matters
   -- e.g. a queued Start must replay before a queued Finish for the same
   truck). Stops the moment an item still can't reach the network, leaving
   it and everything after it queued for the next attempt. A conflict (the
   conditional PATCH matched zero rows -- someone else already changed this
   truck in the meantime) or any other non-network error is NOT worth
   retrying forever with the same payload, so that one item is dropped and
   the rest continue. */
export function flushOfflineQueue(){
  if(flushing || !queue.length) return Promise.resolve();
  flushing = true;
  var sentCount = 0;
  function next(){
    if(!queue.length) return Promise.resolve();
    var item = queue[0];
    return replayOne(item).then(function(){
      queue.shift(); saveOfflineQueue(queue); sentCount++;
      return next();
    }).catch(function(err){
      if(err && err.networkFailure){
        return; // still offline -- stop here, item stays queued for next time
      }
      // conflict, or some other server-side rejection: this exact payload
      // isn't going to succeed by retrying again, so drop it and move on
      // rather than blocking every later queued action behind it forever.
      queue.shift(); saveOfflineQueue(queue);
      return next();
    });
  }
  return next().then(function(){
    flushing = false;
    if(sentCount > 0){
      return loadFromSupabase().then(function(){
        render();
        showToast(tr("offlineQueueFlushed").replace("{n}", sentCount));
      });
    }
    render();
  }).catch(function(){ flushing = false; render(); });
}
