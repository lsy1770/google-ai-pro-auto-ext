"""扩展加载与注入链路冒烟测试（Playwright + 真实 Chromium 加载扩展）。

覆盖：
  1. MV3 扩展被 Chrome 正常加载、manifest 正确、service worker 可被唤醒
  2. popup.html 正常渲染并可调用后台 RPC（getState / importAccounts / saveCard）
  3. one.google.com 主世界注入器改写了 XHR 的 f.req（Ngbm）与 iframe 的 ear 参数
  4. tokenized.play.google.com 结账子框架收到 checkoutTick 后完成零元核验并点击【订阅】
  5. 非零金额时零元保护阻止点击

运行：python browser_extension/tests/test_smoke.py
"""

import json
import os
import sys
import tempfile
import time
import urllib.parse

from playwright.sync_api import sync_playwright

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
EXT_DIR = os.path.abspath(os.path.join(HERE, ".."))

PREFIX = "subs:com.google.android.apps.subscriptions.red:"
ITEM_AI = PREFIX + "g1.2tb.ai.subs_variant"
ITEM_YT = PREFIX + "g1.youtube_premium_individual_add_on"
TOK_12M = (
    "AVbCH/cspB8VdqKJ+ax/uPxUFAVuYRPX4iSjtg4Fu0PG9zUeURSM7y//LlQva1dCd/rbKVM6EJmyiG/"
    "C9BoQ95pMl8yDCHuiwCvM5CuGJME="
)
TOK_YT = (
    "AVbCH/eW4Nfp8KBl0zlm7x9PhaiCvpnqwUuL2D8NFPBQgmM9+HuYS1h2xH5lLWU/BsBj775LK5GqK8UHKqo"
    "SzhDDz+PqP3paNesqLU0r9i6XCrYa"
)

CFG = {
    "name": "sys_layer1_12m",
    "layer": "layer1",
    "token": "12m",
    "mode": 5,
    "full_items": [
        [[ITEM_AI, 21], None, None, None, 1, [TOK_12M]],
        [[ITEM_YT, 21], None, None, None, 1, [TOK_YT]],
    ],
    "ear8": None,
}

PLANS_HTML = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Google One · 方案</title></head>
<body style="background:#fff;margin:0">
<header><div aria-label="Google 账号：demo.user@gmail.com" title="demo.user@gmail.com">demo.user@gmail.com</div></header>
<div id="ent">会员有效期至：2028年5月6日</div>
<div style="height:380px;padding:20px;font:14px sans-serif">Google One 方案页（测试夹具）</div>
<button id="offer" style="margin-left:320px;padding:14px 22px;font-size:15px">获取折扣</button>
<iframe id="ck" style="width:480px;height:260px;border:1px solid #ddd"></iframe>
<script>
document.getElementById('offer').addEventListener('click', () => {
  const node = new Array(13).fill(null);
  node[7] = [null, 5, null, null, null, []];
  node[10] = [[]];
  node[12] = [];
  const payload = [[['Ngbm', JSON.stringify([node, node])]]];
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/log?hit=1');
  xhr.setRequestHeader('content-type', 'application/x-www-form-urlencoded');
  xhr.send('f.req=' + encodeURIComponent(JSON.stringify(payload)));

  const ear = new Array(25).fill(null);
  ear[8] = [null, 5, null, null, null, []];
  ear[13] = [];
  document.getElementById('ck').src =
    'https://tokenized.play.google.com/store/eacquire/multiline?ear=' +
    encodeURIComponent(JSON.stringify(ear));
});
</script></body></html>"""

CHECKOUT_HTML = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>
<body style="font:14px sans-serif;padding:16px">
  <div>Google AI Pro (5 TB)</div>
  <div id="due">今日应付</div>
  <div id="amount">US$0.00</div>
  <button id="sub" style="padding:12px 22px;margin-top:10px">订阅</button>
  <script>
    window.__gpClicked = 0;
    document.getElementById('sub').addEventListener('click', () => { window.__gpClicked += 1; });
  </script>
</body></html>"""

CHECKOUT_PAID_HTML = CHECKOUT_HTML.replace("US$0.00", "US$19.99")

PLAY_HTML = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>订阅</title></head>
<body style="font:14px sans-serif;padding:16px">
  <div>Google AI Pro (5 TB)</div>
  <div>续订日期：2027年11月6日</div>
  <button style="padding:8px 16px">管理</button>
