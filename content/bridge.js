/* ============================================================================
 * content/bridge.js —— one.google.com 隔离世界桥
 *   · 把 offer 配置推进主世界 inject.js（postMessage + 数据集属性）
 *   · 点击方案页的优惠入口按钮（开始使用 / 获取优惠 / 换用此方案 / 升级 …）
 *   · 点击结账过渡确认按钮（继续订阅 / 是的，继续 / 换用此方案 …）
 *   · 读取当前账号邮箱、24 位订阅 ID、注入器状态
 * ==========================================================================*/
(() => {
  "use strict";
  const Core = window.GProCore;
  if (!Core || window.__GP_BRIDGE__) return;
  window.__GP_BRIDGE__ = true;

  const TOP = window.top === window;
  let injectState = null;
  let lastSubId = null;

  const emit = (payload) => {
    try {
      chrome.runtime.sendMessage(Object.assign({ scope: "evt" }, payload));
    } catch (e) {}
  };

  const log = (note, level) => emit({ type: "log", note, level: level || "info" });

  /* --------------------------- 配置推送 ------------------------------- */
  function pushConfig(cfg) {
    try {
      document.documentElement.setAttribute("data-gpro-cfg", JSON.stringify(cfg || null));
    } catch (e) {}
    try {
      window.postMessage({ __gp: 1, type: "cfg", cfg: cfg || null }, "*");
    } catch (e) {}
  }

  function loadStoredConfig() {
    try {
      chrome.storage.local.get(["gpro_inject"], (r) => {
        if (r && r.gpro_inject) pushConfig(r.gpro_inject);
      });
    } catch (e) {}
  }

  /* --------------------------- 页面识别 ------------------------------- */
  function detectEmail() {
    const parts = [];
    try {
      document.querySelectorAll('[aria-label*="@"],[data-email],[title*="@"]').forEach((el) => {
        parts.push(el.getAttribute("aria-label") || "", el.getAttribute("data-email") || "", el.getAttribute("title") || "");
      });
    } catch (e) {}
    try {
      const html = document.documentElement ? document.documentElement.innerHTML : "";
      const m = html.match(/[A-Za-z0-9._%+\-]+@(?:gmail|googlemail)\.[A-Za-z.]{2,}/);
      if (m) parts.push(m[0]);
    } catch (e) {}
    const re = /([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/;
    for (const p of parts) {
      const mm = String(p).match(re);
      if (mm) return mm[1].toLowerCase();
    }
    return "";
  }

  function readSubId() {
    let html = "";
    try {
      html = document.documentElement ? document.documentElement.innerHTML : "";
    } catch (e) {
      return null;
    }
    let m = html.match(/"([a-z]{24})\.AO-[A-Za-z0-9]+"/);
    if (m) return m[1];
    m = html.match(/"([a-z]{24})\.AO-J1O"/);
    if (m) return m[1];
    const blocks = html.match(/AF_initDataCallback\(\{[\s\S]{0,6000}?\}\);/g) || [];
    for (const blk of blocks) {
      if (blk.indexOf("subscriptions.red") < 0 && blk.indexOf("g1.") < 0) continue;
      const cand = blk.match(/"([a-z]{24})"/);
      if (cand) return cand[1];
    }
    return null;
  }

  function pageInfo() {
    const url = location.href;
    const email = detectEmail();
    let snippet = "";
    try {
      snippet = Core.shortText((document.body && document.body.innerText) || "", 600);
    } catch (e) {}
    return {
      kind: /one\.google\.com/.test(location.hostname) ? "plans" : "other",
      url,
      top: TOP,
      signedIn: !!email,
      email,
      title: (document.title || "").slice(0, 80),
      text: snippet,
      inject: injectState || null,
      subId: lastSubId
    };
  }

  /* ------------------------ 方案页优惠入口 ---------------------------- */
  function findOfferButton() {
    const wanted = Core.T.OFFER;
    const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], div[role="button"]'));
    const hits = [];
    for (const el of nodes) {
      if (!Core.isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 15 || rect.height < 15) continue;
      if (rect.left < 240) continue; // 侧栏导航排除
      const t = (el.innerText || el.textContent || "").trim();
      if (!t || t.length > 48) continue;
      const low = t.toLowerCase();
      if (!wanted.some((w) => low === w || low.indexOf(w) >= 0)) continue;
      hits.push({ el, text: t, top: rect.top });
    }
    if (!hits.length) return null;
    // 取页面最下方的动作按钮：Google One 方案卡片中的主按钮
    hits.sort((a, b) => b.top - a.top);
    return hits[0];
  }

  function clickOffer() {
    const hit = findOfferButton();
    if (!hit) return { ok: false, note: "未找到可点击的优惠入口按钮" };
    try {
      hit.el.scrollIntoView({ block: "center" });
    } catch (e) {}
    try {
      hit.el.click();
    } catch (e) {
      try {
        hit.el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      } catch (e2) {
        return { ok: false, note: "点击失败: " + e2.message };
      }
    }
    return { ok: true, text: hit.text };
  }

  function clickTransition() {
    const wanted = Core.T.TRANSITION;
    const nodes = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const el of nodes) {
      const t = (el.innerText || "").trim();
      if (!t || t.length > 24) continue;
      const low = t.toLowerCase();
      if (!wanted.some((w) => low === w || low.indexOf(w) >= 0)) continue;
      if (!Core.trulyOnTop(el)) continue;
      try {
        el.click();
        return { ok: true, text: t };
      } catch (e) {}
    }
    return { ok: false };
  }

  /* --------------------------- 消息处理 ------------------------------ */
  function handle(cmd) {
    switch (cmd.type) {
      case "probe":
        emit({ type: "pageInfo", info: pageInfo() });
        return;
      case "injectSet":
        pushConfig(cmd.cfg || null);
        emit({ type: "injectAck", ok: true });
        return;
      case "clickOffer": {
        const res = clickOffer();
        emit({ type: "offerClicked", ok: res.ok, text: res.text || "", note: res.note || "" });
        return;
      }
      case "clickTransition": {
        const res = clickTransition();
        if (res.ok) emit({ type: "transitionClicked", text: res.text });
        return;
      }
      case "readSubId": {
        const id = readSubId();
        if (id) lastSubId = id;
        emit({ type: "subId", value: id || "" });
        return;
      }
      case "readDates": {
        let text = "";
        try {
          text = (document.body && document.body.innerText) || "";
        } catch (e) {}
        const labeled = Core.pickEntitlement(text);
        const all = Core.allDates(text);
        const best = labeled || (all.length ? Core.maxISO(all) : null);
        emit({
          type: "dates",
          data: {
            url: location.href,
            entitlement: best,
            labeled: labeled || "",
            dates: all,
            plan: Core.planName(text),
            text: Core.shortText(text, 1400)
          }
        });
        return;
      }
      default:
        return;
    }
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.scope !== "cmd") return false;
      // 只有顶层框架处理方案页动作
      if (!TOP && msg.type !== "probe") return false;
      handle(msg);
      return false;
    });
  } catch (e) {}

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.__gp !== 1 || d.type !== "state") return;
    injectState = d.state;
    if (d.state && d.state.subId) lastSubId = d.state.subId;
  });

  window.addEventListener("load", loadStoredConfig);
  loadStoredConfig();
  setTimeout(loadStoredConfig, 1200);
  setTimeout(() => emit({ type: "pageInfo", info: pageInfo() }), 400);
  setInterval(() => {
    try {
      window.postMessage({ __gp: 1, type: "stateReq" }, "*");
    } catch (e) {}
  }, 3000);
})();
