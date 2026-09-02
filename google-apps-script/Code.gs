/**
 * MON Inbound — Google Sheets backend
 * ------------------------------------
 * Bridges the "MON Inbound" mobile app to the "NPA - INBOUND" tab of this
 * spreadsheet. Deploy this as a Web App (see instructions at the bottom of
 * this file) and paste the resulting URL into SHEETS_WEBAPP_URL near the
 * top of the app's index.html.
 *
 * What it does:
 *  - doGet   -> returns every row as JSON so the app can display them.
 *  - doPost  -> the app calls this when someone sets an ETA, starts
 *               unloading, finishes unloading, cancels a start, or reopens
 *               a finished load. It writes straight back into the matching
 *               row (matched by "Reference ID").
 *
 * The app never creates or deletes rows — only the existing columns
 * "LON/POS D/T", "Act Arrival D/T", "Act Dept D/T", "Dur. (Hr:Min)" and
 * "Truck State" are ever written to. Everything else in the sheet
 * (Cont No., Seal No., PO No., Details, etc.) is read-only context.
 *
 * Optional arrival/completion photos: if someone attaches a photo when
 * starting or finishing a truck, it's saved as a file in a Drive folder
 * called "MON Inbound Photos" (created automatically the first time it's
 * needed) and its link is written into two columns this script adds to the
 * sheet itself, also only the first time they're needed: "Start Photo URL"
 * and "Finish Photo URL". You don't need to add these columns by hand.
 *
 * Optional name of who started/finished a truck (typed once on the phone,
 * remembered there after) is written the same lazy way, into "Started By"
 * and "Finished By".
 *
 * Concurrency guard: before start/finish/cancelStart/reopen actually write,
 * doPost re-reads "Truck State" and refuses (with conflict:true) if it isn't
 * in the state that action expects — e.g. two phones tapping "Start" on the
 * same truck within the same second. The app treats conflict:true specially:
 * instead of retrying, it reloads the sheet to show the real current state.
 */

// ===== CONFIG =====
// This is a STANDALONE script (not bound to the spreadsheet via Extensions >
// Apps Script) — on purpose, so it can't collide with any other script
// already bound to this sheet (same project can only have one doGet/doPost).
// It reaches the sheet by ID instead.
//
// The spreadsheet id — the long id in the sheet's URL, right after /d/ and
// before /edit.
var SHEET_ID = '1UZYK6lUa9qzZGC7lcYSkQdIxWntgo05qhMzdThkHqkc';
// The tab id (gid) of "NPA - INBOUND" — taken from the sheet's URL
// (...#gid=802647500). If you ever duplicate/rename the tab, update this.
var SHEET_GID = 802647500;

// ===== Column lookup (by header name, so column order can change freely) =====
var COLS = [
  'Reference ID', 'Order Date', 'IM/EX/TR', 'Truck No.', 'Plant',
  'LON/POS D/T', 'Act Arrival D/T', 'Act Dept D/T', 'Dur. (Hr:Min)',
  'LOF Location', 'Truck State', 'OBD', 'Cont No.', 'Seal No.',
  'Cont Type', 'Closing Date', 'Remark', 'PO No.', 'QTT', 'SKU No.', 'Details'
];

function getSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === SHEET_GID) return sheets[i];
  }
  throw new Error('Tab with gid ' + SHEET_GID + ' not found. Update SHEET_GID in Code.gs.');
}

function getColIndex_(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var idx = {};
  COLS.forEach(function (name) {
    var i = headers.indexOf(name);
    if (i === -1) throw new Error('Column "' + name + '" not found in row 1. Check header spelling.');
    idx[name] = i;
  });
  return idx;
}

