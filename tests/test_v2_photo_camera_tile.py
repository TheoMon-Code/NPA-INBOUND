import asyncio, json, os, re, io
from datetime import date
from PIL import Image
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Regression test for a real report from a manager on site: "can't take a
# photo from android mobile phone". Root cause (see the long comment in
# render.js's photosHtml()): the single "+" tile's hidden file input had
# `multiple` but no `capture` attribute (removed at Round 9 so a gallery pick
# could grab several photos at once) -- but on a real Android phone, the
# generic file/photo chooser that opens for `multiple` frequently drops the
# "Camera" shortcut entirely (a single camera shot can't satisfy "pick
# several"), leaving only Gallery/Files. Invisible in this sandbox, which
# only ever drives Chromium's own synthetic file-chooser interception, not a
# real Android OS picker.
#
# Fix (Round 19): a second, separate tile+input specifically for the camera,
# with `capture="environment"` (forces the camera to open directly, single
# shot) and no `multiple` -- independent of whatever a device's generic
# chooser does or doesn't offer. This test checks the input itself carries
# the right attributes, and that a photo taken through it still uploads
# correctly (same underlying addPhotos() path as the gallery tile).

def make_jpeg_bytes(color):
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), color=color).save(buf, format="JPEG")
    return buf.getvalue()

TRUCK = {
    "id": "22222222-2222-2222-2222-222222222222",
    "reference_id": "T-CAM001",
    "carrier": "Test Carrier",
    "plant": "AMATA",
    "po_no": "PO-66601",
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
        path = url.split("/inbound-photos/", 1)[1]
        UPLOAD_CALLS.append(path)
        await route.fulfill(status=200, content_type="application/json", body="{}")
        return
    if "/rest/v1/photos" in url and method == "POST":
        body = json.loads(request.post_data or "{}")
        row = dict(body)
        row.setdefault("id", "photo-cam-1")
        row.setdefault("created_at", "2026-09-09T09:05:00Z")
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
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)

        await page.click(".card")
        await page.wait_for_timeout(300)

        # The attributes that actually fix the bug: capture="environment"
        # (forces the rear camera directly) and no "multiple" on this
        # specific input -- checked directly rather than relying on the file
        # chooser dialog alone, since Chromium's own synthetic chooser
        # doesn't distinguish "opened the camera" from "opened the gallery"
        # the way a real Android OS picker would.
        capture_attr = await page.get_attribute("#photoAddCameraInput", "capture")
        multiple_attr = await page.get_attribute("#photoAddCameraInput", "multiple")
        print("camera input capture attr:", capture_attr, "multiple attr:", multiple_attr)
        assert capture_attr == "environment", "camera tile must force the camera open directly on a real phone"
        assert multiple_attr is None, "camera tile must stay single-shot, never multi-select"

        # The gallery tile keeps the old, unrelated behaviour: multiple, no
        # capture -- unaffected by this fix, checked here so a future change
        # can't accidentally swap the two.
        gallery_capture_attr = await page.get_attribute("#photoAddGalleryInput", "capture")
        gallery_multiple_attr = await page.get_attribute("#photoAddGalleryInput", "multiple")
        assert gallery_capture_attr is None, "gallery tile must not force the camera"
        assert gallery_multiple_attr == "", "gallery tile must keep allowing multi-select"

        async with page.expect_file_chooser() as fc_info:
            await page.click("[data-photo-add-camera]")
        file_chooser = await fc_info.value
        await file_chooser.set_files([
            {"name": "camera-shot.jpg", "mimeType": "image/jpeg", "buffer": make_jpeg_bytes((0, 0, 255))},
        ])
        await page.wait_for_timeout(1200)

        print("Upload storage paths:", UPLOAD_CALLS)
        assert len(UPLOAD_CALLS) == 1, "expected the single camera photo to upload"
        assert UPLOAD_CALLS[0].startswith(TRUCK["id"] + "/")

        toast_text = await page.text_content(".toast")
        print("toast after camera upload:", toast_text)
        # A single photo uses the singular toast (no count -- see
        # photoUploaded vs. photosUploadedMulti in actions.js addPhotos()),
        # unlike the gallery test's multi-photo count.
        assert "เพิ่มรูปภาพแล้ว" in (toast_text or "")

        await browser.close()
        print("PHOTO CAMERA TILE TEST PASSED")

asyncio.run(main())
