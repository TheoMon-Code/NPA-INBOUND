import asyncio, json, os, re
from datetime import date
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 23: the third of the four ideas Theo picked -- tapping a photo
# thumbnail used to just open the raw Storage URL in a new tab (a dead end
# on a phone, no zoom, no way to flip to the next photo). Now it opens an
# in-app fullscreen viewer (photoViewerHtml() in render.js) with prev/next,
# click-to-zoom, and Escape/ArrowLeft/ArrowRight keyboard support. This test
# also confirms the admin-only remove "✕" -- a DOM sibling of the thumbnail
# button, never a descendant -- can never accidentally open the viewer too.

# Data URIs rather than real URLs -- this sandbox's egress proxy blocks
# arbitrary external hosts, and a photo whose image never loads renders with
# no intrinsic size, which makes Playwright treat it as "not visible" and
# time out on the click-to-zoom step below. A tiny inline SVG (a distinct
# fill color per photo, just so a human reading a failure screenshot could
# tell them apart) sidesteps that entirely.
def svg_photo(color):
    return "data:image/svg+xml,"+("<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'>"
                                    "<rect width='100' height='100' fill='"+color+"'/></svg>")

TRUCK_ID = "66666666-6666-6666-6666-666666666661"
PHOTOS = [
    {"id": "p0", "url": svg_photo("red"), "storage_path": "x/p0.jpg"},
    {"id": "p1", "url": svg_photo("green"), "storage_path": "x/p1.jpg"},
    {"id": "p2", "url": svg_photo("blue"), "storage_path": "x/p2.jpg"},
]
TRUCKS = [{
    "id": TRUCK_ID, "reference_id": "T-VIEW", "carrier": "Viewer Co", "plant": "AMATA",
    "po_no": "PO-VIEW", "order_date": TODAY, "eta": TODAY+"T08:00:00", "truck_state": "completed",
    "act_arrival": TODAY+"T08:05:00", "act_dept": TODAY+"T09:05:00", "photos": PHOTOS,
}]

async def handle(route, request):
    url = request.url
    if "/rest/v1/trucks" in url and request.method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/photos" in url and request.method == "GET":
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    if "/rest/v1/app_settings" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    # removePhoto's DELETE (and any storage call) isn't the point of this
    # test -- fulfill with a generic failure so removePhoto's .catch() runs
    # cleanly instead of an unmocked request hanging.
    await route.fulfill(status=404, body="not mocked: "+url)

async def counter(page):
    if await page.locator(".photoviewer-count").count() == 0:
        return None
    return await page.text_content(".photoviewer-count")

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":390,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(500)

        # ---- admin login (remove "✕" only shows for admin) ----
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(300)

        await page.click(".card")
        await page.wait_for_timeout(300)

        # ---- open the first thumbnail ----
        await page.click("[data-view-photo][data-view-index='0']")
        await page.wait_for_timeout(200)
        assert await page.is_visible(".photoviewer"), "viewer should open on thumbnail tap"
        src = await page.get_attribute(".photoviewer-img", "src")
        cnt = await counter(page)
        print("opened at index 0:", src, cnt)
        assert src == PHOTOS[0]["url"]
        assert cnt == "1 / 3"

        # ---- next ----
        await page.click("[data-photo-viewer-next]")
        await page.wait_for_timeout(150)
        src = await page.get_attribute(".photoviewer-img", "src")
        cnt = await counter(page)
        print("after next:", src, cnt)
        assert src == PHOTOS[1]["url"]
        assert cnt == "2 / 3"

        # ---- prev twice: back to index 0, then wrap to index 2 ----
        await page.click("[data-photo-viewer-prev]")
        await page.wait_for_timeout(150)
        cnt = await counter(page)
        print("after prev 1:", cnt)
        assert cnt == "1 / 3"

        await page.click("[data-photo-viewer-prev]")
        await page.wait_for_timeout(150)
        src = await page.get_attribute(".photoviewer-img", "src")
        cnt = await counter(page)
        print("after prev 2 (wrap):", src, cnt)
        assert src == PHOTOS[2]["url"]
        assert cnt == "3 / 3", "prev from the first photo should wrap to the last"

        # ---- click-to-zoom toggles the .zoomed class ----
        zoomed_before = "zoomed" in (await page.get_attribute(".photoviewer-img", "class") or "")
        await page.click(".photoviewer-img")
        await page.wait_for_timeout(100)
        zoomed_after = "zoomed" in (await page.get_attribute(".photoviewer-img", "class") or "")
        print("zoomed before/after first click:", zoomed_before, zoomed_after)
        assert not zoomed_before and zoomed_after, "clicking the photo should zoom it in"
        await page.click(".photoviewer-img")
        await page.wait_for_timeout(100)
        zoomed_after2 = "zoomed" in (await page.get_attribute(".photoviewer-img", "class") or "")
        assert not zoomed_after2, "clicking again should zoom back out"

        # ---- Escape closes it ----
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(150)
        assert await page.locator(".photoviewer").count() == 0, "Escape should close the viewer"

        # ---- reopening at a specific index opens straight there, not at 0 ----
        await page.click("[data-view-photo][data-view-index='2']")
        await page.wait_for_timeout(200)
        src = await page.get_attribute(".photoviewer-img", "src")
        cnt = await counter(page)
        print("reopened directly at index 2:", src, cnt)
        assert src == PHOTOS[2]["url"]
        assert cnt == "3 / 3"

        # ---- keyboard ArrowRight / ArrowLeft, including wrap-around ----
        await page.keyboard.press("ArrowRight")
        await page.wait_for_timeout(150)
        cnt = await counter(page)
        print("after ArrowRight from last (wrap):", cnt)
        assert cnt == "1 / 3", "ArrowRight from the last photo should wrap to the first"

        await page.keyboard.press("ArrowLeft")
        await page.wait_for_timeout(150)
        cnt = await counter(page)
        print("after ArrowLeft from first (wrap):", cnt)
        assert cnt == "3 / 3", "ArrowLeft from the first photo should wrap to the last"

        await page.keyboard.press("Escape")
        await page.wait_for_timeout(150)

        # ---- the admin remove "✕" must never also open the viewer ----
        assert await page.is_visible(".photoslot-rm"), "admin should see the remove button"
        await page.click(".photoslot-rm >> nth=0")
        await page.wait_for_timeout(200)
        assert await page.locator(".photoviewer").count() == 0, "tapping remove must not open the photo viewer"

        await browser.close()
        print("PHOTO VIEWER TEST PASSED")

asyncio.run(main())
