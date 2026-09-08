import asyncio, json, os, re
from datetime import date
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

TRUCKS = [
    {"id":"t1","reference_id":"T-1","carrier":"Aurora Freight","plant":"AMATA","po_no":"PO-9001",
     "order_date":TODAY,"eta":TODAY+"T08:00:00","truck_state":"pending","photos":[]},
]
DELETE_CALLS = []

async def handle(route, request):
    url = request.url
    method = request.method
    if "/rest/v1/trucks" in url and method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/trucks" in url and method == "DELETE":
        DELETE_CALLS.append(url)
        for t in list(TRUCKS):
            TRUCKS.remove(t)
        await route.fulfill(status=204)
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

        assert await page.locator(".card").count() == 1

        await page.click(".card")
        await page.wait_for_timeout(200)
        await page.click("[data-delete]")
        await page.wait_for_timeout(150)
        await page.click("[data-delete-confirm]")
        await page.wait_for_timeout(200)

        # truck hidden from the list right away, but nothing sent yet
        assert await page.locator(".card").count() == 0
        undo_btn = page.locator("[data-undo-delete]")
        assert await undo_btn.count() == 1
        toast_text = await page.text_content(".toast")
        print("undo toast text:", toast_text)
        assert "PO-9001" in toast_text

        # ---- tap Undo before the window elapses ----
        await undo_btn.click()
        await page.wait_for_timeout(200)
        assert await page.locator(".card").count() == 1, "truck must reappear once undone"
        assert await page.locator(".toast").count() == 0, "undo toast should be gone"

        # give the (canceled) timer a chance to fire anyway, to make sure
        # undo really canceled it rather than just hiding the toast
        await page.wait_for_timeout(5300)
        print("DELETE calls sent despite Undo:", DELETE_CALLS)
        assert not DELETE_CALLS, "must never call DELETE once the pending delete was undone"
        assert await page.locator(".card").count() == 1
        assert len(TRUCKS) == 1

        await browser.close()
        print("DELETE UNDO TEST PASSED")

asyncio.run(main())
