import asyncio, json, os, re
from datetime import date, datetime, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

def eta_in(minutes):
    return (datetime.now() + timedelta(minutes=minutes)).strftime("%H:%M:00")

TRUCKS = [
    # Due in 8 minutes -- inside DUE_SOON_MIN (15, config.js): should get the
    # "coming up soon" cue.
    {"id":"1","reference_id":"T-1","carrier":"Soon Carrier","plant":"AMATA","po_no":"PO-SOON",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(8),"truck_state":"pending","photos":[]},
    # Due in 3 hours -- well outside the window: plain "scheduled", no cue.
    {"id":"2","reference_id":"T-2","carrier":"Later Carrier","plant":"AMATA","po_no":"PO-LATER",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(180),"truck_state":"pending","photos":[]},
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

        cards = page.locator(".card")
        assert await cards.count() == 2

        soon_card = page.locator(".card", has_text="PO-SOON")
        later_card = page.locator(".card", has_text="PO-LATER")

        soon_pill_class = await soon_card.locator(".pill").get_attribute("class")
        later_pill_class = await later_card.locator(".pill").get_attribute("class")
        print("soon truck pill class:", soon_pill_class)
        print("later truck pill class:", later_pill_class)
        assert "duesoon" in soon_pill_class
        assert "scheduled" in soon_pill_class  # additive, not a replacement
        assert "duesoon" not in later_pill_class

        soon_pill_text = await soon_card.locator(".pill").text_content()
        print("soon truck pill text:", soon_pill_text)
        assert "⏰" in soon_pill_text

        soon_stripe_class = await soon_card.locator(".stripe").get_attribute("class")
        assert "duesoon" in soon_stripe_class

        # KPI counts and sort order are untouched by this -- both trucks are
        # still plain "scheduled" as far as derive()/kpiHtml/sortWeight are
        # concerned, this is purely a visual cue layered on top.
        kpi_text = await page.text_content(".kpis")
        print("kpi strip:", kpi_text)
        assert "0" in kpi_text  # nothing "late" yet

        await browser.close()
        print("DUE SOON TEST PASSED")

asyncio.run(main())
