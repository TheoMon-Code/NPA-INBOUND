import asyncio, os, re
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8934/index.html"

# A tiny local HTTP server (see conftest below via route) stands in for
# cdnjs here, so this test exercises the REAL success path: importScripts()
# actually succeeding inside the worker, posting "ready", then parsing a
# real (if minimal) xlsx-like payload -- as opposed to the other suites,
# which all exercise the fallback (cdnjs blocked -> onerror -> main thread).
FAKE_XLSX_LIB = """
self.XLSX = {
  read: function(data, opts){
    return { SheetNames: ["Sheet1"], Sheets: { "Sheet1": {} } };
  },
  utils: {
    sheet_to_json: function(ws, opts){
      return [["h1","h2"],["v1","v2"]];
    }
  }
};
"""

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None)
        page = await browser.new_page()
        page.on("pageerror", lambda exc: print("PAGEERROR:", exc))

        # Redirect the worker's importScripts() call to a same-origin fake
        # "cdnjs" response so we can exercise the ready->parse success path
        # without needing real network access to the real CDN.
        async def fake_cdn(route, request):
            await route.fulfill(status=200, content_type="application/javascript", body=FAKE_XLSX_LIB)
        await page.route(re.compile(r"cdnjs\.cloudflare\.com.*xlsx.*"), fake_cdn)

        await page.goto(BASE)
        await page.wait_for_timeout(300)

        result = await page.evaluate("""() => {
            return new Promise((resolve) => {
                const w = new Worker('js/importWorker.js');
                const timer = setTimeout(() => resolve({timedOut:true}), 8000);
                let sawReady = false;
                w.onerror = (e) => { clearTimeout(timer); resolve({onerror: e.message || String(e)}); };
                w.onmessage = (e) => {
                    if(e.data && e.data.type === 'ready'){
                        sawReady = true;
                        w.postMessage({type:'parse', buffer: new ArrayBuffer(4)});
                        return;
                    }
                    if(e.data && e.data.type === 'result'){
                        clearTimeout(timer);
                        resolve({sawReady, result: e.data});
                    }
                };
            });
        }""")
        print("worker result:", result)
        assert result.get("sawReady") is True, "expected a 'ready' message once importScripts succeeded"
        r = result["result"]
        assert r["ok"] is True
        assert r["sheetNames"] == ["Sheet1"]
        assert r["sheets"]["Sheet1"] == [["h1","h2"],["v1","v2"]]

        await browser.close()
        print("WORKER SUCCESS-PATH TEST PASSED")

asyncio.run(main())
