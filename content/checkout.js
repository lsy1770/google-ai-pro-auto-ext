/* ============================================================================
 * content/checkout.js —— Google Play 结账弹窗（tokenized.play.google.com /
 * eacquire / pay.google.com 子框架）自动化执行器
 * 迁移自 automation_engine._poll_eacquire_modal / open_and_click_subscribe
 *   · 识别弹窗状态：需绑卡 / 可订阅 / 已成功 / 报错
 *   · 内联绑卡（卡号 / 有效期 / CVC / 持卡人 / 免税邮编 97201）
 *   · 零元核验（严格 0.00 或 免费试用 字样）后才点【订阅】
 *   · 点击后自动过 CVC / 密码 / 2FA 二次验证，并捕获成功或失败标志
 * ==========================================================================*/
(() => {
  "use strict";
  const Core = window.GProCore;
  if (!Core || window.__GP_CHECKOUT__) return;
  window.__GP_CHECKOUT__ = true;

  const TOP = window.top === window;
  const emit = (payload) => {
    try {
      chrome.runtime.sendMessage(Object.assign({ scope: "evt" }, payload));
    } catch (e) {}
  };

  const state = {
    clickedAt: 0,
    addCardAt: 0,
    savedAt: 0,
    switchedAt: 0,
    authAt: 0,
    succeeded: false,
    blockedNotified: false,
    lastNote: ""
  };

  function bodyText() {
    try {
      if (!document.body) return "";
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("script, style, noscript, #__gp_bar").forEach((el) => el.remove());
      return (clone.innerText || "").trim();
    } catch (e) {
      return "";
    }
  }

  function isCheckoutFrame() {
    const p = location.pathname + location.search;
    if (!TOP && (/eacquire/i.test(p) || /instrumentmanager|paymentmethod|checkout/i.test(p))) return true;
    if (!TOP && /^(tokenized\.play\.google\.com|pay\.google\.com)$/.test(location.hostname)) return true;
    return false;
  }

  /* --------------------------- 状态条 ------------------------------- */
  let bar = null;
  function paint(kind, text) {
    try {
      if (!document.body || !isCheckoutFrame()) return;
      if (!bar || !document.body.contains(bar)) {
        bar = document.createElement("div");
        bar.id = "__gp_bar";
        bar.style.cssText =
          "position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:8px 12px;text-align:center;" +
          "font:600 12px/1.5 -apple-system,'Segoe UI',Roboto,'Microsoft YaHei',sans-serif;color:#fff;";
        document.body.appendChild(bar);
      }
      bar.style.background = kind === "ok" ? "#1a7f37" : kind === "bad" ? "#c62828" : "#546e7a";
      bar.textContent = text;
    } catch (e) {}
  }

  /* --------------------------- 元素查找 ----------------------------- */
  function visible(selector, scope) {
    const list = Array.from((scope || document).querySelectorAll(selector));
    for (const el of list) if (Core.isVisible(el)) return el;
    return null;
  }

  function findButton(texts, exact) {
    const wanted = texts.map((t) => String(t).toLowerCase());
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, div[role="button"]'));
    for (const el of nodes) {
      if (!Core.isVisible(el)) continue;
      const t = (el.innerText || el.textContent || "").trim();
      if (!t || t.length > 40) continue;
      const low = t.toLowerCase();
      if (wanted.some((w) => (exact ? low === w : low === w || low.indexOf(w) >= 0))) return el;
    }
    return null;
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
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  function classifyInput(el) {
    const attrs = [
      el.autocomplete,
      el.name,
      el.id,
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("formcontrolname"),
      el.getAttribute("data-testid"),
      el.type
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (/cc-number|cardnumber|card-number|card_number|卡号|card number/.test(attrs)) return "number";
    if (/cc-exp|expiry|expiration|exp-|到期|有效期|mm\s*\/?\s*yy/.test(attrs)) return "exp";
    if (/cc-csc|creditcardsecuritycode|\bcvc\b|\bcvv\b|安全码|security code/.test(attrs)) return "cvc";
    if (/cc-name|cardholder|card-holder|持卡人|name on card/.test(attrs)) return "name";
    if (/postal|zip|邮编|邮政编码/.test(attrs)) return "zip";
    return "";
  }

  function cardFields() {
    const inputs = Core.visibleInputs();
    const map = { number: null, exp: null, expMonth: null, expYear: null, cvc: null, name: null, zip: null };
    let score = 0;
    for (const el of inputs) {
      const kind = classifyInput(el);
      if (!kind) continue;
      score += 1;
      if (kind === "exp") {
        const a = (el.autocomplete || el.name || el.getAttribute("aria-label") || "").toLowerCase();
        if (/month|mm/.test(a)) map.expMonth = el;
        else if (/year|yy/.test(a)) map.expYear = el;
        else map.exp = el;
      } else if (!map[kind]) {
        map[kind] = el;
      }
    }
    // 月份/年份下拉
    const selects = Array.from(document.querySelectorAll("select")).filter((el) => Core.isVisible(el));
    for (const sel of selects) {
      const label = (sel.getAttribute("aria-label") || sel.name || sel.id || "").toLowerCase();
      if (/month|月/.test(label) && !map.expMonth) map.expMonth = sel;
      if (/year|年/.test(label) && !map.expYear) map.expYear = sel;
    }
    const hasCard = !!(map.number || map.cvc || map.name);
    return { map, score, hasCard };
  }

  function selectByText(sel, wanted) {
    if (!sel || !sel.options) return false;
    const list = Array.from(sel.options);
    for (const want of wanted) {
      const hit = list.find((o) => {
        const t = (o.textContent || "").trim().toLowerCase();
        const v = String(o.value || "").toLowerCase();
        return t === want || v === want || t.indexOf(want) >= 0;
      });
      if (hit) {
        sel.value = hit.value;
        sel.dispatchEvent(new Event("input", { bubbles: true }));
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  function fillCard(card) {
    const { map, hasCard, score } = cardFields();
    if (!hasCard) return { ok: false, note: "未识别到卡片表单" };
    const num = String(card.number || "").replace(/\s+/g, "");
    const mm = String(card.expMonth || "").padStart(2, "0");
    const yy = String(card.expYear || "").slice(-2);
    const yyyy = String(card.expYear || "");
    if (map.number && num) Core.typeInto(map.number, num);
    if (map.exp) {
      const maxLen = Number(map.exp.getAttribute("maxlength") || 0);
      Core.typeInto(map.exp, maxLen && maxLen <= 5 ? mm + "/" + yy : mm + yy);
    }
    if (map.expMonth) {
      if (map.expMonth.tagName === "SELECT") selectByText(map.expMonth, [mm, String(Number(mm)), "0" + mm]);
      else Core.typeInto(map.expMonth, mm);
    }
    if (map.expYear) {
      if (map.expYear.tagName === "SELECT") selectByText(map.expYear, [yyyy, yy, "20" + yy]);
      else Core.typeInto(map.expYear, yyyy);
    }
    if (map.cvc && card.cvc) Core.typeInto(map.cvc, String(card.cvc));
    if (map.name && card.holder) Core.typeInto(map.name, String(card.holder));
    if (map.zip && (card.zip || "97201")) Core.typeInto(map.zip, String(card.zip || "97201"));
    return { ok: true, note: "已填写卡片信息（字段数 " + score + "）" };
  }

  function saveCard() {
    const btn =
      findButton(["保存卡", "保存", "添加卡", "确认添加", "完成", "save card", "save", "add card", "done", "submit"], true) ||
      findButton(["保存卡", "保存", "save"], false);
    if (btn) {
      clickEl(btn);
      return true;
    }
    const form = visible("form");
    if (form) {
      try {
        form.requestSubmit ? form.requestSubmit() : form.submit();
        return true;
      } catch (e) {}
    }
    return false;
  }

  /* --------------------------- 主 tick ------------------------------ */
  function tick(cmd) {
    if (!isCheckoutFrame()) return null;
    const text = bodyText();
    if (!text || text.length < 8) return null;
    const now = Date.now();
    const guard = cmd.guard !== false;
    const strict = cmd.strict === true;
    const card = cmd.card || {};
    const creds = cmd.creds || {};
    // 已登录模式可以完全不带卡：该账号已有付款方式时只用现有方式结账
    const hasCardData = String(card.number || "").replace(/\s+/g, "").length >= 12 && !!card.cvc;

    const clickedOnce = state.clickedAt > 0;
    const explicitSuccess = /已订阅|订阅成功|感谢您订阅|subscribed|welcome|新会员已生效/i.test(text);
    if (explicitSuccess || (clickedOnce && Core.hasAny(text, Core.T.SUCCESS))) {
      if (!state.succeeded) {
        state.succeeded = true;
        paint("ok", "✅ 已捕获订阅成功标志");
        emit({ type: "checkoutOutcome", kind: "success", text: Core.shortText(text, 400) });
        const dismiss = findButton(["以后再说", "知道了", "not now", "got it", "不用了"], true);
        if (dismiss) setTimeout(() => clickEl(dismiss), 800);
      }
      return { kind: "success" };
    }

    if (Core.hasAny(text, Core.T.ERROR)) {
      paint("bad", "❌ 结账返回错误，已阻止继续");
      emit({ type: "checkoutOutcome", kind: "error", text: Core.shortText(text, 400) });
      return { kind: "error" };
    }

    /* 1. 点击后的二次验证：密码 / 2FA / CVC */
    if (state.clickedAt && now - state.authAt > 2500) {
      const pwd = visible('input[type="password"], input[name="Passwd"]');
      const totpInput = visible('input#totpPin, input[name="totpPin"]');
      const cvcInput = visible('input[autocomplete="cc-csc"], input[name="cvc"], input[name="cvv"]');
      const cvcHint = /CVC|CVV|安全码|security code/i.test(text);
      if (totpInput) {
        state.authAt = now;
        Core.freshTotp(creds.totp || "").then((code) => {
          if (!code) {
            emit({ type: "checkoutOutcome", kind: "blocked", text: "结账内嵌 2FA 需要动态码，但账号未配置 TOTP 密钥" });
            return;
          }
          Core.setNativeValue(totpInput, code);
          const nb = findButton(["下一步", "next", "验证", "verify", "确认", "confirm"], true);
          if (nb) clickEl(nb);
          emit({ type: "checkoutOutcome", kind: "auth", text: "已填入 2FA 动态码 " + code });
        });
        return { kind: "auth" };
      }
      if (pwd && !cvcHint) {
        if (!creds.password) {
          if (!state.blockedNotified) {
            state.blockedNotified = true;
            emit({
              type: "checkoutOutcome",
              kind: "blocked",
              text: "结账要求输入 Google 账号密码二次验证，但当前是已登录模式（没有密码）。请在该标签页手动完成验证，或改用账号队列模式。"
            });
          }
          return { kind: "blocked" };
        }
        state.authAt = now;
        Core.setNativeValue(pwd, creds.password);
        const vb = findButton(["验证", "下一步", "确认", "继续", "verify", "next", "confirm"], true);
        if (vb) clickEl(vb);
        emit({ type: "checkoutOutcome", kind: "auth", text: "已填入账号密码完成二次验证" });
        return { kind: "auth" };
      }
      if ((cvcInput || (cvcHint && visible('input[type="tel"]'))) && card.cvc) {
        state.authAt = now;
        const target = cvcInput || visible('input[type="tel"]');
        Core.setNativeValue(target, String(card.cvc));
        const vb = findButton(["验证", "确认", "继续", "订阅", "verify", "confirm"], true);
        if (vb) clickEl(vb);
        emit({ type: "checkoutOutcome", kind: "auth", text: "已填入 CVC 安全码" });
        return { kind: "auth" };
      }
    }

    /* 2. 内联绑卡表单（仅在配置了支付卡时执行） */
    const fields = cardFields();
    if (hasCardData && fields.hasCard && fields.score >= 2) {
      if (now - state.savedAt > 12000) {
        state.savedAt = now;
        const res = fillCard(card);
        if (res.ok) {
          paint("warn", "正在内联绑卡…");
          setTimeout(() => {
            const saved = saveCard();
            emit({
              type: "checkoutOutcome",
              kind: saved ? "cardSaved" : "cardFilled",
              text: saved ? "已提交银行卡信息，等待 Google Play 绑定" : "已填卡但未找到保存按钮"
            });
          }, 900);
          return { kind: "card" };
        }
      }
      return { kind: "card" };
    }

    /* 3. 需要先添加付款方式 */
    if (Core.hasAny(text, Core.T.NEED_CARD) && now - state.addCardAt > 8000) {
      if (!hasCardData) {
        paint("bad", "❌ 该账号没有可用付款方式，且未填写支付卡");
        if (!state.blockedNotified) {
          state.blockedNotified = true;
          emit({
            type: "checkoutOutcome",
            kind: "blocked",
            text: "弹窗要求添加付款方式，但该账号没有可用付款方式、扩展里也没有填卡。请在【配置】里填卡或先在该账号绑定一次卡。"
          });
        }
        return { kind: "blocked" };
      }
      const add = findButton(Core.T.NEED_CARD, false);
      if (add) {
        state.addCardAt = now;
        paint("warn", "弹窗要求先添加付款方式，正在打开绑卡表单…");
        clickEl(add);
        emit({ type: "checkoutOutcome", kind: "needCard", text: "已点击【添加付款方式】" });
        return { kind: "needCard" };
      }
    }

    /* 4. 付款方式切换（确保使用配置卡） */
    const last4 = String(card.last4 || "").slice(-4);
    if (last4 && /(Mastercard-|Visa-|PaysafeCard|American Express-)/i.test(text) && text.indexOf(last4) < 0 && now - state.switchedAt > 8000) {
      const picker = findButton(["Mastercard-", "Visa-", "PaysafeCard", "American Express-"], false);
      if (picker) {
        state.switchedAt = now;
        clickEl(picker);
        setTimeout(() => {
          const target = findButton([last4], false);
          if (target) {
            clickEl(target);
            emit({ type: "checkoutOutcome", kind: "switchCard", text: "已切换为尾号 " + last4 + " 银行卡" });
          } else {
            emit({ type: "checkoutOutcome", kind: "blocked", text: "付款方式列表中未找到尾号 " + last4 + " 的卡" });
          }
        }, 1400);
        return { kind: "switchCard" };
      }
    }

    /* 5. 点击订阅 */
    const sub = findButton(["订阅", "subscribe"], true);
    if (sub) {
      const z = Core.guardCheck(text, strict);
      if (!z.ok) {
        paint("bad", "❌ 零元核验未通过，已阻止提交");
        if (!state.blockedNotified) {
          state.blockedNotified = true;
          emit({ type: "checkoutOutcome", kind: "blocked", text: z.reason + " | 弹窗文本: " + Core.shortText(text, 200) });
        }
        return { kind: "blocked" };
      }
      if (state.clickedAt) return { kind: "wait" }; // 每次页面生命周期只提交一次订单
      state.clickedAt = now;
      state.blockedNotified = false;
      paint("ok", "✅ 零元核验通过（" + z.mode + "），正在提交订阅…");
      clickEl(sub);
      emit({ type: "checkoutOutcome", kind: "clicked", text: "已点击【订阅】，零元依据: " + z.proof });
      return { kind: "clicked" };
    }

    /* 6. 弹窗仍在，但没有可操作项 */
    if (!state.lastNote || now - state.lastNote > 15000) {
      state.lastNote = now;
      paint("warn", "… 等待结账弹窗加载");
    }
    return null;
  }

  function pageInfo() {
    const text = bodyText();
    return {
      kind: isCheckoutFrame() ? "checkout" : "frame",
      top: TOP,
      url: location.href.slice(0, 160),
      host: location.hostname,
      hasSubscribe: !!findButton(["订阅", "subscribe"], true),
      text: Core.shortText(text, 240)
    };
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.scope !== "cmd") return false;
      if (msg.type === "probe") {
        if (isCheckoutFrame()) emit({ type: "pageInfo", info: pageInfo() });
        return false;
      }
      if (msg.type === "checkoutTick") {
        try {
          tick(msg);
        } catch (err) {
          emit({ type: "checkoutOutcome", kind: "blocked", text: "结账脚本异常: " + String(err && err.message) });
        }
        return false;
      }
      return false;
    });
  } catch (e) {}

  setTimeout(() => {
    if (isCheckoutFrame()) emit({ type: "pageInfo", info: pageInfo() });
  }, 600);
})();
