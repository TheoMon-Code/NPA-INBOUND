import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
IMPORT_ROW_DATE = (date.today() + timedelta(days=1)).isoformat()

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
        ["RM", "PO-99009", "Ancient Carrier", "Barrels", 1, "pcs", "%s", "06:00", "CODEQ", ""],
        ["RM", "PO-99009", "Ancient Carrier", "Kegs", 2, "pcs", "%s", "06:00", "CODEQ2", ""]
      ];
    }
  }
};
""" % (IMPORT_ROW_DATE, IMPORT_ROW_DATE)

TRUCKS = []
NEXT_ID = [1]
POST_ATTEMPTS = []

async def handle_supabase(route, request):
    url = request.url
    method = request.method
    if "/rest/v1/trucks" in url and method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/trucks" in url and method == "POST":
        body = json.loads(request.post_data or "[]")
        rows = body if isinstance(body, list) else [body]
        POST_ATTEMPTS.append(rows)
        # Old project: neither "raw" nor "lots" columns exist yet.
        if any("raw" in r for r in rows):
            await route.fulfill(status=400, content_type="application/json",
                body=json.dumps({"message": "Could not find the 'raw' column of 'trucks' in the schema cache"}))
            return
        if any("lots" in r for r in rows):
            await route.fulfill(status=400, content_type="application/json",
                body=json.dumps({"message": "Could not find the 'lots' column of 'trucks' in the schema cache"}))
            return
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
        await page.wait_for_timeout(300)
        await page.click("[data-open-import]")
        await page.wait_for_timeout(200)
        await page.set_input_files("#importFileInput", {
            "name": "Incoming plan AMATA.xlsx",
            "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "buffer": b"fake-bytes-not-real-xlsx"
        })
        await page.wait_for_timeout(300)
        await page.fill("#import-from-date", "2020-01-01")
        await page.click("[data-import-preview]")
        await page.wait_for_timeout(300)
        await page.click("[data-import-confirm]")
        await page.wait_for_selector(".toast", timeout=10000)
        await page.wait_for_timeout(300)
        toast = await page.text_content(".toast")
        print("Toast:", toast)
        print("POST attempts:", len(POST_ATTEMPTS))
        assert len(POST_ATTEMPTS) == 3, "expected full attempt, then -raw, then -raw-lots (cascading in one chunk)"
        assert "raw" in POST_ATTEMPTS[0][0] and POST_ATTEMPTS[0][0].get("lots") is not None
        assert "raw" not in POST_ATTEMPTS[1][0] and POST_ATTEMPTS[1][0].get("lots") is not None
        assert "raw" not in POST_ATTEMPTS[2][0] and "lots" not in POST_ATTEMPTS[2][0]
        assert len(TRUCKS) == 1, "both lots must still merge into ONE truck even on this fallback path"
        assert TRUCKS[0]["po_no"] == "PO-99009"
        assert "lots" not in TRUCKS[0]
        assert "แจ้งทีม ISD" in (toast or "") and "raw" in (toast or "") and "lots" in (toast or "")
        await browser.close()
        print("BOTH-MISSING CASCADE TEST PASSED")

asyncio.run(main())
