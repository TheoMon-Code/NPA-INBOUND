import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
IMPORT_ROW_DATE = (date.today() + timedelta(days=1)).isoformat()

# Regression test for a real bug found on a real import (see README/project
# notes): with cellDates:true, SheetJS hands back a JS Date object for a bare
# time-of-day cell (Excel has no "time only" type -- it's anchored on Excel's
# pseudo-epoch, 1899-12-30). Built via the local multi-arg Date constructor,
# that Date resolves "Dec 30 1899, Bangkok" using Bangkok's historical LMT
# offset (+06:42:04, pre-1920) rather than the modern +07:00 -- so reading it
# back with UTC getters recovers a time shifted by the ~17m56s gap between
# those two offsets. A real 07:00 ETA silently became "00:17" on a real
# Bangkok-timezone machine, invisibly, since every test here runs in this
# sandbox's UTC timezone where the historical-LMT quirk doesn't exist.
#
# The fix: read with cellDates:false and parse the raw Excel serial by hand
# (pure arithmetic, via XLSX.SSF.parse_date_code -- no Date object, no
# timezone, ever). This test does two things a Bangkok-timezone machine
# would have caught immediately and this sandbox's UTC timezone never could:
# 1) asserts XLSX.read() is actually called with cellDates:false, so a
#    regression back to cellDates:true fails immediately regardless of what
#    timezone the suite happens to run in;
# 2) feeds raw numeric Excel serials (not JS Date objects, not pre-formatted
#    strings) for both the order-date and eta cells and checks the app
#    recovers the exact intended date/time from them via pure arithmetic.

READ_CALLS = []

# A stand-in for SheetJS's own SSF.parse_date_code (date serial ->
# {y,m,d,H,M,S}) -- pure arithmetic, no Date object involved for the actual
# app code this test drives (see importDateFromCell()/importTimeFromCell()),
# same as the real thing. This stub's own internals use Date.UTC()/getUTC*
# to turn the serial into a calendar date -- deliberately UTC-only, never
# local getters -- so building THIS STUB never risks reintroducing the exact
# Bangkok-LMT bug it exists to catch in the app; only importDateFromCell()/
# importTimeFromCell() in importPlan.js need to be timezone-safe, and they
# are, by never touching a Date object at all.
PARSE_DATE_CODE_JS = """
function(v){
  var date = Math.floor(v);
  var time = Math.round(86400 * (v - date));
  var ms = Date.UTC(1899, 11, 30) + date * 86400000;
  var d = new Date(ms);
  var out = { y: d.getUTCFullYear(), m: d.getUTCMonth()+1, d: d.getUTCDate() };
  out.H = Math.floor(time / 3600) % 24;
  time = time % 3600;
  out.M = Math.floor(time / 60);
  out.S = time % 60;
  return out;
}
"""

STUB_XLSX = ("""
window.__readCalls = [];
window.XLSX = {
  SSF: { parse_date_code: %s },
  read: function(data, opts){
    window.__readCalls.push(opts);
    return { SheetNames: ["RM PM incoming"], Sheets: { "RM PM incoming": {} } };
  },
  utils: {
    sheet_to_json: function(ws, opts){
      return [
        ["", "PO", "Supplier name", "ประเภทสินค้าหรืองานที่ขนส่ง", "จำนวนที่ขนส่ง", "หน่วย", "วันที่ขนส่ง", "เวลาเข้าโรงงาน", "โค้ดของที่มาส่ง", "remark"],
        // Raw Excel serials, exactly as a real .xlsx date/time-formatted
        // cell would arrive with cellDates:false -- 46274 = 2026-09-09,
        // 0.29166666666666669 = 07:00:00 (the real value from the real file
        // that triggered this bug; NOT a JS Date object, NOT a string).
        ["RM", "PO-90001", "Real Carrier Co", "Corn Wholegrain Bulk", 30000, "KG", 46274, 0.29166666666666669, "CODE-X", ""]
      ];
    }
  }
};
""" % PARSE_DATE_CODE_JS)

TRUCKS = []

async def handle_supabase(route, request):
    url = request.url
    if "/rest/v1/trucks" in url and request.method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        # Deliberately Asia/Bangkok -- the whole point is this bug only ever
        # showed up on a Bangkok-timezone machine. If cellDates ever regresses
        # back to true, this is what would make it visible again.
        page = await browser.new_page(viewport={"width":390,"height":800}, timezone_id="Asia/Bangkok")
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle_supabase)
        await page.add_init_script(STUB_XLSX)

        await page.goto(BASE)
        await page.wait_for_timeout(400)
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)

        await page.click("[data-open-import]")
        await page.wait_for_timeout(200)
        # Force a file onto the (otherwise real) file input so importPlan.js's
        # normal parseWorkbook()/parseWorkbookMainThread() path runs against
        # our stubbed window.XLSX above, exactly like a real .xlsx pick would.
        await page.evaluate("""() => {
          const input = document.getElementById('importFileInput');
          const file = new File([new Uint8Array([1,2,3])], 'plan.xlsx');
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }""")
        await page.wait_for_timeout(600)
        # "RM PM incoming" already matches handleImportFile()'s /incoming/i
        # auto-select rule (see importPlan.js), so it's pre-checked here --
        # nothing to toggle. Just push the from-date back so today's row
        # can't get filtered out as "past" by runImportPreview().
        if await page.locator("#import-from-date").count():
            await page.fill("#import-from-date", "2026-01-01")
        await page.click("[data-import-preview='1']")
        await page.wait_for_timeout(600)

        read_calls = await page.evaluate("window.__readCalls")
        print("XLSX.read() calls:", read_calls)
        assert len(read_calls) >= 1, "XLSX.read() was never called"
        assert read_calls[0].get("cellDates") is False, \
            "cellDates must be false -- see the comment in importPlan.js for why cellDates:true is unsafe here"

        preview_text = await page.text_content(".importpreview")
        print("preview text:", preview_text)
        assert "2026-09-09" in preview_text, "wrong date recovered from the raw serial"
        assert "07:00" in preview_text, "wrong time recovered from the raw serial -- got the Bangkok-LMT-shifted value instead of 07:00?"
        assert "00:17" not in preview_text, "the exact historical-timezone bug pattern is back"

        await browser.close()
        print("IMPORT TIME SERIAL TEST PASSED")

asyncio.run(main())
