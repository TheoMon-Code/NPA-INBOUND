import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today()

def dkey(offset):
    return (TODAY + timedelta(days=offset)).isoformat()

TRUCKS = [
    {"id":"1","reference_id":"T-1","carrier":"Carrier A","plant":"AMATA","po_no":"PO-1001",
     "order_date":dkey(0),"eta":dkey(0)+"T08:00:00","truck_state":"pending","photos":[]},
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
        page = await browser.new_page()
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(400)
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(300)

        # today tab active by default, no date pill
        today_active = await page.get_attribute("[data-tab='0']", "class")
        print("today tab class at start:", today_active)
        assert "active" in today_active
        assert await page.locator(".tab-dateinfo").count() == 0

        # Round 15: arrows now step ONE day per click (was a straight jump to
        # +/-5, which skipped every day in between -- Theo: "il faut les
        # dates entre, la ca va pas"). Confirm every intermediate day (+1
        # through +5) is individually reachable. Offsets +1/-1 coincide with
        # the Tomorrow/Yesterday quick tabs (no pill, that tab lights up
        # instead) -- only offsets beyond {-1,0,1} show the date pill.
        for step in range(1, 6):
            await page.click("[data-day-nav='1']")
            await page.wait_for_timeout(120)
            if step == 1:
                tomorrow_class = await page.get_attribute("[data-tab='1']", "class")
                print("at +1, tomorrow tab class:", tomorrow_class)
                assert "active" in tomorrow_class
                assert await page.locator(".tab-dateinfo").count() == 0
            else:
                pill = await page.text_content(".tab-dateinfo")
                expected = dkey(step)[8:10] + "/" + dkey(step)[5:7]
                print("date pill after +%d step:" % step, pill, "expected:", expected)
                assert pill.strip() == expected, "must land on every intermediate day, offset %d" % step
                assert await page.locator(".tab.active").count() == 0

        # at +5, forward arrow is now disabled, and one more (forced) click
        # must not overshoot past the clamp
        plus_disabled = await page.get_attribute("[data-day-nav='1']", "disabled")
        print("+ button disabled at max:", plus_disabled is not None)
        assert plus_disabled is not None
        await page.click("[data-day-nav='1']", force=True)
        await page.wait_for_timeout(120)
        pill_overshoot = await page.text_content(".tab-dateinfo")
        assert pill_overshoot.strip() == dkey(5)[8:10] + "/" + dkey(5)[5:7], "must clamp at +5, not overshoot"

        # back to today via quick tab, then step backward one day at a time
        await page.click("[data-tab='0']")
        await page.wait_for_timeout(150)
        for step in range(1, 6):
            await page.click("[data-day-nav='-1']")
            await page.wait_for_timeout(120)
            if step == 1:
                yesterday_class = await page.get_attribute("[data-tab='-1']", "class")
                print("at -1, yesterday tab class:", yesterday_class)
                assert "active" in yesterday_class
                assert await page.locator(".tab-dateinfo").count() == 0
            else:
                pill = await page.text_content(".tab-dateinfo")
                expected = dkey(-step)[8:10] + "/" + dkey(-step)[5:7]
                print("date pill after -%d step:" % step, pill, "expected:", expected)
                assert pill.strip() == expected, "must land on every intermediate day, offset -%d" % step
        minus_disabled = await page.get_attribute("[data-day-nav='-1']", "disabled")
        assert minus_disabled is not None

        # jump back to yesterday/tomorrow quick tabs still work and clear the pill
        await page.click("[data-tab='1']")
        await page.wait_for_timeout(150)
        assert await page.locator(".tab-dateinfo").count() == 0
        tomorrow_active = await page.get_attribute("[data-tab='1']", "class")
        assert "active" in tomorrow_active

        await browser.close()
        print("DAY NAV TEST PASSED")

asyncio.run(main())
