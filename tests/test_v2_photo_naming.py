import asyncio, json, os, re, io
from datetime import date
from PIL import Image
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

def make_jpeg_bytes(color):
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), color=color).save(buf, format="JPEG")
    return buf.getvalue()

TRUCK = {
    "id": "11111111-1111-1111-1111-111111111111",
    "reference_id": "T-ABC123",
    "carrier": "Test Carrier",
    "plant": "AMATA",
    "po_no": "PO-55501",
    "order_date": TODAY,
    "eta": TODAY+"T09:00:00",
    "truck_state": "pending",
    "photos": []
}

UPLOAD_CALLS = []
PHOTO_ROWS = []

async def handle(route, request):
    url = request.url
    method = request.method
    if "/storage/v1/object/inbound-photos/" in url and method == "POST":
        # storage path is the part after .../inbound-photos/
        path = url.split("/inbound-photos/", 1)[1]
        UPLOAD_CALLS.append(path)
        await route.fulfill(status=200, content_type="application/json", body="{}")
        return
    if "/rest/v1/photos" in url and method == "POST":
        body = json.loads(request.post_data or "{}")
        row = dict(body)
        row.setdefault("id", "photo-1")
        row.setdefault("created_at", "2026-09-03T09:05:00Z")
        PHOTO_ROWS.append(row)
        await route.fulfill(status=201, content_type="application/json", body=json.dumps([row]))
        return
    if "/rest/v1/trucks" in url and method == "GET":
        t = dict(TRUCK)
        t["photos"] = [
            {"id": p["id"], "url": p["url"], "storage_path": p["storage_path"], "uploaded_by": p.get("uploaded_by"), "created_at": p["created_at"]}
            for p in PHOTO_ROWS
        ]
        await route.fulfill(status=200, content_type="application/json", body=json.dumps([t]))
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page()
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        page.on("console", lambda msg: print("CONSOLE:", msg.type, msg.text))
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))

        await page.goto(BASE)
        await page.wait_for_timeout(500)

        await page.click("[data-role-step='pin']")
        # focusPin() clears+focuses #pinInput itself, 30ms after the step
        # switch renders -- fill() racing ahead of that timeout would have
        # its value wiped out later, so give it a beat before filling.
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)

        await page.click(".card")
        await page.wait_for_timeout(300)

        # The app's own change handler does `e.target.value = ""` the instant
        # it reads the FileList (see events.js), so checking
        # photoAddInput.files.length afterward is meaningless -- it always
        # reads 0 whether or not the upload actually happened. The real
        # signal is UPLOAD_CALLS / the toast.
        #
        # Clicking the "+" tile calls input.click() from page script, which
        # Chromium/Playwright intercepts as a real file-chooser open (CDP
        # file-chooser interception is armed for the whole page once
        # anything asks for it). If nothing is listening for it, that
        # interception is left dangling and a later out-of-band
        # set_input_files() by selector can silently no-op against it. So
        # register the expect_file_chooser listener *before* the click and
        # resolve it directly, same as driving a real native picker.
        async with page.expect_file_chooser() as fc_info:
            await page.click("[data-photo-add]")
        file_chooser = await fc_info.value
        await file_chooser.set_files([
            {"name": "photo1.jpg", "mimeType": "image/jpeg", "buffer": make_jpeg_bytes((255, 0, 0))},
            {"name": "photo2.jpg", "mimeType": "image/jpeg", "buffer": make_jpeg_bytes((0, 255, 0))},
        ])
        await page.wait_for_timeout(1500)
        toast_now = await page.locator(".toast").count()
        print("toast count after wait:", toast_now)
        if toast_now:
            print("toast text:", await page.text_content(".toast"))

        print("Upload storage paths:", UPLOAD_CALLS)
        assert len(UPLOAD_CALLS) == 2, "expected both multi-selected photos to be uploaded"
        for path in UPLOAD_CALLS:
            # <truckId>/<slug(PO-55501)>-<timestamp>-<rand>.jpg
            assert path.startswith(TRUCK["id"] + "/"), path
            filename = path.split("/", 1)[1]
            assert filename.startswith("PO-55501-"), filename
            assert filename.endswith(".jpg")
        assert UPLOAD_CALLS[0] != UPLOAD_CALLS[1], "two photos must not collide on the same path"

        toast_text = await page.text_content(".toast")
        print("toast after multi-upload:", toast_text)
        assert "2" in (toast_text or "")

        await browser.close()
        print("PHOTO NAMING TEST PASSED")

asyncio.run(main())
