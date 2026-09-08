import asyncio, json, os, re
from datetime import date
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

TRUCKS = [
    {"id":"1", "reference_id":"T-1", "carrier":"Carrier A", "plant":"AMATA",
     "po_no":"PO-1001", "order_date":TODAY, "eta":TODAY+"T08:00:00",
     "truck_state":"pending", "photos":[]},
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
        # A wide desktop-sized viewport -- this is exactly the case Theo
        # reported: "sur le web le bouton est pas placer au bon endroit"
        # (fine on phone). The app has no actual narrow centered "shell"
        # column (that CSS rule turned out to be dead code, never applied
        # to any real element) -- content genuinely fills the whole window
        # edge to edge on desktop too, so the FAB must sit flush against
        # the REAL right edge of the viewport, not some hypothetical
        # centered-480px-column edge.
        page = await browser.new_page(viewport={"width":1920, "height":1000})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(400)
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)

        vw = await page.evaluate("window.innerWidth")
        fab_box = await page.eval_on_selector(".fab", """el => {
            const r = el.getBoundingClientRect();
            return {right:r.right, left:r.left};
        }""")
        gap_from_edge = vw - fab_box["right"]
        print("viewport width:", vw, "fab box:", fab_box, "gap from right edge:", gap_from_edge)

        # The button must sit close to the real right edge of the (full-width)
        # window, not drift to the middle of a 1920px-wide screen.
        assert gap_from_edge < 30, "FAB must hug the real right edge on wide/desktop screens too, not float mid-page"

        await browser.close()
        print("FAB DESKTOP-WIDTH TEST PASSED")

asyncio.run(main())
