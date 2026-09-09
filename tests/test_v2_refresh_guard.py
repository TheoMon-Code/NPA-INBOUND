import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# A "done" truck viewed by a DRIVER used to be exempt from the "don't
# refresh while a sheet is open" guard (isInputSheetOpen() used to only
# protect admin + still-editable trucks) -- this reproduces exactly that
# case: a driver looks at a completed truck's photos/lots/raw sections, and
# the periodic Supabase poll (every 15s) must not disrupt that view.
BASE_TRUCK = {
    "id": "22222222-2222-2222-2222-222222222222",
    "reference_id": "T-DONE1",
    "carrier": "Original Carrier",
    "plant": "AMATA",
    "po_no": "PO-DONE1",
    "order_date": TODAY,
    "eta": TODAY+"T08:00:00",
    "truck_state": "completed",
    "act_arrival": TODAY+"T08:05:00",
    "act_dept": TODAY+"T09:05:00",
    "raw": {"Extra field": "extra value"},
    "photos": []
}

POLL_COUNT = [0]

async def handle(route, request):
    url = request.url
    method = request.method
    if "/rest/v1/trucks" in url and method == "GET":
        POLL_COUNT[0] += 1
        t = dict(BASE_TRUCK)
        # From the 2nd GET onward, the "server" has a different carrier --
        # simulating another device having edited it in the meantime. If our
        # own open sheet keeps showing "Original Carrier" across several of
        # these polls, that proves the poll was correctly skipped while open.
        if POLL_COUNT[0] > 1:
            t["carrier"] = "Changed Carrier #%d" % POLL_COUNT[0]
        await route.fulfill(status=200, content_type="application/json", body=json.dumps([t]))
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        # Explicit phone-width viewport (matching every other suite here) --
        # this test is about the periodic-refresh guard, not screen width,
        # but Playwright's own default viewport (1280x720) is wide enough to
        # trigger the new wide-screen table view (Round 21, >=760px, see
        # css/app.css), under which .card is intentionally not the visible
        # markup. Not a bug in the app; just needed pinning down here like
        # everywhere else so this test keeps exercising the card view.
        page = await browser.new_page(viewport={"width":390,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(500)

        # role gate: pick Driver (no PIN)
        await page.click("[data-pick-role='driver']")
        await page.wait_for_timeout(300)

        await page.click(".card")
        await page.wait_for_timeout(300)
        carrier_at_open = await page.text_content(".sheet-carrier")
        print("carrier at open:", carrier_at_open)
        assert carrier_at_open.strip() == "Original Carrier"

        # expand the "All imported fields" <details> -- if a background
        # render() replaces the sheet while we wait, this collapses shut
        # again on its own (freshly-built HTML has no `open` attribute).
        details = page.locator("details.sheet-section")
        await details.evaluate("(el) => { el.open = true; }")
        assert await details.evaluate("(el) => el.open") is True

        # Wait past two Supabase poll intervals (15s each) while the sheet
        # stays open. Before this fix, a driver's "done"-truck sheet was NOT
        # protected, so this would have refreshed and picked up the
        # "Changed Carrier" text, and collapsed the <details> back shut.
        await page.wait_for_timeout(33000)

        carrier_still_open = await page.text_content(".sheet-carrier")
        print("carrier after 33s with sheet open:", carrier_still_open, "polls so far:", POLL_COUNT[0])
        assert carrier_still_open.strip() == "Original Carrier", "poll must not refresh an open sheet, regardless of role/status"
        assert await details.evaluate("(el) => el.open") is True, "<details> must not have been collapsed by a background render"

        # Now close the sheet and confirm the NEXT poll (already overdue,
        # skipped while we were inside) picks up the change promptly.
        await page.click("[data-close]")
        await page.wait_for_timeout(17000)
        carrier_after_close = await page.text_content(".card-carrier")
        print("carrier after closing + one more poll:", carrier_after_close)
        assert "Changed Carrier" in carrier_after_close, "poll should resume once the sheet is closed"

        await browser.close()
        print("REFRESH GUARD TEST PASSED")

asyncio.run(main())
