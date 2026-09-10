import asyncio, io, json, os, re
from datetime import date
from PIL import Image
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 25: the bulk "photo archive" button, Admin MON IT-only, on the
# Reporting screen (see archiveBlockHtml() in js/render.js, runPhotoArchive()
# in js/reporting.js, downloadPhotosArchive() in js/photoDownload.js). Theo's
# own words after weighing and rejecting a Supabase Pro upgrade and an
# automated SharePoint pipeline: "on peut ajouter un bouton et ca download
# tout mais ca supprimes rien" -- so this test's central claim is as much
# about what does NOT happen (no DELETE, ever) as what does.

def make_jpeg_bytes(color):
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), color=color).save(buf, format="JPEG")
    return buf.getvalue()

PHOTO1_URL = "https://wezkonqnlkmkthbfimai.supabase.co/storage/v1/object/public/inbound-photos/TRUCK-ARC-1/PO-8001-aaa.jpg"
PHOTO2_URL = "https://wezkonqnlkmkthbfimai.supabase.co/storage/v1/object/public/inbound-photos/TRUCK-ARC-2/PO-8002-bbb.jpg"

TRUCKS = [
    {
        "id": "TRUCK-ARC-1", "reference_id": "T-A1", "carrier": "Archive Carrier",
        "plant": "AMATA", "po_no": "PO-8001", "order_date": TODAY, "eta": TODAY+"T08:00:00",
        "truck_state": "pending",
        "photos": [{"id":"p1", "url":PHOTO1_URL, "storage_path":"TRUCK-ARC-1/PO-8001-aaa.jpg", "uploaded_by":"", "created_at":"2026-09-09T08:00:00Z"}],
    },
    {
        "id": "TRUCK-ARC-2", "reference_id": "T-A2", "carrier": "Archive Carrier 2",
        "plant": "AMATA", "po_no": "PO-8002", "order_date": TODAY, "eta": TODAY+"T09:00:00",
        "truck_state": "pending",
        "photos": [{"id":"p2", "url":PHOTO2_URL, "storage_path":"TRUCK-ARC-2/PO-8002-bbb.jpg", "uploaded_by":"", "created_at":"2026-09-09T09:00:00Z"}],
    },
]

STUB_JSZIP = """
window.__zipFiles = [];
window.JSZip = function(){
  this.file = function(name, blob){ window.__zipFiles.push(name); };
  this.generateAsync = function(opts){
    return Promise.resolve(new Blob(["fake zip bytes"], {type:"application/zip"}));
  };
};
"""

seen_archive_query = []
seen_destructive_calls = []

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":390, "height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.add_init_script(STUB_JSZIP)

        async def handle(route, request):
            url = request.url
            method = request.method
            if method in ("DELETE",):
                seen_destructive_calls.append(method+" "+url)
                await route.fulfill(status=200, content_type="application/json", body="[]")
                return
            if url in (PHOTO1_URL, PHOTO2_URL) and method == "GET":
                await route.fulfill(status=200, content_type="image/jpeg", body=make_jpeg_bytes((5, 6, 7)))
                return
            if "/rest/v1/trucks" in url and method == "GET":
                if "select=id,po_no,reference_id,order_date,eta,photos" in url:
                    seen_archive_query.append(url)
                await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
                return
            if "/rest/v1/photos" in url:
                await route.fulfill(status=200, content_type="application/json", body="[]")
                return
            if "/rest/v1/app_settings" in url:
                await route.fulfill(status=200, content_type="application/json", body="[]")
                return
            await route.fulfill(status=404, body="not mocked: "+url)
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(400)

        # ---- Admin MON (not IT) must NOT see the archive button at all ----
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)
        # English, so the filename/label assertions below don't have to
        # match against Thai text -- only safe now that the role-gate
        # overlay (its own separate data-toggle-lang button) is closed.
        await page.click("[data-toggle-lang]")
        await page.wait_for_timeout(200)
        await page.click("[data-open-report]")
        await page.wait_for_timeout(200)
        assert await page.locator("[data-download-archive]").count() == 0, "Admin MON (not IT) must not see the archive button"
        await page.click("[data-close]")
        await page.wait_for_timeout(150)

        # ---- switch to Admin MON IT ----
        await page.click("[data-role-switch]")
        await page.wait_for_timeout(150)
        await page.click("[data-role-step='pin_it']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "913647")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)

        role_badge = await page.text_content("[data-role-switch]")
        print("role badge after Admin IT login:", role_badge)
        assert "IT" in role_badge

        await page.click("[data-open-report]")
        await page.wait_for_timeout(200)
        assert await page.locator("[data-download-archive]").count() == 1, "Admin MON IT should see the archive button"

        from_val = await page.input_value("#report-from")
        to_val = await page.input_value("#report-to")

        async with page.expect_download() as dl_info:
            await page.click("[data-download-archive]")
        download = await dl_info.value
        suggested = download.suggested_filename
        print("archive suggested filename:", suggested)
        assert suggested == "archive_"+from_val+"_"+to_val+".zip"

        assert seen_archive_query, "expected a dedicated archive query (select=id,po_no,reference_id,order_date,eta,photos(...))"
        assert ("order_date=gte."+from_val) in seen_archive_query[-1]
        assert ("order_date=lte."+to_val) in seen_archive_query[-1]

        zip_files = await page.evaluate("window.__zipFiles")
        print("files bundled into the archive:", zip_files)
        assert len(zip_files) == 2, "expected both trucks' photos in the archive"
        assert any("PO-8001" in f and f.split("/")[0].endswith("PO-8001") for f in zip_files), "expected a per-truck subfolder for PO-8001"
        assert any("PO-8002" in f and f.split("/")[0].endswith("PO-8002") for f in zip_files), "expected a per-truck subfolder for PO-8002"
        assert all("/" in f for f in zip_files), "every archived photo should sit inside a per-truck subfolder"

        await page.wait_for_timeout(300)
        toast_text = await page.text_content(".toast")
        print("toast after archive download:", toast_text)

        # ---- the whole point: nothing destructive was ever called ----
        assert not seen_destructive_calls, "the archive button must never delete anything: "+str(seen_destructive_calls)

        await browser.close()
        print("PHOTO ARCHIVE TEST PASSED")

asyncio.run(main())
