import asyncio, json, os, re
from datetime import date, datetime, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 21: solid colored status badges + a collapsible status legend,
# closer to the look of MON's Outbound admin tool (a manager compared the
# two). The badges are a pure CSS change (.pill.<status> in css/app.css) --
# this checks the computed style actually turned solid (white text on a
# colored background) rather than the previous soft-tint chip, for a few
# different statuses so a future edit can't accidentally revert just one of
# them. The legend is new markup (statusLegendHtml() in js/render.js),
# collapsed by default so it costs a driver nothing on a phone screen until
# they tap it open (Theo's condition for this whole round: stay simple to
# look at, on phone as well as web).

def eta_in(minutes):
    return (datetime.now() + timedelta(minutes=minutes)).strftime("%H:%M:00")

TRUCKS = [
    # Scheduled, not due soon -- far enough out that it never crosses into
    # "duesoon" or "late" however long this suite takes to run.
    {"id":"1","reference_id":"T-1","carrier":"Aurora Freight","plant":"AMATA","po_no":"PO-8001",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(180),"truck_state":"pending","photos":[]},
    # Deliberately "late".
    {"id":"2","reference_id":"T-2","carrier":"Late Carrier Co","plant":"AMATA","po_no":"PO-8002",
     "order_date":TODAY,"eta":"1999-01-01T00:00:00","truck_state":"pending","photos":[]},
    # Currently unloading -- "arrived" is the source truck_state that
    # mapRowToTruck() (js/api.js) turns into status "unloading"; the started
    # timestamp itself comes from act_arrival, not a field literally called
    # started_at.
    {"id":"3","reference_id":"T-3","carrier":"Meridian Cargo","plant":"AMATA","po_no":"PO-8003",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(-30),"truck_state":"arrived",
     "act_arrival":datetime.now().isoformat(),"photos":[]},
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
        await page.wait_for_timeout(500)

        assert await page.locator(".card").count() == 3

        # ---- solid badges: white text color on each variant that appears ----
        for cls in ["scheduled", "late", "unloading"]:
            pill = page.locator(".pill."+cls).first
            assert await pill.count() >= 1, "expected a ."+cls+" pill on screen"
            color = await pill.evaluate("el => getComputedStyle(el).color")
            print("pill."+cls+" computed color:", color)
            assert color in ("rgb(255, 255, 255)", "rgba(255, 255, 255, 1)"), \
                "expected white text on a solid badge for ."+cls

        # ---- status legend: collapsed by default, expands on tap ----
        legend = page.locator(".statuslegend")
        assert await legend.count() == 1
        assert await legend.get_attribute("open") is None, "legend should start collapsed"
        rows_before = await page.locator(".statuslegend .legendrow").count()
        print("legend rows while collapsed (should still be in the DOM):", rows_before)
        assert rows_before == 7, "expected one legend row per status kind (incl. duesoon)"

        await page.click(".statuslegend summary")
        await page.wait_for_timeout(150)
        assert await legend.get_attribute("open") is not None, "legend should be open after tapping its summary"
        # The app defaults to Thai (Round 3) -- switch to English before
        # checking specific text, same convention as test_v2_e2e.py.
        await page.click("[data-toggle-lang]")
        await page.wait_for_timeout(200)
        legend_text = await legend.text_content()
        print("legend text once open (EN):", legend_text)
        assert "Unloading" in legend_text
        assert "Done" in legend_text
        assert "Due soon" in legend_text

        await browser.close()
        print("STATUS BADGES + LEGEND TEST PASSED")

asyncio.run(main())
