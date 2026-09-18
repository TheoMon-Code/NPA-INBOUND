import asyncio, json, os, re
from datetime import date
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 36: client feedback (Khun Badeeson) -- "For any data deletion
# performed by an Admin: please add a password confirmation step before the
# deletion is completed... If the password is incorrect, the system should
# not allow the deletion... please maintain an audit log showing the Admin
# user, date/time, and deleted record for traceability. Expected flow:
# Delete -> Confirmation -> Enter Admin Password -> Verify -> Delete
# Successfully."
#
# This app's only credential is the role's own PIN (Round 25) -- there is no
# separate "password" anywhere else -- so promptDeletePin()/
# confirmDeleteWithPin() (js/actions.js) re-verify that same PIN as the new
# third step, between the existing "Confirm delete?" tap and the actual
# (still-undoable) deleteTruck(). The audit log itself already existed
# since Round 26 (js/history.js/logTruckEvent() in js/actions.js) -- this
# test is the first to actually exercise it end to end, tying it to the new
# PIN step: a wrong PIN must block the delete outright (record untouched,
# no truck_events row), Cancel must back out cleanly, and the eventual
# correct-PIN delete must show up in the History screen with the truck and
# the acting Admin's role label.

TRUCKS = [
    {"id":"t1","reference_id":"T-1","carrier":"Aurora Freight","plant":"AMATA","po_no":"PO-9001",
     "order_date":TODAY,"eta":TODAY+"T08:00:00","truck_state":"pending","photos":[]},
]
LOGGED_EVENTS = []
DELETE_CALLS = []

async def handle(route, request):
    url = request.url
    method = request.method
    if "/rest/v1/trucks" in url and method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/trucks" in url and method == "DELETE":
        DELETE_CALLS.append(url)
        for t in list(TRUCKS):
            TRUCKS.remove(t)
        await route.fulfill(status=204)
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    if "/rest/v1/truck_events" in url and method == "POST":
        body = json.loads(request.post_data or "{}")
        LOGGED_EVENTS.append(body)
        await route.fulfill(status=201, content_type="application/json", body="{}")
        return
    if "/rest/v1/truck_events" in url and method == "GET":
        rows = [{"created_at":"2026-01-01T00:00:00Z","action":e.get("action"),
                  "truck_label":e.get("truck_label"),"actor":e.get("actor"),"detail":e.get("detail")}
                 for e in LOGGED_EVENTS]
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(rows))
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

        await page.click(".card")
        await page.wait_for_timeout(200)
        await page.click("[data-delete]")
        await page.wait_for_timeout(150)
        await page.click("[data-delete-confirm]")
        await page.wait_for_timeout(150)
        assert await page.locator("#deletePinInput").count() == 1, "expected the PIN prompt, not an immediate delete"

        # ---- wrong PIN: must block the delete outright ----
        await page.fill("#deletePinInput", "000000")
        await page.click("[data-delete-pin-confirm]")
        await page.wait_for_timeout(150)
        assert await page.locator(".sheet").locator("text=ไม่ถูกต้อง").count() == 1, "wrong PIN must show an error"
        assert await page.locator(".card").count() == 1, "truck must still exist after a wrong PIN"
        assert not DELETE_CALLS and not LOGGED_EVENTS, "nothing must be deleted or logged on a wrong PIN"

        # ---- Cancel backs out cleanly, back to the plain delete button ----
        await page.click("[data-delete-pin-cancel]")
        await page.wait_for_timeout(150)
        assert await page.locator("#deletePinInput").count() == 0
        assert await page.locator("[data-delete]").count() == 1, "cancel must return to the initial delete button"
        assert await page.locator(".card").count() == 1

        # ---- correct PIN: proceeds to the existing (still undoable) delete ----
        await page.click("[data-delete]")
        await page.wait_for_timeout(150)
        await page.click("[data-delete-confirm]")
        await page.wait_for_timeout(150)
        await page.fill("#deletePinInput", "748231")
        await page.click("[data-delete-pin-confirm]")
        await page.wait_for_timeout(200)
        assert await page.locator(".card").count() == 0, "truck hidden right away, same as before this round"
        assert await page.locator("[data-undo-delete]").count() == 1

        await page.wait_for_timeout(5300)  # past UNDO_DELETE_MS -- the real delete now fires
        print("DELETE calls:", DELETE_CALLS)
        print("logged truck_events:", LOGGED_EVENTS)
        assert len(DELETE_CALLS) == 1
        deleted_events = [e for e in LOGGED_EVENTS if e.get("action") == "deleted"]
        assert len(deleted_events) == 1, "the delete must be recorded in the audit log exactly once"
        assert deleted_events[0]["truck_label"] == "PO-9001"
        assert deleted_events[0]["actor"] == "แอดมิน MON", "audit log must record which Admin performed the deletion"

        # ---- and it's visible in the History screen itself ----
        await page.click("[data-open-history]")
        await page.wait_for_timeout(200)
        await page.click("[data-run-history]")
        await page.wait_for_timeout(300)
        history_text = await page.text_content(".sheet")
        print("history sheet text:", history_text)
        assert "PO-9001" in history_text
        assert "ลบ" in history_text  # histActionDeleted, Thai default
        assert "แอดมิน MON" in history_text

        await browser.close()
        print("DELETE PIN CONFIRM TEST PASSED")

asyncio.run(main())
