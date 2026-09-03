/* ---------- device helpers used by the photo feature ---------- */

export function buzz(ms){
  try{ if(navigator.vibrate) navigator.vibrate(ms || 25); }catch(e){}
}

/* Resizes/compresses a photo client-side (max dimension, JPEG quality)
   before it's uploaded, so a driver on a weak 4G connection isn't stuck
   sending a multi-megabyte original for a "proof it happened" shot. */
export function readAndCompressImage(file, maxDim, quality){
  return new Promise(function(resolve, reject){
    var reader = new FileReader();
    reader.onload = function(){
      var img = new Image();
      img.onload = function(){
        var w = img.width, h = img.height;
        var scale = Math.min(1, maxDim / Math.max(w, h));
        var cw = Math.max(1, Math.round(w*scale)), ch = Math.max(1, Math.round(h*scale));
        var canvas = document.createElement("canvas");
        canvas.width = cw; canvas.height = ch;
        canvas.getContext("2d").drawImage(img, 0, 0, cw, ch);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = function(){ reject(new Error("Could not read image")); };
      img.src = reader.result;
    };
    reader.onerror = function(){ reject(new Error("Could not read file")); };
    reader.readAsDataURL(file);
  });
}
