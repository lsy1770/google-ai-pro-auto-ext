/* ============================================================================
 * inject.js —— one.google.com 主世界（MAIN world）请求改写器
 * 迁移自 google_pro_6_12_24/inject.js + automation_engine.HOOK_JS
 *   · 劫持 XHR 的 f.req（Ngbm 调用）把订阅商品替换为 offer 配置
 *   · 劫持 iframe src / TrustedTypePolicy.createScriptURL 的 ear 参数
 *   · 配置来源：window.__GP_CONFIG__（background 通过 scripting 注入）
 *                或 postMessage / data-gpro-cfg（bridge.js）
 * ==========================================================================*/
(() => {
  if (window.__GP_INSTALLED) return;
  window.__GP_INSTALLED = true;

  let cfg = window.__GP_CONFIG__ || null;
  const stats = { mounted: false, layer: "off", patched: 0, earPatched: 0, subId: null, lastError: "" };

  function setConfig(next) {
    if (!next || typeof next !== "object") {
      cfg = null;
      stats.mounted = false;
      stats.layer = "off";
    } else {
      cfg = next;
      stats.mounted = true;
      stats.layer = next.layer || next.name || "custom";
    }
    window.__GP_CONFIG__ = cfg;
    paint();
    report();
    return stats.mounted;
  }
  window.__gpSetConfig = setConfig;

  /* ---------------------------- 状态条 ------------------------------- */
  let badge = null;
  function paint() {
    try {
      if (!document.body) return;
      if (!badge) {
        badge = document.createElement("div");
        badge.id = "__gp_badge";
        badge.style.cssText =
          "position:fixed;right:14px;bottom:14px;z-index:2147483647;padding:7px 11px;border-radius:8px;" +
          "font:12px/1.5 -apple-system,'Segoe UI',Roboto,'Microsoft YaHei',sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.16);" +
          "border:1px solid #d0d7e2;background:#fff;color:#28354a;max-width:280px;pointer-events:none;";
        document.body.appendChild(badge);
      }
      const label = cfg
        ? "注入已挂载 · " + stats.layer + (stats.subId ? " · 续订叠加" : "") + (stats.patched ? " · 已改写 " + stats.patched : "")
        : "注入器：未启用";
      badge.textContent = label;
      badge.style.background = cfg ? "#eaf7ea" : "#f5f5f5";
      badge.style.borderColor = cfg ? "#bfe3c6" : "#d9dde4";
    } catch (e) {}
  }

  function report() {
    try {
      window.postMessage({ __gp: 1, type: "state", state: Object.assign({}, stats) }, "*");
    } catch (e) {}
  }

  /* -------------------------- 请求改写 ------------------------------- */
  function patchNode(node) {
    if (!Array.isArray(node) || !cfg || !Array.isArray(cfg.full_items)) return false;
    let patched = false;
    if (node.length > 12 && Array.isArray(node[12])) {
      if (Array.isArray(node[7]) && Array.isArray(node[7][5]) && node[7][5].length > 0) {
        stats.subId = node[7][5][0];
      }
      node[12] = cfg.full_items;
      const mode = cfg.mode || (Array.isArray(cfg.ear8) ? cfg.ear8[1] : 5) || 5;
      if (cfg.ear8) node[7] = cfg.ear8;
      else if (Array.isArray(node[7]) && Array.isArray(node[7][5]) && node[7][5].length > 0) node[7][1] = mode;
      else if (stats.subId) node[7] = [null, mode, null, null, null, [stats.subId]];
      patched = true;
    }
    if (node.length > 10 && Array.isArray(node[10]) && Array.isArray(node[10][0])) {
      node[10] = [cfg.full_items];
      if (Array.isArray(node[2]) && Array.isArray(node[2][2]) && Array.isArray(node[2][2][8])) {
        node[2][2][8] = [cfg.full_items];
      }
      if (cfg.ear8) node[6] = cfg.ear8;
      patched = true;
    }
    return patched;
  }

  function rewriteFreq(bodyStr) {
    if (typeof bodyStr !== "string" || bodyStr.indexOf("f.req=") < 0 || !cfg) return bodyStr;
    try {
      const parts = bodyStr.split("&");
      for (let i = 0; i < parts.length; i += 1) {
        if (parts[i].indexOf("f.req=") !== 0) continue;
        const raw = decodeURIComponent(parts[i].slice(6).replace(/\\+/g, " "));
        const outer = JSON.parse(raw);
        let changed = false;
        if (Array.isArray(outer)) {
          for (const group of outer) {
            if (!Array.isArray(group)) continue;
            for (const call of group) {
              if (Array.isArray(call) && call[0] === "Ngbm" && typeof call[1] === "string") {
                const payload = JSON.parse(call[1]);
                if (Array.isArray(payload)) {
                  if (patchNode(payload[0])) changed = true;
                  if (patchNode(payload[1])) changed = true;
                }
                if (changed) call[1] = JSON.stringify(payload);
              }
            }
          }
        }
        if (changed) {
          stats.patched += 1;
          parts[i] = "f.req=" + encodeURIComponent(JSON.stringify(outer));
          paint();
          report();
          return parts.join("&");
        }
      }
    } catch (e) {
      stats.lastError = String(e && e.message);
    }
    return bodyStr;
  }

  function rewriteUrl(val) {
    const s = String(val || "");
    if (s.indexOf("/eacquire/multiline") < 0 || !cfg) return val;
    try {
      const u = new URL(s, location.origin);
      const earStr = u.searchParams.get("ear");
      if (!earStr) return val;
      const ear = JSON.parse(earStr);
      if (Array.isArray(ear[8]) && Array.isArray(ear[8][5]) && ear[8][5].length > 0) stats.subId = ear[8][5][0];
      if (Array.isArray(ear[13]) && Array.isArray(cfg.full_items)) ear[13][0] = cfg.full_items;
      if (Array.isArray(ear[4]) && typeof ear[4][0] === "string" && Array.isArray(cfg.full_items)) {
        try {
          const inner4 = JSON.parse(atob(ear[4][0]));
          if (Array.isArray(inner4) && inner4.length > 8) {
            inner4[8] = [cfg.full_items];
            ear[4][0] = btoa(JSON.stringify(inner4));
          }
        } catch (e4) {}
      }
      const mode = cfg.mode || (Array.isArray(cfg.ear8) ? cfg.ear8[1] : 5) || 5;
      if (cfg.ear8) ear[8] = cfg.ear8;
      else if (Array.isArray(ear[8]) && Array.isArray(ear[8][5]) && ear[8][5].length > 0) ear[8][1] = mode;
      else if (stats.subId) ear[8] = [null, mode, null, null, null, [stats.subId]];
      ear[24] = null;
      u.searchParams.set("ear", JSON.stringify(ear));
      stats.earPatched += 1;
      window.__GP_EAR_URL = u.toString();
      paint();
      report();
      return u.toString();
    } catch (e) {
      stats.lastError = String(e && e.message);
      return val;
    }
  }

  /* --------------------------- 安装钩子 ------------------------------ */
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (typeof body === "string" && body.indexOf("Ngbm") >= 0) body = rewriteFreq(body);
    } catch (e) {}
    return origSend.call(this, body);
  };

  try {
    if (window.TrustedTypePolicy && TrustedTypePolicy.prototype.createScriptURL) {
      const origCreate = TrustedTypePolicy.prototype.createScriptURL;
      TrustedTypePolicy.prototype.createScriptURL = function (input, ...args) {
        return origCreate.call(this, rewriteUrl(input), ...args);
      };
    }
  } catch (e) {}

  try {
    const srcDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
    if (srcDesc && srcDesc.set) {
      Object.defineProperty(HTMLIFrameElement.prototype, "src", {
        configurable: true,
        enumerable: srcDesc.enumerable,
        get: srcDesc.get,
        set(v) {
          if (typeof v === "string") v = rewriteUrl(v);
          return srcDesc.set.call(this, v);
        }
      });
    }
    const origSetAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, val) {
      try {
        if (this instanceof HTMLIFrameElement && String(name).toLowerCase() === "src") val = rewriteUrl(String(val));
      } catch (e) {}
      return origSetAttr.call(this, name, val);
    };

    const origAttr = Element.prototype.setAttributeNS;
    if (origAttr) {
      Element.prototype.setAttributeNS = function (ns, name, val) {
        try {
          if (this instanceof HTMLIFrameElement && String(name).toLowerCase() === "src") val = rewriteUrl(String(val));
        } catch (e) {}
        return origAttr.call(this, ns, name, val);
      };
    }

    const origInsert = Element.prototype.insertAdjacentHTML;
    if (origInsert) {
      Element.prototype.insertAdjacentHTML = function (pos, html) {
        return origInsert.call(this, pos, html);
      };
    }
  } catch (e) {}

  /* --------------------------- 配置接收 ------------------------------ */
  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.__gp !== 1) return;
    if (d.type === "cfg") setConfig(d.cfg || null);
    if (d.type === "stateReq") report();
  });

  try {
    const attr = document.documentElement.getAttribute("data-gpro-cfg");
    if (attr) setConfig(JSON.parse(attr));
  } catch (e) {}

  if (cfg) {
    stats.mounted = true;
    stats.layer = cfg.layer || cfg.name || "custom";
  }
  document.addEventListener("DOMContentLoaded", paint);
  setInterval(paint, 4000);
  report();
})();
