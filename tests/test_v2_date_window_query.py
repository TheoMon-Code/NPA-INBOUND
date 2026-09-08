import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today()
TODAY_KEY = TODAY.isoformat()
OLD_DATE = (TODAY - timedelta(days=120)).isoformat()

# Same stub pattern as test_v2_e2e.py (real SheetJS can't load from the CDN in
# this sandbox) -- one data row, dated well outside the +/-5 day display
# window, to exercise the import dedupe-check's own date-range query.
STUB_XLSX = """
window.XLSX = {
  SSF: { parse_date_code: function(v){ return null; } },
  read: function(data, opts){
    return { SheetNames: ["RM PM incoming"], Sheets: { "RM PM incoming": {} } };
  },
  utils: {
    sheet_to_json: function(ws, opts){
      return [
        ["", "PO", "Supplier name", "ประเภทสินค้าหรืองานที่ขนส่ง", "จำนวนที่ขนส่ง", "หน่วย", "วันที่ขนส่ง", "เวลาเข้าโรงงาน"],
        ["RM", "PO-OLD1", "Old Carrier", "Widgets", 10, "pcs", "%s", "09:00"]
      ];
    }
  }
};
""" % OLD_DATE

TRUCKS = [
    {"id":"1", "reference_id":"T-1", "carrier":"Carrier A", "plant":"AMATA",
     "po_no":"PO-1001", "order_date":TODAY_KEY, "eta":TODAY_KEY+"T08:00:00",
     "truck_state":"pending", "photos":[]},
]

seen_urls = []

async def handle(route, request):
    url = request.url
    if "/rest/v1/trucks" in url and request.method == "GET":
        seen_urls.append(url)
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":390, "height":700})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.add_init_script(STUB_XLSX)
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(500)

        # 1) The normal display load (loadFromSupabase(), no explicit range)
        # must be scoped server-side to today +/- MAX_DAY_OFFSET (5) -- this
        # is what keeps every periodic poll cheap regardless of how much
        # history accumulates in the real table over time.
        expected_from = (TODAY - timedelta(days=5)).isoformat()
        expected_to = (TODAY + timedelta(days=5)).isoformat()
        list_calls = [u for u in seen_urls if "select=*" in u]
        assert list_calls, "expected at least one full-list GET to /rest/v1/trucks"
        last = list_calls[-1]
        assert ("order_date=gte."+expected_from) in last, "missing lower bound in "+last
        assert ("order_date=lte."+expected_to) in last, "missing upper bound in "+last
        print("display load URL ok:", last)

        # 2) Import dedupe-check must query the file's OWN date range, not
        # the display window -- exercise it with a row dated well outside
        # +/-5 days (a historical re-import scenario, e.g. record-keeping).
        seen_urls.clear()
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)
        await page.click("[data-open-import]")
        await page.wait_for_timeout(200)
        await page.set_input_files("#importFileInput", {
            "name": "Incoming plan AMATA.xlsx",
            "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "buffer": b"fake-bytes-not-real-xlsx"
        })
        await page.wait_for_timeout(300)
        await page.fill("#import-from-date", (TODAY - timedelta(days=200)).isoformat())
        await page.click("[data-import-preview]")
        await page.wait_for_timeout(400)

        dedupe_calls = [u for u in seen_urls if "select=po_no" in u]
        assert dedupe_calls, "expected a dedupe-check GET (select=po_no,...) during import preview"
        durl = dedupe_calls[-1]
        assert ("order_date=gte."+OLD_DATE) in durl, "dedupe query should scope to the file's own dates, not the display window: "+durl
        assert ("order_date=lte."+OLD_DATE) in durl, "dedupe query upper bound wrong: "+durl
        print("dedupe-check URL ok:", durl)

        preview_text = await page.text_content(".importpreview")
        assert "Old Carrier" in (preview_text or ""), "old-dated row should still show up in the preview: "+repr(preview_text)

        await browser.close()
        print("DATE WINDOW QUERY TEST PASSED")

asyncio.run(main())
