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
        ["", "PO", "Supplier name", "ประเภทสินค้าหรืองานที่ขนส่ง", "จำนวนที่ขนส่ง", "หน่วย", "วันที่ขนส่ง", "เวลาเข้าโรงงาน"],
        ["RM", "PO-PLANT1", "Some Carrier", "Widgets", 5, "pcs", "%s", "09:00"]
      ];
    }
  }
};
""" % IMPORT_ROW_DATE

TRUCKS = []
NEXT_ID = [1]

async def handle(route, request):
    url = request.url; method = request.method
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
            row.setdefault("truck_state", "pending"); row.setdefault("photos", [])
            TRUCKS.append(row); created.append(row)
        await route.fulfill(status=201, content_type="application/json", body=json.dumps(created))
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        # fresh, empty localStorage -- never touched the import screen before
        context = await browser.new_context(viewport={"width":390, "height":700})
        page = await context.new_page()
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
        await page.wait_for_timeout(200)
        await page.set_input_files("#importFileInput", {
            "name": "Incoming plan.xlsx",
            "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "buffer": b"fake-bytes-not-real-xlsx"
        })
        await page.wait_for_timeout(300)

        # 1) default value on a device that's never touched this field
        default_plant = await page.input_value("#import-plant")
        print("default plant value:", default_plant)
        assert default_plant == "AMATA", "must still default to AMATA so nothing changes for existing users"

        # 2) change it, import, and confirm the new plant is what actually
        # gets written to the created truck (not the old hard-coded AMATA)
        await page.fill("#import-plant", "BANGPAKONG")
        await page.fill("#import-from-date", "2020-01-01")
        await page.click("[data-import-preview]")
        await page.wait_for_timeout(400)
        await page.click("[data-import-confirm]")
        await page.wait_for_timeout(500)
        assert len(TRUCKS) == 1
        print("imported truck plant:", TRUCKS[0].get("plant"))
        assert TRUCKS[0]["plant"] == "BANGPAKONG"

        # 3) reload the page (fresh JS state, same browser storage) -- the
        # chosen plant should be remembered per device, like the admin PIN or
        # display language already are.
        await page.reload()
        await page.wait_for_timeout(400)
        # role is already persisted (localStorage) -- no PIN gate to redo
        await page.click("[data-open-import]")
        await page.wait_for_timeout(200)
        await page.set_input_files("#importFileInput", {
            "name": "Incoming plan.xlsx",
            "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "buffer": b"fake-bytes-not-real-xlsx"
        })
        await page.wait_for_timeout(300)
        remembered = await page.input_value("#import-plant")
        print("plant value after reload:", remembered)
        assert remembered == "BANGPAKONG", "should remember the last plant used on this device"

        await browser.close()
        print("PLANT FIELD TEST PASSED")

asyncio.run(main())
