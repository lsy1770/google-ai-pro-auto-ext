/* ============================================================================
 * Google AI Pro 两年零成本 · 全自动注入器  v2.0.0
 * core.js —— 共享底座（service worker 与所有 content script 共用）
 * 从 automation_engine.py 迁移：令牌、层级、日期数学、零元核验、TOTP、DOM 工具
 * ==========================================================================*/
(function (root) {
  "use strict";
  if (root.GProCore) return;

  const VERSION = "2.0.0";

  /* ----------------------------- 常量 ---------------------------------- */
  const PREFIX = "subs:com.google.android.apps.subscriptions.red:";
  const ITEM_AI = PREFIX + "g1.2tb.ai.subs_variant";
  const ITEM_YT = PREFIX + "g1.youtube_premium_individual_add_on";

  // 与 automation_engine.py 完全一致的通用 offer token（账号/币种无关）
  const TOKENS = Object.freeze({
    "12m":
      "AVbCH/cspB8VdqKJ+ax/uPxUFAVuYRPX4iSjtg4Fu0PG9zUeURSM7y//LlQva1dCd/rbKVM6EJmyiG/C9BoQ95pMl8yDCHuiwCvM5CuGJME=",
    "6m_ss":
      "AVbCH/cgl4zvPT2Lqw95Gn+RYAJIVwFwi783i6uVprX7u3MCa5J4CcTXH5RABa5WjBrUoQnwf8vI10TNV7ktd26myIdxqIwGmNoJ5ofYNqpQ10RKoSvHs75wsfA=",
    "6m":
      "AVbCH/fUON3w8hpfeutprA3BMQwrBwYIB6Y8CSWi1isDCDswKUUhGQ3dluj5WXsNKOvr8K5UULBGrRsf4KlW1rHLz0fF3SvxQhBFRbBOHCA=",
    "6m_2":
      "AVbCH/cJ5SeHgkVRt+bdcrapx/aLSu2kbsBgMdI413zbllDNsNQoC/zVlG/Npbu55WlMzBwWPhUedIvZFDg7fw0CmCv/8DKj04IZ21pK7mrV/hh5",
    yt:
      "AVbCH/eW4Nfp8KBl0zlm7x9PhaiCvpnqwUuL2D8NFPBQgmM9+HuYS1h2xH5lLWU/BsBj775LK5GqK8UHKqoSzhDDz+PqP3paNesqLU0r9i6XCrYa"
  });

  // 三层依次叠加（Python: step2 / step3 / step4）
  const LAYERS = Object.freeze([
    Object.freeze({ id: "layer1", label: "首层 · 12 个月", token: "12m", months: 12 }),
    Object.freeze({ id: "layer2", label: "二层 · 6 个月(SS)", token: "6m_ss", months: 6 }),
    Object.freeze({ id: "layer3", label: "三层 · 6 个月", token: "6m", fallbackToken: "6m_2", months: 6 })
  ]);

  const URLS = Object.freeze({
    PLANS: "https://one.google.com/plans?hl=zh-CN",
    PLAY_SUBS: "https://play.google.com/store/account/subscriptions?hl=zh-CN",
    LOGIN:
      "https://accounts.google.com/ServiceLogin?hl=zh-CN&continue=" +
      encodeURIComponent("https://one.google.com/plans?hl=zh-CN")
  });

  const LIMITS = Object.freeze({
    PHASE_MS: 90000,          // 单个阶段最长等待
    CHECKOUT_TICK_MS: 1100,   // 结账弹窗轮询间隔
    CHECKOUT_MAX_TICKS: 110,  // ≈ 2 分钟
    LOGIN_MAX_TICKS: 46,
    CANCEL_MAX_TICKS: 30,
    POST_SUCCESS_WAIT_MS: 25000,
    PAGE_SETTLE_MS: 3500
  });

  /* --------------------------- 小工具 ---------------------------------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function cleanText(value) {
    return String(value || "")
      .replace(/[\u00a0\u202f\u2007]/g, " ")
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" | ");
  }

  function shortText(value, max) {
    const t = cleanText(value);
    const n = max || 220;
    return t.length > n ? t.slice(0, n) + "…" : t;
  }

  /* --------------------------- 日期处理 -------------------------------- */
  const MONTHS_EN = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"
  ];

  function isoFromParts(y, m, d) {
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    if (!year || !month || !day) return null;
    if (year < 2000 || year > 2100) return null;
    const dt = new Date(Date.UTC(year, month - 1, day));
    if (dt.getUTCFullYear() !== year || dt.getUTCMonth() + 1 !== month || dt.getUTCDate() !== day) return null;
    return dt.toISOString().slice(0, 10);
  }

  function parseDate(raw) {
    const value = String(raw || "").trim();
    if (!value) return null;
    let m = value.match(/^(\d{4})(?:年\s*|[-/.])(\d{1,2})(?:月\s*|[-/.])(\d{1,2})日?$/);
    if (m) return isoFromParts(m[1], m[2], m[3]);
    m = value.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i);
    if (m) {
      const name = m[1].toLowerCase();
      const idx = MONTHS_EN.findIndex((x) => x === name || x.slice(0, 3) === name.slice(0, 3));
      if (idx >= 0) return isoFromParts(m[3], idx + 1, m[2]);
      return null;
    }
    m = value.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/i);
    if (m) {
      const name = m[2].toLowerCase();
      const idx = MONTHS_EN.findIndex((x) => x === name || x.slice(0, 3) === name.slice(0, 3));
      if (idx >= 0) return isoFromParts(m[3], idx + 1, m[1]);
      return null;
    }
    return null;
  }

  const DATE_RE =
    /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)|(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})|([A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})|(\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4})/g;

  function allDates(text) {
    const out = [];
    const src = String(text || "");
    let m;
    DATE_RE.lastIndex = 0;
    while ((m = DATE_RE.exec(src))) {
      const iso = parseDate(m[0].replace(/\s+/g, " ").trim());
      if (iso && out.indexOf(iso) < 0) out.push(iso);
    }
    return out;
  }

  function maxISO(list) {
    return list.length ? list.slice().sort().pop() : null;
  }

  function todayISO(now) {
    const d = new Date(now === undefined ? Date.now() : now);
    return d.toISOString().slice(0, 10);
  }

  function addMonths(dateISO, months) {
    const base = new Date(dateISO + "T00:00:00Z");
    const day = base.getUTCDate();
    base.setUTCDate(1);
    base.setUTCMonth(base.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
    base.setUTCDate(Math.min(day, lastDay));
    return base.toISOString().slice(0, 10);
  }

  function monthsBetween(fromISO, toISO) {
    if (!fromISO || !toISO) return 0;
    const a = new Date(fromISO + "T00:00:00Z");
    const b = new Date(toISO + "T00:00:00Z");
    let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
    if (b.getUTCDate() < a.getUTCDate()) m -= 1;
    return m;
  }

  function daysBetween(fromISO, toISO) {
    const a = new Date(fromISO + "T00:00:00Z").getTime();
    const b = new Date(toISO + "T00:00:00Z").getTime();
    return Math.round((b - a) / 86400000);
  }

  /* ---------------------- Play / Google One 文本解析 -------------------- */
  const DATE_LABEL_RE =
    /(取消日期|取消时间|续订日期|下次付款日期|下次收费日期|到期日期|到期时间|到期日|有效期至|有效期到|有效期|结束日期|结束时间|会员到期|试用结束|试用将于|免费试用至|当前周期|将于[^\n]{0,14}?结束|将于|Cancellation date|Renews(?: on)?|Next payment(?: date)?|Expires(?: on)?|Ends(?: on)?|Valid until|Trial ends|will end on|Access until)/i;

  function pickEntitlement(text) {
    const src = String(text || "").replace(/[\u00a0\u202f]/g, " ");
    const lines = src.split(/\n|\s{2,}|\|/).map((s) => s.trim()).filter(Boolean);
    const labels = [];
    for (const line of lines) {
      const m = line.match(DATE_LABEL_RE);
      if (!m) continue;
      const tail = line.slice((m.index || 0) + m[0].length);
      const iso = allDates(tail)[0] || allDates(line)[0];
      if (iso) labels.push(iso);
    }
    if (labels.length) return maxISO(labels);
    const any = allDates(src);
    return any.length ? maxISO(any) : null;
  }

  // 目标判定：after 不早于 expected；允许比 expected 早 7 天以内（Google 按账期算会差几天）
  function meetsTarget(afterISO, expectedISO, slackDays) {
    if (!afterISO || !expectedISO) return false;
    if (afterISO >= expectedISO) return true;
    const slack = slackDays === undefined ? 7 : slackDays;
    return daysBetween(afterISO, expectedISO) <= slack;
  }


  function planName(text) {
    const t = String(text || "");
    if (/20\s?TB/i.test(t)) return "Google AI Ultra (20 TB)";
    if (/30\s?TB/i.test(t)) return "Google AI Ultra (30 TB)";
    if (/Google AI Pro|5\s?TB/i.test(t)) return "Google AI Pro (5 TB)";
    if (/Google AI Ultra/i.test(t)) return "Google AI Ultra";
    if (/Google One/i.test(t)) return "Google One";
    return "未知订阅";
  }

  function isCanceled(text) {
    return /重新订阅|已取消|取消日期|Resubscribe|Canceled|Cancelled/i.test(String(text || ""));
  }

  /* -------------------------- 零元核验 -------------------------------- */
  const AMOUNT_LABEL_RE =
    /(?:total\s+(?:due\s+)?today|(?:amount\s+)?due\s+(?:today|now)|today['’]?s\s+(?:total|charge)|(?:今日|今天|现在|本次)(?:应付(?:金额)?|需付(?:金额)?|总计|合计|费用|付款|支付金额))/i;
  const MONEY_RE = /(?:US\$|USD|\$|€|£|¥)\s*([+-]?\d[\d,]*(?:\.\d{1,2})?)(?![\d.]|,\d)/g;

  // 严格模式：必须找到明确的“当次应付 = 0”
  function zeroDueProof(text) {
    const lines = String(text || "")
      .replace(/[\u00a0\u202f]/g, " ")
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const proofs = [];
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(AMOUNT_LABEL_RE);
      if (!m) continue;
      let ctx = lines[i].slice((m.index || 0) + m[0].length).replace(/^\s*[:：]?\s*/, "");
      if (!ctx && i + 1 < lines.length) ctx = lines[i + 1];
      ctx = ctx.split(/\b(?:then|after|starting)\b|之后|期满后|随后/i)[0];
      const matches = [...ctx.matchAll(MONEY_RE)];
      if (!matches.length || matches.some((x) => !/^0(?:\.0{1,2})?$/.test(x[1].replace(/,/g, "")))) {
        return { safe: false, reason: "当次应付金额非零或格式无法可靠识别。", proof: "" };
      }
      proofs.push((m[0] + ": " + ctx).slice(0, 140));
    }
    if (!proofs.length) return { safe: false, reason: "未找到明确的当次应付金额。", proof: "" };
    return { safe: true, reason: "", proof: proofs.join("; ") };
  }

  // 兜底模式：弹窗明示免费/试用字样（0.00 / 免费 / Free / won't be charged）
  const FREE_HINT_RE =
    /(0[.,]00|免费|试用|免费试用|free\s*trial|\bfree\b|won['’]?t be charged|不会(?:向您)?收费|无费用|no charge)/i;
  const PAID_HINT_RE =
    /(立即付款|pay now|pay today|今日扣款|charged today|首月.*\d)/i;

  function guardCheck(text, strict) {
    const t = String(text || "");
    const strictRes = zeroDueProof(t);
    if (strictRes.safe) return { ok: true, proof: strictRes.proof, mode: "strict" };
    if (strict) {
      return { ok: false, reason: strictRes.reason || "未找到明确为 0 的当次应付金额，已阻止提交。", proof: "" };
    }
    const free = FREE_HINT_RE.test(t);
    const paid = PAID_HINT_RE.test(t);
    if (free && !paid) return { ok: true, proof: "免费/试用字样命中（宽松模式）", mode: "hint" };
    return {
      ok: false,
      reason: strictRes.reason || "未检测到 0.00 / 免费试用字样，已阻止提交以保护零成本。",
      proof: ""
    };
  }

  /* ------------------------- 请求配置构建 ---------------------------- */
  function resolveToken(name) {
    if (!name) return "";
    return TOKENS[name] || String(name);
  }

  function buildConfig(layerId, subId, tokenOverride) {
    const layer = LAYERS.find((l) => l.id === layerId) || LAYERS[0];
    const tokenKey = tokenOverride || layer.token;
    const token = resolveToken(tokenKey);
    const items = [
      [[ITEM_AI, 21], null, null, null, 1, [token]],
      [[ITEM_YT, 21], null, null, null, 1, [TOKENS.yt]]
    ];
    return {
      name: "sys_" + layer.id + "_" + tokenKey,
      layer: layer.id,
      token: tokenKey,
      mode: 5,
      full_items: items,
      ear8: subId ? [null, 5, null, null, null, [subId]] : null,
      subId: subId || null
    };
  }

  /* ----------------------------- TOTP -------------------------------- */
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  function base32Decode(input) {
    const s = String(input || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of s) {
      const idx = B32.indexOf(ch);
      if (idx < 0) continue;
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return new Uint8Array(out);
  }

  async function totp(secret, nowMs) {
    const key = base32Decode(secret);
    if (!key.length) return "";
    const now = nowMs === undefined ? Date.now() : nowMs;
    const counter = Math.floor(now / 1000 / 30);
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setUint32(0, Math.floor(counter / 4294967296), false);
    dv.setUint32(4, counter >>> 0, false);
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, buf));
    const off = sig[19] & 0x0f;
    const code =
      (((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3]) % 1000000;
    return String(code).padStart(6, "0");
  }

  function totpSecondsLeft(nowMs) {
    const now = nowMs === undefined ? Date.now() : nowMs;
    return 30 - (Math.floor(now / 1000) % 30);
  }

  async function freshTotp(secret) {
    if (!secret) return "";
    const left = totpSecondsLeft();
    if (left <= 3) await sleep((left + 1) * 1000);
    return totp(secret);
  }

  /* --------------------------- DOM 工具 ------------------------------ */
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return false;
    return true;
  }

  function trulyOnTop(el) {
    try {
      if (!isVisible(el)) return false;
      let cur = el;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        if (cur.getAttribute && cur.getAttribute("aria-hidden") === "true") return false;
        const cs = getComputedStyle(cur);
        if (cs.display === "none" || parseFloat(cs.opacity) < 0.85) return false;
        cur = cur.parentElement;
      }
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx <= 0 || cy <= 0 || cx >= innerWidth || cy >= innerHeight) return false;
      const top = document.elementFromPoint(cx, cy);
      if (!top) return false;
      return el.contains(top) || top.contains(el);
    } catch (e) {
      return false;
    }
  }

  function setNativeValue(el, value) {
    if (!el) return false;
    let proto = null;
    try {
      proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    } catch (e) {
      proto = HTMLInputElement.prototype;
    }
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    try {
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
    } catch (e) {
      try {
        el.value = value;
      } catch (e2) {
        return false;
      }
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // 逐字符模拟输入：多数 React/Angular 表单需要 key 事件才会刷新校验状态
  function typeInto(el, text) {
    const value = String(text == null ? "" : text);
    if (!el) return false;
    try {
      el.focus();
      el.click && el.click();
    } catch (e) {}
    setNativeValue(el, "");
    let acc = "";
    for (const ch of value) {
      acc += ch;
      try {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, code: "Key" + ch.toUpperCase(), bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keypress", { key: ch, charCode: ch.charCodeAt(0), bubbles: true }));
      } catch (e) {}
      setNativeValue(el, acc);
      try {
        el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      } catch (e) {}
    }
    try {
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    } catch (e) {}
    return true;
  }

  function visibleInputs(scope) {
    const doc = scope || document;
    return Array.from(doc.querySelectorAll("input, textarea, select")).filter(
      (el) => isVisible(el) && !el.disabled && el.type !== "hidden"
    );
  }

  function byText(selector, texts, opts) {
    const list = Array.from(document.querySelectorAll(selector || "button, [role=\"button\"], a"));
    const wanted = (texts || []).map((t) => String(t).toLowerCase());
    const exact = opts && opts.exact;
    return list.filter((el) => {
      if (!isVisible(el)) return false;
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      if (!t || t.length > 48) return false;
      return wanted.some((w) => (exact ? t === w : t === w || t.indexOf(w) >= 0));
    });
  }

  /* --------------------------- 文本常量 ------------------------------- */
  const T = Object.freeze({
    OFFER: [
      "开始使用", "开始免费试用", "获取优惠", "获取折扣", "领取优惠", "换用此方案", "升级",
      "获取 Google AI Pro", "获取 Google AI Ultra", "开始试用",
      "get started", "get offer", "get discount", "upgrade", "switch to this plan",
      "start free trial", "try it free", "redeem offer"
    ],
    SUBSCRIBE: ["订阅", "subscribe", "确认订阅", "confirm"],
    TRANSITION: [
      "继续订阅", "是的，继续", "换用此方案", "重新订阅", "继续", "同意", "我同意", "前往结账",
      "switch to this plan", "resubscribe", "continue to subscribe", "yes, continue", "continue", "agree"
    ],
    SUCCESS: [
      "已订阅", "订阅成功", "感谢您订阅", "通过此类购买活动获取", "Google Play 积分", "Play Points",
      "Earn Google Play Points", "开启备用付款方式", "添加备用付款方式", "备用付款方式", "Backup payment",
      "欢迎您", "新会员已生效", "subscribed", "Welcome"
    ],
    ERROR: [
      "出了点问题", "无法完成", "拒绝了您的付款", "付款遭拒", "支付遭拒", "由于资金不足", "[OR-", "[OR_",
      "OR_FGVEM", "[BX-CPL-05]", "您的订单仍在处理中", "订单处理完成后", "购买失败",
      "Something went wrong", "couldn't be completed", "Check that you have the correct country",
      "declined", "insufficient funds"
    ],
    DISMISS: ["以后再说", "不用了", "知道了", "跳过", "取消", "not now", "got it", "skip", "cancel"],
    NEED_CARD: [
      "添加付款方式", "首先添加付款方式", "添加信用卡或借记卡", "添加卡", "添加银行卡",
      "add a payment method", "add credit or debit card", "add card"
    ]
  });

  function hasAny(text, list) {
    const t = String(text || "").toLowerCase();
    return list.some((kw) => t.indexOf(String(kw).toLowerCase()) >= 0);
  }

  /* ----------------------------- 导出 -------------------------------- */
  const api = {
    VERSION, PREFIX, ITEM_AI, ITEM_YT, TOKENS, LAYERS, URLS, LIMITS, T,
    sleep, cleanText, shortText, parseDate, allDates, maxISO, todayISO, addMonths, monthsBetween,
    daysBetween, pickEntitlement, planName, isCanceled, zeroDueProof, guardCheck, buildConfig, meetsTarget,
    base32Decode, totp, totpSecondsLeft, freshTotp,
    isVisible, trulyOnTop, setNativeValue, typeInto, visibleInputs, byText, hasAny
  };
  root.GProCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