</body></html>"""

EXT_ID_JS = """() => {
  const mgr = document.querySelector('extensions-manager');
  if (!mgr || !mgr.shadowRoot) return '';
  const list = mgr.shadowRoot.querySelector('extensions-item-list');
  if (!list || !list.shadowRoot) return '';
  const item = list.shadowRoot.querySelector('extensions-item');
  return item ? item.id : '';
}"""


def log(msg):
    print(msg, flush=True)


def find_ext_id(ctx):
    page = ctx.new_page()
    page.goto("chrome://extensions/")
    time.sleep(1.6)
    ext_id = page.evaluate(EXT_ID_JS)
    page.close()
    return ext_id


def preflight(chromium_path):
    """Chrome 加载前的前置校验：
    1) 目录内不能有 `_` 开头的文件/目录（Chrome 保留，会直接拒绝加载）；
    2) 用 Chrome 自带 --pack-extension 做一次真实清单校验。
    """
    import shutil
    import subprocess

    problems = []
    reserved = []
    for root, dirs, files in os.walk(EXT_DIR):
        for name in list(dirs) + list(files):
            if name.startswith("_"):
                reserved.append(os.path.relpath(os.path.join(root, name), EXT_DIR))
    results = []
    results.append(("扩展目录没有 `_` 开头条目（Chrome 保留名）", not reserved, ", ".join(reserved[:6])))

    parent = os.path.dirname(EXT_DIR)
    crx = os.path.join(parent, os.path.basename(EXT_DIR) + ".crx")
    pem = os.path.join(parent, os.path.basename(EXT_DIR) + ".pem")
    for path in (crx, pem):
        if os.path.exists(path):
            os.remove(path)
    packed = False
    detail = ""
    try:
        proc = subprocess.run(
            [chromium_path, f"--pack-extension={EXT_DIR}", "--no-message-box"],
            capture_output=True,
            timeout=120,
        )
        packed = os.path.exists(crx)
        detail = (proc.stderr or proc.stdout or b"").decode("utf-8", "replace")[-200:]
    except Exception as exc:  # pragma: no cover
        detail = repr(exc)[:200]
    finally:
        for path in (crx, pem):
            if os.path.exists(path):
                os.remove(path)
    results.append(("Chrome 能打包该扩展（清单校验通过）", packed, detail))
    return results


def main():
    failures = []

    def check(name, condition, detail=""):
        if condition:
            log(f"  [PASS] {name}")
        else:
            log(f"  [FAIL] {name} {detail}")
            failures.append(name)

    user_dir = tempfile.mkdtemp(prefix="gpro-profile-")
    args = [
        f"--disable-extensions-except={EXT_DIR}",
        f"--load-extension={EXT_DIR}",
        "--no-first-run",
        "--no-default-browser-check",
    ]

    with sync_playwright() as p:
        log(f"[1] 启动 Chromium 加载扩展: {EXT_DIR}")
        for name, ok, detail in preflight(p.chromium.executable_path):
            check(name, ok, detail)
        ctx = p.chromium.launch_persistent_context(
            user_dir, args=args, headless=True, channel="chromium", viewport={"width": 1280, "height": 900}
        )

        captured = {}

        def handle_log(route, request):
            captured["body"] = request.post_data or ""
            route.fulfill(status=204, body="")

        def handle_plans(route, request):
            route.fulfill(status=200, content_type="text/html; charset=utf-8", body=PLANS_HTML)

        def handle_checkout(route, request):
            body = CHECKOUT_PAID_HTML if "paid=1" in request.url else CHECKOUT_HTML
            route.fulfill(status=200, content_type="text/html; charset=utf-8", body=body)

        def handle_play(route, request):
            route.fulfill(status=200, content_type="text/html; charset=utf-8", body=PLAY_HTML)

        # Playwright 后注册的路由优先匹配：先注册通配，再注册精确路径
        ctx.route("https://one.google.com/**", handle_plans)
        ctx.route("https://one.google.com/log**", handle_log)
        ctx.route("https://tokenized.play.google.com/**", handle_checkout)
        ctx.route("https://play.google.com/**", handle_play)

        ext_id = find_ext_id(ctx)
        check("扩展已被 Chrome 加载", bool(ext_id), ext_id)
        if not ext_id:
            ctx.close()
            return 1
        log(f"    扩展 ID: {ext_id}")

        # --- 2. popup ---
        log("[2] popup 渲染与后台 RPC")
        popup = ctx.new_page()
        popup.goto(f"chrome-extension://{ext_id}/popup.html")
        popup.wait_for_selector("#btnStart", timeout=10000)
        check("popup 渲染出控制按钮", popup.is_visible("#btnStart"))
        check("popup 渲染出账号导入框", popup.evaluate("() => !!document.getElementById('importBox')"))

        manifest = popup.evaluate("() => chrome.runtime.getManifest()")
        check("manifest 版本为 2.2.0", manifest.get("version") == "2.2.0", manifest.get("version"))
        check(
            "权限包含 scripting/storage/tabs/alarms",
            all(x in manifest.get("permissions", []) for x in ("scripting", "storage", "tabs", "alarms")),
            str(manifest.get("permissions")),
        )

        state = popup.evaluate("() => chrome.runtime.sendMessage({scope:'popup', type:'getState'})")
        check("后台 getState 正常返回", bool(state and state.get("ok")), str(state)[:200])

        sw_started = len(ctx.service_workers) > 0
        if not sw_started:
            try:
                ctx.wait_for_event("serviceworker", timeout=6000)
                sw_started = True
            except Exception:
                sw_started = False
        check("service worker 可被唤醒", sw_started)

        imported = popup.evaluate(
            """() => chrome.runtime.sendMessage({scope:'popup', type:'importAccounts',
                 rawText:'tester@gmail.com----pass1234----backup@gmail.com----JBSWY3DPEHPK3PXP'})"""
        )
        check("账号导入 RPC 成功（新增 1 个）", bool(imported and imported.get("added") == 1), str(imported)[:200])

        saved = popup.evaluate(
            """() => chrome.runtime.sendMessage({scope:'popup', type:'saveCard',
                 card:{number:'4111111111111111', expMonth:'09', expYear:'2030', cvc:'123', holder:'TEST USER', zip:'97201'}})"""
        )
        check("支付卡保存 RPC 成功", bool(saved and saved.get("ok")), str(saved)[:200])

        popup.evaluate("() => chrome.runtime.sendMessage({scope:'popup', type:'clearAccounts'})")

        # --- 3. 注入器 ---
        log("[3] 注入器：Ngbm f.req 与 ear 改写")
        popup.evaluate("(cfg) => chrome.storage.local.set({gpro_inject: cfg})", CFG)
        page = ctx.new_page()
        page.goto("https://one.google.com/plans?hl=zh-CN")
        page.wait_for_selector("#offer", timeout=10000)

        mounted = False
        for _ in range(40):
            if page.evaluate("() => !!(window.__GP_INSTALLED && window.__GP_CONFIG__)"):
                mounted = True
                break
            time.sleep(0.2)
        check("主世界钩子已安装并拿到配置", mounted)

        page.click("#offer")
        for _ in range(40):
            if captured.get("body"):
                break
            time.sleep(0.2)
        body = urllib.parse.unquote(captured.get("body", ""))
        check("XHR 请求被拦截并改写", TOK_12M in body, body[:200])
        check("full_items 已替换（AI 商品键存在）", ITEM_AI in body, body[:200])
        check("YouTube 免费令牌一并注入", TOK_YT in body)

        frame_handle = None
        for attempt in range(60):
            for fr in page.frames:
                if "eacquire" in fr.url:
                    frame_handle = fr
                    break
            if frame_handle:
                break
            if attempt in (5, 20, 50):
                diag = page.evaluate(
                    """() => {
                        const f = document.getElementById('ck');
                        return {
                          iframes: document.querySelectorAll('iframe').length,
                          src: f ? f.src.slice(0, 120) : '',
                          display: f ? getComputedStyle(f).display : '',
                          connected: f ? f.isConnected : false
                        };
                    }"""
                )
                log(f"    [diag {attempt}] {json.dumps(diag, ensure_ascii=False)}")
            time.sleep(0.2)
        check("结账 iframe 已创建", frame_handle is not None)
        if frame_handle is None:
            log("    frames: " + str([f.url[:90] for f in page.frames]))
        if frame_handle:
            ear_raw = urllib.parse.parse_qs(urllib.parse.urlparse(frame_handle.url).query).get("ear", [""])[0]
            ear = json.loads(ear_raw) if ear_raw else []
            patched = bool(ear) and ear[13][0][0][0][0] == ITEM_AI and ear[24] is None
            check("ear 参数已注入 offer 且 ear[24] 清空", patched, str(ear)[:200])

        # --- 4. 结账代理 ---
        log("[4] 结账子框架：零元核验 + 点击订阅")
        tab_id = popup.evaluate(
            "() => chrome.tabs.query({url:'https://one.google.com/*'}).then(t => t.length ? t[0].id : null)"
        )
        check("定位到工作标签页", bool(tab_id), str(tab_id))

        tick = {
            "type": "checkoutTick",
            "card": {
                "number": "4111111111111111",
                "expMonth": "09",
                "expYear": "2030",
                "cvc": "123",
                "holder": "TEST USER",
                "zip": "97201",
                "last4": "1111",
            },
            "creds": {},
            "guard": True,
            "strict": False,
        }
        for _ in range(8):
            popup.evaluate(
                "(a) => chrome.tabs.sendMessage(a.tabId, Object.assign({scope:'cmd'}, a.cmd)).catch(() => {})",
                {"tabId": tab_id, "cmd": tick},
            )
            time.sleep(0.35)
        clicked = frame_handle.evaluate("() => window.__gpClicked") if frame_handle else 0
        check("零元弹窗中已自动点击【订阅】", clicked == 1, str(clicked))

        # --- 5. 非零金额保护 ---
        log("[5] 零元保护：非零金额必须拦截")
        paid = ctx.new_page()
        paid.goto("https://one.google.com/plans?hl=zh-CN")
        paid.wait_for_selector("#offer", timeout=10000)
        paid.evaluate(
            """() => {
                const ear = new Array(25).fill(null);
                ear[8] = [null, 5, null, null, null, []];
                ear[13] = [];
                document.getElementById('ck').src =
                  'https://tokenized.play.google.com/store/eacquire/multiline?paid=1&ear=' +
                  encodeURIComponent(JSON.stringify(ear));
            }"""
        )
        paid_frame = None
        for attempt in range(60):
            for fr in paid.frames:
                if "paid=1" in fr.url:
                    paid_frame = fr
                    break
            if paid_frame:
                break
            if attempt in (5, 25, 50):
                diag = paid.evaluate(
                    """() => {
                        const f = document.getElementById('ck');
                        return { iframes: document.querySelectorAll('iframe').length, src: f ? f.src.slice(0, 130) : '' };
                    }"""
                )
                log(f"    [paid diag {attempt}] {json.dumps(diag, ensure_ascii=False)}")
            time.sleep(0.2)
        check("非零金额结账框架已加载", paid_frame is not None)
        if paid_frame:
            tab_ids = popup.evaluate(
                "() => chrome.tabs.query({url:'https://one.google.com/*'}).then(t => t.map(x => x.id))"
            )
            for _ in range(5):
                for tid in tab_ids or []:
                    popup.evaluate(
                        "(a) => chrome.tabs.sendMessage(a.tabId, Object.assign({scope:'cmd'}, a.cmd)).catch(() => {})",
                        {"tabId": tid, "cmd": tick},
                    )
                time.sleep(0.4)
            paid_clicked = paid_frame.evaluate("() => window.__gpClicked")
            bar_text = paid_frame.evaluate(
                "() => { const b = document.getElementById('__gp_bar'); return b ? b.textContent : ''; }"
            )
            check("非零金额未点击订阅", paid_clicked == 0, str(paid_clicked))
            check("页面提示零元核验未通过", "零元核验" in bar_text, bar_text)

        # --- 6. 已登录账号模式 ---
        log("[6] 已登录账号模式：识别当前账号 + 启动 + 停止")
        probe = popup.evaluate("() => chrome.runtime.sendMessage({scope:'popup', type:'probeSession'})")
        check(
            "probeSession 识别出浏览器已登录账号",
            bool(probe and probe.get("ok") and probe.get("email") == "demo.user@gmail.com"),
            str(probe)[:200],
        )
        check(
            "多来源核验取较晚日期（Google One 2028-05-06 > Play 2027-11-06）",
            bool(probe and probe.get("expiry") == "2028-05-06" and probe.get("source") == "Google One"),
            str(probe)[:200],
        )

        started = popup.evaluate("() => chrome.runtime.sendMessage({scope:'popup', type:'start', mode:'session'})")
        check("已登录模式 start 返回 ok（不要求账号/密码）", bool(started and started.get("ok")), str(started)[:200])

        ses = None
        for _ in range(50):
            st = popup.evaluate("() => chrome.runtime.sendMessage({scope:'popup', type:'getState'})")
            if st and st.get("state"):
                ses = st["state"]
                if ses.get("session", {}).get("email"):
                    break
            time.sleep(0.4)
        check(
            "运行状态里记录了当前登录账号",
            bool(ses and ses.get("session", {}).get("email") == "demo.user@gmail.com"),
            str(ses and ses.get("session"))[:200],
        )

        popup.evaluate("() => chrome.runtime.sendMessage({scope:'popup', type:'stop'})")
        stopped = False
        for _ in range(80):
            st = popup.evaluate("() => chrome.runtime.sendMessage({scope:'popup', type:'getState'})")
            if st and st.get("state") and not st["state"].get("running"):
                stopped = True
                break
            time.sleep(0.4)
        check("停止后回到空闲状态", stopped)

        shot_dir = os.path.join(HERE, "..", "test-results")
        os.makedirs(shot_dir, exist_ok=True)
        popup.screenshot(path=os.path.join(shot_dir, "popup-smoke.png"), full_page=True)
        ctx.close()

    log("")
    if failures:
        log("失败项: " + " | ".join(failures))
        return 1
    log("全部冒烟测试通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
