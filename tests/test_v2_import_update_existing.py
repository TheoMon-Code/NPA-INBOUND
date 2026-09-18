import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
DATE1 = (date.today() + timedelta(days=1)).isoformat()

# Round 36: client feedback (Khun Badeeson) -- "When uploading a shipment
# file, please check whether the shipment (by PO/Shipment No./Delivery No.)
# already exists in the system. If it does, please UPDATE the existing
# record with the latest data instead of creating a duplicate entry. Please
# also make sure duplicate rows within the same upload file are not both
# imported."
#
# This fixture re-imports a plan where PO-1001 (already in the DB, still
# "pending") comes back with a changed quantity/code/remark -- that must
# PATCH the existing truck in place (matched by PO+date+time+carrier, see
# importCoreKey()-based matching in runImportPreview()/js/importPlan.js),
# never insert a second truck for it. PO-1002 is a genuinely new shipment,
# appearing TWICE, byte-identical, in the same file (a pasted-twice row) --
# that must collapse to exactly one new truck (dedupeExactRows()), not two.
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
        ["RM", "PO-1001", "Existing Carrier", "Corn Wholegrain Bulk", 150, "KG", "%s", "08:00", "CODE-NEW", "updated remark"],
        ["RM", "PO-1002", "New Carrier", "Salt Bulk", 200, "KG", "%s", "09:00", "CODE-A", ""],
        ["RM", "PO-1002", "New Carrier", "Salt Bulk", 200, "KG", "%s", "09:00", "CODE-A", ""]
      ];
    }
  }
};
""" % (DATE1, DATE1, DATE1)

TRUCKS = [{
    "id": "existing-1", "reference_id": "T-EXIST1", "carrier": "Existing Carrier", "plant": "AMATA",
    "po_no": "PO-1001", "order_date": DATE1, "eta": DATE1+"T08:00:00", "truck_state": "pending",
    "sku_no": "CODE-OLD", "qtt": "100 KG", "remark": "old remark", "details": "[RM] Corn Wholegrain Bulk",
    "photos": []
}]
PATCH_CALLS = []
NEXT_ID = [1]

async def handle(route, request):
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
            row.setdefault("id", f"new-{NEXT_ID[0]}"); NEXT_ID[0] += 1
            row.setdefault("truck_state", "pending")
            row.setdefault("photos", [])
            TRUCKS.append(row)
            created.append(row)
        await route.fulfill(status=201, content_type="application/json", body=json.dumps(created))
        return
    if "/rest/v1/trucks" in url and method == "PATCH":
        m = re.search(r"id=eq\.([^&]+)", url)
        truck_id = m.group(1) if m else None
        body = json.loads(request.post_data or "{}")
        PATCH_CALLS.append({"id": truck_id, "body": body})
        for t in TRUCKS:
            if t["id"] == truck_id:
                t.update(body)
        await route.fulfill(status=204)
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
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(400)
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)

        await page.click("[data-open-import]")
        await page.wait_for_timeout(300)
        await page.set_input_files("#importFileInput", {
            "name": "plan.xlsx",
            "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "buffer": b"stub-not-really-parsed-see-STUB_XLSX",
        })
        await page.wait_for_timeout(300)

        await page.click("[data-import-preview='1']")
        await page.wait_for_timeout(400)

        preview_text = await page.text_content(".importpreview")
        print("preview text:", preview_text)
        # Exactly one PO-1002 row shown, not two -- the pasted-twice duplicate
        # must already be collapsed before the admin even sees the preview
        # (the row text shows the product/qty, not the PO number itself).
        assert preview_text.count("Salt Bulk") == 1, "an exact duplicate row pasted twice in the same file must be deduped, not shown twice"
        assert "Corn Wholegrain Bulk" in preview_text, "the changed PO-1001 row must appear in the preview"

        summary_text = await page.text_content(".hint")
        print("summary:", summary_text)

        await page.click("[data-import-confirm]")
        await page.wait_for_timeout(600)

        print("TRUCKS after import:", json.dumps(TRUCKS, indent=2, default=str))
        print("PATCH calls:", PATCH_CALLS)

        # PO-1001: updated in place, never duplicated
        assert len(PATCH_CALLS) == 1, "the changed PO-1001 shipment must be updated exactly once"
        assert PATCH_CALLS[0]["id"] == "existing-1"
        assert PATCH_CALLS[0]["body"]["qtt"] == "150 KG"
        assert PATCH_CALLS[0]["body"]["sku_no"] == "CODE-NEW"
        assert PATCH_CALLS[0]["body"]["remark"] == "updated remark"

        po1001_trucks = [t for t in TRUCKS if t["po_no"] == "PO-1001"]
        assert len(po1001_trucks) == 1, "PO-1001 must still be exactly one truck, not duplicated"
        assert po1001_trucks[0]["qtt"] == "150 KG"

        # PO-1002: exactly one new truck despite appearing twice in the file
        po1002_trucks = [t for t in TRUCKS if t["po_no"] == "PO-1002"]
        assert len(po1002_trucks) == 1, "a byte-identical duplicate row in the same upload must not create two trucks"

        assert len(TRUCKS) == 2, "expected exactly 2 trucks total: the updated PO-1001 plus one new PO-1002"

        await browser.close()
        print("IMPORT UPDATE-EXISTING TEST PASSED")

asyncio.run(main())
