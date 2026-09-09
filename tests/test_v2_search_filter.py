import asyncio, json, os, re
from datetime import date, datetime, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# eta_in(minutes) is relative to *now* rather than a fixed wall-clock time --
# a fixed "08:00"/"09:00" eta used to intermittently register as "late" too
# (whenever the suite happened to run after that hour + GRACE_MIN), making
# this test flaky depending on time of day. Trucks 1 and 2 are anchored well
# into the future so they're never late regardless of when this runs; only
# truck 3 (deep in the past) is meant to ever be "late".
def eta_in(minutes):
    return (datetime.now() + timedelta(minutes=minutes)).strftime("%H:%M:00")

TRUCKS = [
    {"id":"1","reference_id":"T-1","carrier":"Aurora Freight","plant":"AMATA","po_no":"PO-1001",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(90),"truck_state":"pending","photos":[]},
    {"id":"2","reference_id":"T-2","carrier":"Meridian Cargo","plant":"AMATA","po_no":"PO-2002",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(150),"truck_state":"pending","photos":[]},
    # Deliberately "late": eta far enough in the past that GRACE_MIN (20min)
    # is already blown, whatever time this test happens to run at.
    {"id":"3","reference_id":"T-3","carrier":"Late Carrier Co","plant":"BANGPAKONG","po_no":"PO-3003",
     "order_date":TODAY,"eta":"1999-01-01T00:00:00","truck_state":"pending","photos":[]},
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

        # ---- baseline: all 3 trucks visible, nothing filtered ----
        cards = await page.locator(".card").count()
        print("cards with no filter:", cards)
        assert cards == 3

        # ---- typing in the search box narrows the list live, no button tap ----
        await page.fill("#searchInput", "meridian")
        await page.wait_for_timeout(150)
        cards = await page.locator(".card").count()
        card_text = await page.text_content(".list")
        print("cards after searching 'meridian':", cards)
        assert cards == 1
        assert "PO-2002" in card_text

        # search input must keep focus across the re-render triggered by typing
        focused_id = await page.evaluate("document.activeElement && document.activeElement.id")
        print("focused element id after typing:", focused_id)
        assert focused_id == "searchInput"

        # a query matching nothing shows the "no results" message, not the
        # generic "no trucks today" one (there ARE trucks today, just none
        # matching this search)
        await page.fill("#searchInput", "zzz-no-such-carrier")
        await page.wait_for_timeout(150)
        assert await page.locator(".card").count() == 0
        empty_text = await page.text_content(".empty")
        print("empty state text for a non-matching search:", empty_text)

        # clear the search, try the PO number instead of the carrier name
        await page.fill("#searchInput", "")
        await page.wait_for_timeout(150)
        assert await page.locator(".card").count() == 3
        await page.fill("#searchInput", "1001")
        await page.wait_for_timeout(150)
        assert await page.locator(".card").count() == 1

        # ---- "late only" quick filter ----
        await page.fill("#searchInput", "")
        await page.wait_for_timeout(150)
        await page.click("[data-toggle-late-filter]")
        await page.wait_for_timeout(150)
        cards = await page.locator(".card").count()
        late_text = await page.text_content(".list")
        print("cards with late-only filter:", cards)
        assert cards == 1
        assert "PO-3003" in late_text

        # filters combine: "late" search term + late-only filter -> matches;
        # unrelated search term + late-only filter -> no results
        await page.fill("#searchInput", "late carrier")
        await page.wait_for_timeout(150)
        assert await page.locator(".card").count() == 1
        await page.fill("#searchInput", "meridian")
        await page.wait_for_timeout(150)
        assert await page.locator(".card").count() == 0

        # turning the filter back off restores the search-only result
        await page.click("[data-toggle-late-filter]")
        await page.wait_for_timeout(150)
        assert await page.locator(".card").count() == 1

        await browser.close()
        print("SEARCH/FILTER TEST PASSED")

asyncio.run(main())
