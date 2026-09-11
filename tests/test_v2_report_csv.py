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
        # Round 24: Theo asked for the PO number and carrier in the export too
        # (so a row identifies which truck it is without cross-referencing the
        # app) -- added right after eta, ahead of the columns that were already
        # here, which shifts damage_remark from index 5 to index 7. Round 26
        # appended truck_label (index 8), then started_by/finished_by
        # (indexes 9/10) right after it -- this assertion was never updated
        # for either at the time, caught while running the full suite for
        # Round 27's unrelated changes; fixed here since it's a plain test-only
        # gap, not an app bug (the app's own header/rows were already correct).
        assert rows[0] == ["date","eta","po_no","carrier","truck_state","act_arrival","act_dept","damage_remark","truck_label","started_by","finished_by"]
        assert len(rows) == 3  # header + 2 trucks
        assert rows[1][0] == d(-2)
        assert rows[2][0] == d(-1)
        assert rows[1][2] == "PO-1" and rows[1][3] == "A"
        assert rows[2][2] == "PO-2" and rows[2][3] == "B"
        # the comma-and-quote-containing damage remark must round-trip intact
        assert rows[2][7] == 'Layer 2 crushed, has a "note, with comma"'
        # neither mocked truck has a truck_label/started_by/finished_by --
        # confirms the three new trailing columns are present but blank,
        # not just silently omitted.
        assert rows[1][8] == "" and rows[1][9] == "" and rows[1][10] == ""

        await browser.close()
        print("REPORT CSV EXPORT TEST PASSED")

asyncio.run(main())
