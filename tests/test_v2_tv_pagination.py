import asyncio, json, os, re
from datetime import date, datetime, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 23: Theo picked "TV mode: pagination/rotation" as one of the four
# ideas to build after Round 22's TV board -- a busy day (30-40 trucks) would
# otherwise just run off the bottom of a screen nobody is there to scroll.
# TV_ROWS_PER_PAGE=10: 22 trucks -> 3 pages (10, 10, 2), rotating
# automatically and wrapping back to page 1.
#
# Round 34: the real rotation interval (TV_ROTATE_MS, js/config.js) went from
# 8s to 20s (Theo: "ca change de tab trop vite"), which would triple this
# test's real-time waits -- ?rotateMs=1500 (see ui.tvRotateMsOverride in
# js/state.js / main.js) asks tvTick() to rotate on a short test-only
# interval instead, the same pattern already used for ?pollMs= on the
# Supabase poll interval. tvTick() itself only runs once a second (piggy-
# backed on the 1s clock tick, see js/ticking.js), so the actual rotation
# period seen from outside drifts a bit around rotateMs (Date.now()-based,
# only checked once a second) -- rather than guess a fixed sleep per page
# (a wait even a little too long silently skips straight past the next page
# to the one after it), this polls for the page indicator to actually change
# instead, with a generous timeout.

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

async def wait_for_page(page, expected_cur, timeout_ms=8000, step_ms=250):
    """Polls page_pos() until data-tv-page reads expected_cur, instead of
    guessing a fixed sleep -- the rotation period drifts around rotateMs
    (see the Round 34 comment above), so a fixed wait tends to either miss
    the transition or overshoot straight past it."""
    waited = 0
    result = await page_pos(page)
    while result is None or result[0] != expected_cur:
        if waited >= timeout_ms:
            raise AssertionError("timed out waiting for TV page "+str(expected_cur)+", last seen: "+str(result))
        await page.wait_for_timeout(step_ms)
        waited += step_ms
        result = await page_pos(page)
    return result

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":1280,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE+"?tv=1&rotateMs=1500")
        await page.wait_for_timeout(800)

        cur, total, pos = await page_pos(page)
        print("page 1:", cur, "/", total, pos)
        assert total == 3, "expected 22 trucks / 10 per page = 3 pages"
        assert cur == 1
        assert pos == ["PO-"+str(i) for i in range(1, 11)], "page 1 should show PO-1..PO-10"

        cur, total, pos = await wait_for_page(page, 2)
        print("page 2:", cur, "/", total, pos)
        assert pos == ["PO-"+str(i) for i in range(11, 21)], "page 2 should show PO-11..PO-20"

        cur, total, pos = await wait_for_page(page, 3)
        print("page 3:", cur, "/", total, pos)
        assert pos == ["PO-21", "PO-22"], "page 3 should show the remaining 2 trucks"

        cur, total, pos = await wait_for_page(page, 1)
        print("page 1 again (wrapped):", cur, "/", total, pos)
        assert pos == ["PO-"+str(i) for i in range(1, 11)]

        await browser.close()
        print("TV PAGINATION TEST PASSED")

asyncio.run(main())
