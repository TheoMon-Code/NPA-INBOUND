import asyncio, json, os, re
from datetime import date, datetime, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 35: the pill already shows a live elapsed counter while a truck is
# unloading ("Unloading · 00:45") and a duration once it's done
# ("Done · 1h05") -- useful for "how long has this taken", but Theo asked to
# also see the actual clock time a truck started or finished. actualTimesText()/
# actualTimeHtml() (js/render.js) read t.startedAt/t.finishedAt (act_arrival/
# act_dept) and show a "▶ HH:MM"/"⏹ HH:MM" marker next to the scheduled ETA on
# the card meta line and the TV board's ETA cell.
#
# Round 36: client feedback (Khun Badeeson) asked for the same information as
# its own dedicated "Start Time / End Time / Duration" columns on the admin
# desktop table specifically ("this will help Operation monitor the actual
# processing time... Inbound Productivity / Waiting Time / Process Time"),
# with End Time reading "In Progress" while a truck is still unloading. That
# table's ETA cell no longer carries the Round 35 ▶/⏹ marker at all (see
# tableRowHtml() in js/render.js) -- superseded by the three new columns.
# Cards are unchanged from Round 35 (no room there for three more columns).
#
# Round 38: the TV board also got its own dedicated Start Time/End Time
# columns (no Duration -- not asked for there), so its ETA cell lost the
# Round 35 ▶/⏹ marker too (see tvRowHtml() in js/render.js) -- same migration
# Round 36 already did for the admin desktop table above. Only the card view
# still carries the inline marker at this point.

def eta_in(minutes):
    return (datetime.now() + timedelta(minutes=minutes)).strftime("%H:%M:00")

TRUCKS = [
    # Not yet arrived -- must show only the scheduled ETA, nothing in
    # Start/End/Duration (admin table) and no ▶/⏹ marker at all (cards/TV).
    {"id":"1","reference_id":"T-1","carrier":"Aurora Freight","plant":"AMATA","po_no":"PO-PEND",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(120),"truck_state":"pending","photos":[]},
    # Currently unloading -- act_arrival set, act_dept not yet.
    {"id":"2","reference_id":"T-2","carrier":"Meridian Cargo","plant":"AMATA","po_no":"PO-UNLD",
     "order_date":TODAY,"eta":TODAY+"T09:00:00","truck_state":"arrived",
     "act_arrival":TODAY+"T09:15:00","photos":[]},
    # Finished -- both act_arrival and act_dept set, 95 minutes apart.
    {"id":"3","reference_id":"T-3","carrier":"Delta Transport","plant":"AMATA","po_no":"PO-DONE",
     "order_date":TODAY,"eta":TODAY+"T08:00:00","truck_state":"completed",
     "act_arrival":TODAY+"T08:05:00","act_dept":TODAY+"T09:40:00","photos":[]},
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

async def row_cells(row_locator):
    return await row_locator.locator("td").all_text_contents()

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page(viewport={"width":1024,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)

        # ---- admin desktop table + cards (same page, both markups exist) ----
        await page.goto(BASE)
        await page.wait_for_timeout(400)
        await page.click("[data-role-step='pin']")
        await page.wait_for_timeout(150)
        await page.fill("#pinInput", "748231")
        await page.click("[data-pin-submit]")
        await page.wait_for_timeout(400)

        # Column order (tableRowHtml/listTableHtml in js/render.js): Type(0),
        # Status(1), PO(2), Carrier(3), Thai name(4), Plant(5), Date(6),
        # ETA(7), Start Time(8), End Time(9), Duration(10).
        pend_cells = await row_cells(page.locator("tr.truckrow[data-open='1']"))
        print("pending row cells:", pend_cells)
        assert pend_cells[8].strip() == "—" and pend_cells[9].strip() == "—" and pend_cells[10].strip() == "—", \
            "a not-yet-arrived truck must show no Start/End/Duration at all"

        unld_cells = await row_cells(page.locator("tr.truckrow[data-open='2']"))
        print("unloading row cells:", unld_cells)
        assert unld_cells[7].strip() == "09:00", "unloading truck should still show its scheduled ETA"
        assert unld_cells[8].strip() == "09:15", "unloading truck should show its actual start time"
        assert unld_cells[9].strip() == "กำลังดำเนินการ", "unloading truck's End Time should read In Progress (default Thai)"
        assert unld_cells[10].strip() != "—", "unloading truck should show a live elapsed duration"

        done_cells = await row_cells(page.locator("tr.truckrow[data-open='3']"))
        print("done row cells:", done_cells)
        assert done_cells[8].strip() == "08:05" and done_cells[9].strip() == "09:40", \
            "done truck should show both its actual start and finish time"
        assert done_cells[10].strip() == "1h35", "done truck's duration should be the finish-minus-start gap"

        # ---- same "▶/⏹" marker check as Round 35, but only on the card
        #      surface now -- the admin table above no longer carries it,
        #      and (Round 38) neither does the TV board any more. ----
        await page.set_viewport_size({"width":390,"height":800})
        await page.wait_for_timeout(150)
        cards_text = await page.text_content(".list")
        assert "▶ 09:15" in cards_text
        assert "▶ 08:05" in cards_text and "⏹ 09:40" in cards_text

        # ---- TV board: Round 38 replaced the inline ▶/⏹ marker with its own
        #      dedicated Start Time/End Time columns (tvTableHeadHtml() order:
        #      Status(0), PO(1), Carrier(2), Thai name(3), Plant(4), ETA(5),
        #      Start Time(6), End Time(7), Product/Qty(8)) -- same shape as
        #      the admin desktop table checked above, just without Duration. ----
        await page.goto(BASE+"?tv=1")
        await page.wait_for_timeout(500)
        # Round 38 follow-up: the TV header now lives in its own small,
        # non-scrolling table (.tvheadtable) above the scrolling body table
        # (.tvbodytable) -- both carry the "trucktable" class, so `.trucktable`
        # alone matches two elements now. `.tvtable` is the shared wrapper
        # around both and is what this needs to check.
        tv_text = await page.text_content(".tvtable")
        print("TV table text:", tv_text)
        assert "▶" not in tv_text and "⏹" not in tv_text, \
            "the old inline ▶/⏹ marker should be gone from the TV board -- superseded by dedicated columns"

        tv_pend_cells = await row_cells(page.locator(".trucktable tbody tr", has_text="PO-PEND"))
        print("TV pending row cells:", tv_pend_cells)
        assert tv_pend_cells[6].strip() == "—" and tv_pend_cells[7].strip() == "—", \
            "a not-yet-arrived truck must show no Start/End time on the TV board"

        tv_unld_cells = await row_cells(page.locator(".trucktable tbody tr", has_text="PO-UNLD"))
        print("TV unloading row cells:", tv_unld_cells)
        assert tv_unld_cells[6].strip() == "09:15", "TV board should show the actual start time"
        assert tv_unld_cells[7].strip() == "กำลังดำเนินการ", "TV board's End Time should read In Progress (default Thai)"

        tv_done_cells = await row_cells(page.locator(".trucktable tbody tr", has_text="PO-DONE"))
        print("TV done row cells:", tv_done_cells)
        assert tv_done_cells[6].strip() == "08:05" and tv_done_cells[7].strip() == "09:40", \
            "TV board should show both the actual start and finish time once done"

        await browser.close()
        print("ACTUAL TIMES TEST PASSED")

asyncio.run(main())
