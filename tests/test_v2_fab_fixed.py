import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# A long list (40 trucks) so the page is much taller than one viewport --
# this is exactly the scenario Theo reported: "le orange + ... est fixe et
# ne defile pas en bas de l'ecran ... si on a bcp de inbound ca va pas".
TRUCKS = [
    {"id":str(i), "reference_id":"T-%d"%i, "carrier":"Carrier %d"%i, "plant":"AMATA",
     "po_no":"PO-%d"%(1000+i), "order_date":TODAY, "eta":TODAY+"T08:00:00",
     "truck_state":"pending", "photos":[]}
    for i in range(40)
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

        # Sanity: the mocked 40 trucks actually produced a page taller than
        # the viewport (otherwise this test wouldn't be exercising anything).
        doc_height = await page.evaluate("document.documentElement.scrollHeight")
        viewport_height = 700
        print("document height:", doc_height, "viewport height:", viewport_height)
        assert doc_height > viewport_height + 200, "test setup didn't produce a long page"

        box_top = await page.eval_on_selector(".fab", "el => el.getBoundingClientRect().top")
        print("fab top at scroll 0:", box_top)

        # Scroll to the very bottom of the (long) list
        await page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
        await page.wait_for_timeout(200)
        scroll_y = await page.evaluate("window.scrollY")
        box_top_scrolled = await page.eval_on_selector(".fab", "el => el.getBoundingClientRect().top")
        print("scrollY:", scroll_y, "fab top after scrolling to bottom:", box_top_scrolled)

        # The FAB's position *relative to the viewport* must stay the same
        # whether the page is scrolled or not -- that's what position:fixed
        # buys us. Before the fix (position:absolute against a growing
        # .shell) this would have jumped to some very large value scrolled
        # far below the fold instead of staying put.
        assert abs(box_top - box_top_scrolled) < 2, "FAB must stay pinned to the viewport regardless of scroll position"

        # And it must actually be within the visible viewport (not off-screen)
        assert 0 <= box_top_scrolled <= viewport_height, "FAB must be visible within the viewport"

        # It should still be clickable/functional after scrolling all the way down
        await page.click(".fab")
        await page.wait_for_timeout(300)
        add_open = await page.locator(".sheet").count()
        print("add-truck sheet opened after scroll+click:", add_open)
        assert add_open == 1

        await browser.close()
        print("FAB FIXED-POSITION TEST PASSED")

asyncio.run(main())
