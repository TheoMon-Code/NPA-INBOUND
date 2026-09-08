import asyncio, csv, io, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today()

def d(offset): return (TODAY + timedelta(days=offset)).isoformat()

TRUCKS = [
    {"id":"1","reference_id":"T-1","carrier":"A","plant":"AMATA","po_no":"PO-1",
     "order_date":d(-2),"eta":d(-2)+"T08:00:00","truck_state":"completed",
     "act_arrival":d(-2)+"T07:55:00","act_dept":d(-2)+"T08:40:00","photos":[]},
    {"id":"2","reference_id":"T-2","carrier":"B","plant":"AMATA","po_no":"PO-2",
     "order_date":d(-1),"eta":d(-1)+"T09:00:00","truck_state":"completed",
     "act_arrival":d(-1)+"T09:45:00","act_dept":d(-1)+"T10:20:00",
     "damage_remark":"Layer 2 crushed, has a \"note, with comma\"","photos":[]},
]

async def handle(route, request):
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
        page = await browser.new_page(viewport={"width":390,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(400)
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)

        await page.click("[data-open-report]")
        await page.wait_for_timeout(200)
        await page.click("[data-run-report]")
        await page.wait_for_timeout(400)

        assert await page.locator("[data-export-report-csv]").count() == 1

        async with page.expect_download() as dl_info:
            await page.click("[data-export-report-csv]")
        download = await dl_info.value
        suggested = download.suggested_filename
        print("suggested filename:", suggested)
        assert suggested.startswith("mon-inbound-report_") and suggested.endswith(".csv")

        path = await download.path()
        with open(path, "rb") as f:
            raw = f.read()
        # BOM present (Excel-friendly UTF-8), then decodes cleanly
        assert raw.startswith(b"\xef\xbb\xbf"), "expected a UTF-8 BOM at the start of the file"
        text = raw.decode("utf-8-sig")
        rows = list(csv.reader(io.StringIO(text)))
        print("CSV rows:", rows)
        assert rows[0] == ["date","eta","truck_state","act_arrival","act_dept","damage_remark"]
        assert len(rows) == 3  # header + 2 trucks
        assert rows[1][0] == d(-2)
        assert rows[2][0] == d(-1)
        # the comma-and-quote-containing damage remark must round-trip intact
        assert rows[2][5] == 'Layer 2 crushed, has a "note, with comma"'

        await browser.close()
        print("REPORT CSV EXPORT TEST PASSED")

asyncio.run(main())
