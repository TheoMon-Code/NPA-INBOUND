import asyncio, json, os, re
from datetime import date
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 13: Khun Badeeson asked for at least 40 photos per truck (they often
# need many photos per shipment). Confirms MAX_PHOTOS_PER_TRUCK actually
# reads as 40 in the running app: the "+" add slot must still show at 39
# photos and disappear once a truck already has 40.
def truck_with_n_photos(n, tid, po):
    return {
        "id": tid, "reference_id": "T-"+po, "carrier": "Photo Cap Carrier", "plant": "AMATA",
        "po_no": po, "order_date": TODAY, "eta": TODAY+"T08:00:00", "truck_state": "completed",
        "act_arrival": TODAY+"T08:05:00", "act_dept": TODAY+"T09:05:00",
        "photos": [{"id":"p%d"%i, "url":"https://example.com/p%d.jpg"%i, "storage_path":"x/p%d.jpg"%i} for i in range(n)]
    }

TRUCKS = [
    truck_with_n_photos(39, "55555555-5555-5555-5555-555555555551", "PO-CAP39"),
    truck_with_n_photos(40, "55555555-5555-5555-5555-555555555552", "PO-CAP40"),
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
        page = await browser.new_page()
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(500)
        await page.click("[data-pick-role='driver']")
        await page.wait_for_timeout(300)

        cards = page.locator(".card")
        await cards.nth(0).click()
        await page.wait_for_timeout(300)
        hint = await page.text_content(".photogrid ~ .hint, .hint")
        add_visible_39 = await page.is_visible(".photoslot.add")
        print("39-photo truck: add slot visible:", add_visible_39)
        assert add_visible_39, "at 39/40 photos the add slot must still be offered"

        await page.click("[data-close]")
        await page.wait_for_timeout(200)
        await cards.nth(1).click()
        await page.wait_for_timeout(300)
        add_visible_40 = await page.is_visible(".photoslot.add")
        print("40-photo truck: add slot visible:", add_visible_40)
        assert not add_visible_40, "at the 40-photo cap the add slot must disappear"

        photos_hint_text = await page.text_content(".sheet-section .hint")
        print("hint text (should mention 40):", photos_hint_text)

        await browser.close()
        print("PHOTO CAP 40 TEST PASSED")

asyncio.run(main())
