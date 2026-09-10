import asyncio, json, os, re
from datetime import date, datetime, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 23: Theo picked "TV mode: pagination/rotation" as one of the four
# ideas to build after Round 22's TV board -- a busy day (30-40 trucks) would
# otherwise just run off the bottom of a screen nobody is there to scroll.
# TV_ROWS_PER_PAGE=10 / TV_ROTATE_MS=8000 (js/config.js): 22 trucks -> 3 pages
# (10, 10, 2), rotating automatically every 8s and wrapping back to page 1.

def eta_in(minutes):
    return (datetime.now() + timedelta(minutes=minutes)).strftime("%H:%M:00")

# All 22 trucks are comfortably in the future (starting 60 minutes out, 5
# minutes apart) so every one derives to a plain "scheduled" status -- no
# late/due-soon logic to worry about, and ascending ETA sorts them in the
# exact PO-1..PO-22 order they're listed here (see sortWeight() in
# render.js), which is what makes each page's expected contents predictable.
TRUCKS = [
    {"id":str(i), "reference_id":"T-"+str(i), "carrier":"Carrier "+str(i), "plant":"AMATA",
     "po_no":"PO-"+str(i), "order_date":TODAY, "eta":TODAY+"T"+eta_in(60+5*(i-1)),
     "truck_state":"pending", "photos":[]}
    for i in range(1, 23)
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

async def page_pos(page):
    info = page.locator(".tvpageinfo")
    if await info.count() == 0:
        return None
    cur = await info.get_attribute("data-tv-page")
    total = await info.get_attribute("data-tv-total-pages")
    pos = await page.locator(".trucktable tbody tr td.mono").all_text_contents()
    return (int(cur), int(total), pos)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":1280,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE+"?tv=1")
        await page.wait_for_timeout(500)

        cur, total, pos = await page_pos(page)
        print("page 1:", cur, "/", total, pos)
        assert total == 3, "expected 22 trucks / 10 per page = 3 pages"
        assert cur == 1
        assert pos == ["PO-"+str(i) for i in range(1, 11)], "page 1 should show PO-1..PO-10"

        await page.wait_for_timeout(8500)
        cur, total, pos = await page_pos(page)
        print("page 2:", cur, "/", total, pos)
        assert cur == 2
        assert pos == ["PO-"+str(i) for i in range(11, 21)], "page 2 should show PO-11..PO-20"

        await page.wait_for_timeout(8500)
        cur, total, pos = await page_pos(page)
        print("page 3:", cur, "/", total, pos)
        assert cur == 3
        assert pos == ["PO-21", "PO-22"], "page 3 should show the remaining 2 trucks"

        await page.wait_for_timeout(8500)
        cur, total, pos = await page_pos(page)
        print("page 1 again (wrapped):", cur, "/", total, pos)
        assert cur == 1, "expected the board to wrap back to page 1 after the last page"
        assert pos == ["PO-"+str(i) for i in range(1, 11)]

        await browser.close()
        print("TV PAGINATION TEST PASSED")

asyncio.run(main())
