import asyncio, json, os, re
from datetime import date, datetime, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 35: the pill already shows a live elapsed counter while a truck is
# unloading ("Unloading · 00:45") and a duration once it's done
# ("Done · 1h05") -- useful for "how long has this taken", but Theo asked to
# also see the actual clock time a truck started or finished ("faudra peut
# etre aussi voir l'heure a laquelle ca a commencer ou finit"), which neither
# of those answers. actualTimesText()/actualTimeHtml() (js/render.js) read
# the same t.startedAt/t.finishedAt (act_arrival/act_dept) the pill already
# uses, just formatted as a clock time ("HH:MM") instead of a duration, and
# are added ADDITIVELY next to the existing scheduled ETA -- never replacing
# it -- on the card meta line, the admin desktop table's ETA cell, and the
# TV board's ETA cell. This checks all three surfaces, plus that a truck
# that hasn't started yet shows neither marker at all.

def eta_in(minutes):
    return (datetime.now() + timedelta(minutes=minutes)).strftime("%H:%M:00")

TRUCKS = [
    # Not yet arrived -- must show only the scheduled ETA, no ▶/⏹ at all.
    {"id":"1","reference_id":"T-1","carrier":"Aurora Freight","plant":"AMATA","po_no":"PO-PEND",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(120),"truck_state":"pending","photos":[]},
    # Currently unloading -- act_arrival set, act_dept not yet -- should show
    # a start time (▶) but no finish time (⏹).
    {"id":"2","reference_id":"T-2","carrier":"Meridian Cargo","plant":"AMATA","po_no":"PO-UNLD",
     "order_date":TODAY,"eta":TODAY+"T09:00:00","truck_state":"arrived",
     "act_arrival":TODAY+"T09:15:00","photos":[]},
    # Finished -- both act_arrival and act_dept set -- should show both.
    {"id":"3","reference_id":"T-3","carrier":"Delta Transport","plant":"AMATA","po_no":"PO-DONE",
     "order_date":TODAY,"eta":TODAY+"T08:00:00","truck_state":"completed",
     "act_arrival":TODAY+"T08:05:00","act_dept":TODAY+"T09:40:00","photos":[]},
]

async def handle(route, request):
    url = request.url
    if "/rest/v1/trucks" in url and request.method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    if "/rest/v1/app_settings" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":1024,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        # ---- admin desktop table + cards (same page, both markups exist) ----
        await page.goto(BASE)
        await page.wait_for_timeout(400)
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)

        table_text = await page.text_content(".trucktable")
        print("admin table text:", table_text)
        assert "09:15" in table_text and "▶" in table_text, "unloading truck should show its actual start time"
        assert "09:00" in table_text, "unloading truck should still show its scheduled ETA too"
        assert "08:05" in table_text and "09:40" in table_text and "⏹" in table_text, \
            "done truck should show both its actual start and finish time"

        pend_row = page.locator("tr.truckrow", has_text="PO-PEND")
        pend_text = await pend_row.text_content()
        assert "▶" not in pend_text and "⏹" not in pend_text, "a not-yet-arrived truck must show no actual time marker"

        # ---- same check on the mobile card view ----
        await page.set_viewport_size({"width":390,"height":800})
        await page.wait_for_timeout(150)
        cards_text = await page.text_content(".list")
        assert "▶ 09:15" in cards_text
        assert "▶ 08:05" in cards_text and "⏹ 09:40" in cards_text

        # ---- TV board ----
        await page.goto(BASE+"?tv=1")
        await page.wait_for_timeout(500)
        tv_text = await page.text_content(".trucktable")
        print("TV table text:", tv_text)
        assert "▶ 09:15" in tv_text
        assert "▶ 08:05" in tv_text and "⏹ 09:40" in tv_text
        tv_pend_row = page.locator(".trucktable tbody tr", has_text="PO-PEND")
        tv_pend_text = await tv_pend_row.text_content()
        assert "▶" not in tv_pend_text and "⏹" not in tv_pend_text

        await browser.close()
        print("ACTUAL TIMES TEST PASSED")

asyncio.run(main())
