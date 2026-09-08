import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

TRUCKS = [
    {"id":str(i), "reference_id":"T-%d"%i, "carrier":"Carrier %d"%i, "plant":"AMATA",
     "po_no":"PO-%d"%(1000+i), "order_date":TODAY, "eta":TODAY+"T08:00:00",
     "truck_state":"pending", "photos":[]}
    for i in range(30)
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

        # Scroll the list down first -- opening the sheet while scrolled is
        # exactly the scenario that used to break (scrim/sheet anchored to
        # the tall .shell instead of the viewport).
        await page.evaluate("window.scrollTo(0, 900)")
        await page.wait_for_timeout(150)

        await page.click(".card >> nth=5")
        await page.wait_for_timeout(300)

        sheet_box = await page.eval_on_selector(".sheet", """el => {
            const r = el.getBoundingClientRect();
            return {top:r.top, left:r.left, width:r.width, height:r.height};
        }""")
        vw = await page.evaluate("window.innerWidth")
        vh = await page.evaluate("window.innerHeight")
        print("sheet box:", sheet_box, "viewport:", vw, vh)

        # Theo: "la page edit doit prendre tout l'ecran ... je dois rien voir
        # d'autre que ca" -- the sheet must cover the full viewport, edge to
        # edge, regardless of how far the underlying list was scrolled.
        assert abs(sheet_box["top"]) < 2, "sheet must start at the very top of the viewport"
        assert abs(sheet_box["left"]) < 2, "sheet must start at the very left of the viewport"
        assert abs(sheet_box["width"] - vw) < 2, "sheet must span the full viewport width"
        assert abs(sheet_box["height"] - vh) < 2, "sheet must span the full viewport height"

        # The close (X) button must still be present and usable
        close_visible = await page.is_visible(".sheet-close")
        print("close button visible:", close_visible)
        assert close_visible

        # The old drag-handle bar (a bottom-sheet affordance) shouldn't be
        # visible in a true fullscreen page
        handle_visible = await page.is_visible(".sheet-handle")
        print("drag handle visible:", handle_visible)
        assert not handle_visible

        await page.click("[data-close='1']")
        await page.wait_for_timeout(300)
        sheet_count = await page.locator(".sheet").count()
        print("sheets open after close:", sheet_count)
        assert sheet_count == 0

        await browser.close()
        print("FULLSCREEN SHEET TEST PASSED")

asyncio.run(main())
