import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"

# use "tomorrow" (relative to whatever day this actually runs) so the imported
# truck lands inside the app's Yesterday/Today/Tomorrow window and shows up
# in the list without the test needing to fake the clock.
IMPORT_ROW_DATE = (date.today() + timedelta(days=1)).isoformat()

STUB_XLSX = """
window.XLSX = {
  SSF: { parse_date_code: function(v){ return null; } },
  read: function(data, opts){
    return { SheetNames: ["RM PM incoming"], Sheets: { "RM PM incoming": {} } };
  },
  utils: {
    sheet_to_json: function(ws, opts){
      // header row (index 0) + one data row
      return [
        ["", "PO", "Supplier name", "ประเภทสินค้าหรืองานที่ขนส่ง", "จำนวนที่ขนส่ง", "หน่วย", "วันที่ขนส่ง", "เวลาเข้าโรงงาน", "โค้ดของที่มาส่ง", "remark", "Extra Col 1", "Extra Col 2"],
        ["RM", "PO-99001", "Test Carrier Co", "Widgets", 42, "pcs", "%s", "09:15", "CODE1", "note here", "extra-value-1", "extra-value-2"]
      ];
    }
  }
};
""" % IMPORT_ROW_DATE

TRUCKS = []
NEXT_ID = [1]

