import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today()
def d(offset): return (TODAY + timedelta(days=offset)).isoformat()

# Round 40: Theo, after sharing an existing MON report (an "OPL Skill
# Matrix" workbook) as an example -- "je voulais un vrai fichier excel du
# type... je veux le meme type" (he wants a real, styled multi-sheet Excel
# workbook in that same corporate style, not just the flat "Export CSV"
# already on this screen). New button next to it, "Export Excel report"
# (exportReportExcel(), js/excelReport.js), builds a 4-sheet workbook
# (Report/Trucks/Carriers/Trend) with the MON logo, the app's own good/bad/
# warn colours, and Excel conditional formatting (data bars / threshold
# fills) standing in for a native chart -- no free browser library actually
# writes real Excel chart objects.
#
# IMPORTANT CAVEAT, read before touching this file again: this suite can
# only verify the button's presence and its GRACEFUL FAILURE path here --
# this sandbox's own outbound network was blocked to cdnjs.cloudflare.com
# (and everywhere else) while this feature was built, so the actual
# ExcelJS-loaded, "click it and get a real correct .xlsx back" path has
# never been run end-to-end by an automated test. That first real test is
# still owed -- do it (open the downloaded file and check its sheets/
# values) the first time this sandbox's network reaches cdnjs again, and
# expand this file then rather than assuming the happy path is covered.

TRUCKS = [
    {"id":"1","reference_id":"T-1","carrier":"A","plant":"AMATA","po_no":"PO-1",
     "order_date":d(-4),"eta":d(-4)+"T08:00:00","truck_state":"completed",
     "act_arrival":d(-4)+"T07:50:00","act_dept":d(-4)+"T08:30:00","photos":[]},
    {"id":"2","reference_id":"T-2","carrier":"B","plant":"AMATA","po_no":"PO-2",
     "order_date":d(-3),"eta":d(-3)+"T09:00:00","truck_state":"completed",
     "act_arrival":d(-3)+"T09:30:00","act_dept":d(-3)+"T10:15:00","photos":[]},
    {"id":"3","reference_id":"T-3","carrier":"C","plant":"AMATA","po_no":"PO-3",
     "order_date":d(-2),"eta":d(-2)+"T08:00:00","truck_state":"pending","photos":[]},
]

async def handle(route, request):
    url = request.url
    if "/rest/v1/trucks" in url and request.method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    if "/rest/v1/app_settings" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":420, "height":1000})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(400)
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)
        await page.click("[data-toggle-lang]")  # English, for a readable assertion below
        await page.wait_for_timeout(200)

        await page.click("[data-open-report]")
        await page.wait_for_timeout(200)

        # Button must not appear before a report has actually been run --
        # same gating as the CSV export/carrier ranking next to it (all
        # inside reportSheetHtml()'s `if(d){...}` block, js/render.js).
        assert await page.locator("[data-export-report-excel]").count() == 0, \
            "the Excel export button must not show before Generate has produced results"

        await page.click("[data-run-report]")
        await page.wait_for_timeout(400)

        btn = page.locator("[data-export-report-excel]")
        assert await btn.count() == 1
        text = await btn.text_content()
        print("button text:", text)
        assert "Excel" in text

        # It sits next to (not instead of) the existing CSV export -- Theo
        # never asked for CSV to go away, only for a real workbook option
        # alongside it.
        assert await page.locator("[data-export-report-csv]").count() == 1

        # Clicking it must never crash the app, even when the ExcelJS
        # library itself fails to load (a real, valid scenario on a flaky
        # connection, not just this sandbox's current situation) -- a
        # toast, and the sheet stays open and usable.
        await btn.click()
        await page.wait_for_timeout(3000)
        toast_text = await page.text_content(".toast")
        print("toast after click:", toast_text)
        assert await page.locator(".sheet").count() == 1
        assert await page.locator("[data-export-report-csv]").count() == 1, \
            "the sheet must stay open and usable even if the Excel library failed to load"

        await browser.close()
        print("REPORT EXCEL BUTTON TEST PASSED")

asyncio.run(main())
