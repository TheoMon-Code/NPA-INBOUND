import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today()

def d(offset): return (TODAY + timedelta(days=offset)).isoformat()

# 4 trucks spread over the last 6 days, exercising every KPI:
#  - id1: completed, arrived 10min before eta (on time), 40min unload
#  - id2: completed, arrived 30min after eta (late, grace is 20min)
#  - id3: still "pending", no arrival ever logged (a data-entry gap)
#  - id4: completed, has a damage remark
TRUCKS = [
    {"id":"1","reference_id":"T-1","carrier":"A","plant":"AMATA","po_no":"PO-1",
     "order_date":d(-4),"eta":d(-4)+"T08:00:00","truck_state":"completed",
     "act_arrival":d(-4)+"T07:50:00","act_dept":d(-4)+"T08:30:00","photos":[]},
    {"id":"2","reference_id":"T-2","carrier":"B","plant":"AMATA","po_no":"PO-2",
     "order_date":d(-3),"eta":d(-3)+"T09:00:00","truck_state":"completed",
     "act_arrival":d(-3)+"T09:30:00","act_dept":d(-3)+"T10:15:00","photos":[]},
    {"id":"3","reference_id":"T-3","carrier":"C","plant":"AMATA","po_no":"PO-3",
     "order_date":d(-2),"eta":d(-2)+"T08:00:00","truck_state":"pending","photos":[]},
    {"id":"4","reference_id":"T-4","carrier":"D","plant":"AMATA","po_no":"PO-4",
     "order_date":d(-1),"eta":d(-1)+"T08:00:00","truck_state":"completed",
     "act_arrival":d(-1)+"T08:05:00","act_dept":d(-1)+"T08:45:00",
     "damage_remark":"Layer 3 crushed","photos":[]},
]

seen_report_urls = []

async def handle(route, request):
    url = request.url
    if "/rest/v1/trucks" in url and request.method == "GET":
        if "select=order_date,eta,truck_state" in url:
            seen_report_urls.append(url)
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

        # default range should be the last 7 days, and cover all 4 trucks
        from_val = await page.input_value("#report-from")
        to_val = await page.input_value("#report-to")
        print("default range:", from_val, "..", to_val)
        assert from_val <= d(-4) and to_val >= d(-1)

        await page.click("[data-run-report]")
        await page.wait_for_timeout(400)

        assert seen_report_urls, "expected a scoped report query (select=order_date,eta,truck_state,...)"
        assert ("order_date=gte."+from_val) in seen_report_urls[-1]
        assert ("order_date=lte."+to_val) in seen_report_urls[-1]

        kpi_text = await page.text_content(".kpis:last-of-type")
        print("report KPIs:", kpi_text)
        assert "4" in kpi_text   # total trucks
        assert "3" in kpi_text   # completed
        # rated arrivals: id1 (10min early -> on time), id2 (30min late, grace
        # is 20min -> late), id4 (5min late, within grace -> on time); id3
        # never got an arrival logged so it's not rated either way.
        assert "67%" in kpi_text # on-time = 2 of 3 rated
        assert "1" in kpi_text   # damage remarks / no-arrival-logged (both are 1)

        note = await page.text_content(".hint")
        # just confirm the "rated on N trucks" note rendered without throwing
        assert note is not None

        # ---- from > to should be rejected client-side, not sent to the server ----
        seen_report_urls.clear()
        await page.fill("#report-from", d(1))
        await page.fill("#report-to", d(-1))
        await page.click("[data-run-report]")
        await page.wait_for_timeout(300)
        err = await page.text_content(".sheet .hint")
        print("range-order error shown:", err)
        assert not seen_report_urls, "must not query the server with an inverted date range"

        await browser.close()
        print("REPORTING TEST PASSED")

asyncio.run(main())
