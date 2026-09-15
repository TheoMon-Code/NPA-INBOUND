import asyncio, json, os, re
from datetime import date, datetime, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 33: Theo spotted two trucks sharing a carrier+date+time slot but with
# DIFFERENT po_no values -- "4563428496#1"/"4563428496#2", a container-
# numbering convention some suppliers already write into their own PO
# reference column in the source file. Those never got their product/qty
# shown under the PO on the card/table/TV views, because that line only
# checked for an app-assigned truckLabel (importAssignLabels() in
# importPlan.js only sets truckLabel when po_no is IDENTICAL across a shared
# slot -- see its Round 26/30 comments). Since two "#1"/"#2" containers can
# easily hold different products or quantities, this looked identical at a
# glance. looksLikeSiblingRef() in js/render.js now also treats a po_no
# ending in "#<n>" as reason to show that line -- WITHOUT changing
# truckLabel/grouping/dedupe for these rows at all (confirmed below: they
# stay two independent trucks, no "Truck N" label appears).
#
# A plain single-container PO (no "#", no shared slot) must still show
# nothing extra, exactly as before -- the whole point of Round 24/26 was to
# not clutter the common case.
def eta_at(hhmm):
    return TODAY+"T"+hhmm+":00"

TRUCKS = [
    {
        "id": "1", "reference_id": "T-1", "carrier": "MC Croker", "plant": "AMATA",
        "po_no": "4563428496#1", "details": "Beef trim", "qtt": "1200 KG",
        "order_date": TODAY, "eta": eta_at("09:00"), "truck_state": "pending", "photos": []
    },
    {
        "id": "2", "reference_id": "T-2", "carrier": "MC Croker", "plant": "AMATA",
        "po_no": "4563428496#2", "details": "Beef offal", "qtt": "800 KG",
        "order_date": TODAY, "eta": eta_at("09:00"), "truck_state": "pending", "photos": []
    },
    {
        "id": "3", "reference_id": "T-3", "carrier": "Aurora Freight", "plant": "AMATA",
        "po_no": "PO-5001", "details": "Widgets", "qtt": "42 pcs",
        "order_date": TODAY, "eta": eta_at("11:00"), "truck_state": "pending", "photos": []
    },
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

        # ---- card view (phone width) ----
        cards_text = await page.locator(".list-cards").text_content()
        print("cards text:", cards_text)
        assert "Beef trim" in cards_text and "1200 KG" in cards_text, \
            "a '#1' po_no truck should show its product/qty on the card"
        assert "Beef offal" in cards_text and "800 KG" in cards_text, \
            "a '#2' po_no truck should show its product/qty on the card"
        assert "Widgets" not in cards_text, \
            "a plain single-container PO must NOT show product/qty (no clutter for the common case)"

        # neither #1/#2 truck should have picked up an app-assigned
        # "Truck N" label -- looksLikeSiblingRef() must not have touched
        # truckLabel/grouping at all, only whether the details line renders.
        assert "Truck 1" not in cards_text and "Truck 2" not in cards_text

        # ---- desktop table ----
        await page.set_viewport_size({"width":1024,"height":800})
        await page.wait_for_timeout(150)
        table_text = await page.text_content(".trucktable")
        print("table text:", table_text)
        assert "Beef trim" in table_text and "1200 KG" in table_text
        assert "Beef offal" in table_text and "800 KG" in table_text
        assert "Widgets" not in table_text

        await browser.close()
        print("HASH PO DETAILS TEST PASSED")

asyncio.run(main())
