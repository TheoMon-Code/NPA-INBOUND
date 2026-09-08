import asyncio, json, os, re
from datetime import date
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 13: a single free-text "damage / claim" remark per truck, requested
# by Khun Badeeson (via Theo) to note e.g. which layer of the container
# damage was found on, for supplier claims. Editable any time by anyone,
# saved through a plain PATCH (damage_remark column) -- this suite covers
# the normal save path.
TRUCKS = [{
    "id": "33333333-3333-3333-3333-333333333333",
    "reference_id": "T-DMG1", "carrier": "Damage Test Carrier", "plant": "AMATA",
    "po_no": "PO-DMG1", "order_date": TODAY, "eta": TODAY+"T08:00:00",
    "truck_state": "completed", "act_arrival": TODAY+"T08:05:00", "act_dept": TODAY+"T09:05:00",
    "damage_remark": "", "photos": []
}]
PATCH_BODIES = []

async def handle(route, request):
    url = request.url
    method = request.method
    if "/rest/v1/trucks" in url and method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/trucks" in url and method == "PATCH":
        body = json.loads(request.post_data or "{}")
        PATCH_BODIES.append(body)
        TRUCKS[0].update(body)
        await route.fulfill(status=200, content_type="application/json", body=json.dumps([TRUCKS[0]]))
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

        await page.click(".card")
        await page.wait_for_timeout(300)

        remark_visible = await page.is_visible("#damageRemarkInput")
        print("remark field visible:", remark_visible)
        assert remark_visible

        await page.fill("#damageRemarkInput", "Layer 2 — 3 crushed boxes, PO-DMG1")
        await page.click("[data-save-remark]")
        await page.wait_for_selector(".toast")
        await page.wait_for_timeout(300)
        toast = await page.text_content(".toast")
        print("toast after save:", toast)
        assert ("Remark saved" in (toast or "")) or ("บันทึกหมายเหตุแล้ว" in (toast or ""))

        print("PATCH bodies:", PATCH_BODIES)
        assert len(PATCH_BODIES) == 1
        assert PATCH_BODIES[0].get("damage_remark") == "Layer 2 — 3 crushed boxes, PO-DMG1"
        assert TRUCKS[0]["damage_remark"] == "Layer 2 — 3 crushed boxes, PO-DMG1"

        # sheet stays open after saving a remark (unlike ETA, which closes it)
        assert await page.is_visible("#damageRemarkInput")

        # re-opening the sheet later shows the saved remark pre-filled
        await page.click("[data-close]")
        await page.wait_for_timeout(200)
        await page.click(".card")
        await page.wait_for_timeout(300)
        val = await page.input_value("#damageRemarkInput")
        print("remark value on reopen:", val)
        assert val == "Layer 2 — 3 crushed boxes, PO-DMG1"

        await browser.close()
        print("DAMAGE REMARK TEST PASSED")

asyncio.run(main())
