import asyncio, json, os, re
from datetime import date, datetime, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 34, two more TV-board requests from Theo:
#
# 1. "Si le inbound est finit ou completed, on peut... une vraie separation"
#    (asked earlier for the admin table/cards, then: "Oui le mode TV ne va
#    pas faut le faire je pense" -- the same Ongoing/Completed split +
#    muting needed to reach the TV board too. Done per-page here (see
#    renderTv() in js/render.js), since a page is small enough (<=10 rows)
#    that the split never needs to look across pages.
#
# 2. "Il faut que les colonnes soient celle en thai aussi pour soucis de
#    concordance" -- Theo saw English column headers on a board he expected
#    in Thai, traced to this device's own saved ui.lang (EN/TH is a
#    per-browser localStorage preference, see js/storage.js's loadLang()).
#    ?lang=th|en (js/main.js) now overrides it for one page load so the TV
#    link can force a specific language no matter what an earlier admin left
#    that device set to.

def eta_in(minutes):
    return (datetime.now() + timedelta(minutes=minutes)).strftime("%H:%M:00")

MIXED_TRUCKS = [
    {"id":"1","reference_id":"T-1","carrier":"Aurora Freight","carrier_th":"ออโรร่า","plant":"AMATA","po_no":"PO-OPEN1",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(120),"truck_state":"pending","photos":[]},
    {"id":"2","reference_id":"T-2","carrier":"Meridian Cargo","carrier_th":"เมอริเดียน","plant":"AMATA","po_no":"PO-DONE1",
     "order_date":TODAY,"eta":TODAY+"T08:00:00","truck_state":"completed",
     "act_arrival":TODAY+"T08:05:00","act_dept":TODAY+"T08:40:00","photos":[]},
]

async def handle(route, request):
    url = request.url
    if "/rest/v1/trucks" in url and request.method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(MIXED_TRUCKS))
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

        # ---- ?lang=en forces English regardless of the default (Thai) ----
        await page.goto(BASE+"?tv=1&lang=en")
        await page.wait_for_timeout(500)

        headers = await page.locator(".trucktable thead th").all_text_contents()
        print("TV column headers (lang=en):", headers)
        assert headers == ["Status", "PO / Ref", "Carrier", "Thai name", "Plant", "ETA", "Product / Qty"], \
            "expected English column headers with ?lang=en (incl. the new Thai-name column), " \
            "regardless of this browser's stored ui.lang"

        # (not .first -- with both Ongoing/Completed present the very first
        # tbody row is the "Ongoing" section divider, not a truck row)
        open_row_text = await page.locator(".trucktable tbody tr", has_text="PO-OPEN1").text_content()
        assert "ออโรร่า" in open_row_text, "expected the carrier's Thai name in its own column"

        section_rows = await page.locator(".trucktable tbody tr.tablesectionrow").all_text_contents()
        print("TV section rows (lang=en):", section_rows)
        assert section_rows == ["Ongoing", "Completed"], "expected both section headers, in this order"

        assert await page.locator(".trucktable tbody tr.tv-completed").count() == 1, \
            "exactly the completed truck's row should carry .tv-completed"
        completed_text = await page.locator(".trucktable tbody tr.tv-completed").text_content()
        assert "PO-DONE1" in completed_text

        legend_text = await page.locator(".tvbannerlegend").text_content()
        assert "Done" in legend_text and "Late" in legend_text, "banner legend should also be in English"

        # ---- ?lang=th forces Thai, same board ----
        await page.goto(BASE+"?tv=1&lang=th")
        await page.wait_for_timeout(500)
        headers_th = await page.locator(".trucktable thead th").all_text_contents()
        print("TV column headers (lang=th):", headers_th)
        assert headers_th[0] == "สถานะ" and headers_th[3] == "ชื่อภาษาไทย" and headers_th[5] == "เวลานัด", \
            "expected Thai column headers with ?lang=th"

        await browser.close()
        print("TV SPLIT + LANG OVERRIDE TEST PASSED")

asyncio.run(main())