function doGet(e) {
  try {
    var sheet = getSheet_();
    var idx = getColIndex_(sheet);
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return jsonOut_({ trucks: [] });

    // These columns are optional and only exist once they've actually been
    // needed (see getOrCreateCol_ in doPost) — read them leniently so a
    // sheet that never received a photo or a name doesn't error out.
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var startPhotoCol = headers.indexOf('Start Photo URL');
    var finishPhotoCol = headers.indexOf('Finish Photo URL');
    var startedByCol = headers.indexOf('Started By');
    var finishedByCol = headers.indexOf('Finished By');

    var numRows = lastRow - 1;
    var numCols = sheet.getLastColumn();
    var values = sheet.getRange(2, 1, numRows, numCols).getValues();

    var trucks = [];
    for (var r = 0; r < values.length; r++) {
      var row = values[r];
      var ref = row[idx['Reference ID']];
      if (!ref) continue; // skip blank trailing rows

      trucks.push({
        id: String(ref),
        orderDate: fmtDate_(row[idx['Order Date']]),
        imExTr: row[idx['IM/EX/TR']] || '',
        carrier: row[idx['Truck No.']] || '',
        plant: row[idx['Plant']] || '',
        eta: fmtDateTime_(row[idx['LON/POS D/T']]),
        actualArrival: fmtDateTime_(row[idx['Act Arrival D/T']]),
        actualDeparture: fmtDateTime_(row[idx['Act Dept D/T']]),
        duration: row[idx['Dur. (Hr:Min)']] || '',
        lofLocation: row[idx['LOF Location']] || '',
        state: row[idx['Truck State']] || 'pending',
        obd: row[idx['OBD']] || '',
        contNo: row[idx['Cont No.']] || '',
        sealNo: row[idx['Seal No.']] || '',
        contType: row[idx['Cont Type']] || '',
        closingDate: fmtDate_(row[idx['Closing Date']]),
        remark: row[idx['Remark']] || '',
        poNo: row[idx['PO No.']] || '',
        qtt: row[idx['QTT']] || '',
        skuNo: row[idx['SKU No.']] || '',
        details: row[idx['Details']] || '',
        startPhotoUrl: startPhotoCol !== -1 ? (row[startPhotoCol] || '') : '',
        finishPhotoUrl: finishPhotoCol !== -1 ? (row[finishPhotoCol] || '') : '',
        startedBy: startedByCol !== -1 ? (row[startedByCol] || '') : '',
        finishedBy: finishedByCol !== -1 ? (row[finishedByCol] || '') : ''
      });
    }
    return jsonOut_({ trucks: trucks });
  } catch (err) {
    return jsonOut_({ error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var payload = JSON.parse(e.postData.contents);
    var sheet = getSheet_();
    var idx = getColIndex_(sheet);

    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return jsonOut_({ ok: false, error: 'Sheet is empty' });

    var refValues = sheet.getRange(2, idx['Reference ID'] + 1, lastRow - 1, 1).getValues();
    var targetRow = -1;
    for (var i = 0; i < refValues.length; i++) {
      if (String(refValues[i][0]) === String(payload.id)) { targetRow = 2 + i; break; }
    }
    if (targetRow === -1) return jsonOut_({ ok: false, error: 'Reference ID not found: ' + payload.id });

    var action = payload.action;

    // Concurrency guard: two phones acting on the same truck at nearly the
    // same time (double-tap, or two people at the dock) shouldn't silently
    // overwrite each other. Check the truck's current state right before
    // writing and refuse if it's not what this action expects — the app
    // then reloads the real state instead of retrying blindly.
    var stateCol = idx['Truck State'] + 1;
    var currentState = String(sheet.getRange(targetRow, stateCol).getValue() || 'pending');
    var CONFLICT = {
      start: { need: ['pending', ''], already: 'This truck was already started elsewhere.', code: 'already_started' },
      finish: {
        need: ['arrived'],
        already: currentState === 'completed' ? 'This truck was already finished elsewhere.' : 'This truck has not been started yet.',
        code: currentState === 'completed' ? 'already_finished' : 'not_started_yet'
      },
      cancelStart: { need: ['arrived'], already: 'This truck is no longer in the "started" state.', code: 'not_in_started_state' },
      reopen: { need: ['completed'], already: 'This truck is no longer in the "completed" state.', code: 'not_in_completed_state' }
    };
    // "error" is an English fallback message (e.g. for logs); the app
    // translates using "code" when it recognizes it, so the driver/admin
    // always sees this in whichever display language (EN/TH) they're using.
    if (CONFLICT[action] && CONFLICT[action].need.indexOf(currentState) === -1) {
      return jsonOut_({ ok: false, conflict: true, error: CONFLICT[action].already, code: CONFLICT[action].code });
    }

    if (action === 'setEta') {
      sheet.getRange(targetRow, idx['LON/POS D/T'] + 1).setValue(new Date(payload.etaIso));
    } else if (action === 'start') {
      sheet.getRange(targetRow, idx['Act Arrival D/T'] + 1).setValue(new Date(payload.timestampIso));
      sheet.getRange(targetRow, stateCol).setValue('arrived');
      if (payload.photoBase64) {
        var startUrl = savePhoto_(payload.id, 'start', payload.photoBase64);
        if (startUrl) {
          var startCol = getOrCreateCol_(sheet, 'Start Photo URL');
          sheet.getRange(targetRow, startCol).setValue(startUrl);
        }
      }
      if (payload.by) {
        var startedByCol = getOrCreateCol_(sheet, 'Started By');
        sheet.getRange(targetRow, startedByCol).setValue(String(payload.by));
      }
    } else if (action === 'finish') {
      sheet.getRange(targetRow, idx['Act Dept D/T'] + 1).setValue(new Date(payload.timestampIso));
      sheet.getRange(targetRow, stateCol).setValue('completed');
      if (payload.duration) sheet.getRange(targetRow, idx['Dur. (Hr:Min)'] + 1).setValue(payload.duration);
      if (payload.photoBase64) {
        var finishUrl = savePhoto_(payload.id, 'finish', payload.photoBase64);
        if (finishUrl) {
          var finishCol = getOrCreateCol_(sheet, 'Finish Photo URL');
          sheet.getRange(targetRow, finishCol).setValue(finishUrl);
        }
      }
      if (payload.by) {
        var finishedByCol = getOrCreateCol_(sheet, 'Finished By');
        sheet.getRange(targetRow, finishedByCol).setValue(String(payload.by));
      }
    } else if (action === 'cancelStart') {
      sheet.getRange(targetRow, idx['Act Arrival D/T'] + 1).clearContent();
      sheet.getRange(targetRow, stateCol).setValue('pending');
    } else if (action === 'reopen') {
      sheet.getRange(targetRow, idx['Act Dept D/T'] + 1).clearContent();
      sheet.getRange(targetRow, stateCol).setValue('arrived');
    } else {
      return jsonOut_({ ok: false, error: 'Unknown action: ' + action });
    }
    return jsonOut_({ ok: true });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ===== Arrival / completion photos =====
// Optional: the driver can attach a photo when starting or finishing a
// truck. Photos are stored as files in a Drive folder (created the first
// time it's needed) and only their link is written back into the sheet, in
// two columns this script adds itself the first time a photo comes in
// ("Start Photo URL" / "Finish Photo URL") — you never need to create them
// by hand, and sheets that never receive a photo never get them added.
var PHOTO_FOLDER_NAME = 'MON Inbound Photos';

function getPhotoFolder_() {
  var folders = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(PHOTO_FOLDER_NAME);
}

function savePhoto_(id, action, dataUrl) {
  var match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(dataUrl);
  if (!match) return '';
  var mime = match[1];
  var bytes = Utilities.base64Decode(match[2]);
  var ext = mime.indexOf('png') !== -1 ? 'png' : 'jpg';
  var blob = Utilities.newBlob(bytes, mime, id + '-' + action + '.' + ext);
  var file = getPhotoFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.google.com/uc?id=' + file.getId();
}

// Returns the 1-based column number for `name`, creating it at the end of
// the header row the first time it's needed. Used for the photo-URL columns
// and the optional "Started By" / "Finished By" columns.
function getOrCreateCol_(sheet, name) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var i = headers.indexOf(name);
  if (i !== -1) return i + 1;
  var newCol = lastCol + 1;
  sheet.getRange(1, newCol).setValue(name);
  return newCol;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function fmtDate_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v);
}
function fmtDateTime_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
  }
  return String(v);
}

