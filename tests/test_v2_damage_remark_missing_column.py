import asyncio, json, os, re
from datetime import date
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Same graceful-degradation idea as the "raw"/"lots" columns (Rounds 7/10):
# if a Supabase project hasn't run the "damage_remark" column migration yet,
# saving a remark must fail with a clear ISD-facing message instead of a
# raw/confusing PostgREST error -- and, unlike raw/lots (where *something*
# still gets saved), nothing here is saved, so the message must not claim
# it was.
TRUCKS = [{
    "id": "44444444-4444-4444-4444-444444444444",
    "reference_id": "T-DMG2", "carrier": "No Column Carrier", "plant": "AMATA",
    "po_no": "PO-DMG2", "order_date": TODAY, "eta": TODAY+"T08:00:00",
    "truck_state": "completed", "act_arrival": TODAY+"T08:05:00", "act_dept": TODAY+"T09:05:00",
    "photos": []
}]

async def handle(route, request):
    url = request.url
    method = request.method
    if "/rest/v1/trucks" in url and method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/trucks" in url and method == "PATCH":
        body = json.loads(request.post_data or "{}")
        if "damage_remark" in body:
            await route.fulfill(
                status=400, content_type="application/json",
                body=json.dumps({"message": "Could not find the 'damage_remark' column of 'trucks' in the schema cache"})
            )
            return
        await route.fulfill(status=200, content_type="application/json", body=json.dumps([TRUCKS[0]]))
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        # Explicit phone-width viewport -- Playwright's own default
        # (1280x720) is wide enough to trigger the wide-screen table view
        # added in Round 21 (>=760px, see css/app.css), under which .card
        # is intentionally not the visible markup. Not a bug in the app;
        # this test is about something else and just needs pinning down
        # to the card view like every other suite here.
        page = await browser.new_page(viewport={"width":390,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(500)
        await page.click("[data-pick-role='driver']")
        await page.wait_for_timeout(300)
        await page.click(".card")
        await page.wait_for_timeout(300)

        await page.fill("#damageRemarkInput", "Layer 1 damage")
        await page.click("[data-save-remark]")
        await page.wait_for_selector(".toast")
        await page.wait_for_timeout(300)
        toast = await page.text_content(".toast")
        print("toast (column missing):", toast)
        assert ("damage_remark" in (toast or "")) and ("ISD" in (toast or "") or "ทีม ISD" in (toast or ""))
        assert "saved" not in (toast or "").lower() or "not save" in (toast or "").lower() or "ยังบันทึก" in (toast or "")

        await browser.close()
        print("DAMAGE REMARK MISSING-COLUMN TEST PASSED")

asyncio.run(main())
