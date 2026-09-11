import asyncio, json, os, re
from datetime import date, datetime, timedelta
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"
TODAY = date.today().isoformat()
IMPORT_ROW_DATE = (date.today() + timedelta(days=1)).isoformat()

# Round 28: two related asks from a real user (relayed by Theo) after
# inspecting the real "Incoming plan AMATA" file --
#  1) the "RM PM incoming" sheet's column E ("ชื่อภาษาไทย") shown alongside
#     the carrier name (column D, "Supplier name") -- confirmed on real data
#     that E is NOT reliably a translation of D (see importPlan.js's
#     IMPORT_FIELD_MATCHERS comment), so it's captured as its own field
#     (carrierTh / trucks.carrier_th) rather than replacing carrier.
#  2) a colour per material type (RM/PM, column A) on the card/table so the
#     two are easy to tell apart at a glance -- trucks.mat_type.
# Part A below drives the real import screen (mirrors test_v2_plant_field.py)
# to confirm the column mapping + insert payload; Part B mocks the GET
# response directly (mirrors test_v2_table_view_responsive.py) to check the
# card/table/sheet rendering without re-driving the whole import flow.

def eta_in(minutes):
    return (datetime.now() + timedelta(minutes=minutes)).strftime("%H:%M:00")

# ---------- Part A: import mapping ----------

STUB_XLSX = """
window.XLSX = {
  SSF: { parse_date_code: function(v){ return null; } },
  read: function(data, opts){
    return { SheetNames: ["RM PM incoming"], Sheets: { "RM PM incoming": {} } };
  },
  utils: {
    sheet_to_json: function(ws, opts){
      return [
        ["", "PO", "Supplier name", "ชื่อภาษาไทย", "ประเภทสินค้าหรืองานที่ขนส่ง", "จำนวนที่ขนส่ง", "หน่วย", "วันที่ขนส่ง", "เวลาเข้าโรงงาน"],
        ["RM", "PO-1001", "100079388 S&D Industries Co Ltd", "เอส แอน ดี", "Wheat Wholegrain", 100, "KG", "%s", "09:00"],
        ["PM", "PO-1002", "SGL - Mon Logistic", "รถบริษัทมนต์ - SGL", "Pallet wrap", 50, "PCS", "%s", "10:00"]
      ];
    }
  }
};
""" % (IMPORT_ROW_DATE, IMPORT_ROW_DATE)

IMPORTED = []
NEXT_ID = [1]

async def import_handle(route, request):
    url = request.url; method = request.method
    if "/rest/v1/trucks" in url and method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(IMPORTED))
        return
    if "/rest/v1/trucks" in url and method == "POST":
        body = json.loads(request.post_data or "[]")
        rows = body if isinstance(body, list) else [body]
        created = []
        for r in rows:
            row = dict(r)
            row.setdefault("id", f"id-{NEXT_ID[0]}"); NEXT_ID[0] += 1
            row.setdefault("truck_state", "pending"); row.setdefault("photos", [])
            IMPORTED.append(row); created.append(row)
        await route.fulfill(status=201, content_type="application/json", body=json.dumps(created))
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def run_import_part(browser):
    context = await browser.new_context(viewport={"width":390, "height":700})
    page = await context.new_page()
    page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
    await page.add_init_script(STUB_XLSX)
    await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), import_handle)

    await page.goto(BASE)
    await page.wait_for_timeout(400)
    await page.click("[data-role-step='pin']")
    await page.wait_for_timeout(150)
    await page.fill("#pinInput", "748231")
    await page.click("[data-pin-submit]")
    await page.wait_for_timeout(400)
    await page.click("[data-open-import]")
    await page.wait_for_timeout(200)
    await page.set_input_files("#importFileInput", {
        "name": "Incoming plan.xlsx",
        "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "buffer": b"fake-bytes-not-real-xlsx"
    })
    await page.wait_for_timeout(300)
    await page.fill("#import-from-date", "2020-01-01")
    await page.click("[data-import-preview]")
    await page.wait_for_timeout(400)
    await page.click("[data-import-confirm]")
    await page.wait_for_timeout(500)

    assert len(IMPORTED) == 2, "expected both rows to import as separate trucks"
    rm_row = next(r for r in IMPORTED if r["po_no"] == "PO-1001")
    pm_row = next(r for r in IMPORTED if r["po_no"] == "PO-1002")
    print("RM row carrier/carrier_th/mat_type:", rm_row["carrier"], "|", rm_row["carrier_th"], "|", rm_row["mat_type"])
    print("PM row carrier/carrier_th/mat_type:", pm_row["carrier"], "|", pm_row["carrier_th"], "|", pm_row["mat_type"])
    # column D (Supplier name) stays the carrier -- never replaced by E
    assert rm_row["carrier"] == "100079388 S&D Industries Co Ltd"
    assert rm_row["carrier_th"] == "เอส แอน ดี"
    assert rm_row["mat_type"] == "RM"
    assert pm_row["carrier"] == "SGL - Mon Logistic"
    assert pm_row["carrier_th"] == "รถบริษัทมนต์ - SGL"
    assert pm_row["mat_type"] == "PM"
    # the existing "[RM]"/"[PM]" prefix on the product line (Round 6) is
    # unchanged by this round -- mat_type is a new structured field
    # *alongside* it, not a replacement.
    assert rm_row["details"].startswith("[RM] ")
    assert pm_row["details"].startswith("[PM] ")

    await context.close()

