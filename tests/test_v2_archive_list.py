import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today()
def d(offset): return (TODAY + timedelta(days=offset)).isoformat()

# Round 27: Admin "Archive" screen (js/archiveList.js) -- browses actual
# trucks (not aggregated KPIs, see test_v2_reporting.py for that) over a
# picked date range, further back than the live day view. Deliberately
# read-only (see js/archiveList.js's own top comment): this covers the
# archive query itself, the date-range guard, and that rows render with
# their real fields -- not any click-to-open behavior, since there isn't one.
LIVE_TRUCKS = []  # the live +/-MAX_DAY_OFFSET window is empty; archive looks further back
ARCHIVE_ROWS = [
    {"order_date": d(-20), "eta": "2026-01-01T08:00:00", "carrier": "Old Carrier Co",
     "plant": "AMATA", "po_no": "PO-OLD1", "truck_label": None, "details": "Steel coils",
     "qtt": "500 pcs", "truck_state": "completed", "act_arrival": None, "act_dept": None,
     "damage_remark": "Layer 1 dented"},
    {"order_date": d(-15), "eta": "2026-01-01T09:00:00", "carrier": "Another Co",
     "plant": "BANGPAKONG", "po_no": "PO-OLD2", "truck_label": "PO-OLD2 - Truck 1",
     "details": "Resin pellets", "qtt": "20000 KG", "truck_state": "pending",
     "act_arrival": None, "act_dept": None, "damage_remark": ""},
]

seen_archive_urls = []

async def handle(route, request):
    url = request.url
    if "/rest/v1/trucks" in url and request.method == "GET":
        if "select=order_date,eta,carrier,plant,po_no,truck_label" in url:
            seen_archive_urls.append(url)
            await route.fulfill(status=200, content_type="application/json", body=json.dumps(ARCHIVE_ROWS))
        else:
            await route.fulfill(status=200, content_type="application/json", body=json.dumps(LIVE_TRUCKS))
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":390, "height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(400)
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)

        await page.click("[data-open-archive-list]")
        await page.wait_for_timeout(200)

        from_val = await page.input_value("#archive-list-from")
        to_val = await page.input_value("#archive-list-to")
        print("default archive range:", from_val, "..", to_val)
        # wide enough by default to actually cover more than the live window
        assert from_val <= d(-13)

        # widen it to cover both archived rows above, then run
        await page.fill("#archive-list-from", d(-25))
        await page.click("[data-run-archive-list]")
        await page.wait_for_timeout(400)

        assert seen_archive_urls, "expected the archive-list query to fire"
        assert ("order_date=gte."+d(-25)) in seen_archive_urls[-1]

        text = await page.text_content(".sheet")
        print("archive sheet text:", text)
        assert "PO-OLD1" in text and "Old Carrier Co" in text and "Steel coils" in text
        assert "PO-OLD2 - Truck 1" in text  # truck_label preferred over bare po_no
        assert "⚠" in text  # damage badge on the first row only

        # ---- from > to rejected client-side ----
        await page.fill("#archive-list-from", d(1))
        await page.fill("#archive-list-to", d(-1))
        seen_archive_urls.clear()
        await page.click("[data-run-archive-list]")
        await page.wait_for_timeout(300)
        assert not seen_archive_urls, "must not query the server with an inverted date range"

        # ---- no truck sheet is ever openable from this screen (read-only) ----
        assert await page.locator("[data-open]").count() == 0

        await browser.close()
        print("ARCHIVE LIST TEST PASSED")

asyncio.run(main())
