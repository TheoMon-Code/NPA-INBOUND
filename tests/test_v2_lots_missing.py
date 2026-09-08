import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
IMPORT_ROW_DATE = (date.today() + timedelta(days=1)).isoformat()

# Two rows sharing PO+date+time+carrier (one truck, two lots) against a
# Supabase project that hasn't run the "lots" column migration yet -- the
# insert should retry without "lots" (keeping "raw") and still save the
# truck using its first lot's fields, same as before this feature existed.
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
        ["RM", "PO-88002", "NoLots Carrier", "Sacks", 3, "pcs", "%s", "13:00", "CODEY", ""],
        ["RM", "PO-88002", "NoLots Carrier", "Crates", 9, "pcs", "%s", "13:00", "CODEZ", ""]
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
        # Simulate a project where "lots" doesn't exist yet, but "raw" does.
        if any("lots" in r for r in rows):
            await route.fulfill(
                status=400, content_type="application/json",
                body=json.dumps({"message": "Could not find the 'lots' column of 'trucks' in the schema cache"})
            )
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
        print("Toast after import (lots column missing):", toast)

        print("POST attempts:", len(POST_ATTEMPTS))
        assert len(POST_ATTEMPTS) == 2, "expected a rejected attempt with lots + a retry without lots"
        assert "lots" in POST_ATTEMPTS[0][0]
        assert "raw" in POST_ATTEMPTS[0][0], "raw should still be attempted (only lots is missing here)"
        assert "lots" not in POST_ATTEMPTS[1][0]
        assert "raw" in POST_ATTEMPTS[1][0], "raw must survive the lots-only fallback"
        assert len(TRUCKS) == 1, "still one truck row even though lots couldn't be saved"
        assert TRUCKS[0]["po_no"] == "PO-88002"
        assert TRUCKS[0]["details"] == "[RM] Sacks", "primary (first) lot's fields must still be saved"
        assert "lots" not in TRUCKS[0]
        assert ("แจ้งทีม ISD" in (toast or "")) or ("ask ISD" in (toast or "")), "toast should mention the lots migration, not just raw"

        await browser.close()
        print("LOTS-MISSING FALLBACK TEST PASSED")

asyncio.run(main())
