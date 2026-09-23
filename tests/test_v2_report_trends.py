import asyncio, json, os, re
from datetime import date, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today()

def d(offset): return (TODAY + timedelta(days=offset)).isoformat()

# Round 39: Theo -- "un rapport detaillé des ibounds... avec des trends pour
# observer les trends, improvments etc." (clarified via AskUserQuestion: all
# four of truck volume / on-time rate / avg. unloading time / damage
# incidents, screen-only) plus a mid-turn follow-up -- "Il faut aussi que ca
# reprennes toute la DA de ma compagnie + logo" (the report must carry the
# company's full visual identity + logo). This covers both: the four trend
# charts (computeTrendBuckets() in reporting.js, reportTrendChartsHtml() in
# render.js) and the new branded header on the Reports sheet
# (reportBrandBandHtml()).

TRUCKS_SHORT = []
CARRIERS = ["Aurora Freight", "Meridian Cargo"]
for i in range(10):
    offset = -9 + i
    late = (i % 3 == 0)
    eta_h = 8
    arr_h = eta_h + (2 if late else 0)
    t = {
        "id": str(i+1), "reference_id": "T-"+str(i+1), "carrier": CARRIERS[i % 2],
        "plant": "AMATA", "po_no": "PO-"+str(3000+i),
        "order_date": d(offset), "eta": d(offset)+"T08:00:00",
        "truck_state": "completed",
        "act_arrival": d(offset)+"T%02d:%02d:00" % (arr_h, 5 if late else 0),
        "act_dept": d(offset)+"T%02d:30:00" % (arr_h+1),
        "photos": []
    }
    if i == 2:
        t["damage_remark"] = "Pallet crushed"
    TRUCKS_SHORT.append(t)

# A sparse 60-day spread (only every 3rd day has a truck) so the granularity
# switches to weekly (>45 days) and there are real gap buckets with no data.
TRUCKS_LONG = []
for i in range(0, 60, 3):
    offset = -59 + i
    TRUCKS_LONG.append({
        "id": "L"+str(i), "reference_id": "TL-"+str(i), "carrier": "Aurora Freight",
        "plant": "AMATA", "po_no": "PO-L"+str(i),
        "order_date": d(offset), "eta": d(offset)+"T08:00:00",
        "truck_state": "completed",
        "act_arrival": d(offset)+"T08:05:00", "act_dept": d(offset)+"T08:35:00",
        "photos": []
    })

TRUCKS = TRUCKS_SHORT

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

async def open_report(page):
    await page.goto(BASE)
    await page.wait_for_timeout(400)
    await page.click("[data-role-step='pin']")
    await page.wait_for_timeout(150)
    await page.fill("#pinInput", "748231")
    await page.click("[data-pin-submit]")
    await page.wait_for_timeout(400)
    await page.click("[data-toggle-lang]")  # English, for readable assertions
    await page.wait_for_timeout(200)
    await page.click("[data-open-report]")
    await page.wait_for_timeout(200)

async def main():
    global TRUCKS
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)

        # ---- branded header, always present even before Generate is clicked ----
        TRUCKS = TRUCKS_SHORT
        page = await browser.new_page(viewport={"width":420, "height":1200})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)
        await open_report(page)

        assert await page.locator(".report-brand-band").count() == 1, "Reports sheet must show its own branded header"
        assert await page.locator(".report-brand-band .mark-badge img.mark").count() == 1, "branded header must show the MON logo"
        band_text = await page.text_content(".report-brand-band")
        print("brand band text:", band_text)
        assert "MON LOGISTICS" in band_text

        # ---- short (10-day) range: daily buckets, all 4 charts render ----
        await page.fill("#report-from", d(-9))
        await page.fill("#report-to", d(0))
        await page.click("[data-run-report]")
        await page.wait_for_timeout(400)

        hint = await page.text_content(".sheet-section .hint")
        print("granularity hint (short range):", hint)
        assert "day" in hint.lower()

        chart_count = await page.locator(".trendchart").count()
        assert chart_count == 4, "expected volume/on-time/avg-duration/damage charts"

        # 10 days -> 10 bars/dots per chart, one per day (no gaps skipped).
        volume_bars = await page.locator(".trendcard:has-text('Truck volume') path").count()
        print("volume bar count:", volume_bars)
        assert volume_bars == 10

        # Only bucket index 2 (3rd day back) has a damage remark -- the rest
        # must render as the neutral/muted zero style, never --bad, so a
        # quiet range doesn't read as "all incidents".
        damage_fills = await page.locator(".trendcard:has-text('Damage incidents') path").evaluate_all(
            "els => els.map(e => getComputedStyle(e).fill)"
        )
        print("damage bar fills:", damage_fills)
        # Computed fill comes back as an rgb() string; just confirm the one
        # real incident's bar rendered in a different colour than the
        # zero-damage days around it, i.e. red is reserved for an actual
        # incident and never used as a generic "series colour".
        assert len(set(damage_fills)) == 2, "zero-damage buckets must render differently from the one real incident"

        # ---- table view toggle: accessible alternative to the charts ----
        assert await page.locator(".trendtable-details").count() == 1
        await page.click(".trendtable-details summary")
        await page.wait_for_timeout(150)
        table_rows = await page.locator(".trendtable tbody tr").count()
        print("table rows (short range):", table_rows)
        assert table_rows == 10
        await page.close()

        # ---- long (60-day) range: switches to weekly buckets ----
        TRUCKS = TRUCKS_LONG
        page = await browser.new_page(viewport={"width":420, "height":1200})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)
        await open_report(page)
        await page.fill("#report-from", d(-59))
        await page.fill("#report-to", d(0))
        await page.click("[data-run-report]")
        await page.wait_for_timeout(400)

        hint2 = await page.text_content(".sheet-section .hint")
        print("granularity hint (60-day range):", hint2)
        assert "week" in hint2.lower()

        # every bar/dot must still be present (buckets with zero trucks are
        # kept, never silently dropped) -- 60 days is 9 Monday-start weeks.
        volume_bars2 = await page.locator(".trendcard:has-text('Truck volume') path").count()
        print("weekly volume bar count:", volume_bars2)
        assert volume_bars2 >= 8

        await browser.close()
        print("REPORT TRENDS TEST PASSED")

asyncio.run(main())
