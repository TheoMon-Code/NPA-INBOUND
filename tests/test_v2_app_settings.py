import asyncio, json, os, re
from datetime import date, datetime, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 23: the fourth idea Theo picked -- an Admin screen to adjust the five
# operational thresholds (grace period, photo cap, day-nav range, due-soon
# window, undo-delete window) without a code change, first raised and left
# aside back at Round 17. Backed by a single shared Supabase row
# (app_settings, id=1) rather than per-device localStorage, specifically so
# every phone agrees on what counts as "late" (see js/settings.js's own
# comment for the reasoning). This test covers: defaults pre-filling the form
# from an empty app_settings table (graceful degradation, same pattern as
# trucks.raw/lots/damage_remark), a save actually reaching Supabase with the
# right endpoint/header/body, the change applying live with no reload, and a
# failed save surfacing an error without losing the open sheet.

def eta_in(minutes):
    return (datetime.now() + timedelta(minutes=minutes)).strftime("%H:%M:00")

TRUCK_ID = "77777777-7777-7777-7777-777777777771"
TRUCKS = [{
    # 10 minutes past ETA: comfortably "scheduled" under the default 20-minute
    # grace period, but "late" the moment grace drops to 5 -- the whole point
    # of this fixture is to make the settings change visibly change something.
    "id": TRUCK_ID, "reference_id": "T-SET", "carrier": "Settings Co", "plant": "AMATA",
    "po_no": "PO-SETTINGS", "order_date": TODAY, "eta": TODAY+"T"+eta_in(-10),
    "truck_state": "pending", "photos": [],
}]

captured = {"save_requests": []}
fail_next_save = {"on": False}

async def handle(route, request):
    url = request.url
    method = request.method
    if "/rest/v1/trucks" in url and method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/photos" in url and method == "GET":
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    if "/rest/v1/app_settings" in url and method == "GET":
        # Simulates a Supabase project that has run the new SQL (table
        # exists) but has no row yet -- the graceful-fallback path the
        # comment above describes, distinct from a missing table entirely.
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    if "/rest/v1/app_settings" in url and method == "POST":
        captured["save_requests"].append({
            "url": url,
            "prefer": request.headers.get("prefer"),
            "body": json.loads(request.post_data or "{}"),
        })
        if fail_next_save["on"]:
            await route.fulfill(status=500, content_type="application/json", body=json.dumps({"message":"boom"}))
        else:
            await route.fulfill(status=201, content_type="application/json", body=json.dumps([{"id":1}]))
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def pill_class(page):
    return await page.get_attribute(".pill", "class")

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":390,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(500)

        # ---- admin login (the settings icon is admin-only) ----
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(300)

        before = await pill_class(page)
        print("pill class before any change:", before)
        assert "late" not in before, "10 minutes past ETA should be within the default 20-minute grace"

        # ---- open the settings screen, defaults pre-filled from config.js ----
        assert await page.is_visible("[data-open-app-settings]")
        await page.click("[data-open-app-settings]")
        await page.wait_for_timeout(200)
        grace_val = await page.input_value("#setting-graceMin")
        print("graceMin pre-filled from defaults:", grace_val)
        assert grace_val == "20", "with no app_settings row, the field must show config.js's default (20)"

        # ---- change it and save ----
        await page.fill("#setting-graceMin", "5")
        await page.click("[data-save-settings]")
        await page.wait_for_timeout(300)

        assert len(captured["save_requests"]) == 1, "saving should POST exactly once"
        req = captured["save_requests"][0]
        print("save request:", req)
        assert "on_conflict=id" in req["url"]
        assert req["prefer"] == "resolution=merge-duplicates,return=representation"
        saved = req["body"]["settings"]
        for key in ("graceMin", "maxPhotosPerTruck", "maxDayOffset", "dueSoonMin", "undoDeleteMs"):
            assert key in saved, "saved settings body should include every SETTINGS_DEFS key, missing "+key
        assert saved["graceMin"] == 5

        # ---- applies live, no reload ----
        after = await pill_class(page)
        print("pill class right after saving:", after)
        assert "late" in after, "dropping grace to 5 minutes should make a truck 10 minutes past ETA show as late immediately"
        assert await page.locator("[data-save-settings]").count() == 0, "the settings sheet should close on a successful save"

        # ---- a failed save keeps the sheet open and shows the error ----
        fail_next_save["on"] = True
        await page.click("[data-open-app-settings]")
        await page.wait_for_timeout(200)
        await page.fill("#setting-graceMin", "7")
        await page.click("[data-save-settings]")
        await page.wait_for_timeout(300)
        still_open = await page.locator("[data-save-settings]").count()
        err_text = await page.text_content(".sheet .hint[style*='bad']")
        print("after failed save -- sheet still open:", still_open, "error text:", err_text)
        assert still_open == 1, "a failed save must not close the settings sheet"
        assert err_text and "boom" in err_text, "the Supabase error message should surface in the sheet"

        await browser.close()
        print("APP SETTINGS TEST PASSED")

asyncio.run(main())
