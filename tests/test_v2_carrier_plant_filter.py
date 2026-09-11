import asyncio, json, os, re
from datetime import date
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 27: structured carrier/plant dropdown filters, alongside the existing
# free-text search (test_v2_search_filter.py) -- three trucks spanning two
# plants and three carriers so both selects have something real to narrow.
TRUCKS = [
    {"id":"1","reference_id":"T-1","carrier":"Aurora Freight","plant":"AMATA","po_no":"PO-1001",
     "order_date":TODAY,"eta":TODAY+"T09:00:00","truck_state":"pending","photos":[]},
    {"id":"2","reference_id":"T-2","carrier":"Meridian Cargo","plant":"AMATA","po_no":"PO-2002",
     "order_date":TODAY,"eta":TODAY+"T10:00:00","truck_state":"pending","photos":[]},
    {"id":"3","reference_id":"T-3","carrier":"Meridian Cargo","plant":"BANGPAKONG","po_no":"PO-3003",
     "order_date":TODAY,"eta":TODAY+"T11:00:00","truck_state":"pending","photos":[]},
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

        assert await page.locator(".card").count() == 3

        # ---- options are exactly what's on today's list, plus "All" ----
        carrier_opts = await page.locator("#filterCarrierSelect option").all_text_contents()
        plant_opts = await page.locator("#filterPlantSelect option").all_text_contents()
        print("carrier options:", carrier_opts)
        print("plant options:", plant_opts)
        assert set(carrier_opts[1:]) == {"Aurora Freight", "Meridian Cargo"}
        assert set(plant_opts[1:]) == {"AMATA", "BANGPAKONG"}

        # ---- selecting a carrier narrows the list ----
        await page.select_option("#filterCarrierSelect", "Meridian Cargo")
        await page.wait_for_timeout(150)
        cards = await page.locator(".card").count()
        print("cards after carrier=Meridian Cargo:", cards)
        assert cards == 2

        # ---- combined with a plant filter, narrows further (AND, not OR) ----
        await page.select_option("#filterPlantSelect", "BANGPAKONG")
        await page.wait_for_timeout(150)
        text = await page.text_content(".list")
        cards = await page.locator(".card").count()
        print("cards after also plant=BANGPAKONG:", cards, text)
        assert cards == 1
        assert "PO-3003" in text

        # ---- back to "All" on both restores the full list ----
        await page.select_option("#filterCarrierSelect", "")
        await page.select_option("#filterPlantSelect", "")
        await page.wait_for_timeout(150)
        assert await page.locator(".card").count() == 3

        await browser.close()
        print("CARRIER/PLANT FILTER TEST PASSED")

asyncio.run(main())
