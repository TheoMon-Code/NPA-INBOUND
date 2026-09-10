import asyncio, io, json, os, re
from datetime import date
from PIL import Image
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Regression/feature test for the "download all photos" button (Round 20) --
# a manager on site asked for a way to grab every photo on a truck at once
# ("similar to the FG export"), rather than opening/saving each one from the
# grid individually. Built as a client-side zip via JSZip (js/photoDownload.js),
# loaded lazily from cdnjs on first use -- blocked from the real CDN in this
# sandbox (see the agent-proxy egress notes elsewhere in this suite), so
# window.JSZip is stubbed directly via add_init_script. Since
# downloadTruckPhotos() checks `if(window.JSZip) return Promise.resolve()`
# before ever creating the dynamic <script> tag, stubbing it here means the
# real network fetch to cdnjs never happens at all -- not a network mock,
# a straight substitute for the library itself, same idea as test_v2_worker_path.py
# stubbing self.XLSX.

def make_jpeg_bytes(color):
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), color=color).save(buf, format="JPEG")
    return buf.getvalue()

PHOTO1_URL = "https://wezkonqnlkmkthbfimai.supabase.co/storage/v1/object/public/inbound-photos/TRUCK-ZIP-1/PO-77701-1-aaa.jpg"
PHOTO2_URL = "https://wezkonqnlkmkthbfimai.supabase.co/storage/v1/object/public/inbound-photos/TRUCK-ZIP-1/PO-77701-2-bbb.jpg"
PHOTO3_URL = "https://wezkonqnlkmkthbfimai.supabase.co/storage/v1/object/public/inbound-photos/TRUCK-ZIP-1/PO-77701-3-ccc.jpg"

TRUCK = {
    "id": "TRUCK-ZIP-1",
    "reference_id": "T-ZIP1",
    "carrier": "Zip Carrier Co",
    "plant": "AMATA",
    "po_no": "PO-77701",
    "order_date": TODAY,
    "eta": TODAY+"T09:00:00",
    "truck_state": "pending",
    "photos": [
        {"id": "p1", "url": PHOTO1_URL, "storage_path": "TRUCK-ZIP-1/PO-77701-1-aaa.jpg", "uploaded_by": "", "created_at": "2026-09-09T09:00:00Z"},
        {"id": "p2", "url": PHOTO2_URL, "storage_path": "TRUCK-ZIP-1/PO-77701-2-bbb.jpg", "uploaded_by": "", "created_at": "2026-09-09T09:01:00Z"},
        {"id": "p3", "url": PHOTO3_URL, "storage_path": "TRUCK-ZIP-1/PO-77701-3-ccc.jpg", "uploaded_by": "", "created_at": "2026-09-09T09:02:00Z"},
    ],
}

# A minimal, faithful-enough JSZip substitute: records every file added and
# returns a real Blob on generateAsync (so the app's own download flow --
# createObjectURL/<a download>/click -- runs completely unmocked from that
# point on, exactly like a real zip would).
STUB_JSZIP = """
window.__zipFiles = [];
window.JSZip = function(){
  this.file = function(name, blob){ window.__zipFiles.push(name); };
  this.generateAsync = function(opts){
    return Promise.resolve(new Blob(["fake zip bytes"], {type:"application/zip"}));
  };
};
"""

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":390,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.add_init_script(STUB_JSZIP)

        async def handle(route, request):
            url = request.url
            method = request.method
            if url in (PHOTO1_URL, PHOTO2_URL, PHOTO3_URL) and method == "GET":
                await route.fulfill(status=200, content_type="image/jpeg", body=make_jpeg_bytes((10, 20, 30)))
                return
            if "/rest/v1/trucks" in url and method == "GET":
                await route.fulfill(status=200, content_type="application/json", body=json.dumps([TRUCK]))
                return
            if "/rest/v1/photos" in url:
                await route.fulfill(status=200, content_type="application/json", body="[]")
                return
            await route.fulfill(status=404, body="not mocked: "+url)
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(400)
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)

        await page.click(".card")
        await page.wait_for_timeout(300)

        assert await page.locator("[data-download-photos]").count() == 1, "expected a download-photos button once the truck has photos"

        async with page.expect_download() as dl_info:
            await page.click("[data-download-photos]")
        download = await dl_info.value
        suggested = download.suggested_filename
        print("suggested filename:", suggested)
        # Round 24: Theo first asked (and got, in an earlier pass) only the
        # photos INSIDE the zip renamed to date_time_PO -- he then pointed out
        # (screenshot of his download history) that he meant the outer zip's
        # own name too. Both now share the same date_time_PO prefix. TRUCK's
        # eta is "09:00:00" (mapped to "09:00" by mapRowToTruck, then
        # "h"-joined here instead of ":", which isn't valid in a Windows
        # filename).
        assert suggested == TODAY+"_09h00_PO-77701-photos.zip", "expected the zip named date_time_PO"

        zip_files = await page.evaluate("window.__zipFiles")
        print("files bundled into the zip:", zip_files)
        assert len(zip_files) == 3, "expected all 3 photos to be fetched and added to the zip"
        # Round 24 (follow-up): Theo also asked that each photo's own index be
        # zero-padded ("-01", "-02"...) rather than "-1", "-2" -- both so they
        # sort correctly and so the scheme "stays scalable" as more photos get
        # added to a truck. Width is 2 here since only 3 photos are in this zip.
        assert set(zip_files) == {
            TODAY+"_09h00_PO-77701-01.jpg",
            TODAY+"_09h00_PO-77701-02.jpg",
            TODAY+"_09h00_PO-77701-03.jpg",
        }

        await page.wait_for_timeout(300)
        toast_text = await page.text_content(".toast")
        print("toast after zip download:", toast_text)
        assert "ดาวน์โหลดรูปภาพแล้ว" in (toast_text or "")

        await browser.close()
        print("PHOTO ZIP DOWNLOAD TEST PASSED")

asyncio.run(main())