# ---------- Part B: card / table / sheet rendering ----------

TRUCKS = [
    {"id":"1","reference_id":"T-1","carrier":"100079388 S&D Industries Co Ltd","carrier_th":"เอส แอน ดี",
     "mat_type":"RM","plant":"AMATA","po_no":"PO-2001",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(120),"truck_state":"pending","photos":[]},
    {"id":"2","reference_id":"T-2","carrier":"SGL - Mon Logistic","carrier_th":"รถบริษัทมนต์ - SGL",
     "mat_type":"PM","plant":"AMATA","po_no":"PO-2002",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(180),"truck_state":"pending","photos":[]},
    # a truck with neither field (manually created, or from "Indirect
    # incoming" which has no RM/PM column) must render exactly as before --
    # no stray "· null", no color class.
    {"id":"3","reference_id":"T-3","carrier":"Plain Carrier Co","plant":"AMATA","po_no":"PO-2003",
     "order_date":TODAY,"eta":TODAY+"T"+eta_in(240),"truck_state":"pending","photos":[]},
]

async def render_handle(route, request):
    url = request.url
    if "/rest/v1/trucks" in url and request.method == "GET":
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(TRUCKS))
        return
    if "/rest/v1/photos" in url:
        await route.fulfill(status=200, content_type="application/json", body="[]")
        return
    await route.fulfill(status=404, body="not mocked: "+url)

async def run_render_part(browser):
    page = await browser.new_page(viewport={"width":390, "height":800})
    page.on("pageerror", lambda exc: print("PAGEERROR:", exc))
    await page.route(re.compile(r"wezkonqnlkmkthbfimai\.supabase\.co.*"), render_handle)

    await page.goto(BASE)
    await page.wait_for_timeout(400)
    await page.click("[data-role-step='pin']")
    await page.wait_for_timeout(150)
    await page.fill("#pinInput", "748231")
    await page.click("[data-pin-submit]")
    await page.wait_for_timeout(400)

    # ---- cards (mobile) ----
    carrier_texts = await page.locator(".card-carrier").all_text_contents()
    print("card carrier lines:", carrier_texts)
    assert any("เอส แอน ดี" in t for t in carrier_texts), "RM truck's Thai name should show under the carrier"
    assert any("รถบริษัทมนต์" in t for t in carrier_texts), "PM truck's Thai name should show under the carrier"
    assert any(t == "Plain Carrier Co" for t in carrier_texts), "a truck with no carrier_th shows just the carrier, nothing appended"

    rm_chip = page.locator(".card", has_text="PO-2001").locator(".chip", has_text="RM")
    pm_chip = page.locator(".card", has_text="PO-2002").locator(".chip", has_text="PM")
    assert await rm_chip.count() == 1
    assert await pm_chip.count() == 1
    rm_bg = await rm_chip.evaluate("el => getComputedStyle(el).backgroundColor")
    pm_bg = await pm_chip.evaluate("el => getComputedStyle(el).backgroundColor")
    print("RM chip bg:", rm_bg, "| PM chip bg:", pm_bg)
    assert rm_bg != pm_bg, "RM and PM should be visually distinguishable colors"
    # the plain truck (no mat_type) must show no RM/PM chip at all
    plain_chips = await page.locator(".card", has_text="PO-2003").locator(".chip").all_text_contents()
    assert "RM" not in plain_chips and "PM" not in plain_chips

    # ---- truck sheet (full detail) ----
    await page.click(".card >> nth=0")
    await page.wait_for_timeout(200)
    sheet_carrier = await page.text_content(".sheet-carrier")
    print("sheet carrier line:", sheet_carrier)
    assert "S&D Industries" in sheet_carrier and "เอส แอน ดี" in sheet_carrier
    await page.click("[data-close='1']")
    await page.wait_for_timeout(150)

    # ---- desktop table view ----
    await page.set_viewport_size({"width":1280, "height":800})
    await page.wait_for_timeout(200)
    assert await page.locator("tr.truckrow.matrm").count() == 1
    assert await page.locator("tr.truckrow.matpm").count() == 1
    rm_row_bg = await page.locator("tr.truckrow.matrm").evaluate("el => getComputedStyle(el).backgroundColor")
    pm_row_bg = await page.locator("tr.truckrow.matpm").evaluate("el => getComputedStyle(el).backgroundColor")
    plain_row_bg = await page.locator("tr.truckrow", has_text="PO-2003").evaluate("el => getComputedStyle(el).backgroundColor")
    print("table row backgrounds -- RM:", rm_row_bg, "PM:", pm_row_bg, "plain:", plain_row_bg)
    assert rm_row_bg != plain_row_bg and pm_row_bg != plain_row_bg and rm_row_bg != pm_row_bg
    table_text = await page.locator("tr.truckrow.matrm").text_content()
    assert "เอส แอน ดี" in table_text

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        await run_import_part(browser)
        await browser.close()
        browser2 = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        await run_render_part(browser2)
        await browser2.close()
        print("CARRIER TH / MAT TYPE TEST PASSED")

asyncio.run(main())
