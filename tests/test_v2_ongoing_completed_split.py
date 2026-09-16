import asyncio, json, os, re
from datetime import date, datetime, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 34: Theo wanted a done truck to actually stand apart from the ones
# still needing attention -- sortWeight() (js/render.js) already sorted
# "done" trucks to the bottom, but with nothing marking where today's open
# work ends and the already-handled part begins. Two changes, both covered
# here: (1) an "Ongoing"/"Completed" section header splits the list -- but
# ONLY when the day actually has both kinds, never a header with nothing to
# separate; (2) every completed card/row gets a muted ".completed"/
# ".completed-row" class regardless of whether the header shows.

def eta_in(minutes):
    return (datetime.now() + timedelta(minutes=minutes)).strftime("%H:%M:00")

MIXED_TRUCKS = [
    {"id": "1", "reference_id": "T-1", "carrier": "Aurora Freight", "plant": "AMATA",
     "po_no": "PO-OPEN1", "order_date": TODAY, "eta": TODAY+"T"+eta_in(120),
     "truck_state": "pending", "photos": []},
    {"id": "2", "reference_id": "T-2", "carrier": "Meridian Cargo", "plant": "AMATA",
     "po_no": "PO-DONE1", "order_date": TODAY, "eta": TODAY+"T08:00:00",
     "truck_state": "completed", "act_arrival": TODAY+"T08:05:00", "act_dept": TODAY+"T08:40:00",
     "photos": []},
]

ALL_OPEN_TRUCKS = [
    {"id": "3", "reference_id": "T-3", "carrier": "Aurora Freight", "plant": "AMATA",
     "po_no": "PO-OPEN2", "order_date": TODAY, "eta": TODAY+"T"+eta_in(120),
     "truck_state": "pending", "photos": []},
]

STATE = {"trucks": MIXED_TRUCKS}

async def handle(route, request):
    url = request.url
    if "/rest/v1/trucks" in url and request.method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(STATE["trucks"]))
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":390,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        # ---- a day with BOTH an open and a completed truck ----
        await page.goto(BASE)
        await page.wait_for_timeout(400)
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)

        # The app defaults to Thai (ui.lang), so the section labels render in
        # Thai here too unless toggled -- checking Thai text either confirms
        # the translation key actually resolved, so it's kept as-is rather
        # than switching to English first.
        labels = await page.locator(".list-cards .section-label").all_text_contents()
        print("section labels (mixed day, card view):", labels)
        assert labels == ["กำลังดำเนินการ", "เสร็จแล้ว"], "expected both headers, in this order, only when both kinds are present"

        cards_html = await page.locator(".list-cards").inner_html()
        assert "PO-DONE1" in cards_html and "PO-OPEN1" in cards_html

        completed_card = page.locator(".card.completed")
        assert await completed_card.count() == 1, "exactly the done truck's card should carry .completed"
        assert "PO-DONE1" in (await completed_card.text_content())

        open_card_completed = await page.locator(".card:not(.completed)").text_content()
        assert "PO-OPEN1" in open_card_completed and "PO-DONE1" not in open_card_completed

        # ---- same split on the desktop table ----
        await page.set_viewport_size({"width":1024,"height":800})
        await page.wait_for_timeout(150)
        section_rows = await page.locator(".trucktable tbody tr.tablesectionrow").all_text_contents()
        print("section rows (mixed day, table view):", section_rows)
        assert section_rows == ["กำลังดำเนินการ", "เสร็จแล้ว"]
        assert await page.locator(".trucktable tbody tr.truckrow.completed-row").count() == 1
        completed_row_text = await page.locator(".trucktable tbody tr.truckrow.completed-row").text_content()
        assert "PO-DONE1" in completed_row_text

        # ---- an all-open day: no header at all, nothing muted ----
        # The role/PIN is already remembered (localStorage) from the login
        # above, so a reload lands straight back in the list -- no need to
        # log in again.
        STATE["trucks"] = ALL_OPEN_TRUCKS
        await page.set_viewport_size({"width":390,"height":800})
        await page.reload()
        await page.wait_for_timeout(500)

        labels_open_only = await page.locator(".list-cards .section-label").count()
        print("section label count (all-open day):", labels_open_only)
        assert labels_open_only == 0, "a day with only one kind must show no section header at all"
        assert await page.locator(".card.completed").count() == 0

        await browser.close()
        print("ONGOING/COMPLETED SPLIT TEST PASSED")

asyncio.run(main())
