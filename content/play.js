/* ============================================================================
 * content/play.js —— play.google.com 订阅页（顶层框架）
 * 迁移自 automation_engine.inspect_play_subscriptions / ensure_subscription_active /
 *          step5_cancel_and_verify
 *   · 读取订阅记录、套餐名、到期/取消日期
 *   · 已取消时点【重新订阅】恢复活跃
 *   · 逐 tick 推进取消续订流程（管理 → 取消订阅 → 挽留页 → 原因 → 继续 → 确认）
 * ==========================================================================*/
(() => {
  "use strict";
  const Core = window.GProCore;
  if (!Core || window.__GP_PLAY__) return;
  window.__GP_PLAY__ = true;

  const TOP = window.top === window;
  const emit = (payload) => {
    try {
      chrome.runtime.sendMessage(Object.assign({ scope: "evt" }, payload));
    } catch (e) {}
  };

  function isPlaySubsPage() {
    return TOP && /play\.google\.com$/.test(location.hostname) && /\/store\/account\/subscriptions/.test(location.pathname);
  }

  function bodyText() {
    try {
      return (document.body && document.body.innerText) || "";
    } catch (e) {
      return "";
    }
  }

  function findButton(texts, exact) {
    const wanted = texts.map((t) => String(t).toLowerCase());
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, div[role="button"]'));
    for (const el of nodes) {
      if (!Core.isVisible(el)) continue;
      const t = (el.innerText || el.textContent || "").trim();
      if (!t || t.length > 30) continue;
      const low = t.toLowerCase();
      if (wanted.some((w) => (exact ? low === w : low === w || low.indexOf(w) >= 0))) return el;
    }
    return null;
  }

  function allButtons(texts) {
    const wanted = texts.map((t) => String(t).toLowerCase());
    return Array.from(document.querySelectorAll('button, [role="button"], a, div[role="button"]')).filter((el) => {
      if (!Core.isVisible(el)) return false;
      const t = (el.innerText || "").trim().toLowerCase();
      return wanted.some((w) => t === w);
    });
  }

  function clickEl(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: "center" });
    } catch (e) {}
    try {
      el.click();
      return true;
    } catch (e) {
      try {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  function read() {
    const text = bodyText();
    const clean = Core.cleanText(text);
    const entitlement = Core.pickEntitlement(text);
    return {
      ok: true,
      url: location.href,
      text: clean.slice(0, 4000),
      clean,
      plan: Core.planName(clean),
      entitlement,
      canceled: Core.isCanceled(clean),
      hasManage: !!findButton(["管理", "manage"], true),
      hasCancel: !!findButton(["取消订阅", "cancel subscription"], false),
      hasResubscribe: /重新订阅|resubscribe/i.test(clean),
      updatedAt: Date.now()
    };
  }

  function resubscribe() {
    const btn = findButton(["重新订阅", "resubscribe"], false);
    if (!btn) return { ok: false, note: "未找到【重新订阅】按钮" };
    clickEl(btn);
    setTimeout(() => {
      const again = allButtons(["重新订阅", "resubscribe"]);
      if (again.length) clickEl(again[again.length - 1]);
      setTimeout(() => {
        const ok = findButton(["确定", "确认", "ok", "confirm"], true);
        if (ok) clickEl(ok);
      }, 900);
    }, 1500);
    return { ok: true, note: "已点击【重新订阅】" };
  }

  function cancelTick() {
    if (!isPlaySubsPage()) {
      return { done: false, note: "不在 Play 订阅页" };
    }
    const text = bodyText();
    if (/取消日期|Cancellation date/i.test(text) && !/取消订阅/.test(text)) {
      return { done: true, note: "已显示取消日期，取消完成" };
    }
    if (/重新订阅|Resubscribe/i.test(text) && !/取消订阅/.test(text)) {
      return { done: true, note: "订阅已处于已取消状态" };
    }

    const cancelBtns = allButtons(["取消订阅", "cancel subscription"]);
    const dialog = document.querySelector('[role="dialog"]');

    // 最终确认：出现两个【取消订阅】按钮（页面 + 对话框）
    if (cancelBtns.length >= 2) {
      clickEl(cancelBtns[cancelBtns.length - 1]);
      return { done: false, note: "已点击最终【取消订阅】确认" };
    }

    if (dialog) {
      const noThanks = findButton(["不，谢谢", "不用了", "暂不", "no thanks", "no, thanks"], false);
      if (noThanks) {
        clickEl(noThanks);
        return { done: false, note: "已跳过挽留页" };
      }
      const reason = findButton(["拒绝回答", "不愿透露", "其他原因", "暂不需要", "decline to answer"], false);
      if (reason) clickEl(reason);
      const radios = Array.from(document.querySelectorAll('[role="radio"], input[type="radio"]')).filter((el) =>
        Core.isVisible(el)
      );
      if (radios.length) clickEl(radios[radios.length - 1]);
      const cont = findButton(["继续", "continue", "下一步", "next"], true);
      if (cont && !cont.disabled) {
        clickEl(cont);
        return { done: false, note: "已在取消对话框中继续" };
      }
      return { done: false, note: "等待取消对话框就绪" };
    }

    if (cancelBtns.length === 1) {
      clickEl(cancelBtns[0]);
      return { done: false, note: "已点击【取消订阅】打开取消流程" };
    }

    const manage = findButton(["管理", "manage"], true);
    if (manage) {
      clickEl(manage);
      return { done: false, note: "已打开订阅管理页" };
    }
    return { done: false, note: "未找到管理或取消入口" };
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.scope !== "cmd" || !TOP) return false;
      if (msg.type === "probe") {
        emit({
          type: "pageInfo",
          info: {
            kind: isPlaySubsPage() ? "play" : "play-other",
            top: true,
            url: location.href.slice(0, 160),
            stage: isPlaySubsPage() ? "subscriptions" : "other",
            snippet: Core.shortText(bodyText(), 200)
          }
        });
        return false;
      }
      if (msg.type === "playRead") {
        emit({ type: "playData", data: read() });
        return false;
      }
      if (msg.type === "playResubscribe") {
        const res = resubscribe();
        emit({ type: "playActionResult", action: "resubscribe", ok: res.ok, note: res.note });
        return false;
      }
      if (msg.type === "playCancelTick") {
        const res = cancelTick();
        emit({ type: "playCancelTickResult", done: !!res.done, note: res.note });
        return false;
      }
      return false;
    });
  } catch (e) {}

  setTimeout(() => {
    if (isPlaySubsPage()) {
      emit({ type: "pageInfo", info: { kind: "play", top: true, url: location.href.slice(0, 160), stage: "subscriptions" } });
    }
  }, 500);
})();
