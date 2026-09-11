import asyncio, json, os, re
from datetime import date
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 27: an optional signature captured on a <canvas> (see
# signatureHtml() in render.js and the pointer-event delegation in
# events.js) -- covers: drawing + saving reaches Supabase with a PNG data
# URL, the sheet switches to showing the saved image afterward, "Sign
# again" goes back to a blank canvas, and the same graceful-degradation
# message as damage_remark (test_v2_damage_remark_missing_column.py) when
# the "signature" column hasn't been migrated in yet.

TRUCK_ID = "55555555-5555-5555-5555-555555555555"
TRUCK = {
    "id": TRUCK_ID, "reference_id": "T-SIG", "carrier": "Signature Co", "plant": "AMATA",
    "po_no": "PO-SIG", "order_date": TODAY, "eta": TODAY+"T08:00:00",
    "truck_state": "completed", "act_arrival": TODAY+"T08:05:00", "act_dept": TODAY+"T09:05:00",
    "signature": None, "photos": [],
}

captured = {"patch_body": None}

async def make_handler(missing_column):
    # A successful save must show up on the very next GET (loadFromSupabase()
    # re-syncs right after every write) -- mutating this dict in place, rather
    # than always returning the original fixture, is what lets the test also
    # confirm the sheet actually switches to showing the saved image.
    current = dict(TRUCK)
    async def handle(route, request):
        url = request.url
        method = request.method
        if "/rest/v1/trucks" in url and method == "GET":
            await route.fulfill(status=200, content_type="application/json", body=json.dumps([current]))
            return
        if "/rest/v1/trucks" in url and method == "PATCH":
            body = json.loads(request.post_data or "{}")
            if "signature" in body:
                captured["patch_body"] = body
                if missing_column:
                    await route.fulfill(
                        status=400, content_type="application/json",
                        body=json.dumps({"message": "Could not find the 'signature' column of 'trucks' in the schema cache"})
                    )
                    return
                current["signature"] = body["signature"]
                await route.fulfill(status=200, content_type="application/json", body=json.dumps([current]))
                return
            await route.fulfill(status=200, content_type="application/json", body=json.dumps([current]))
            return
        if "/rest/v1/photos" in url:
            await route.fulfill(status=200, content_type="application/json", body="[]")
            return
        await route.fulfill(status=404, body="not mocked: "+url)
    return handle

async def draw_a_stroke(page):
    box = await page.locator("#signatureCanvas").bounding_box()
    x, y = box["x"], box["y"]
    await page.mouse.move(x + 20, y + 20)
    await page.mouse.down()
    await page.mouse.move(x + 80, y + 60, steps=5)
    await page.mouse.move(x + 140, y + 30, steps=5)
    await page.mouse.up()

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)

        # ---- success path ----
        page = await browser.new_page(viewport={"width":390,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), await make_handler(missing_column=False))

        await page.goto(BASE)
        await page.wait_for_timeout(400)
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)
        await page.click(".card")
        await page.wait_for_timeout(300)

        # no signature saved yet -> straight into draw mode
        assert await page.locator("#signatureCanvas").count() == 1
        assert await page.locator(".signature-preview").count() == 0

        await draw_a_stroke(page)
        await page.click("[data-save-signature]")
        await page.wait_for_timeout(500)

        assert captured["patch_body"] is not None
        sig = captured["patch_body"]["signature"]
        print("saved signature data URL prefix:", sig[:30])
        assert sig.startswith("data:image/png;base64,")

        # after saving, the sheet shows the saved image, not the blank canvas
        assert await page.locator(".signature-preview").count() == 1
        assert await page.locator("#signatureCanvas").count() == 0
        toast = await page.text_content(".toast")
        print("toast after save:", toast)

        # "Sign again" goes back to draw mode
        await page.click("[data-edit-signature]")
        await page.wait_for_timeout(150)
        assert await page.locator("#signatureCanvas").count() == 1

        await page.close()

        # ---- missing-column graceful degradation ----
        captured["patch_body"] = None
        page2 = await browser.new_page(viewport={"width":390,"height":800})
        page2.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page2.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), await make_handler(missing_column=True))

        await page2.goto(BASE)
        await page2.wait_for_timeout(400)
        await page2.click("[data-role-step='pin']")
        await page2.wait_for_timeout(150)
        await page2.fill("#pinInput", "748231")
        await page2.click("[data-pin-submit]")
        await page2.wait_for_timeout(400)
        await page2.click(".card")
        await page2.wait_for_timeout(300)

        await draw_a_stroke(page2)
        await page2.click("[data-save-signature]")
        await page2.wait_for_selector(".toast")
        await page2.wait_for_timeout(300)
        toast2 = await page2.text_content(".toast")
        print("toast (column missing):", toast2)
        assert "signature" in (toast2 or "") and ("ISD" in (toast2 or "") or "ทีม ISD" in (toast2 or ""))
        # the drawing must stay on screen (canvas, not the view mode) since
        # nothing was actually saved
        assert await page2.locator("#signatureCanvas").count() == 1

        await browser.close()
        print("SIGNATURE PAD TEST PASSED")

asyncio.run(main())
