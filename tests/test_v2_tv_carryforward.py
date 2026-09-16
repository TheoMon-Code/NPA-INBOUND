import asyncio, json, os, re
from datetime import date, datetime, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()
YESTERDAY = (date.today() - timedelta(days=1)).isoformat()
THREE_DAYS_AGO = (date.today() - timedelta(days=3)).isoformat()
TOMORROW = (date.today() + timedelta(days=1)).isoformat()

# Round 34: Theo's exact worry after seeing the TV board -- "si y a des
# trucks de la veille qui sont en retard on les voit pas et ca peut etre un
# probleme" (a truck from the day before that's still late just disappears
# once the date rolls over). Rather than a fixed "yesterday only" cutoff
# (which just relocates the same silent-disappearance risk by one day, and
# staff sometimes forget to update a truck for a while), the TV board now
# carries forward ANY not-"done" truck regardless of how old it is -- see
# tvVisibleTrucks() in js/render.js. This also exercises the derive() fix
# (js/status.js) that makes a truck whose whole scheduled day has already
# passed read as "late" instead of quietly "scheduled".

def eta_in(minutes):
    return (datetime.now() + timedelta(minutes=minutes)).strftime("%H:%M:00")

TRUCKS = [
    # Today, still open -- must show, ordinary case.
    {"id":"1","reference_id":"T-1","carrier":"Today Co","plant":"AMATA","po_no":"PO-TODAY",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(120),"truck_state":"pending","photos":[]},
    # Yesterday, still pending -- the case Theo flagged: must be carried
    # forward onto the board, and must read as "late" (not "scheduled").
    {"id":"2","reference_id":"T-2","carrier":"Forgotten Co","plant":"AMATA","po_no":"PO-YESTERDAY-OPEN",
     "order_date":YESTERDAY,"eta":YESTERDAY+"T09:00:00","truck_state":"pending","photos":[]},
    # Three days ago, still unloading -- no age cutoff, so this must show too.
    {"id":"3","reference_id":"T-3","carrier":"VeryLate Co","plant":"AMATA","po_no":"PO-OLD-OPEN",
     "order_date":THREE_DAYS_AGO,"eta":THREE_DAYS_AGO+"T09:00:00","truck_state":"arrived","act_arrival":THREE_DAYS_AGO+"T09:05:00","photos":[]},
    # Yesterday, but already completed -- must NOT show; carrying forward is
    # only for unfinished trucks.
    {"id":"4","reference_id":"T-4","carrier":"Done Co","plant":"AMATA","po_no":"PO-YESTERDAY-DONE",
     "order_date":YESTERDAY,"eta":YESTERDAY+"T08:00:00","truck_state":"completed",
     "act_arrival":YESTERDAY+"T08:05:00","act_dept":YESTERDAY+"T08:40:00","photos":[]},
    # Tomorrow -- must never leak onto a board meant for today + carried-over.
    {"id":"5","reference_id":"T-5","carrier":"Future Co","plant":"AMATA","po_no":"PO-TOMORROW",
     "order_date":TOMORROW,"eta":TOMORROW+"T09:00:00","truck_state":"pending","photos":[]},
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
        page = await browser.new_page(viewport={"width":1280,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE+"?tv=1")
        await page.wait_for_timeout(500)

        table_text = await page.text_content(".trucktable")
        assert "PO-TODAY" in table_text, "today's own truck must still show"
        assert "PO-YESTERDAY-OPEN" in table_text, "an open truck from yesterday must be carried forward"
        assert "PO-OLD-OPEN" in table_text, "an open truck from 3 days ago must still be carried forward (no age cutoff)"
        assert "PO-YESTERDAY-DONE" not in table_text, "a completed truck from yesterday must NOT be carried forward"
        assert "PO-TOMORROW" not in table_text, "tomorrow's truck must never appear"

        # ---- carried-forward rows read as "late" (not "scheduled"), and
        #      show their own date next to the time so they don't look like
        #      an ordinary same-day row ----
        rows = await page.evaluate("""
          () => Array.from(document.querySelectorAll('.trucktable tbody tr')).map(tr => ({
            text: tr.textContent, hasAlert: tr.classList.contains('tvalert')
          }))
        """)
        old_row = next(r for r in rows if "PO-YESTERDAY-OPEN" in r["text"])
        print("carried-forward row:", old_row)
        assert old_row["hasAlert"], "a carried-forward open truck should pulse like any other late truck"
        yesterday_short = (date.today() - timedelta(days=1)).strftime("%d/%m")
        assert "09:00" in old_row["text"], "expected the truck's own ETA time to still show"
        assert yesterday_short in old_row["text"], \
            "expected the row to show its own (past) date ("+yesterday_short+") next to the time"

        await browser.close()
        print("TV CARRYFORWARD TEST PASSED")

asyncio.run(main())
