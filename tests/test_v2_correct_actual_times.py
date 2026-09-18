import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 37: client feedback -- "je pense idealement l'admin devrait avoir la
# possibilite d'edit les Start/End time" (a chauffeur can forget to tap
# "Start unloading", leaving act_arrival wrong or missing entirely, which
# quietly skews the productivity/waiting-time numbers Badeeson's point 3 was
# about). Admin can now hand-correct either time:
#   - while a truck is still "unloading" -- only Start is editable yet
#     (data-save-start, saveStartTime() in actions.js);
#   - once a truck is "done" -- both Start and End together, one Save
#     button (data-save-actual, saveActualTimes() in actions.js).
# Both PATCH act_arrival/act_dept exactly like the live start/finish actions
# do, ALSO set a boolean "arrival_corrected"/"departure_corrected" flag
# (supabase-schema.sql) so a hand-corrected time is visibly different (a
# "Corrected" badge) from one the chauffeur actually tapped, and log to the
# same audit trail (truck_events) as every other mutation. The Reporting
# screen's new "Manually corrected" KPI tile counts trucks with either flag
# set (js/reporting.js's statsForRows()).
UNLOADING_ID = "11111111-1111-1111-1111-111111111111"
DONE_ID = "22222222-2222-2222-2222-222222222222"
TRUCKS = [
    {
        "id": UNLOADING_ID, "reference_id": "T-CORR1", "carrier": "Corr Carrier 1", "plant": "AMATA",
        "po_no": "PO-CORR1", "order_date": TODAY, "eta": TODAY+"T08:00:00",
        "truck_state": "arrived", "act_arrival": TODAY+"T08:07:00", "started_by": "",
        "arrival_corrected": False, "departure_corrected": False, "photos": []
    },
    {
        "id": DONE_ID, "reference_id": "T-CORR2", "carrier": "Corr Carrier 2", "plant": "AMATA",
        "po_no": "PO-CORR2", "order_date": TODAY, "eta": TODAY+"T09:00:00",
        "truck_state": "completed", "act_arrival": TODAY+"T09:03:00", "act_dept": TODAY+"T09:50:00",
        "arrival_corrected": False, "departure_corrected": False, "photos": []
    },
]
PATCH_CALLS = []
LOGGED_EVENTS = []

async def handle(route, request):
    url = request.url
    method = request.method
    if "/rest/v1/trucks" in url and method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/trucks" in url and method == "PATCH":
        m = re.search(r"id=eq\.([^&]+)", url)
        truck_id = m.group(1) if m else None
        body = json.loads(request.post_data or "{}")
        PATCH_CALLS.append({"id": truck_id, "body": body})
        for t in TRUCKS:
            if t["id"] == truck_id:
                t.update(body)
        await route.fulfill(status=200, content_type="application/json", body=json.dumps([t for t in TRUCKS if t["id"] == truck_id]))
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    if "/rest/v1/truck_events" in url and method == "POST":
        body = json.loads(request.post_data or "{}")
        LOGGED_EVENTS.append(body)
        await route.fulfill(status=201, content_type="application/json", body="{}")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":390,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        await page.goto(BASE)
        await page.wait_for_timeout(400)
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)

        # ---- Scenario A: still "unloading" -- only Start is editable ----
        await page.click("[data-open='"+UNLOADING_ID+"']")
        await page.wait_for_timeout(300)
        assert await page.is_visible("#startTimeInput"), "Admin must see an editable Start time while a truck is unloading"
        assert not await page.locator("#endTimeInput").count(), "End time has nothing to correct yet -- must not show while still unloading"

        await page.fill("#startTimeInput", "07:45")
        await page.click("[data-save-start='"+UNLOADING_ID+"']")
        await page.wait_for_selector(".toast")
        await page.wait_for_timeout(400)

        print("PATCH calls after start correction:", PATCH_CALLS)
        start_patch = [c for c in PATCH_CALLS if c["id"] == UNLOADING_ID]
        assert len(start_patch) == 1
        assert start_patch[0]["body"].get("act_arrival") == TODAY+"T07:45:00"
        assert start_patch[0]["body"].get("arrival_corrected") is True
        assert TRUCKS[0]["act_arrival"] == TODAY+"T07:45:00"

        events_a = [e for e in LOGGED_EVENTS if e.get("truck_id") == UNLOADING_ID]
        assert len(events_a) == 1 and events_a[0]["action"] == "start_time_corrected"
        assert events_a[0]["detail"] == "08:07 -> 07:45"

        # the sheet re-syncs after the save and now shows the "Corrected" badge
        await page.wait_for_timeout(200)
        sheet_text = await page.text_content(".sheet")
        print("sheet text after correction:", sheet_text)
        assert "07:45" in sheet_text
        assert ("Corrected" in sheet_text) or ("แก้ไขแล้ว" in sheet_text)

        await page.click("[data-close]")
        await page.wait_for_timeout(200)

        # ---- Scenario B: "done" -- both Start and End editable together ----
        await page.click("[data-open='"+DONE_ID+"']")
        await page.wait_for_timeout(300)
        assert await page.is_visible("#startTimeInput") and await page.is_visible("#endTimeInput")

        await page.fill("#startTimeInput", "08:55")
        await page.fill("#endTimeInput", "09:40")
        await page.click("[data-save-actual='"+DONE_ID+"']")
        await page.wait_for_selector(".toast")
        await page.wait_for_timeout(400)

        print("PATCH calls after actual-times correction:", PATCH_CALLS)
        done_patches = [c for c in PATCH_CALLS if c["id"] == DONE_ID]
        # one PATCH per changed field (act_arrival, act_dept) -- both differ
        # from the mocked truck's original 09:03/09:50, so both fire.
        assert any(c["body"].get("act_arrival") == TODAY+"T08:55:00" and c["body"].get("arrival_corrected") is True for c in done_patches)
        assert any(c["body"].get("act_dept") == TODAY+"T09:40:00" and c["body"].get("departure_corrected") is True for c in done_patches)
        assert TRUCKS[1]["act_arrival"] == TODAY+"T08:55:00"
        assert TRUCKS[1]["act_dept"] == TODAY+"T09:40:00"

        events_b = [e for e in LOGGED_EVENTS if e.get("truck_id") == DONE_ID]
        actions_b = sorted(e["action"] for e in events_b)
        assert actions_b == ["end_time_corrected", "start_time_corrected"]

        await page.wait_for_timeout(200)
        sheet_text_b = await page.text_content(".sheet")
        print("sheet text (done, corrected):", sheet_text_b)
        # both the Start and End badges must show -- two occurrences, one per field
        corrected_count = sheet_text_b.count("Corrected") + sheet_text_b.count("แก้ไขแล้ว")
        assert corrected_count == 2, "expected a 'Corrected' badge on both Start and End"

        await page.click("[data-close]")
        await page.wait_for_timeout(200)

        # ---- Reporting screen: the new "Manually corrected" KPI tile ----
        await page.click("[data-open-report]")
        await page.wait_for_timeout(200)
        await page.click("[data-run-report]")
        await page.wait_for_timeout(400)

        report_text = await page.text_content(".sheet")
        print("report sheet text:", report_text)
        assert ("Manually corrected" in report_text) or ("แก้ไขด้วยมือ" in report_text)
        # both mocked trucks now have at least one corrected flag set --
        # the tile must read 2, not 0 or 1.
        kpi_values = await page.locator(".kpi .v").all_text_contents()
        print("KPI tile values:", kpi_values)
        assert "2" in kpi_values

        await browser.close()
        print("CORRECT ACTUAL TIMES TEST PASSED")

asyncio.run(main())