async def handle_supabase(route, request):
    url = request.url
    method = request.method
    if "/rest/v1/trucks" in url and method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/trucks" in url and method == "POST":
        body = json.loads(request.post_data or "[]")
        rows = body if isinstance(body, list) else [body]
        created = []
        for r in rows:
            row = dict(r)
            row.setdefault("id", f"id-{NEXT_ID[0]}"); NEXT_ID[0]+=1
            row.setdefault("truck_state", "pending")
            row.setdefault("photos", [])
            TRUCKS.append(row)
            created.append(row)
        await route.fulfill(status=201, content_type="application/json", body=json.dumps(created))
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
                row.update(body)
                matched.append(row)
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(matched))
        return
    if "/rest/v1/trucks" in url and method == "DELETE":
        m = re.search(r"id=eq\.([^&]+)", url)
        tid = m.group(1) if m else None
        TRUCKS[:] = [r for r in TRUCKS if r.get("id") != tid]
        await route.fulfill(status=204)
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page()
        errors = []
        failed_requests = []
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        def on_request_failed(req):
            failed_requests.append((req.method, req.url, req.failure))
        page.on("requestfailed", on_request_failed)
        await page.add_init_script(STUB_XLSX)
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle_supabase)

        await page.goto(BASE)
        await page.wait_for_timeout(500)

        # ---- role gate: pick Admin via PIN ----
        await page.click("[data-role-step='pin']")
        # focusPin() clears+focuses #pinInput itself, 30ms after this step
        # renders -- fill() racing ahead of that timeout would have its
        # value wiped out later, so give it a beat before filling.
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(300)
        role_badge = await page.text_content(".rolebadge")
        print("Role badge after admin login:", role_badge)
        assert "Admin" in (role_badge or "") or "แอดมิน" in (role_badge or ""), "admin role not set"

        # ---- bilingual toggle ----
        await page.click("[data-toggle-lang]")
        await page.wait_for_timeout(200)
        html_lang = await page.get_attribute("html", "lang")
        print("lang after toggle:", html_lang)
        assert html_lang == "en"
        await page.click("[data-toggle-lang]")
        await page.wait_for_timeout(200)

        # ---- create a truck manually ----
        await page.click("[data-add]")
        await page.fill("#f-carrier", "Manual Carrier")
        await page.fill("#f-plant", "Plant 9")
        await page.fill("#f-ref", "PO-MANUAL")
        await page.click("[data-create]")
        await page.wait_for_timeout(400)
        print("Trucks after manual create:", len(TRUCKS))
        assert len(TRUCKS) == 1

        # ---- open the truck, save ETA, start, finish ----
        await page.click(".card")
        await page.wait_for_timeout(200)
        await page.fill("#etaInput", "10:15")
        await page.click("[data-save-eta]")
        await page.wait_for_timeout(400)
        print("Truck ETA:", TRUCKS[0].get("eta"))
        assert TRUCKS[0].get("eta")

        await page.click(".card")
        await page.wait_for_timeout(200)
        await page.click("[data-start]")
        await page.wait_for_timeout(400)
        print("Truck state after start:", TRUCKS[0].get("truck_state"))
        assert TRUCKS[0].get("truck_state") == "arrived"

        # sheet stays open across start -> finish (only saveEta closes it)
        await page.click("[data-finish]")
        await page.wait_for_timeout(400)
        print("Truck state after finish:", TRUCKS[0].get("truck_state"))
        assert TRUCKS[0].get("truck_state") == "completed"

        # ---- delete it (need confirm double-tap); sheet is still open ----
        # Round 17: deleting no longer removes the truck immediately -- it's
        # hidden right away but only actually sent to the mock backend after
        # an "Undo" window (UNDO_DELETE_MS in config.js), see deleteTruck()
        # in actions.js.
        await page.click("[data-delete]")
        await page.wait_for_timeout(150)
        await page.click("[data-delete-confirm]")
        await page.wait_for_timeout(300)
        undo_toast = await page.text_content(".toast")
        print("Toast right after delete (should offer Undo):", undo_toast)
        assert len(TRUCKS) == 1, "must not hit the backend yet -- still inside the undo window"
        assert await page.locator("[data-undo-delete]").count() == 1

        await page.wait_for_timeout(5300)  # past UNDO_DELETE_MS -- the real delete fires now
        delete_toast = await page.text_content(".toast")
        print("Toast after the undo window elapsed:", delete_toast)
        print("Trucks after delete:", len(TRUCKS))
        assert len(TRUCKS) == 0
        assert "ลบรถบรรทุกแล้ว" in (delete_toast or "") or "deleted" in (delete_toast or "").lower()

        # ---- import feature: open, preview, confirm ----
        await page.click("[data-open-import]")
        await page.wait_for_timeout(200)
        # a fake xlsx file input (content doesn't matter, XLSX.read is stubbed)
        await page.set_input_files("#importFileInput", {
            "name": "Incoming plan AMATA.xlsx",
            "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "buffer": b"fake-bytes-not-real-xlsx"
        })
        await page.wait_for_timeout(300)
        await page.fill("#import-from-date", "2020-01-01")
        await page.click("[data-import-preview]")
        await page.wait_for_timeout(300)
        preview_text = await page.text_content(".importpreview")
        print("Import preview text:", preview_text)
        assert "PO-99001" not in (preview_text or "") # PO not shown, carrier/details are
        assert "Test Carrier Co" in (preview_text or "")
        await page.click("[data-import-confirm]")
        await page.wait_for_timeout(500)
        print("Trucks after import:", len(TRUCKS))
        assert len(TRUCKS) == 1
        imported = TRUCKS[0]
        print("Imported truck raw field:", imported.get("raw"))
        assert imported.get("raw", {}).get("Extra Col 1") == "extra-value-1"
        assert imported.get("po_no") == "PO-99001"

        # imported truck is dated "tomorrow" - switch tabs to see it
        await page.click("[data-tab='1']")
        await page.wait_for_timeout(200)

        # open the imported truck and check "All imported fields" section renders
        await page.click(".card")
        await page.wait_for_timeout(200)
        all_fields_visible = await page.is_visible("details.sheet-section")
        print("All source fields section visible:", all_fields_visible)
        assert all_fields_visible

        print("console/page errors seen:", errors)
        print("failed network requests:", failed_requests)
        # Only the known-blocked external hosts (Google Fonts CSS, the cdnjs
        # XLSX CDN) are expected to fail in this sandbox's egress policy --
        # any *other* console error (a module import/reference error, etc.)
        # is a real bug and must fail the test.
        allowed_hosts = ("fonts.googleapis.com", "cdnjs.cloudflare.com")
        unexpected = [e for e in errors if not any(h in e for h in allowed_hosts) and "ERR_TUNNEL_CONNECTION_FAILED" not in e and "Failed to load resource" not in e]
        assert not unexpected, "unexpected console/page errors: %r (all errors: %r)" % (unexpected, errors)
        for method, url, failure in failed_requests:
            # Chromium/Playwright have a known quirk where a route.fulfill()'d
            # 204-No-Content response (used for our DELETE mock, matching the
            # real Supabase REST API) still raises a DevTools "requestfailed"
            # (ERR_ABORTED) event even though the page's fetch() promise
            # resolves normally -- verified above via the app's own success
            # toast and the resulting state change, so this is allow-listed
            # specifically for DELETE.
            is_known_ok = any(h in url for h in allowed_hosts) or (method == "DELETE" and "supabase.co" in url and failure == "net::ERR_ABORTED")
            assert is_known_ok, "unexpected failed request: %s %s (%s)" % (method, url, failure)

        await browser.close()
        print("ALL PASSED")

asyncio.run(main())
