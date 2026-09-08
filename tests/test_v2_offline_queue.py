import asyncio, json, os, re
from datetime import date
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

TRUCKS = [
    {"id":"1", "reference_id":"T-1", "carrier":"Carrier A", "plant":"AMATA",
     "po_no":"PO-1001", "order_date":TODAY, "eta":TODAY+"T08:00:00",
     "truck_state":"pending", "photos":[]},
]

# Toggled by the test itself rather than Playwright's context.set_offline():
# set_offline() has no effect on a request that's already intercepted by
# page.route() (the route handler runs instead of ever touching the real
# network), so it can't be used to simulate "network unreachable" against a
# fully-mocked backend. route.abort() is what actually makes the page's own
# fetch() reject -- exactly what api.js's sbRest() tags as networkFailure.
NETWORK_DOWN = [False]

async def handle(route, request):
    url = request.url; method = request.method
    if "/rest/v1/trucks" in url and method == "PATCH" and NETWORK_DOWN[0]:
        await route.abort("failed")
        return
    if "/rest/v1/trucks" in url and method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/trucks" in url and method == "PATCH":
        m = re.search(r"id=eq\.([^&]+)", url)
        tid = m.group(1) if m else None
        state_m = re.search(r"truck_state=eq\.([^&]+)", url)
        expected_state = state_m.group(1) if state_m else None
        body = json.loads(request.post_data or "{}")
        matched = []
        for row in TRUCKS:
            if row.get("id") == tid and (expected_state is None or row.get("truck_state") == expected_state):
                row.update(body); matched.append(row)
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(matched))
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        context = await browser.new_context(viewport={"width":390, "height":700})
        page = await context.new_page()
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(400)
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)

        # ---- go offline, then tap Start on the one truck ----
        NETWORK_DOWN[0] = True
        await page.click(".card")
        await page.wait_for_timeout(200)
        await page.click("[data-start]")
        await page.wait_for_timeout(500)

        toast = await page.text_content(".toast")
        print("toast while offline:", toast)
        assert "จะส่งเมื่อกลับมามีสัญญาณ" in (toast or ""), "expected the 'queued, will send later' toast, got: "+repr(toast)

        badge = await page.text_content(".queuebadge")
        print("queue badge:", badge)
        assert badge and "1" in badge, "expected a '1 pending' badge while the action is queued"

        # the mock never actually saw the PATCH (network was down at the
        # browser level) -- truck must still show as "pending" server-side
        assert TRUCKS[0]["truck_state"] == "pending", "truck must NOT have been patched while offline"

        # ---- back online: the queued Start should replay automatically ----
        NETWORK_DOWN[0] = False
        await page.evaluate("window.dispatchEvent(new Event('online'))")
        await page.wait_for_timeout(800)

        print("truck_state after reconnect:", TRUCKS[0]["truck_state"])
        assert TRUCKS[0]["truck_state"] == "arrived", "queued Start should have replayed once back online"
        assert TRUCKS[0].get("act_arrival"), "the original arrival timestamp captured while offline must have been sent, not lost"

        badge_after = await page.query_selector(".queuebadge")
        print("badge present after flush:", badge_after is not None)
        assert badge_after is None, "pending badge should be gone once the queue is empty"

        flushed_toast = await page.text_content(".toast")
        print("toast after flush:", flushed_toast)
        assert "1" in (flushed_toast or ""), "expected a toast confirming 1 offline action was synced"

        await browser.close()
        print("OFFLINE QUEUE TEST PASSED")

asyncio.run(main())
