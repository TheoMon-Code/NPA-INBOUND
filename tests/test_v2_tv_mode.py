import asyncio, json, os, re
from datetime import date, datetime, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()
TOMORROW = (date.today() + timedelta(days=1)).isoformat()

# Round 22: Theo, right after seeing the Round 21 redesign deployed --
# "Faudra que tu mettes in mode TV" -- a fixed, read-only board for a
# screen mounted in the warehouse/office (closer to what MON's Outbound
# admin tool already has). Enabled purely by a URL flag (?tv=1, see
# ui.tvMode in js/main.js/js/state.js) so the one device permanently
# pointed at that screen just always loads that URL -- no role picker, no
# PIN, no search/filters/KPI tiles/"+" button, and no clickable rows, since
# nobody is meant to touch this screen at all. This checks that everything
# admin/driver-only stays gone, that only TODAY's trucks show (a tomorrow
# truck must not leak in), that clicking a row does nothing (renderTv() in
# js/render.js never puts data-open on a TV row), and that the status
# legend is permanently visible here (a follow-up from Theo: "le status
# description doit etre obligatoirement visible" -- unlike the collapsible
# one in the normal admin/driver view, there's nobody around to tap it
# open on a wall-mounted screen).

TRUCKS = [
    {"id":"1","reference_id":"T-1","carrier":"Aurora Freight","plant":"AMATA","po_no":"PO-9101",
     "order_date":TODAY,"eta":TODAY+"T14:00:00","truck_state":"pending","photos":[]},
    {"id":"2","reference_id":"T-2","carrier":"Late Carrier Co","plant":"AMATA","po_no":"PO-9102",
     "order_date":TODAY,"eta":"1999-01-01T00:00:00","truck_state":"pending","photos":[]},
    # Tomorrow -- must NOT appear on a board that only ever shows today.
    {"id":"3","reference_id":"T-3","carrier":"Tomorrow Freight","plant":"AMATA","po_no":"PO-9103",
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
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":1280,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE+"?tv=1")
        await page.wait_for_timeout(500)

        # ---- no role gate, no PIN screen, ever ----
        assert await page.locator(".rolegate").count() == 0, "TV mode must never show the role/PIN gate"

        # ---- nothing admin/driver-only leaks onto the board ----
        assert await page.locator("#searchInput").count() == 0, "no search bar in TV mode"
        assert await page.locator(".kpi").count() == 0, "no KPI tiles in TV mode"
        assert await page.locator(".fab").count() == 0, "no '+' add button in TV mode"
        assert await page.locator(".card").count() == 0, "TV mode has no card view at all"

        # ---- the status legend IS shown here, and it's permanently visible
        #      (a plain div, not a <details> someone would have to tap open --
        #      there's nobody there to tap it) ----
        legend = page.locator(".tvlegend")
        assert await legend.count() == 1, "expected the status legend to be present on the TV board"
        assert await legend.is_visible(), "the TV board's legend must be visible without any interaction"
        assert await page.locator(".tvlegend details").count() == 0, "TV legend must not be a collapsible <details>"
        # There's no language toggle on the TV board (nothing is interactive),
        # so this stays language-agnostic (the app defaults to Thai) and just
        # checks the structure: one row per status kind, same swatch classes
        # used everywhere else (.pill/.stripe/.legendswatch all line up).
        rows = await legend.locator(".legendrow").count()
        assert rows == 7, "expected one legend row per status kind (incl. duesoon)"
        for cls in ["pending","urgent","scheduled","duesoon","late","unloading","done"]:
            assert await legend.locator(".legendswatch."+cls).count() == 1, "missing legend swatch for "+cls

        # ---- body carries the tvmode class the CSS scales up from ----
        has_class = await page.evaluate("document.body.classList.contains('tvmode')")
        assert has_class, "expected body.tvmode for the TV-mode CSS to apply"

        # ---- only today's 2 trucks show, not tomorrow's ----
        rows = await page.locator(".trucktable tbody tr").count()
        print("TV board rows:", rows)
        assert rows == 2, "expected only today's trucks on the board"
        table_text = await page.text_content(".trucktable")
        assert "PO-9101" in table_text and "PO-9102" in table_text
        assert "PO-9103" not in table_text, "tomorrow's truck must not appear on the board"

        # ---- the refresh countdown still works here (same #id as elsewhere) ----
        assert await page.locator("#pollCountdownEl").count() == 1

        # ---- a row is not clickable: no sheet should ever open ----
        await page.locator(".trucktable tbody tr").first.click()
        await page.wait_for_timeout(300)
        assert await page.locator(".sheet").count() == 0, "clicking a TV-mode row must do nothing"

        await browser.close()
        print("TV MODE TEST PASSED")

asyncio.run(main())
