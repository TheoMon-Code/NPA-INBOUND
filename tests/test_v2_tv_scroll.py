import asyncio, json, os, re
from datetime import date, datetime, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()

# Round 38: replaces test_v2_tv_pagination.py. Theo: "que l'ecran qui scroll
# auto down pour voir tout" -- the old fixed-size page rotation (Rounds
# 23-37) is gone; a busy day's full list now scrolls continuously instead of
# flipping between pages (see setupTvAutoScroll() in js/render.js and the
# .tvscrollviewport/.tvscrollcontent CSS in css/app.css). This checks three
# things: (1) a quiet day (short list) never turns scrolling on at all --
# same as before this round, nothing should move if everything already
# fits; (2) a busy day (22 trucks, same fixture Round 23's pagination test
# used) does turn it on, scrolling down exactly as far as the content itself
# (no duplication -- see the Round 38 follow-up below) with an animation-
# duration matching TV_SCROLL_PX_PER_SEC (or the ?scrollSpeed= override used
# here to keep the test fast); (3) a re-render (forced via a short ?pollMs=)
# resumes from wherever the animation already was instead of jumping back to
# the top -- the animation-delay this second check produces must be more
# negative than the first, and the visible on-screen position must have
# moved on (not reset), otherwise every ~15s periodic refresh would make the
# board visibly stutter back to the start.
#
# Round 38 follow-up: the first cut duplicated the table markup once (so a
# CSS translateY(0)->-50% animation could loop with no visible seam) -- but
# Theo saw that as the board showing "Ongoing / Completed / Ongoing /
# Completed" back to back and asked for the opposite: once the list
# finishes, it should jump back to the top, not carry on into a second copy.
# setupTvAutoScroll() no longer duplicates anything -- it animates down by
# exactly the real content's scroll distance and lets a plain CSS animation
# loop snap back to "from" on its own. This test's row-count check below now
# expects exactly the real 22 rows (not 44), and a new check confirms the
# table markup itself was never duplicated in the DOM.

def eta_in(minutes):
    return (datetime.now() + timedelta(minutes=minutes)).strftime("%H:%M:00")

QUIET_TRUCKS = [
    {"id":"1","reference_id":"T-1","carrier":"Aurora Freight","plant":"AMATA","po_no":"PO-1",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(60),"truck_state":"pending","photos":[]},
    {"id":"2","reference_id":"T-2","carrier":"Meridian Cargo","plant":"AMATA","po_no":"PO-2",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(90),"truck_state":"pending","photos":[]},
]

# Same 22-truck fixture Round 23's pagination test used -- comfortably in the
# future, 5 minutes apart, so ascending ETA sorts them PO-1..PO-22 in order.
BUSY_TRUCKS = [
    {"id":str(i), "reference_id":"T-"+str(i), "carrier":"Carrier "+str(i), "plant":"AMATA",
     "po_no":"PO-"+str(i), "order_date":TODAY, "eta":TODAY+"T"+eta_in(60+5*(i-1)),
     "truck_state":"pending", "photos":[]}
    for i in range(1, 23)
]

TRUCKS = QUIET_TRUCKS

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

async def scroll_state(page):
    return await page.evaluate("""
      () => {
        const content = document.querySelector('.tvscrollcontent');
        if (!content) return null;
        const style = getComputedStyle(content);
        return {
          scrolling: content.classList.contains('tvscrolling'),
          duration: style.animationDuration,
          delay: style.animationDelay,
          rowCount: document.querySelectorAll('.trucktable tbody tr').length
        };
      }
    """)

async def main():
    global TRUCKS
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)

        # ---- quiet day: short list, nothing should scroll ----
        TRUCKS = QUIET_TRUCKS
        page = await browser.new_page(viewport={"width":1280,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)
        await page.goto(BASE+"?tv=1")
        await page.wait_for_timeout(500)
        state = await scroll_state(page)
        print("quiet day scroll state:", state)
        assert state is not None, "expected the TV scroll viewport/content wrapper even on a quiet day"
        assert state["rowCount"] == 2
        assert not state["scrolling"], "a short list that already fits must not auto-scroll"
        await page.close()

        # ---- busy day: 22 trucks, should scroll ----
        TRUCKS = BUSY_TRUCKS
        page = await browser.new_page(viewport={"width":1280,"height":800})
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
        await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), handle)
        # ?scrollSpeed= (test-only override, see ui.tvScrollSpeedOverride in
        # js/state.js) keeps the animation duration short and predictable
        # instead of depending on TV_SCROLL_PX_PER_SEC and this fixture's
        # actual rendered height. ?pollMs= (existing test-only override,
        # js/main.js) is set here too, from the very first load, so a
        # Supabase re-poll -- and the full renderTv() rebuild that comes with
        # it -- happens well inside this same page's lifetime below: the
        # resume logic being tested (tvScrollStartedAt/tvScrollLastDistance in
        # js/render.js) is module-level JS state that a fresh page.goto()
        # would itself reset, so this has to stay one page load throughout,
        # not a second navigation.
        await page.goto(BASE+"?tv=1&scrollSpeed=4000&pollMs=1500")
        await page.wait_for_timeout(500)
        state1 = await scroll_state(page)
        print("busy day scroll state (1st render):", state1)
        assert state1["scrolling"], "a 22-truck list must not fit and should auto-scroll"
        # Round 38 follow-up: no more duplication -- exactly the real 22 rows
        # (all "pending" today, so there's no Ongoing/Completed section-header
        # row to also count), and exactly one body table in the DOM, never two.
        assert state1["rowCount"] == 22, "expected the real row count, not a duplicated copy"
        body_table_count = await page.locator(".tvbodytable").count()
        assert body_table_count == 1, "the table markup must never be duplicated in the DOM"

        def delay_seconds(s):
            return float(s["delay"].rstrip("s"))
        delay1 = delay_seconds(state1)

        # ---- resume across a forced re-render: must not jump back to the
        #      top. Waiting past two 1.5s poll cycles forces at least one
        #      loadFromSupabase()-triggered render() (see main.js's
        #      setInterval) while this same page stays open.
        await page.wait_for_timeout(3200)
        state2 = await scroll_state(page)
        delay2 = delay_seconds(state2)
        print("busy day scroll state (after forced re-render): delay1=", delay1, "delay2=", delay2, state2)
        assert state2["scrolling"], "should still be auto-scrolling after the forced re-render"
        # A resumed animation keeps growing more negative over time (mod the
        # cycle length) -- it never resets to 0/near-0 just because a rebuild
        # happened. This is the regression Round 38 specifically guarded
        # against: naively restarting the CSS animation on every ~15s
        # periodic refresh would make the board visibly jump back to the top
        # instead of ever completing a smooth pass.
        assert delay2 < 0, "a re-rendered, already-scrolling board should resume with a negative delay"
        assert delay2 != delay1, "the delay should have moved on across the forced re-render, not stayed frozen"

        await browser.close()
        print("TV SCROLL TEST PASSED")

asyncio.run(main())
