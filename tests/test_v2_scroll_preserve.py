import asyncio, json, os, re
from datetime import date
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Enough trucks that the list is actually taller than the viewport and worth
# scrolling -- the periodic background re-render (every ~15s) used to reset
# window scroll to the top every time it fired, which is the "violent"
# jump reported while just browsing the list (no sheet open at all).
TRUCKS = [
    {
        "id": "id-%d" % i, "reference_id": "T-%d" % i, "carrier": "Carrier %d" % i,
        "plant": "AMATA", "po_no": "PO-%d" % i, "order_date": TODAY,
        "eta": TODAY+"T08:%02d:00" % (i % 60), "truck_state": "pending", "photos": []
    }
    for i in range(30)
]

async def handle(route, request):
    url = request.url
    method = request.method
    if "/rest/v1/trucks" in url and method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page()
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)
        await page.set_viewport_size({"width": 390, "height": 700})

        await page.goto(BASE)
        await page.wait_for_timeout(500)
        await page.click("[data-pick-role='driver']")
        await page.wait_for_timeout(400)

        await page.evaluate("window.scrollTo(0, 600)")
        await page.wait_for_timeout(100)
        y_before = await page.evaluate("window.scrollY")
        print("scrollY before wait:", y_before)
        assert y_before > 0, "test setup: page must actually be scrollable and scrolled"

        # Wait past a periodic re-render (every ~15 ticks == ~15s, see
        # ticking.js) with nothing else going on.
        await page.wait_for_timeout(17000)

        y_after = await page.evaluate("window.scrollY")
        print("scrollY after 17s:", y_after)
        assert abs(y_after - y_before) < 5, "scroll position must survive the periodic background re-render"

        await browser.close()
        print("SCROLL PRESERVE TEST PASSED")

asyncio.run(main())
