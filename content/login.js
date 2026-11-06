/* ============================================================================
 * content/login.js —— accounts.google.com / gds.google.com 登录代理
 * 迁移自 automation_engine.pass_reauth_on_page / step1_login
 *   邮箱 → 密码 → 辅助邮箱 → 2FA 动态码 → 跳过 gds 提示
 *   每个 tick 只做一个动作，由后台循环驱动（可中断、可恢复）
 * ==========================================================================*/
(() => {
  "use strict";
  const Core = window.GProCore;
  if (!Core || window.__GP_LOGIN__) return;
  window.__GP_LOGIN__ = true;

  const TOP = window.top === window;
  const emit = (payload) => {
    try {
      chrome.runtime.sendMessage(Object.assign({ scope: "evt" }, payload));
    } catch (e) {}
  };

  const vis = Core.isVisible;

  function bodyText() {
    try {
      return (document.body && document.body.innerText) || "";
    } catch (e) {
      return "";
    }
  }

  function findText(texts, extraSelector) {
    const wanted = texts.map((t) => String(t).toLowerCase());
    const nodes = Array.from(
      document.querySelectorAll(extraSelector || 'button, [role="button"], a, div[role="button"], span')
    );
    for (const el of nodes) {
      if (!vis(el)) continue;
      const t = (el.innerText || el.textContent || "").trim();
      if (!t || t.length > 40) continue;
      const low = t.toLowerCase();
      if (wanted.some((w) => low === w || low.indexOf(w) >= 0)) return el;
    }
    return null;
  }

  function firstVisible(selector) {
    const list = Array.from(document.querySelectorAll(selector));
    for (const el of list) if (vis(el)) return el;
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
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  function detectStage() {
    const url = location.href;
    const body = bodyText();
    if (/challenge\/recaptcha/.test(url) || /证明您不是自动程序|not a robot|unusual traffic|异常流量/i.test(body))
      return "recaptcha";
    if (/challenge\/totp/.test(url) || firstVisible('input#totpPin, input[name="totpPin"]')) return "totp";
    if (/challenge\/kpe/.test(url) || /确认您的辅助邮箱|Confirm your recovery email/i.test(body)) return "recovery";
    if (firstVisible('input[type="password"], input[name="Passwd"]')) return "password";
    if (firstVisible('input#identifierId, input[name="identifier"], input[type="email"]')) return "identifier";
    if (document.querySelector("[data-identifier]")) return "chooser";
    if (/signin\/rejected|Add 2-Step Verification/.test(url)) return "rejected";
    if (/尝试其他方式|Try another way/i.test(body)) return "otherway";
    if (/验证您的身份|Verify it's you/i.test(body)) return "verify";
    if (/gds\.google\.com|recoveryoptions|homeaddress|确保您始终都能登录|设置住址|确认您的基本信息/i.test(url + " " + body))
      return "gds";
    if (/accounts\.google\.com/.test(location.hostname)) return "idle";
    return "other";
  }

  function pageInfo() {
    return {
      kind: "login",
      stage: detectStage(),
      url: location.href,
      top: TOP,
      host: location.hostname
    };
  }

  /* ----------------------------- 动作 -------------------------------- */
  function actIdentifier(creds) {
    const inp = firstVisible('input#identifierId, input[name="identifier"], input[type="email"]');
    if (!inp) return { stage: "identifier", note: "未见邮箱输入框" };
    if (creds.email) {
      Core.setNativeValue(inp, creds.email);
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const next =
      firstVisible("#identifierNext button") ||
      firstVisible("#identifierNext") ||
      findText(["下一步", "next", "继续", "continue"]);
    if (next) clickEl(next);
    else inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return { stage: "identifier", note: "已提交邮箱: " + creds.email };
  }

  function actPassword(creds) {
    const inp = firstVisible('input[type="password"], input[name="Passwd"]');
    if (!inp) return { stage: "password", note: "未见密码输入框" };
    if (creds.password) Core.setNativeValue(inp, creds.password);
    const next = firstVisible("#passwordNext button") || firstVisible("#passwordNext") || findText(["下一步", "next"]);
    if (next) clickEl(next);
    else inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return { stage: "password", note: "已提交密码" };
  }

  async function actTotp(creds) {
    const inp = firstVisible('input#totpPin, input[name="totpPin"], input[type="tel"]');
    if (!inp) return { stage: "totp", note: "未见动态码输入框" };
    if (!creds.totp) return { stage: "blocked", note: "账号缺少 TOTP 密钥，需要手动输入 2FA" };
    const code = await Core.freshTotp(creds.totp);
    Core.setNativeValue(inp, code);
    const next = firstVisible("#totpNext button") || firstVisible("#totpNext") || findText(["下一步", "next"]);
    if (next) clickEl(next);
    else inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return { stage: "totp", note: "已提交 2FA 动态码 " + code };
  }

  function actRecovery(creds) {
    if (!creds.recovery) {
      const other = findText(["确认您的辅助邮箱", "confirm your recovery email"]);
      if (other) clickEl(other);
      return { stage: "blocked", note: "账号缺少辅助邮箱，需要手动选择验证方式" };
    }
    const inp = firstVisible(
      'input#knowledge-preregistered-email-response, input[name="knowledgePreregisteredEmailResponse"], input[type="email"]'
    );
    if (!inp) {
      const option = findText(["确认您的辅助邮箱", "confirm your recovery email"]);
      if (option) {
        clickEl(option);
        return { stage: "recovery", note: "已选择辅助邮箱验证方式" };
      }
      return { stage: "recovery", note: "等待辅助邮箱输入框" };
    }
    Core.setNativeValue(inp, creds.recovery);
    const next = findText(["下一步", "next"]);
    if (next) clickEl(next);
    else inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return { stage: "recovery", note: "已提交辅助邮箱" };
  }

  function actChooser(creds) {
    const items = Array.from(document.querySelectorAll("[data-identifier]"));
    const want = String(creds.email || "").toLowerCase();
    const wantNoDot = want.replace(/\./g, "");
    for (const el of items) {
      const ident = String(el.getAttribute("data-identifier") || "").toLowerCase();
      if (ident === want || ident.replace(/\./g, "") === wantNoDot) {
        clickEl(el);
        return { stage: "chooser", note: "已点选账号 " + ident };
      }
    }
    const other = findText(["使用其他账号", "use another account"]);
    if (other) {
      clickEl(other);
      return { stage: "chooser", note: "未命中已登录账号，切换为手动输入邮箱" };
    }
    return { stage: "chooser", note: "账号选择器未命中目标账号" };
  }

  function actGds() {
    const el = findText(["取消", "cancel", "跳过", "skip", "以后再说", "not now", "不用了", "稍后再说"]);
    if (el) {
      clickEl(el);
      return { stage: "gds", note: "已跳过 gds 辅助信息提示页" };
    }
    return { stage: "gds", note: "gds 提示页未找到跳过按钮" };
  }

  function actOtherWay() {
    const el = findText(["试试其他方式", "尝试其他方式", "try another way"]);
    if (el) {
      clickEl(el);
      return { stage: "otherway", note: "已展开其他验证方式" };
    }
    return { stage: "otherway", note: "未找到其他验证方式入口" };
  }

  function actVerify() {
    const el = findText(["验证您的身份", "verify it's you", "verify it’s you"]);
    if (el) {
      clickEl(el);
      return { stage: "verify", note: "已点击身份验证按钮" };
    }
    return { stage: "verify", note: "身份验证按钮未出现" };
  }

  async function tick(creds) {
    const stage = detectStage();
    switch (stage) {
      case "gds":
        return actGds();
      case "chooser":
        return actChooser(creds);
      case "identifier":
        return actIdentifier(creds);
      case "password":
        return actPassword(creds);
      case "totp":
        return await actTotp(creds);
      case "recovery":
        return actRecovery(creds);
      case "otherway":
        return actOtherWay();
      case "verify":
        return actVerify();
      case "recaptcha":
        return { stage: "blocked", note: "触发人机验证 (recaptcha)，需要手动完成一次" };
      case "rejected":
        return { stage: "blocked", note: "新设备安全拦截 (signin/rejected)，需要手动确认一次" };
      default:
        return { stage: stage, note: "" };
    }
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.scope !== "cmd") return false;
      if (!TOP) return false;
      if (msg.type === "probe") {
        emit({ type: "pageInfo", info: pageInfo() });
        return false;
      }
      if (msg.type === "loginTick") {
        Promise.resolve()
          .then(() => tick(msg.creds || {}))
          .then((res) => emit({ type: "loginProgress", stage: res.stage, note: res.note }))
          .catch((err) => emit({ type: "loginProgress", stage: "error", note: String(err && err.message) }));
        return false;
      }
      return false;
    });
  } catch (e) {}

  setTimeout(() => {
    if (TOP) emit({ type: "pageInfo", info: pageInfo() });
  }, 300);
})();
