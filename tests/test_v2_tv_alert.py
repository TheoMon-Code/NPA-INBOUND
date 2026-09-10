import asyncio, json, os, re
from datetime import date, datetime, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 23: the second of the two TV-mode ideas Theo picked -- a persistent
# pulsing highlight on any row that needs attention (late, or "urgent" i.e.
# no ETA at all on a truck due today), rather than a one-off flash at the
# instant it happens, precisely because nobody is watching the board
# continuously (see the .tvalert CSS/tvRowHtml() comments in render.js/
# css/app.css for why a continuous cue was chosen over a transition flash).

def eta_in(minutes):
    return (datetime.now() + timedelta(minutes=minutes)).strftime("%H:%M:00")

TRUCKS = [
    # Comfortably late (grace is 20min by default) -- should pulse.
    {"id":"1","reference_id":"T-1","carrier":"Late Co","plant":"AMATA","po_no":"PO-LATE",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(-60),"truck_state":"pending","photos":[]},
    # No ETA at all, due today -- "urgent", should also pulse.
    {"id":"2","reference_id":"T-2","carrier":"Urgent Co","plant":"AMATA","po_no":"PO-URGENT",
     "order_date":TODAY,"eta":None,"truck_state":"pending","photos":[]},
    # Comfortably on schedule -- should NOT pulse.
    {"id":"3","reference_id":"T-3","carrier":"OnTime Co","plant":"AMATA","po_no":"PO-ONTIME",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(180),"truck_state":"pending","photos":[]},
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

        rows = await page.evaluate("""
          () => Array.from(document.querySelectorAll('.trucktable tbody tr')).map(tr => ({
            text: tr.textContent,
            hasAlert: tr.classList.contains('tvalert'),
            animationName: getComputedStyle(tr).animationName
          }))
        """)
        by_po = {}
        for r in rows:
            for po in ("PO-LATE", "PO-URGENT", "PO-ONTIME"):
                if po in r["text"]:
                    by_po[po] = r
        print("rows:", by_po)

        assert by_po["PO-LATE"]["hasAlert"], "a late truck should carry the tvalert class"
        assert by_po["PO-LATE"]["animationName"] == "tvalertpulse"
        assert by_po["PO-URGENT"]["hasAlert"], "an urgent (no-ETA) truck should also carry tvalert"
        assert by_po["PO-URGENT"]["animationName"] == "tvalertpulse"
        assert not by_po["PO-ONTIME"]["hasAlert"], "an on-schedule truck must not pulse"
        assert by_po["PO-ONTIME"]["animationName"] == "none"

        await browser.close()
        print("TV ALERT TEST PASSED")

asyncio.run(main())
