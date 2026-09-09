import asyncio, json, os, re
from datetime import date
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 21: a manager compared this app to MON's Outbound admin tool, which
# shows a visible "next refresh in mm:ss" countdown -- Inbound's own poll
# (SUPABASE_POLL_MS, 15s) already ran silently in the background since Round
# 16, this just makes it visible. The countdown text is updated directly by
# tick() every second (js/ticking.js), deliberately NOT through the periodic
# full render() (which only runs every ~15 ticks, see Round 11) -- routing a
# once-a-second DOM write through a full #app rebuild would be wasteful and,
# worse, would silently collapse anything not specifically preserved across
# render() (scroll position and input focus/selection are, see Round 11/17 --
# but an open <details> element, like the new status legend, is NOT). This
# test checks both: the countdown itself ticks down, and something render()
# does NOT know how to preserve (an open <details>) survives several seconds
# of it ticking -- proving the countdown updates are NOT going through
# render().

TRUCK = {
    "id": "1", "reference_id": "T-1", "carrier": "Aurora Freight", "plant": "AMATA",
    "po_no": "PO-9001", "order_date": TODAY, "eta": TODAY+"T23:59:00",
    "truck_state": "pending", "photos": [],
}

async def handle(route, request):
    url = request.url
    if "/rest/v1/trucks" in url and request.method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps([TRUCK]))
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

def parse_mmss(txt):
    m, s = txt.strip().split(":")
    return int(m)*60 + int(s)

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

        countdown = page.locator("#pollCountdownEl")
        assert await countdown.count() == 1, "expected a visible refresh countdown once Supabase is enabled"
        initial_txt = await countdown.text_content()
        print("initial countdown text:", initial_txt)
        assert re.match(r"^\d{2}:\d{2}$", initial_txt or ""), "expected mm:ss format"
        initial_sec = parse_mmss(initial_txt)
        # SUPABASE_POLL_MS is 15000 -- the very first value should be at or
        # just under 15s, never above it and never wildly under.
        assert 10 <= initial_sec <= 15, "expected the initial countdown to start near the 15s poll interval"

        # Open the status legend -- something a full render() would NOT know
        # how to keep open (unlike scroll/focus, see Round 11/17).
        await page.click(".statuslegend summary")
        await page.wait_for_timeout(150)
        assert await page.get_attribute(".statuslegend", "open") is not None, "legend should be open right after tapping it"

        await page.wait_for_timeout(3200)
        later_txt = await countdown.text_content()
        print("countdown text ~3s later:", later_txt)
        later_sec = parse_mmss(later_txt)
        assert later_sec < initial_sec, "countdown should have ticked down after ~3 seconds"
        assert (initial_sec - later_sec) <= 5, "should have moved by roughly the elapsed time, not jumped/reset"

        # The legend must still be open -- if the countdown update were
        # secretly routed through render() every second, this <details>
        # would have been rebuilt shut long before this point.
        assert await page.get_attribute(".statuslegend", "open") is not None, \
            "status legend should still be open -- the countdown tick must not be doing a full render()"

        await browser.close()
        print("REFRESH COUNTDOWN TEST PASSED")

asyncio.run(main())
