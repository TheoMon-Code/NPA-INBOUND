import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"

IMPORT_ROW_DATE = (date.today() + timedelta(days=1)).isoformat()

# Two rows sharing the exact same PO + date + time + carrier -- exactly the
# real-world pattern found in MON's own "Incoming plan AMATA" file (same PO,
# same delivery slot, different line-item number / product / qty). Before
# the lot-grouping fix, the second row here would have been silently
# dropped as a "duplicate" at import time.
STUB_XLSX = """
window.XLSX = {
  SSF: { parse_date_code: function(v){ return null; } },
  read: function(data, opts){
    return { SheetNames: ["RM PM incoming"], Sheets: { "RM PM incoming": {} } };
  },
  utils: {
    sheet_to_json: function(ws, opts){
      return [
        ["", "PO", "Supplier name", "ประเภทสินค้าหรืองานที่ขนส่ง", "จำนวนที่ขนส่ง", "หน่วย", "วันที่ขนส่ง", "เวลาเข้าโรงงาน", "โค้ดของที่มาส่ง", "remark"],
        ["RM", "PO-77001", "Multi Carrier Co", "Bags", 10, "PLLT", "%s", "09:15", "CODE-A", "lot 1"],
        ["RM", "PO-77001", "Multi Carrier Co", "Boxes", 5, "PLLT", "%s", "09:15", "CODE-B", "lot 2"]
      ];
    }
  }
};
""" % (IMPORT_ROW_DATE, IMPORT_ROW_DATE)

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
            row.setdefault("id", f"id-{NEXT_ID[0]}"); NEXT_ID[0]+=1
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
        page = await browser.new_page()
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
            "name": "incoming-plan.xlsx",
            "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "buffer": b"stub-not-really-parsed-see-STUB_XLSX",
        })
        await page.wait_for_timeout(300)
        # both source rows are on the pre-checked "RM PM incoming" sheet
        await page.fill("#import-from-date", IMPORT_ROW_DATE)
        await page.click("[data-import-preview]")
        await page.wait_for_timeout(300)

        preview_text = await page.text_content(".importpreview")
        print("preview text:", preview_text)
        assert "2 ล็อต" in preview_text, "expected the +2 lots badge in the preview row"

        await page.click("[data-import-confirm]")
        await page.wait_for_timeout(600)

        print("TRUCKS after import:", json.dumps(TRUCKS, indent=2, default=str))
        assert len(TRUCKS) == 1, "the two same-PO/date/time/carrier rows must merge into ONE truck, not two"
        truck = TRUCKS[0]
        assert truck.get("po_no") == "PO-77001"
        lots = truck.get("lots")
        assert lots and len(lots) == 2, "truck must carry both lots in its `lots` array"
        assert lots[0]["details"] == "[RM] Bags"
        assert lots[1]["details"] == "[RM] Boxes"
        # top-level fields still mirror the first lot (backward compatible
        # with a single-lot truck / any code that doesn't know about `lots`)
        assert truck.get("details") == "[RM] Bags"

        # open the card and confirm the "Lots on this truck" section lists both
        await page.click("[data-tab='1']")
        await page.wait_for_timeout(300)
        card_text = await page.text_content(".card")
        print("card text:", card_text)
        assert "2 ล็อต" in card_text
        await page.click(".card")
        await page.wait_for_timeout(300)
        sheet_text = await page.text_content(".sheet")
        assert "Bags" in sheet_text and "Boxes" in sheet_text

        await browser.close()
        print("MULTI-LOT IMPORT TEST PASSED")

asyncio.run(main())
