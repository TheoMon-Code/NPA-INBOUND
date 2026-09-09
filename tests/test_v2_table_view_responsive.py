import asyncio, json, os, re
from datetime import date, datetime, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 21: a table view of the day's trucks for a wide (desktop/web) screen,
# alongside the existing card view for a phone -- a manager compared this
# app to MON's Outbound admin tool, which lists its orders as a dense table.
# Both markups are always in the DOM (see listHtml()/listTableHtml() in
# js/render.js); a pure CSS media query (min-width:760px, see css/app.css)
# decides which one is actually visible, so a phone never renders/pays for
# the denser table. This checks both breakpoints on the SAME page (resizing
# the viewport rather than reloading), and that clicking a table row opens
# the same truck sheet as clicking a card would.

def eta_in(minutes):
    return (datetime.now() + timedelta(minutes=minutes)).strftime("%H:%M:00")

TRUCKS = [
    {"id":"1","reference_id":"T-1","carrier":"Aurora Freight","plant":"AMATA","po_no":"PO-7001",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(120),"truck_state":"pending","photos":[]},
    {"id":"2","reference_id":"T-2","carrier":"Meridian Cargo","plant":"BANGPAKONG","po_no":"PO-7002",
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
        # Start narrow, like a phone -- same as every other suite in this
        # project, so this exercises the actual default/most common case
        # too, not just the new wide-screen behavior.
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

        # ---- narrow (phone) viewport: cards visible, table hidden ----
        assert await page.locator(".card").first.is_visible(), "cards should be visible on a phone-width screen"
        assert not await page.locator(".trucktable").first.is_visible(), "the table should not be visible on a phone-width screen"

        # ---- resize to a desktop-width viewport: table visible, cards hidden ----
        await page.set_viewport_size({"width":1024,"height":800})
        await page.wait_for_timeout(150)
        assert await page.locator(".trucktable").is_visible(), "the table should be visible on a wide screen"
        assert not await page.locator(".card").first.is_visible(), "cards should not be visible on a wide screen"
        rows = await page.locator(".trucktable tbody tr.truckrow").count()
        print("table rows at wide viewport:", rows)
        assert rows == 2
        table_text = await page.text_content(".trucktable")
        assert "PO-7001" in table_text and "PO-7002" in table_text
        assert "BANGPAKONG" in table_text

        # ---- clicking a table row opens the same truck sheet a card would ----
        await page.click("tr.truckrow[data-open='2']")
        await page.wait_for_timeout(300)
        sheet_id = await page.text_content(".sheet-id")
        print("sheet opened from a table row click:", sheet_id)
        assert "PO-7002" in (sheet_id or "")

        # ---- back to narrow: cards visible again, table hidden again ----
        await page.click("[data-close]")
        await page.wait_for_timeout(150)
        await page.set_viewport_size({"width":390,"height":800})
        await page.wait_for_timeout(150)
        assert await page.locator(".card").first.is_visible()
        assert not await page.locator(".trucktable").first.is_visible()

        await browser.close()
        print("TABLE VIEW RESPONSIVE TEST PASSED")

asyncio.run(main())
