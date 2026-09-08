import asyncio, json, os, re
from datetime import date
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Chromium's Emulation.setSafeAreaInsetsOverride (CDP) simulates a real
# phone's notch / status-bar overlay -- this is what "display": "standalone"
# (home-screen install) exposes to CSS env(safe-area-inset-*). This test
# proves the topbar's own content clears that inset now, instead of being
# overlapped by it as reported ("le bandeau bleu en haut est coupe").
TRUCKS = [{
    "id": "id-1", "reference_id": "T-1", "carrier": "Carrier",
    "plant": "AMATA", "po_no": "PO-1", "order_date": TODAY,
    "eta": TODAY+"T08:00:00", "truck_state": "pending", "photos": []
}]

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
        page = await browser.new_page()
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)
        await page.set_viewport_size({"width": 390, "height": 844})

        client = await page.context.new_cdp_session(page)
        SAFE_TOP = 44  # typical iPhone notch/status-bar height in CSS px
        await client.send("Emulation.setSafeAreaInsetsOverride", {
            "insets": {"top": SAFE_TOP, "left": 0, "bottom": 34, "right": 0}
        })

        await page.goto(BASE)
        await page.wait_for_timeout(500)
        await page.click("[data-pick-role='driver']")
        await page.wait_for_timeout(400)

        topbar_top = await page.evaluate("document.querySelector('.topbar').getBoundingClientRect().top")
        brand_word_top = await page.evaluate("document.querySelector('.brand-word').getBoundingClientRect().top")
        computed_padding_top = await page.evaluate(
            "getComputedStyle(document.querySelector('.topbar')).paddingTop"
        )
        print("topbar top:", topbar_top, "brand-word top:", brand_word_top, "computed padding-top:", computed_padding_top)

        # The header's actual content (brand name / clock) must start at or
        # below the simulated status bar -- i.e. env(safe-area-inset-top)
        # must actually have been folded into the topbar's padding.
        assert topbar_top == 0, "topbar itself should still start at the viewport edge (its background fills behind the status bar)"
        assert brand_word_top >= SAFE_TOP, (
            "header content must clear the simulated status bar/notch (top=%.1f, need >= %d) -- "
            "this is the 'bandeau bleu coupe' bug if it fails" % (brand_word_top, SAFE_TOP)
        )
        # sanity: padding-top should be noticeably larger than the pre-fix
        # flat 14px, proving env(safe-area-inset-top) actually contributed.
        assert float(computed_padding_top.replace("px","")) >= SAFE_TOP, (
            "computed padding-top (%s) should incorporate the %dpx safe-area inset" % (computed_padding_top, SAFE_TOP)
        )

        await browser.close()
        print("SAFE AREA TOP TEST PASSED")

asyncio.run(main())
