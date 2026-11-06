/* ============================================================================
 * popup.js —— 控制台界面（仅做展示与 RPC，所有自动化在 background.js）
 * ==========================================================================*/
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ scope: "popup" }, msg), (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: "无响应" });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message) });
      }
    });

  const STATUS_TEXT = {
    pending: "待执行",
    running: "执行中",
    completed: "已完成",
    partial: "待同步",
    error: "失败",
    stopped: "已停止"
  };

  let latest = null;
  let lastLogCount = -1;
  let saveTimer = null;
  let hintAuto = true;

  /* ------------------------------ Tab ------------------------------- */
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + btn.dataset.pane));
    });
  });

  /* ---------------------------- 渲染 --------------------------------- */
  function pill(text, cls) {
    const el = $("pill");
    el.textContent = text;
    el.className = "pill " + (cls || "");
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function currentMode() {
    const el = document.querySelector('input[name="runmode"]:checked');
    return el ? el.value : "session";
  }

  function applyModeUI(mode) {
    const session = mode === "session";
    $("btnStart").textContent = session ? "开始执行（当前登录账号）" : "全自动执行队列";
    $("sesLabel").textContent = session ? "浏览器当前账号" : "当前执行账号";
    $("rowQueue").style.display = session ? "none" : "flex";
    if (hintAuto) {
      hint(
        session
          ? "已登录模式：直接用本浏览器当前登录的 Google 账号执行，不需要输入邮箱密码。"
          : "账号队列模式：按【账号】页签里导入的账号逐个执行（自动登录 + 2FA）。",
        "",
        true
      );
    }
  }

  function renderRun(state) {
    const running = !!state.running;
    const mode = state.mode || currentMode();
    const ses = state.session || {};
    $("sesEmail").textContent = ses.email || (mode === "session" ? "未读取" : state.currentEmail || "—");
    $("sesPlan").textContent = [ses.plan, ses.expiry].filter(Boolean).join(" · ") || "—";
    $("curStep").textContent = state.step || (running ? "启动中…" : "—");
    $("curQueue").textContent = `${state.queueIndex + (running ? 1 : 0)} / ${state.queue.length || 0}`;
    $("btnStart").disabled = running;
    $("btnStop").disabled = !running;
    $("btnProbe").disabled = running;
    document.querySelectorAll('input[name="runmode"]').forEach((r) => {
      r.disabled = running;
    });
    if (state.stopping) pill("停止中…", "stop");
    else if (running) pill("执行中", "run");
    else if (state.results && state.results.some((r) => !r.ok)) pill("有失败", "err");
    else pill("空闲", "idle");

    const logs = state.logs || [];
    const tail = logs.slice(-14).map((l) => `[${fmtTime(l.t)}] ${l.text}`).join("\n");
    if (tail !== $("miniLog").textContent) {
      $("miniLog").textContent = tail || "（暂无日志）";
      $("miniLog").scrollTop = $("miniLog").scrollHeight;
    }
    if (logs.length !== lastLogCount) {
      lastLogCount = logs.length;
      const full = logs.map((l) => `[${fmtTime(l.t)}] ${l.text}`).join("\n");
      $("logs").textContent = full || "（暂无日志）";
      $("logs").scrollTop = $("logs").scrollHeight;
    }

    if (state.lastShot && state.lastShot.dataUrl) {
      const img = $("shot");
      img.src = state.lastShot.dataUrl;
      img.style.display = "block";
      $("shotTag").textContent = state.lastShot.tag || "";
    } else {
      $("shot").style.display = "none";
      $("shotTag").textContent = "";
    }
  }

  function renderAccounts(accounts) {
    const list = $("accList");
    $("accCount").textContent = String(accounts.length);
    list.innerHTML = "";
    for (const acc of accounts) {
      const li = document.createElement("li");
      const top = document.createElement("div");
      top.className = "top";
      const mail = document.createElement("div");
      mail.className = "mail";
      mail.textContent = acc.email;
      const chip = document.createElement("span");
      chip.className = "chip " + (acc.status || "pending");
      chip.textContent = STATUS_TEXT[acc.status] || acc.status || "待执行";
      top.appendChild(mail);
      top.appendChild(chip);

      const meta = document.createElement("div");
      meta.className = "meta";
      const bits = [];
      if (acc.plan) bits.push(acc.plan);
      if (acc.expiry) bits.push("到期/取消日 " + acc.expiry);
      if (acc.message) bits.push(acc.message);
      meta.textContent = bits.join(" ｜ ") || "未执行";

      const acts = document.createElement("div");
      acts.className = "acts";
      const mk = (label, handler, cls) => {
        const b = document.createElement("button");
        b.textContent = label;
        if (cls) b.className = cls;
        b.addEventListener("click", handler);
        return b;
      };
      acts.appendChild(
        mk("单跑此号", async () => {
          hint("正在为 " + acc.email + " 启动全自动流程…");
          const res = await send({ type: "start", emails: [acc.email] });
          hint(res.ok ? "已加入队列：" + acc.email : "启动失败：" + (res.error || ""), res.ok ? "ok" : "err");
          refresh();
        })
      );
      acts.appendChild(
        mk("重置", async () => {
          await send({ type: "resetAccount", email: acc.email });
          refresh();
        })
      );
      acts.appendChild(
        mk("删除", async () => {
          await send({ type: "deleteAccount", email: acc.email });
          refresh();
        })
      );

      li.appendChild(top);
      li.appendChild(meta);
      li.appendChild(acts);
      list.appendChild(li);
    }
  }

  function renderConfig(card, options) {
    if (document.activeElement && ["cardNumber", "cardMonth", "cardYear", "cardCvc", "cardHolder", "cardZip"].includes(document.activeElement.id)) {
      // 正在输入，不覆盖
    } else {
      $("cardNumber").value = card.number || "";
      $("cardMonth").value = card.expMonth || "";
      $("cardYear").value = card.expYear || "";
      $("cardCvc").value = card.cvc || "";
      $("cardHolder").value = card.holder || "";
      $("cardZip").value = card.zip || "97201";
    }
    $("optAutoLogin").checked = options.autoLogin !== false;
    $("optAutoCancel").checked = options.autoCancel !== false;
    $("optGuard").checked = options.zeroGuard !== false;
    $("optStrict").checked = options.strictZero === true;
    $("optStrictVerify").checked = options.strictVerify !== false;
    const mode = options.runMode || "session";
    document.querySelectorAll('input[name="runmode"]').forEach((r) => {
      if (!r.disabled) r.checked = r.value === mode;
    });
    applyModeUI(currentMode());
  }

  function hint(text, cls, auto) {
    const el = $("hint");
    el.textContent = text || "";
    el.className = "hint" + (cls ? " " + cls : "");
    hintAuto = !!auto;
  }

  /* --------------------------- 数据刷新 ------------------------------- */
  async function refresh() {
    const res = await send({ type: "getState" });
    if (!res || !res.ok) {
      hint("无法连接后台 service worker：" + ((res && res.error) || "未知错误"), "err");
      return;
    }
    latest = res;
    renderRun(res.state);
    renderAccounts(res.accounts || []);
    renderConfig(res.card || {}, res.options || {});
  }

  /* --------------------------- 事件绑定 ------------------------------- */
  $("btnStart").addEventListener("click", async () => {
    const mode = currentMode();
    hint(mode === "session" ? "正在识别当前登录账号并启动全自动流程…" : "正在启动账号队列…");
    await saveCardNow(); // 防止刚填完卡就点执行时保存还没落库
    const res = await send({ type: "start", mode, options: { runMode: mode } });
    if (!res.ok) hint("启动失败：" + (res.error || ""), "err");
    else hint(mode === "session" ? "已启动：将对当前登录账号执行三层叠加" : "已加入队列：" + (res.queued || []).join(", "), "ok");
    refresh();
  });

  $("btnProbe").addEventListener("click", async () => {
    hint("正在读取浏览器当前登录账号…");
    const res = await send({ type: "probeSession" });
    if (!res.ok) hint("读取失败：" + (res.error || ""), "err");
    else hint(`当前账号：${res.email}｜套餐 ${res.plan || "未知"}｜到期日 ${res.expiry || "未识别"}`, "ok");
    refresh();
  });

  $("btnStop").addEventListener("click", async () => {
    const res = await send({ type: "stop" });
    hint(res.ok ? "已发送停止指令" : "停止失败：" + (res.error || ""), res.ok ? "ok" : "err");
    refresh();
  });

  $("btnFocus").addEventListener("click", async () => {
    const res = await send({ type: "focusTab" });
    if (!res.ok) hint("无法切换标签页：" + (res.error || ""), "err");
  });

  $("btnImport").addEventListener("click", async () => {
    const raw = $("importBox").value.trim();
    if (!raw) return hint("请先粘贴账号文本", "err");
    const res = await send({ type: "importAccounts", rawText: raw });
    if (!res.ok) return hint("导入失败：" + (res.error || ""), "err");
    hint(`导入完成：新增 ${res.added}，更新 ${res.updated}，共 ${res.total} 个`, "ok");
    $("importBox").value = "";
    refresh();
  });

  $("btnClearAccounts").addEventListener("click", async () => {
    await send({ type: "clearAccounts" });
    hint("已清空账号列表", "ok");
    refresh();
  });

  $("btnClearLogs").addEventListener("click", async () => {
    await send({ type: "clearLogs" });
    lastLogCount = -1;
    refresh();
  });

  $("btnCopyLogs").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("logs").textContent || "");
      hint("日志已复制到剪贴板", "ok");
    } catch (e) {
      hint("复制失败：" + e.message, "err");
    }
  });

  async function saveCardNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const card = {
      number: $("cardNumber").value.replace(/\s+/g, ""),
      expMonth: $("cardMonth").value.replace(/\D/g, ""),
      expYear: $("cardYear").value.replace(/\D/g, ""),
      cvc: $("cardCvc").value.replace(/\D/g, ""),
      holder: $("cardHolder").value.trim(),
      zip: ($("cardZip").value || "97201").trim()
    };
    await send({ type: "saveCard", card });
    return card;
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      await saveCardNow();
      hint("配置已保存", "ok");
    }, 500);
  }

  ["cardNumber", "cardMonth", "cardYear", "cardCvc", "cardHolder", "cardZip"].forEach((id) => {
    $(id).addEventListener("input", scheduleSave);
  });

  function saveOptions() {
    send({
      type: "saveOptions",
      options: {
        runMode: currentMode(),
        autoLogin: $("optAutoLogin").checked,
        autoCancel: $("optAutoCancel").checked,
        zeroGuard: $("optGuard").checked,
        strictZero: $("optStrict").checked,
        strictVerify: $("optStrictVerify").checked
      }
    }).then(() => refresh());
  }

  document.querySelectorAll('input[name="runmode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      applyModeUI(radio.value);
      saveOptions();
    });
  });

  ["optAutoLogin", "optAutoCancel", "optGuard", "optStrict", "optStrictVerify"].forEach((id) => {
    $(id).addEventListener("change", saveOptions);
  });

  /* ------------------------- 截图权限（可选） ------------------------- */
  async function refreshShotPerm() {
    try {
      const granted = await chrome.permissions.contains({ origins: ["<all_urls>"] });
      $("shotPermState").textContent = granted ? "截图：已授权" : "截图：未授权（不影响主流程）";
      $("btnShotPerm").disabled = granted;
    } catch (e) {
      $("shotPermState").textContent = "截图：状态未知";
    }
  }

  $("btnShotPerm").addEventListener("click", async () => {
    try {
      const granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
      hint(granted ? "已授予截图权限，下次任务会保存关键截图" : "未授予截图权限，任务照常执行但没有截图", granted ? "ok" : "err");
    } catch (e) {
      hint("申请截图权限失败：" + e.message, "err");
    }
    refreshShotPerm();
  });

  /* ----------------------------- 轮询 -------------------------------- */
  refresh();
  refreshShotPerm();
  setInterval(refresh, 1200);
})();
