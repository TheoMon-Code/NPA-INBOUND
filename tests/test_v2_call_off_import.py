import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
DATE1 = (date.today() + timedelta(days=1)).isoformat()
DATE2 = (date.today() + timedelta(days=2)).isoformat()

# Round 31: Khun Badeeson forwarded a new weekly "Call off" template for
# frozen goods ("2.CALL OFF FREOZEN 2026.xlsx") and asked that its "Call off"
# tab be importable the same way "RM PM incoming"/"Indirect incoming" are.
# That sheet has nothing in common with those two: English headers, no PO,
# no carrier column -- and its own identity for "one truck": Route + Trip +
# Delivery date + Time arrive @ Nestle, which the real file shows carrying
# several batch rows (sometimes several different products) per trip. See
# importGroupCallOffRows()/importExtractCallOffRows() in js/importPlan.js.
#
# This fixture covers, in one file:
#  - a trip with two batches on the same route/trip/date/time -> ONE truck,
#    both batches folded into its `lots` array (not two trucks -- Theo's
#    Round 30 fix for RM/PM does NOT apply here, confirmed against the real
#    data: several batches/products per trip is normal, not several trucks
#    that happen to share a timestamp)
#  - a same-day "AM > Mon" (return leg) row -> skipped entirely, only
#    "Mon > AM" (arriving at the plant) is tracked
#  - a second day with a single-batch trip -> still gets its own truck_label
#    (there's no PO to fall back to for a label)
STUB_XLSX = """
window.XLSX = {
  SSF: { parse_date_code: function(v){ return null; } },
  read: function(data, opts){
    return { SheetNames: ["Call off"], Sheets: { "Call off": {} } };
  },
  utils: {
    sheet_to_json: function(ws, opts){
      return [
        ["Week","Version","Route","Trip","Day","Delivery date","Time arrive @ Nestle","Mat Code ","Describtion ","Pallet size","Call off Q'TY ","Q'TY (Pllt)","Batch number ","Remark","Data Log","Complete","ใบเคลื่อนย้าย"],
        ["WK02", null, "Mon > AM", 1, "Mon", "%s", "08:00", 44406318, "Chicken Frame Frozen Nude Box 900Kgs", 900, 900, 1, "BATCH-A", "", false, false, null],
        ["WK02", null, "Mon > AM", 1, "Mon", "%s", "08:00", 44419442, "Tuna ByProduct Frozen  480kgs", 480, 1440, 3, "BATCH-B", "note here", false, false, null],
        ["WK02", null, "AM > Mon", 1, "Mon", "%s", "09:00", 44406318, "Chicken Frame Frozen Nude Box 900Kgs", 900, 900, 1, "BATCH-C", "", false, false, null],
        ["WK03", null, "Mon > AM", 1, "Tue", "%s", "07:00", 44398926, "Salmon ByProduct RespSourc Frozen 500kg ", 500, 500, 1, "BATCH-D", "", false, false, null]
      ];
    }
  }
};
""" % (DATE1, DATE1, DATE1, DATE2)

TRUCKS = []
NEXT_ID = [1]

