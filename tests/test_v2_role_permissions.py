import asyncio, json, os, re
from datetime import date
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 25: three roles behind three separate PINs (Admin MON / Admin MON IT /
# Nestlé) instead of the old single "admin" role -- see js/state.js's
# adminMonCode/adminItCode/nestleCode and the roleGateHtml() "pin"/"pin_it"/
# "pin_nestle" steps in js/render.js. This test exercises the NEW Nestlé role
# end to end: it should behave as "consultation + import + téléchargement
# seulement" -- confirmed via AskUserQuestion during the design of this round --
# with no access at all to the damage remark, ETA edit, start/finish/cancel/
# reopen, delete, photo upload, or the admin-only Reporting/app-settings
# screens. A second truck (already "unloading") checks the lifecycle buttons
# stay hidden there too, not just on a still-pending truck.
PHOTO_URL = "https://wezkonqnlkmkthbfimai.supabase.co/storage/v1/object/public/inbound-photos/TRUCK-NESTLE-1/PO-9001-aaa.jpg"
TRUCKS = [
    {
        "id": "TRUCK-NESTLE-1", "reference_id": "T-N1", "carrier": "Nestle Carrier",
        "plant": "AMATA", "po_no": "PO-9001", "order_date": TODAY, "eta": TODAY+"T10:00:00",
        "truck_state": "pending", "damage_remark": "Layer 2 crushed",
        "photos": [{"id":"p1", "url":PHOTO_URL, "storage_path":"TRUCK-NESTLE-1/PO-9001-aaa.jpg", "uploaded_by":"", "created_at":"2026-09-09T09:00:00Z"}],
    },
    {
        "id": "TRUCK-NESTLE-2", "reference_id": "T-N2", "carrier": "Nestle Carrier 2",
        "plant": "AMATA", "po_no": "PO-9002", "order_date": TODAY, "eta": TODAY+"T07:00:00",
        "truck_state": "arrived", "act_arrival": TODAY+"T07:05:00", "photos": [],
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
    if "/rest/v1/app_settings" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":390, "height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(400)

        # ---- role gate now offers Admin MON / Admin MON IT / Nestlé / Driver ----
        assert await page.locator("[data-role-step='pin']").count() == 1
        assert await page.locator("[data-role-step='pin_it']").count() == 1
        assert await page.locator("[data-role-step='pin_nestle']").count() == 1
        assert await page.locator("[data-pick-role='driver']").count() == 1

        await page.click("[data-role-step='pin_nestle']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "205918")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)

        # English, so the role-badge/label assertions below don't have to
        # match against Thai text -- only safe to click now that the role
        # gate overlay (which has its own separate data-toggle-lang button)
        # is closed, same pattern as test_v2_e2e.py.
        await page.click("[data-toggle-lang]")
        await page.wait_for_timeout(200)

        role_badge = await page.text_content("[data-role-switch]")
        print("role badge after Nestle login:", role_badge)
        assert "Nestl" in role_badge

        # ---- topbar: import + PIN-settings visible, report + app-settings + FAB hidden ----
        assert await page.locator("[data-open-import]").count() == 1, "Nestle should see the import icon"
        assert await page.locator("[data-open-pin-settings]").count() == 1, "Nestle should be able to change its own PIN"
        assert await page.locator("[data-open-report]").count() == 0, "Nestle must not see Reporting"
        assert await page.locator("[data-open-app-settings]").count() == 0, "Nestle must not see app settings"
        assert await page.locator("[data-add]").count() == 0, "Nestle must not get the manual add-truck FAB"
        assert await page.locator(".tabs-row").count() == 1, "Nestle should still get day-by-day navigation"

        # ---- pending truck: photos + download visible, no damage remark, no ETA edit, no start ----
        await page.click("[data-open='TRUCK-NESTLE-1']")
        await page.wait_for_timeout(300)
        sheet_text = await page.text_content(".sheet")
        print("pending truck sheet text:", sheet_text)
        assert "crushed" not in sheet_text, "Nestle must never see the damage remark text"
        assert await page.locator("[data-save-eta]").count() == 0, "Nestle must not be able to edit the ETA"
        assert await page.locator("[data-start]").count() == 0, "Nestle must not be able to start unloading"
        assert await page.locator("[data-download-photos]").count() == 1, "Nestle should still be able to download photos"
        assert await page.locator("[data-photo-add-camera]").count() == 0, "Nestle must not get the add-photo tiles"
        assert await page.locator("[data-photo-add-gallery]").count() == 0
        assert await page.locator("[data-photo-remove]").count() == 0, "Nestle must not be able to remove a photo"
        assert await page.locator("[data-delete]").count() == 0, "Nestle must not be able to delete a truck"
        await page.click("[data-close]")
        await page.wait_for_timeout(200)

        # ---- unloading truck: no finish/cancel buttons either ----
        await page.click("[data-open='TRUCK-NESTLE-2']")
        await page.wait_for_timeout(300)
        assert await page.locator("[data-finish]").count() == 0, "Nestle must not be able to finish unloading"
        assert await page.locator("[data-cancel]").count() == 0, "Nestle must not be able to cancel an unload"

        await browser.close()
        print("ROLE PERMISSIONS TEST PASSED")

asyncio.run(main())
