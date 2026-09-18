import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today()

def dkey(offset):
    return (TODAY + timedelta(days=offset)).isoformat()

# Round 36: client feedback (Khun Badeeson) -- "The MHE Worklist currently
# only displays shipments scheduled for the current day... please allow MHE
# to process outstanding shipments from previous days that have not yet been
# unloaded, and also allow MHE to process next-day planned shipments if they
# arrive earlier than scheduled... date navigation should be simple...
# completed shipments should be clearly identified to prevent duplicate
# processing."
#
# The driver role used to be hard-locked to today's trucks (no day tabs at
# all -- showTabs excluded "driver", listHtml()/listTableHtml() always read
# ui.dayOffset===0 in practice since nothing ever changed it, and the sheet's
# "Start unloading" button required t.date === todayKey() exactly). This
# round: MHE_DAY_WINDOW (config.js) caps the driver's OWN day tabs/nav to
# +/-1 day (previous/current/next -- "simple", not the full Admin history
# reach), effectiveDayOffset()/canStartOnDate() (render.js) apply that cap to
# both which day's trucks are listed and whether the Start button is usable,
# and a truck 2+ days out stays structurally out of reach (the nav arrow
# disables right at the +/-1 boundary, there's no way to click further).
# The pre-existing (Round 34) ongoing/completed section split and .card.
# completed styling already satisfy "clearly identified to prevent duplicate
# processing" -- this test just confirms it still applies to the driver's
# own day views, not only Admin's.

TRUCKS = [
    {"id":"t-yest","reference_id":"T-YEST","carrier":"Yesterday Co","plant":"AMATA","po_no":"PO-YEST",
     "order_date":dkey(-1),"eta":dkey(-1)+"T08:00:00","truck_state":"pending","photos":[]},
    {"id":"t-today","reference_id":"T-TODAY","carrier":"Today Co","plant":"AMATA","po_no":"PO-TODAY",
     "order_date":dkey(0),"eta":dkey(0)+"T09:00:00","truck_state":"pending","photos":[]},
    {"id":"t-done","reference_id":"T-DONE","carrier":"Done Co","plant":"AMATA","po_no":"PO-DONE",
     "order_date":dkey(0),"eta":dkey(0)+"T07:00:00","truck_state":"completed",
     "act_arrival":dkey(0)+"T07:05:00","act_dept":dkey(0)+"T08:00:00","photos":[]},
    {"id":"t-tmrw","reference_id":"T-TMRW","carrier":"Tomorrow Co","plant":"AMATA","po_no":"PO-TMRW",
     "order_date":dkey(1),"eta":dkey(1)+"T08:00:00","truck_state":"pending","photos":[]},
    {"id":"t-far","reference_id":"T-FAR","carrier":"Far Co","plant":"AMATA","po_no":"PO-FAR",
     "order_date":dkey(2),"eta":dkey(2)+"T08:00:00","truck_state":"pending","photos":[]},
]

async def handle(route, request):
    url = request.url
    method = request.method
    if "/rest/v1/trucks" in url and method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    if "/rest/v1/truck_events" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":390,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(500)
        await page.click("[data-pick-role='driver']")
        await page.wait_for_timeout(400)

        # ---- day tabs are shown at all for the driver (used to be Admin/Nestlé only) ----
        assert await page.locator(".tabs-row").count() == 1, "driver must now see the day tabs"
        assert await page.locator("[data-tab='-1']").count() == 1
        assert await page.locator("[data-tab='0']").count() == 1
        assert await page.locator("[data-tab='1']").count() == 1

        # ---- today: PO-TODAY visible + startable, PO-DONE visible but in its own completed section ----
        cards_text = await page.locator(".card").all_text_contents()
        print("today's cards:", cards_text)
        assert any("PO-TODAY" in c for c in cards_text)
        assert any("PO-DONE" in c for c in cards_text)
        section_labels = await page.locator(".section-label").all_text_contents()
        print("section labels today:", section_labels)
        assert len(section_labels) == 2, "a day with both an open and a finished truck must show the Ongoing/Completed split"
        done_card_classes = await page.locator(".card", has_text="PO-DONE").get_attribute("class")
        assert "completed" in done_card_classes, "a finished truck's card must stay visually marked done, even from the driver's own worklist"

        # ---- previous day (PO-YEST): reachable and startable ----
        await page.click("[data-tab='-1']")
        await page.wait_for_timeout(200)
        cards_text = await page.locator(".card").all_text_contents()
        print("yesterday's cards:", cards_text)
        assert any("PO-YEST" in c for c in cards_text), "MHE must see an outstanding shipment left over from the previous day"
        await page.click(".card")
        await page.wait_for_timeout(200)
        assert await page.locator("[data-start]").count() == 1, "a previous-day shipment must still be startable, not just visible"
        await page.click("[data-close]")
        await page.wait_for_timeout(150)

        # ---- capped at -1: the prev-day arrow is now disabled, no way past it ----
        assert await page.locator("[data-day-nav='-1']").get_attribute("disabled") is not None, \
            "MHE's day window is +/-1 only -- must not be able to reach 2 days back"

        # ---- next day (PO-TMRW): reachable and startable ahead of its scheduled date ----
        await page.click("[data-tab='1']")
        await page.wait_for_timeout(200)
        cards_text = await page.locator(".card").all_text_contents()
        print("tomorrow's cards:", cards_text)
        assert any("PO-TMRW" in c for c in cards_text), "MHE must be able to process a next-day shipment that arrives early"
        await page.click(".card")
        await page.wait_for_timeout(200)
        assert await page.locator("[data-start]").count() == 1, "a next-day shipment must be startable ahead of time, not just previewable"
        await page.click("[data-close]")
        await page.wait_for_timeout(150)

        # ---- capped at +1: the next-day arrow is now disabled, PO-FAR (2 days out) stays out of reach ----
        assert await page.locator("[data-day-nav='1']").get_attribute("disabled") is not None, \
            "MHE's day window is +/-1 only -- must not be able to reach 2 days ahead"
        all_cards_text = " ".join(await page.locator(".card").all_text_contents())
        assert "PO-FAR" not in all_cards_text, "a shipment 2 days out must stay outside MHE's simple +/-1 day window"

        await browser.close()
        print("MHE MULTI-DAY WORKLIST TEST PASSED")

asyncio.run(main())