async def handle_supabase(route, request):
    url = request.url
    method = request.method
    if "/rest/v1/trucks" in url and method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/trucks" in url and method == "POST":
        body = json.loads(request.post_data or "[]")
        rows = body if isinstance(body, list) else [body]
        created = []
        for r in rows:
            row = dict(r)
            row.setdefault("id", f"id-{NEXT_ID[0]}"); NEXT_ID[0] += 1
            row.setdefault("truck_state", "pending")
            row.setdefault("photos", [])
            TRUCKS.append(row)
            created.append(row)
        await route.fulfill(status=201, content_type="application/json", body=json.dumps(created))
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":390,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.add_init_script(STUB_XLSX)
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle_supabase)

        await page.goto(BASE)
        await page.wait_for_timeout(500)
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)

        await page.click("[data-open-import]")
        await page.wait_for_timeout(300)
        await page.set_input_files("#importFileInput", {
            "name": "2.CALL OFF FREOZEN  2026.xlsx",
            "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "buffer": b"stub-not-really-parsed-see-STUB_XLSX",
        })
        await page.wait_for_timeout(300)

        # the "Call off" sheet must be pre-checked automatically, same as an
        # "incoming" sheet -- confirm before even touching the date field
        checked = await page.is_checked("input[type=checkbox]")
        print("Call off sheet pre-checked:", checked)
        assert checked, "the Call off sheet should be pre-checked like an *incoming* sheet"

        await page.fill("#import-from-date", DATE1)
        await page.click("[data-import-preview]")
        await page.wait_for_timeout(300)

        preview_text = await page.text_content(".importpreview")
        print("preview text:", preview_text)
        assert "Mon > AM - Trip 1" in preview_text
        assert "2 ล็อต" in preview_text, "expected the 2-lots badge for the trip with two batches"
        assert "AM > Mon" not in preview_text, "the return leg must never appear as a truck"

        summary_text = await page.text_content(".hint")
        print("summary:", summary_text)

        await page.click("[data-import-confirm]")
        await page.wait_for_timeout(600)

        print("TRUCKS after import:", json.dumps(TRUCKS, indent=2, default=str))
        assert len(TRUCKS) == 2, "expected exactly 2 trucks: one per Mon > AM trip, the AM > Mon leg skipped"

        t1 = next(t for t in TRUCKS if t["order_date"] == DATE1)
        t2 = next(t for t in TRUCKS if t["order_date"] == DATE2)

        assert t1["carrier"] == "MON"
        assert t1["mat_type"] == "FZ"
        assert t1["truck_label"] == "Mon > AM - Trip 1"
        assert t1["po_no"] is None
        lots = t1.get("lots")
        assert lots and len(lots) == 2, "the two-batch trip must carry both batches in `lots`"
        assert lots[0]["details"] == "[FZ] Chicken Frame Frozen Nude Box 900Kgs"
        assert lots[0]["qtt"] == "900 KG (1 plt)"
        assert lots[0]["remark"] == "Batch BATCH-A"
        assert lots[1]["details"] == "[FZ] Tuna ByProduct Frozen 480kgs"
        assert lots[1]["qtt"] == "1440 KG (3 plt)"
        assert lots[1]["remark"] == "Batch BATCH-B — note here"
        # top-level fields mirror the first batch (same convention as the
        # old RM/PM lots feature)
        assert t1["details"] == "[FZ] Chicken Frame Frozen Nude Box 900Kgs"
        assert t1["qtt"] == "900 KG (1 plt)"
        assert t1["sku_no"] == "44406318"

        assert t2["carrier"] == "MON"
        assert t2["mat_type"] == "FZ"
        assert t2["truck_label"] == "Mon > AM - Trip 1"
        assert "lots" not in t2 or not t2.get("lots"), "a single-batch trip has no `lots` array"
        assert t2["details"] == "[FZ] Salmon ByProduct RespSourc Frozen 500kg"
        assert t2["qtt"] == "500 KG (1 plt)"

        # open the truck list: the FZ badge shows, and the two-lot truck's
        # card lists both batches in its "Lots on this truck" section
        await page.click("[data-tab='1']")
        await page.wait_for_timeout(300)
        list_text = await page.text_content(".list-cards")
        print("truck list text:", list_text)
        assert "FZ" in list_text
        assert "Mon > AM - Trip 1" in list_text

        await page.click(".card")
        await page.wait_for_timeout(300)
        sheet_text = await page.text_content(".sheet")
        print("sheet text:", sheet_text)
        assert "Chicken Frame" in sheet_text and "Tuna ByProduct" in sheet_text

        await browser.close()
        print("CALL OFF IMPORT TEST PASSED")

asyncio.run(main())