/**
 * ===== HOW TO DEPLOY =====
 * This is a STANDALONE project — it is NOT pasted into the "Extensions >
 * Apps Script" editor of the Sheet, on purpose: if that sheet already has a
 * bound script (as this one does — "PP + SHIFT"), that project already has
 * its own doGet/doPost, and a project can only have one of each. Pasting
 * this file in there would silently break whatever that script already
 * does. Keeping this one standalone means it can never collide with it.
 *
 * 1. Go to https://script.google.com -> New project.
 * 2. Delete the placeholder code and paste this entire file in its place.
 * 3. Rename the project (top left, e.g. "MON Inbound bridge") — optional,
 *    just for clarity in your Drive.
 * 4. Click Deploy -> New deployment.
 * 5. Type: "Web app".
 * 6. Execute as: "Me".
 * 7. Who has access: "Anyone" (required — the app calls this anonymously;
 *    it does not expose anything beyond what doGet/doPost return above).
 * 8. Click Deploy, authorize the permissions Google asks for. The first
 *    time, Google shows an "unverified app" warning because this is your
 *    own script that hasn't been published — click "Advanced" then
 *    "Go to [project name] (unsafe)" to continue; it's safe, that warning
 *    just means the script hasn't gone through Google's public-app review
 *    (irrelevant for a script only you deployed for your own sheet).
 * 9. Copy the "Web app URL" it gives you (ends in /exec).
 * 10. Paste that URL into SHEETS_WEBAPP_URL near the top of index.html,
 *     then redeploy the site on Netlify.
 *
 * Note: the account you use in step 1-4 needs at least edit access to the
 * "NPA - INBOUND" spreadsheet (SHEET_ID above) — use the same Google
 * account that already has access to it.
 *
 * If you rename or restructure columns later, only the COLS list and
 * SHEET_GID above ever need to change — nothing else in this file
 * hardcodes a column position. If the sheet itself is ever copied to a new
 * spreadsheet, update SHEET_ID too.
 */
