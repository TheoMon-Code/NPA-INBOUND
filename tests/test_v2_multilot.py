import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"

IMPORT_ROW_DATE = (date.today() + timedelta(days=1)).isoformat()

# Two rows sharing the exact same PO + date + time + carrier -- the same
# real-world pattern found in MON's own "Incoming plan AMATA" file (same PO,
# same delivery slot, different line-item number / product / qty).
#
# Round 28 merged rows like this into one truck's `lots` array, on the
# strength of MON's on-site manager confirming that read for PO 4563895042.
# Round 30 reverts that: a later PO (4563428496, M C Croker) turned out to
# be two genuinely separate trucks/containers sharing a slot (remark carries
# distinct container numbers per row) -- so rows sharing a slot must import
# as separate trucks again, distinguished by a "<PO> - Truck N" label
# (truck_label), the original Round 26 model.
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
        # Explicit phone-width viewport -- Playwright's own default
        # (1280x720) is wide enough to trigger the wide-screen table view
        # added in Round 21 (>=760px, see css/app.css), under which .card
        # is intentionally not the visible markup. Not a bug in the app;
        # this test is about something else and just needs pinning down
        # to the card view like every other suite here.
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
        assert "PO-77001 - Truck 1" in preview_text
        assert "PO-77001 - Truck 2" in preview_text

        await page.click("[data-import-confirm]")
        await page.wait_for_timeout(600)

        print("TRUCKS after import:", json.dumps(TRUCKS, indent=2, default=str))
        assert len(TRUCKS) == 2, "the two same-PO/date/time/carrier rows must import as TWO separate trucks, not merge"
        truck1 = next(t for t in TRUCKS if t.get("truck_label") == "PO-77001 - Truck 1")
        truck2 = next(t for t in TRUCKS if t.get("truck_label") == "PO-77001 - Truck 2")
        assert truck1["po_no"] == "PO-77001" and truck2["po_no"] == "PO-77001"
        assert truck1["details"] == "[RM] Bags" and truck1["qtt"] == "10 PLLT"
        assert truck2["details"] == "[RM] Boxes" and truck2["qtt"] == "5 PLLT"
        # `lots` rides along as an explicit null on every insert (same
        # convention as carrier_th/mat_type elsewhere in this payload) --
        # what actually matters is that it's never POPULATED for these two,
        # since they're genuinely separate trucks, not one truck's lots.
        assert not truck1.get("lots") and not truck2.get("lots")

        # open the truck list and confirm both "Truck 1"/"Truck 2" cards show
        # up, each with its own product line under the label
        await page.click("[data-tab='1']")
        await page.wait_for_timeout(300)
        list_text = await page.text_content(".list-cards")
        print("truck list text:", list_text)
        assert "PO-77001 - Truck 1" in list_text and "Bags" in list_text
        assert "PO-77001 - Truck 2" in list_text and "Boxes" in list_text

        await browser.close()
        print("SEPARATE-TRUCKS IMPORT TEST PASSED")

asyncio.run(main())
