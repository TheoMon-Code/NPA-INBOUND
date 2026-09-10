import asyncio, json, os, re
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"

# Round 25: the single shared "adminCode" became three role-specific PIN
# codes (adminMonCode/adminItCode/nestleCode -- see js/state.js). A device
# that already had the OLD seed shape (just "adminCode", no adminMonCode)
# must keep working with its existing PIN under the Admin MON role, and
# must still get sensible fresh defaults for the two brand-new roles it
# never had before. This test serves a hand-edited index.html with the
# pre-Round-25 seed shape (simulating an old cached copy of the page) to
# exercise state.js's migration branch, rather than the normal seed already
# shipped in this repo's own index.html.
LEGACY_PIN = "554433"

async def handle_index(route, request):
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "..", "index.html"), "r", encoding="utf-8") as f:
        body = f.read()
    legacy_seed = '<script id="app-data" type="application/json">{"seq":10,"trucks":[],"adminCode":"'+LEGACY_PIN+'"}</script>'
    body = re.sub(r'<script id="app-data".*?</script>', legacy_seed, body, count=1)
    assert "adminMonCode" not in body, "test setup bug: legacy seed substitution failed"
    await route.fulfill(status=200, content_type="text/html", body=body)

async def handle_supabase(route, request):
    url = request.url
    if "/rest/v1/trucks" in url and request.method == "GET":
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    if "/rest/v1/photos" in url or "/rest/v1/app_settings" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":390, "height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(BASE, handle_index)
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle_supabase)

        await page.goto(BASE)
        await page.wait_for_timeout(400)

        # ---- the OLD PIN value (carried over from "adminCode") still unlocks Admin MON ----
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", LEGACY_PIN)
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(300)
        # English, so the role-badge assertions below don't have to match
        # against Thai text -- only safe now that the role-gate overlay
        # (its own separate data-toggle-lang button) is closed.
        await page.click("[data-toggle-lang]")
        await page.wait_for_timeout(200)
        role_badge = await page.text_content("[data-role-switch]")
        print("role badge after legacy-PIN login:", role_badge)
        assert "Admin" in role_badge and "IT" not in role_badge, "the migrated PIN should log in as plain Admin MON, not Admin MON IT"

        # ---- switch away, confirm the fresh default PINs work for the two new roles ----
        await page.click("[data-role-switch]")
        await page.wait_for_timeout(150)
        await page.click("[data-role-step='pin_it']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "913647")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(300)
        role_badge_it = await page.text_content("[data-role-switch]")
        print("role badge after Admin IT default-PIN login:", role_badge_it)
        assert "IT" in role_badge_it, "the fresh default Admin MON IT PIN should work on a migrated device"

        await page.click("[data-role-switch]")
        await page.wait_for_timeout(150)
        await page.click("[data-role-step='pin_nestle']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "205918")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(300)
        role_badge_nestle = await page.text_content("[data-role-switch]")
        print("role badge after Nestle default-PIN login:", role_badge_nestle)
        assert "Nestl" in role_badge_nestle, "the fresh default Nestle PIN should work on a migrated device"

        # ---- the OLD PIN value must NOT also work for the new roles ----
        await page.click("[data-role-switch]")
        await page.wait_for_timeout(150)
        await page.click("[data-role-step='pin_it']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", LEGACY_PIN)
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(300)
        err = await page.text_content(".rolegate .hint")
        print("error shown for legacy PIN on Admin IT step:", err)
        assert err, "the old adminCode value must not also unlock Admin MON IT"

        await browser.close()
        print("PIN MIGRATION TEST PASSED")

asyncio.run(main())
