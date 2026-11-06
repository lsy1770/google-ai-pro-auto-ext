/* ============================================================================
 * background.js —— 全自动流水线调度器（MV3 service worker）
 * 迁移自 automation_engine.GoogleUltraAutomator.run_pipeline 的 5 步流程：
 *   Step1 登录（邮箱/密码/辅助邮箱/2FA）
 *   Step2 首层 12 个月  → Step3 二层 6 个月(SS) → Step4 三层 6 个月（含备用令牌）
 *   Step5 取消自动续订并核验到期日
 * 每一步都是幂等的：重跑会先读 Play 实际日期，已达标直接跳过。
 * ==========================================================================*/
importScripts("core.js");

const Core = self.GProCore;

const KEYS = {
  accounts: "gpro_accounts",
  card: "gpro_card",
  options: "gpro_options",
  inject: "gpro_inject",
  state: "gpro_state"
};

const DEFAULT_OPTIONS = {
  runMode: "session", // session = 直接用浏览器已登录账号；queue = 按导入的账号队列逐个执行
  autoLogin: true,
  autoCancel: true,
  zeroGuard: true,
  strictZero: false,
  pageSettle: 3500,
  postSuccessWait: 25000,
  stepGap: 2000,
  keepAlive: true
};

const DEFAULT_CARD = { number: "", expMonth: "", expYear: "", cvc: "", holder: "", zip: "97201" };

/* ----------------------------- 运行时状态 ------------------------------ */
const S = {
  running: false,
  stopping: false,
  resuming: false,
  mode: "session",
  session: null,
  queue: [],
  queueIndex: 0,
  currentEmail: "",
  step: "",
  stepIndex: 0,
  logs: [],
  results: [],
  lastShot: null,
  shotBlocked: false,
  tabId: null,
  startedAt: 0,
  heartbeat: 0
};

let flushTimer = null;
let flushBusy = false;

function snapshot() {
  return {
    running: S.running,
    stopping: S.stopping,
    mode: S.mode,
    session: S.session,
    queue: S.queue,
    queueIndex: S.queueIndex,
    currentEmail: S.currentEmail,
    step: S.step,
    stepIndex: S.stepIndex,
    logs: S.logs.slice(-260),
    results: S.results,
    lastShot: S.lastShot,
    startedAt: S.startedAt,
    tabId: S.tabId
  };
}

function flush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    if (flushBusy) return;
    flushBusy = true;
    try {
      await chrome.storage.local.set({ [KEYS.state]: snapshot() });
    } catch (e) {}
    flushBusy = false;
  }, 400);
}

function log(text, level) {
  const line = { t: Date.now(), level: level || "info", text: String(text) };
  S.logs.push(line);
  if (S.logs.length > 500) S.logs.splice(0, S.logs.length - 500);
  S.heartbeat = Date.now();
  try {
    console.log("[GPro]", text);
  } catch (e) {}
  flush();
}

function stopError() {
  const e = new Error("用户已停止任务");
  e.code = "STOPPED";
  return e;
}

function checkStop() {
  if (S.stopping) throw stopError();
}

/* ----------------------------- 事件总线 ------------------------------- */
const waiters = [];

function emitLocal(evt) {
  for (let i = waiters.length - 1; i >= 0; i -= 1) {
    const w = waiters[i];
    let hit = false;
    try {
      hit = w.match(evt);
    } catch (e) {
      hit = false;
    }
    if (!hit) continue;
    clearTimeout(w.timer);
    waiters.splice(i, 1);
    w.resolve(evt);
  }
}

function waitEvent(match, timeout) {
  return new Promise((resolve) => {
    const w = { match, resolve };
    w.timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      resolve(null);
    }, timeout);
    waiters.push(w);
  });
}

/* ----------------------------- 存储读取 ------------------------------- */
async function getStore(defaults) {
  return await chrome.storage.local.get(defaults);
}

async function getAccounts() {
  const r = await chrome.storage.local.get({ [KEYS.accounts]: [] });
  return Array.isArray(r[KEYS.accounts]) ? r[KEYS.accounts] : [];
}

async function setAccounts(list) {
  await chrome.storage.local.set({ [KEYS.accounts]: list });
}

async function getCard() {
  const r = await chrome.storage.local.get({ [KEYS.card]: DEFAULT_CARD });
  return Object.assign({}, DEFAULT_CARD, r[KEYS.card] || {});
}

async function getOptions() {
  const r = await chrome.storage.local.get({ [KEYS.options]: DEFAULT_OPTIONS });
  return Object.assign({}, DEFAULT_OPTIONS, r[KEYS.options] || {});
}

/* ----------------------------- DOM 驱动 -------------------------------- */
function broadcast(tabId, msg) {
  if (!tabId) return;
  try {
    const p = chrome.tabs.sendMessage(tabId, Object.assign({ scope: "cmd" }, msg));
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureTab() {
  let tab = null;
  if (S.tabId) {
    try {
      tab = await chrome.tabs.get(S.tabId);
    } catch (e) {
      tab = null;
    }
  }
  if (!tab) {
    tab = await chrome.tabs.create({ url: Core.URLS.PLANS, active: true });
  } else {
    try {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) {}
  }
  S.tabId = tab.id;
  flush();
  return tab.id;
}

function waitTabLoaded(tabId, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        chrome.tabs.onUpdated.removeListener(onUpd);
      } catch (e) {}
      resolve(true);
    };
    const onUpd = (id, info) => {
      if (id === tabId && info && info.status === "complete") finish();
    };
    try {
      chrome.tabs.onUpdated.addListener(onUpd);
      chrome.tabs
        .get(tabId)
        .then((t) => {
          if (t && t.status === "complete") finish();
        })
        .catch(() => {});
    } catch (e) {}
    setTimeout(finish, timeout || 25000);
  });
}

async function goto(tabId, url) {
  checkStop();
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (e) {
    throw new Error("无法导航到 " + url + ": " + e.message);
  }
  await sleep(700);
  await waitTabLoaded(tabId, 25000);
  await sleep(600);
}

async function probeTop(tabId, timeout) {
  const end = Date.now() + (timeout || 8000);
  while (Date.now() < end) {
    checkStop();
    broadcast(tabId, { type: "probe" });
    const evt = await waitEvent((e) => e.type === "pageInfo" && e.info && e.info.top === true && e.tabId === tabId, 900);
    if (evt) return evt.info;
  }
  return null;
}

async function capture(tabId, tag) {
  if (S.shotBlocked) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) {}
    await sleep(400);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    S.lastShot = { tag, dataUrl, at: Date.now() };
    S.shotBlocked = false;
    flush();
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/activeTab|all_urls|permission/i.test(msg)) {
      S.shotBlocked = true;
      log("未授予截图权限，已关闭自动截图（可在【配置】里点“授予截图权限”后重启任务）", "warn");
      return;
    }
    log("截图失败（可忽略）: " + msg, "warn");
  }
}

/* --------------------------- 注入配置下发 ------------------------------ */
async function applyInject(tabId, cfg) {
  try {
    await chrome.storage.local.set({ [KEYS.inject]: cfg });
  } catch (e) {}
  broadcast(tabId, { type: "injectSet", cfg });
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: "MAIN",
      func: (c) => {
        window.__GP_CONFIG__ = c;
        if (typeof window.__gpSetConfig === "function") window.__gpSetConfig(c);
      },
      args: [cfg]
    });
  } catch (e) {
    // scripting 失败时仍会走 postMessage 通道
  }
}

/* ------------------------------ 登录 --------------------------------- */
async function ensureSignedIn(tabId, acc, opts) {
  const creds = {
    email: acc.email || "",
    password: acc.password || "",
    recovery: acc.recovery || "",
    totp: acc.totp || ""
  };

  // 已登录模式：只确认当前会话，不做任何登录动作
  const first = await probeTop(tabId, 8000);
  if (first && first.kind === "plans") {
    if (S.mode !== "session" && acc.email && first.email && first.email.toLowerCase() !== acc.email.toLowerCase()) {
      log(`⚠️ 当前登录账号为 ${first.email}，与目标 ${acc.email} 不一致，将尝试切换账号`, "warn");
    } else {
      log(`✅ 使用浏览器已登录账号：${first.email || acc.email || "(未识别邮箱)"}`);
      return first;
    }
  }
  if (opts.autoLogin === false || S.mode === "session") {
    throw new Error("浏览器当前未登录 Google 账号（或不在 one.google.com），请先在该标签页登录后再执行");
  }

  for (let round = 0; round < 3; round += 1) {
    checkStop();
    const info = await probeTop(tabId, 6000);
    if (info && info.kind === "plans") {
      if (info.email && acc.email && info.email.toLowerCase() !== acc.email.toLowerCase()) {
        log(`⚠️ 当前登录账号为 ${info.email}，与目标 ${acc.email} 不一致，将尝试切换账号`, "warn");
      } else {
        log(`✅ 已登录 ${info.email || acc.email}`);
        return info;
      }
    }

    log("正在打开 Google 登录页并自动填写账号信息…");
    await goto(tabId, Core.URLS.LOGIN);
    await sleep(1500);

    for (let i = 0; i < Core.LIMITS.LOGIN_MAX_TICKS; i += 1) {
      checkStop();
      const pi = await probeTop(tabId, 2600);
      if (pi && pi.kind === "plans") {
        await sleep(1200);
        const p2 = await probeTop(tabId, 5000);
        if (p2 && p2.kind === "plans") {
          if (p2.email && acc.email && p2.email.toLowerCase() !== acc.email.toLowerCase()) {
            throw new Error(`登录后的账号是 ${p2.email}，不是目标 ${acc.email}，已中止以免操作错误账号`);
          }
          log(`✅ 登录完成: ${p2.email || acc.email}`);
          return p2;
        }
      }
      broadcast(tabId, { type: "loginTick", creds });
      const ev = await waitEvent((e) => e.type === "loginProgress" && e.tabId === tabId, 3400);
      if (ev) {
        if (ev.stage === "blocked") throw new Error("登录需要人工介入：" + ev.note);
        if (ev.note) log("登录: " + ev.note);
      }
      await sleep(400);
    }
  }
  throw new Error("自动登录未完成，请在该标签页手动登录一次后点“继续”");
}

/* --------------------------- Play 订阅读取 ---------------------------- */
async function readPlay(tabId, acc) {
  await goto(tabId, Core.URLS.PLAY_SUBS);
  await sleep(1500);
  const info = await probeTop(tabId, 12000);
  if (info && /accounts\.google\.com|gds\.google\.com/.test(info.url || "")) {
    await ensureSignedIn(tabId, acc, await getOptions());
    await goto(tabId, Core.URLS.PLAY_SUBS);
    await sleep(1500);
  }
  let last = null;
  let reloaded = false;
  for (let i = 0; i < 10; i += 1) {
    checkStop();
    broadcast(tabId, { type: "playRead" });
    const ev = await waitEvent((e) => e.type === "playData" && e.tabId === tabId, 2600);
    if (ev && ev.data) {
      const d = ev.data;
      last = d;
      const clean = d.clean || "";
      const ready = clean.length > 8 && !/^(正在加载|加载中|loading)/i.test(clean);
      if (ready) {
        log(
          `Play 状态 → 套餐: ${d.plan} | 日期: ${d.entitlement || "未识别"}` +
            (d.canceled ? " | 已取消/待续订" : "") +
            (d.hasManage ? " | 有管理入口" : "")
        );
        return d;
      }
    }
    if (i === 4 && !reloaded) {
      reloaded = true;
      log("Play 页面内容为空，正在重新加载一次…", "warn");
      try {
        await chrome.tabs.reload(tabId);
      } catch (e) {}
      await sleep(2500);
    }
    await sleep(1100);
  }
  if (last) return last;
  throw new Error("无法读取 Play 订阅页内容（页面结构可能变化）");
}

/* --------------------- Google One 侧会员日期读取 ---------------------- */
async function readOneSettings(tabId) {
  const urls = ["https://one.google.com/settings?expand=upgrade&hl=zh-CN", Core.URLS.PLANS];
  let best = null;
  let plan = "";
  let snapshot = "";
  for (const url of urls) {
    checkStop();
    try {
      await goto(tabId, url);
    } catch (e) {
      continue;
    }
    await sleep(2000);
    for (let i = 0; i < 3; i += 1) {
      broadcast(tabId, { type: "readDates" });
      const ev = await waitEvent((e) => e.type === "dates" && e.tabId === tabId, 3000);
      if (ev && ev.data) {
        const d = ev.data;
        if (d.text) snapshot = d.text;
        if (d.entitlement && (!best || d.entitlement > best)) best = d.entitlement;
        if (d.plan && d.plan !== "未知订阅") plan = d.plan;
        break;
      }
      await sleep(1000);
    }
  }
  return { entitlement: best, plan, text: snapshot };
}

// 多来源判断权益：Play 的"下次付款日期"对月付账号只有 +1 个月，必须同时看 Google One 的试用结束/有效期
async function readEntitlement(tabId, acc) {
  let play = null;
  let one = null;
  try {
    play = await readPlay(tabId, acc);
  } catch (e) {
    log("Play 订阅页读取失败: " + e.message, "warn");
  }
  try {
    one = await readOneSettings(tabId);
  } catch (e) {
    log("Google One 会员页读取失败: " + e.message, "warn");
  }
  const cands = [];
  if (play && play.entitlement) cands.push({ src: "Play", date: play.entitlement });
  if (one && one.entitlement) cands.push({ src: "Google One", date: one.entitlement });
  cands.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const best = cands.length ? cands[cands.length - 1] : null;
  if (one && one.entitlement && play && play.entitlement && one.entitlement !== play.entitlement) {
    log(`ℹ️ 两个来源日期不同：Play ${play.entitlement} / Google One ${one.entitlement}，取较晚者`);
  }
  return {
    play,
    one,
    best: best ? best.date : null,
    bestSrc: best ? best.src : "",
    plan: (one && one.plan) || (play && play.plan) || "",
    canceled: play ? !!play.canceled : false
  };
}

async function resubscribeIfNeeded(tabId, play, acc) {
  if (!/重新订阅|resubscribe/i.test(play.clean || "")) return play;
  log("订阅处于【已取消】状态，正在点击【重新订阅】恢复叠加能力…");
  broadcast(tabId, { type: "playResubscribe" });
  const ev = await waitEvent((e) => e.type === "playActionResult" && e.action === "resubscribe" && e.tabId === tabId, 6000);
  if (ev && ev.note) log("重新订阅: " + ev.note);
  await sleep(4500);
  return await readPlay(tabId, acc);
}

/* ------------------------- 24 位订阅 ID 读取 -------------------------- */
async function readSubId(tabId) {
  await goto(tabId, Core.URLS.PLANS);
  await sleep(2200);
  for (let i = 0; i < 3; i += 1) {
    checkStop();
    broadcast(tabId, { type: "readSubId" });
    const ev = await waitEvent((e) => e.type === "subId" && e.tabId === tabId, 3500);
    if (ev && ev.value) {
      log("读取到当前订阅 ID: " + ev.value);
      return ev.value;
    }
    await sleep(1000);
  }
  log("未能在页面静态数据中定位订阅 ID，将由拦截器在 Ngbm/ear 中自动继承原订阅", "warn");
  return null;
}

/* --------------------------- 优惠入口点击 ----------------------------- */
async function clickOffer(tabId) {
  for (let i = 0; i < 8; i += 1) {
    checkStop();
    broadcast(tabId, { type: "clickOffer" });
    const ev = await waitEvent((e) => e.type === "offerClicked" && e.tabId === tabId, 1500);
    if (ev && ev.ok) {
      log(`已点击优惠入口【${ev.text}】，等待 Google Play 结账弹窗…`);
      return true;
    }
    await sleep(700);
  }
  return false;
}

/* --------------------------- 结账弹窗等待 ----------------------------- */
function checkoutCard(card) {
  const num = String(card.number || "").replace(/\s+/g, "");
  return {
    number: num,
    expMonth: String(card.expMonth || "").padStart(2, "0"),
    expYear: String(card.expYear || ""),
    cvc: String(card.cvc || ""),
    holder: card.holder || "CARD HOLDER",
    zip: card.zip || "97201",
    last4: num.length >= 4 ? num.slice(-4) : ""
  };
}

async function waitCheckout(tabId, acc, opts, tag) {
  const card = checkoutCard(await getCard());
  const creds = { password: acc.password || "", totp: acc.totp || "" };
  let sawClicked = false;
  let sawCheckout = false;
  let opened = false;

  for (let i = 0; i < Core.LIMITS.CHECKOUT_MAX_TICKS; i += 1) {
    checkStop();
    broadcast(tabId, {
      type: "checkoutTick",
      card,
      creds,
      guard: opts.zeroGuard !== false,
      strict: opts.strictZero === true,
      tag
    });
    if (i % 3 === 0) broadcast(tabId, { type: "clickTransition" });

    const ev = await waitEvent((e) => e.type === "checkoutOutcome" && e.tabId === tabId, Core.LIMITS.CHECKOUT_TICK_MS + 300);
    if (ev) {
      const kind = ev.kind;
      if (kind === "success") {
        log("✅ " + (ev.text || "已捕获订阅成功标志"));
        await capture(tabId, tag + "_success");
        return { ok: true };
      }
      if (kind === "error") {
        log("❌ 结账返回错误: " + ev.text, "error");
        await capture(tabId, tag + "_error");
        return { ok: false, reason: "结账错误: " + ev.text };
      }
      if (kind === "blocked") {
        log("⛔ " + ev.text, "warn");
        await capture(tabId, tag + "_blocked");
        return { ok: false, reason: ev.text };
      }
      if (kind === "clicked") {
        sawClicked = true;
        log("🖱 " + ev.text);
      } else if (kind === "needCard") {
        log("💳 " + ev.text);
      } else if (kind === "cardSaved" || kind === "cardFilled") {
        log("💳 " + ev.text);
      } else if (kind === "switchCard") {
        log("💳 " + ev.text);
      } else if (kind === "auth") {
        log("🔐 " + ev.text);
      }
    }

    if (i % 5 === 4) {
      const top = await probeTop(tabId, 2500);
      if (!top) continue;
      if (/accounts\.google\.com|gds\.google\.com/.test(top.url || "")) {
        log("结账过程触发登录验证，正在自动完成身份验证…", "warn");
        await ensureSignedIn(tabId, acc, opts);
        return { ok: false, reason: "login" };
      }
      if (top.inject && top.inject.patched && !opened) {
        opened = true;
        log(`注入器已改写 ${top.inject.patched} 个 Ngbm 结账请求（层: ${top.inject.layer}）`);
      }
      const text = String(top.text || "");
      if (/购买失败|BX-CPL-05|出了点问题|Purchase failed/.test(text)) {
        return { ok: false, reason: "页面提示购买失败: " + Core.shortText(text, 160) };
      }
      if (/欢迎您|新会员已生效/.test(text)) {
        log("✅ 检测到 Google One 新会员生效提示");
        return { ok: true };
      }
      if (top.kind === "play" && sawClicked) {
        log("结账弹窗已关闭，正在核对 Play 记录…");
        return { ok: true };
      }
    }
    if (i === 4) {
      const c = await waitEvent((e) => e.type === "pageInfo" && e.info && e.info.kind === "checkout" && e.tabId === tabId, 1200);
      sawCheckout = !!c;
      if (!sawCheckout) log("… 尚未检测到结账弹窗（继续等待，注入器可能正在改写请求）");
    }
  }
  return { ok: false, reason: "等待结账超时（" + Math.round((Core.LIMITS.CHECKOUT_MAX_TICKS * Core.LIMITS.CHECKOUT_TICK_MS) / 1000) + " 秒）" };
}

/* --------------------------- 单层结账尝试 ----------------------------- */
async function attemptSubscribe(tabId, acc, opts, layer, token) {
  const subId = await readSubId(tabId);
  const cfg = Core.buildConfig(layer.id, subId, token);
  log(`本层注入配置: ${layer.label} | 令牌 ${token} | 订阅ID ${subId || "(自动继承)"}`);

  let lastReason = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    checkStop();
    await goto(tabId, Core.URLS.PLANS);
    await sleep(opts.pageSettle || 3500);
    let info = await probeTop(tabId, 10000);
    if (!info) throw new Error("方案页未就绪");
    if (/accounts\.google\.com|gds\.google\.com/.test(info.url || "")) {
      await ensureSignedIn(tabId, acc, opts);
      await goto(tabId, Core.URLS.PLANS);
      await sleep(opts.pageSettle || 3500);
    }
    await applyInject(tabId, cfg);
    await sleep(800);
    await applyInject(tabId, cfg);

    const clicked = await clickOffer(tabId);
    if (!clicked) {
      lastReason = "未找到可点击的优惠入口按钮";
      log("⚠️ " + lastReason + "，重试中…", "warn");
      await sleep(2500);
      continue;
    }

    const res = await waitCheckout(tabId, acc, opts, cfg.name);
    if (res.ok) return res;
    lastReason = res.reason || "";
    if (lastReason === "login") continue;
    if (attempt === 1) return res;
    log("⚠️ 本次未完成结账（" + lastReason + "），重新拉起方案页重试…", "warn");
    await sleep(3000);
  }
  return { ok: false, reason: lastReason || "多次尝试未完成结账" };
}

/* ------------------------------ 各步骤 -------------------------------- */
async function stepPrepare(tabId, acc, opts) {
  S.step = "Step 1/5 登录与账号校验";
  flush();
  log("=== Step 1/5: 登录校验 & 账号核对 ===");
  await goto(tabId, Core.URLS.PLANS);
  await sleep(opts.pageSettle || 3000);
  const info = await ensureSignedIn(tabId, acc, opts);
  const email = (info && info.email) || acc.email;
  log(`当前操作账号: ${email}`);
  await capture(tabId, "step1_login");
}

async function stepLayer(tabId, acc, opts, idx) {
  const layer = Core.LAYERS[idx];
  const expectedMonths = Core.LAYERS.slice(0, idx + 1).reduce((sum, l) => sum + l.months, 0);
  S.step = `Step ${idx + 2}/5 ${layer.label}`;
  flush();
  log(`=== Step ${idx + 2}/5: ${layer.label}（累计目标 ${expectedMonths} 个月） ===`);

  let ent = await readEntitlement(tabId, acc);
  if (ent.play && /重新订阅|resubscribe/i.test(ent.play.clean || "")) {
    await resubscribeIfNeeded(tabId, ent.play, acc);
    ent = await readEntitlement(tabId, acc);
  }

  const today = Core.todayISO();
  const targetISO = Core.addMonths(today, expectedMonths); // 目标：从今天起累计 expectedMonths 个月
  const before = ent.best;
  if (before) {
    const have = Core.monthsBetween(today, before);
    log(`基准：今日 ${today}，现有最晚日期 ${before}（来源 ${ent.bestSrc}，约 ${have} 个月）；本层目标 ≥ ${targetISO}`);
    if (Core.meetsTarget(before, targetISO, 7)) {
      log(`✅ 现有权益已达 ${expectedMonths} 个月，本层自动跳过`);
      acc.expiry = before;
      acc.plan = ent.plan;
      return;
    }
  } else {
    log(`未读到任何现有到期日（Play/Google One 均为空），按从零执行；本层目标 ≥ ${targetISO}`);
  }

  const tokens = [layer.token].concat(layer.fallbackToken ? [layer.fallbackToken] : []);
  let lastReason = "";
  for (const token of tokens) {
    const res = await attemptSubscribe(tabId, acc, opts, layer, token);
    if (!res.ok) {
      lastReason = res.reason || "未知原因";
      log(`⚠️ 令牌 ${token} 未完成结账: ${lastReason}`, "warn");
      await sleep(3000);
      continue;
    }
    log("✅ 结账成功，等待 Google 侧结算并回读权益（" + Math.round((opts.postSuccessWait || 25000) / 1000) + " 秒）…");
    await sleep(opts.postSuccessWait || 25000);

    // 多次回读：Play 的"下次付款日期"对月付账号只显示 +1 个月，
    // 真正的试用结束日要同时看 Google One 会员页；Google 同步慢时要给足时间
    const waits = [0, 15000, 20000, 25000, 30000];
    let verified = null;
    let lastAfter = null;
    for (let k = 0; k < waits.length; k += 1) {
      checkStop();
      if (waits[k]) await sleep(waits[k]);
      const after = await readEntitlement(tabId, acc);
      lastAfter = after;
      if (after.best && Core.meetsTarget(after.best, targetISO, 7)) {
        verified = after;
        break;
      }
      log(
        `核验中(${k + 1}/${waits.length})：最晚日期 ${after.best || "未识别"}` +
          `（来源 ${after.bestSrc || "-"}），目标 ${targetISO}，继续等待同步…`,
        "warn"
      );
    }
    if (verified) {
      acc.expiry = verified.best;
      acc.plan = verified.plan;
      log(`🎯 ${layer.label} 核验通过：${verified.best}（来源 ${verified.bestSrc}）`);
      await capture(tabId, `step${idx + 2}_verified`);
      return;
    }

    if (opts.strictVerify === true) {
      throw new Error(
        `${layer.label} 已提交，但回读日期未达到 ${targetISO}（当前 ${(lastAfter && lastAfter.best) || "未识别"}）。` +
          `Google 侧同步通常有延迟，可稍后重跑本账号（已达成的层会自动跳过）。`
      );
    }
    acc.partial = true;
    acc.expiry = (lastAfter && lastAfter.best) || acc.expiry;
    log(
      `⚠️ 订单已提交成功，但 Google 侧还没同步到 ${targetISO}（当前 ${(lastAfter && lastAfter.best) || "未识别"}）。` +
        `已标记「待同步」并继续下一层；几分钟到几小时后重跑本账号会把缺的层补齐（已达成层自动跳过）。`,
      "warn"
    );
    return;
  }
  throw new Error(`${layer.label} 未完成: ${lastReason}`);
}

async function stepCancel(tabId, acc, opts) {
  S.step = "Step 5/5 取消续订与最终核验";
  flush();
  log("=== Step 5/5: 取消自动续订 & 最终权益核验 ===");
  let play = await readPlay(tabId, acc);

  const alreadyCanceled = /取消日期|Cancellation date|重新订阅|Resubscribe/i.test(play.clean || "");
  if (opts.autoCancel !== false && !alreadyCanceled) {
    log("正在自动执行取消续订流程…");
    await goto(tabId, Core.URLS.PLAY_SUBS);
    await sleep(2000);
    for (let i = 0; i < Core.LIMITS.CANCEL_MAX_TICKS; i += 1) {
      checkStop();
      broadcast(tabId, { type: "playCancelTick" });
      const ev = await waitEvent((e) => e.type === "playCancelTickResult" && e.tabId === tabId, 2600);
      if (ev) {
        if (ev.note) log("取消流程: " + ev.note);
        if (ev.done) break;
      }
      await sleep(700);
    }
    await sleep(2500);
    play = await readPlay(tabId, acc);
  } else if (alreadyCanceled) {
    log("订阅已处于已取消状态，跳过取消操作");
  } else {
    log("已按配置跳过自动取消续订");
  }

  // 最终对账：同时看 Play 与 Google One，取较晚日期并换算成"还剩几个月"
  const finalEnt = await readEntitlement(tabId, acc);
  const today = Core.todayISO();
  const expiry = finalEnt.best || acc.expiry || "未识别";
  const months = finalEnt.best ? Core.monthsBetween(today, finalEnt.best) : 0;
  acc.expiry = expiry;
  acc.plan = finalEnt.plan || acc.plan;
  await capture(tabId, "step5_final");

  if (finalEnt.best && months >= 24) {
    acc.partial = false;
    log(`🎉 账号 ${acc.email} 完成 | 套餐: ${acc.plan} | 权益截止: ${expiry}（约 ${months} 个月，来源 ${finalEnt.bestSrc}）`);
  } else if (finalEnt.best) {
    acc.partial = true;
    log(
      `⚠️ 账号 ${acc.email} 当前权益截止 ${expiry}（约 ${months} 个月，来源 ${finalEnt.bestSrc}），未达 24 个月。` +
        `若刚才的层已提交成功，等 Google 同步后重跑本账号即可自动补齐剩余层（已达成层会跳过）。`,
      "warn"
    );
  } else {
    log(`⚠️ 账号 ${acc.email} 未能回读到任何权益日期，请到 Play / Google One 手动确认`, "warn");
  }
}

/* ---------------------------- 单账号执行 ------------------------------ */
async function patchAccount(email, patch) {
  const list = await getAccounts();
  for (const a of list) {
    if (a.email === email) Object.assign(a, patch);
  }
  await setAccounts(list);
  return list;
}

// 已登录模式下进度写在 session 快照里；账号队列模式下写回账号列表
async function recordProgress(email, patch) {
  if (S.mode === "session") {
    S.session = Object.assign({ email, status: "running", plan: "", expiry: "", message: "" }, S.session || {}, patch, { email });
    flush();
    return;
  }
  await patchAccount(email, patch);
}

async function runAccount(acc, opts, fromStep) {
  const tabId = await ensureTab();
  S.currentEmail = acc.email;
  S.startedAt = S.startedAt || Date.now();
  S.stepIndex = fromStep || 0;
  flush();

  const steps = [
    { id: "prepare", fn: () => stepPrepare(tabId, acc, opts) },
    { id: "layer1", fn: () => stepLayer(tabId, acc, opts, 0) },
    { id: "layer2", fn: () => stepLayer(tabId, acc, opts, 1) },
    { id: "layer3", fn: () => stepLayer(tabId, acc, opts, 2) },
    { id: "cancel", fn: () => stepCancel(tabId, acc, opts) }
  ];

  log(`▶ 开始执行${S.mode === "session" ? "当前登录账号" : "账号"} ${acc.email}（从 ${steps[S.stepIndex].id} 开始）`);

  for (let i = S.stepIndex; i < steps.length; i += 1) {
    checkStop();
    S.stepIndex = i;
    flush();
    await recordProgress(acc.email, { status: "running", message: S.step });

    try {
      await steps[i].fn();
    } catch (e) {
      if (e && e.code === "STOPPED") {
        await recordProgress(acc.email, { status: "stopped", message: "已手动停止", expiry: acc.expiry || "", plan: acc.plan || "" });
        throw e;
      }
      log(`❌ ${steps[i].id} 失败: ${e.message}`, "error");
      await capture(tabId, steps[i].id + "_fail");
      await recordProgress(acc.email, {
        status: "error",
        message: steps[i].id + " 失败: " + e.message,
        expiry: acc.expiry || "",
        plan: acc.plan || ""
      });
      S.results.push({ email: acc.email, ok: false, step: steps[i].id, reason: e.message });
      throw e;
    }

    if (i < steps.length - 1) await sleep(opts.stepGap || 2000);
  }

  const finalStatus = acc.partial ? "partial" : "completed";
  await recordProgress(acc.email, {
    status: finalStatus,
    message: acc.partial ? "已提交，等待 Google 侧同步（稍后重跑可补齐）" : "全流程完成",
    expiry: acc.expiry || "",
    plan: acc.plan || ""
  });
  S.results.push({
    email: acc.email,
    ok: !acc.partial,
    partial: !!acc.partial,
    expiry: acc.expiry || "",
    plan: acc.plan || ""
  });
  log(`✅ ${acc.email} 执行完成${acc.partial ? "（有待同步的层）" : ""}`);
}

/* --------------------- 已登录账号模式（不登录、不换号） ----------------- */
async function resolveSessionAccount(tabId) {
  await goto(tabId, Core.URLS.PLANS);
  await sleep(2500);
  let info = await probeTop(tabId, 15000);
  if (!info || /accounts\.google\.com|gds\.google\.com/.test(info.url || "") || info.kind !== "plans") {
    return null;
  }
  // 兜底：页面没解析出邮箱时，等待内容脚本的邮箱探测
  let email = info.email || "";
  for (let i = 0; i < 5 && !email; i += 1) {
    await sleep(1200);
    const again = await probeTop(tabId, 5000);
    if (again && again.kind === "plans") {
      email = again.email || "";
      info = again;
    }
  }
  return { email: email || "(未识别邮箱)", info };
}

async function runSession(opts) {
  if (S.running) return;
  S.mode = "session";
  S.running = true;
  S.stopping = false;
  S.queue = ["当前登录账号"];
  S.queueIndex = 0;
  S.startedAt = Date.now();
  S.results = [];
  S.session = { email: "", status: "running", plan: "", expiry: "", message: "正在识别浏览器当前登录账号…" };
  log("🚀 已登录账号模式启动：不执行登录、不切换账号，只叠加权益并核验");
  log(`自动取消续订=${opts.autoCancel !== false ? "开" : "关"} | 零元保护=${opts.zeroGuard !== false ? "开" : "关"}`);

  try {
    const tabId = await ensureTab();
    const resolved = await resolveSessionAccount(tabId);
    if (!resolved) {
      throw new Error("未检测到已登录的 Google 账号：请先在该浏览器登录 Google，并保持能打开 one.google.com/plans");
    }
    S.currentEmail = resolved.email;
    S.session.email = resolved.email;
    log(`✅ 当前浏览器登录账号：${resolved.email}`);
    const acc = { email: resolved.email, password: "", recovery: "", totp: "" };
    await runAccount(acc, Object.assign({}, opts, { autoLogin: false }), 1); // 跳过 Step1 登录，直接叠加
  } catch (e) {
    if (e && e.code === "STOPPED") {
      log("⏹ 已按用户要求停止");
      if (S.session) S.session.status = "stopped";
    } else {
      log(`❌ 执行中断: ${e.message}`, "error");
      if (S.session) {
        S.session.status = "error";
        S.session.message = e.message;
      }
      S.results.push({ email: S.currentEmail || "当前账号", ok: false, step: S.step, reason: e.message });
    }
  } finally {
    S.running = false;
    S.stopping = false;
    S.step = "空闲";
    log("🏁 已登录账号流程结束");
    flush();
  }
}

/* ------------------------------ 队列 --------------------------------- */
async function runQueue(emails) {
  if (S.running) return;
  const opts = Object.assign(await getOptions(), {});
  const accounts = await getAccounts();
  const targets = accounts.filter((a) => emails.indexOf(a.email) >= 0);
  if (!targets.length) {
    log("没有可执行的账号，请先导入账号", "warn");
    return;
  }
  S.mode = "queue";
  S.running = true;
  S.stopping = false;
  S.queue = targets.map((a) => a.email);
  S.queueIndex = 0;
  S.startedAt = Date.now();
  S.results = [];
  log(`🚀 全自动队列启动：${S.queue.length} 个账号 | 自动取消续订=${opts.autoCancel ? "开" : "关"} | 零元保护=${opts.zeroGuard ? "开" : "关"}`);

  try {
    for (let i = 0; i < targets.length; i += 1) {
      if (S.stopping) break;
      S.queueIndex = i;
      S.stepIndex = 0;
      try {
        await runAccount(targets[i], opts, 0);
      } catch (e) {
        if (e && e.code === "STOPPED") {
          log("⏹ 队列已按用户要求停止");
          break;
        }
        log(`账号 ${targets[i].email} 中断: ${e.message}`, "error");
      }
    }
  } finally {
    S.running = false;
    S.stopping = false;
    S.currentEmail = "";
    S.step = "空闲";
    log("🏁 队列执行结束");
    flush();
  }
}

/* --------------------------- 账号文本导入 ----------------------------- */
function splitLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return [];
  if (raw.indexOf("----") >= 0) return raw.split("----").map((s) => s.trim()).filter(Boolean);
  if (raw.indexOf("——") >= 0) return raw.split("——").map((s) => s.trim()).filter(Boolean);
  if (raw.indexOf("—") >= 0) return raw.split("—").map((s) => s.trim()).filter(Boolean);
  if (raw.indexOf("|") >= 0) return raw.split("|").map((s) => s.trim()).filter(Boolean);
  if (raw.indexOf("\t") >= 0) return raw.split("\t").map((s) => s.trim()).filter(Boolean);
  if (raw.indexOf(",") >= 0) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (raw.indexOf("/") >= 0 && raw.indexOf("@") >= 0 && raw.indexOf("://") < 0)
    return raw.split("/").map((s) => s.trim()).filter(Boolean);
  return raw.split(/\s+/).filter(Boolean);
}

function parseAccounts(rawText) {
  const lines = String(rawText || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const parts = splitLine(line);
    if (parts.length < 2) continue;
    let email = "";
    let password = "";
    let rest = [];
    const at = parts.findIndex((p) => p.indexOf("@") >= 0);
    if (at < 0) continue;
    email = parts[at];
    password = parts[at + 1] || "";
    rest = parts.slice(at + 2);
    let recovery = "";
    let totpSecret = "";
    let note = "";
    for (const token of rest) {
      const t = String(token).replace(/\s+/g, "");
      if (t.indexOf("@") >= 0 && t.indexOf("://") < 0) {
        if (!recovery) recovery = token;
      } else if (/^[A-Za-z2-7]{16,}=*$/.test(t) && !totpSecret) {
        totpSecret = t;
      } else if (/^(\d{1,3}\.){3}\d{1,3}:\d+$/.test(t) || t.indexOf("://") >= 0) {
        note = t;
      }
    }
    out.push({ email, password, recovery, totp: totpSecret, proxy: note });
  }
  return out;
}

async function importAccounts(rawText) {
  const parsed = parseAccounts(rawText);
  const list = await getAccounts();
  const norm = (e) => String(e || "").toLowerCase().replace(/\./g, "");
  let added = 0;
  let updated = 0;
  for (const item of parsed) {
    const hit = list.find((a) => norm(a.email) === norm(item.email));
    if (hit) {
      hit.password = item.password || hit.password;
      hit.recovery = item.recovery || hit.recovery;
      hit.totp = item.totp || hit.totp;
      hit.proxy = item.proxy || hit.proxy;
      updated += 1;
      continue;
    }
    list.push({
      email: item.email,
      password: item.password,
      recovery: item.recovery,
      totp: item.totp,
      proxy: item.proxy,
      status: "pending",
      message: "待执行",
      expiry: "",
      plan: "",
      addedAt: Date.now()
    });
    added += 1;
  }
  await setAccounts(list);
  log(`📥 账号导入完成：新增 ${added}，更新 ${updated}，共 ${list.length} 个`);
  return { added, updated, total: list.length };
}

/* ---------------------------- 弹窗 RPC -------------------------------- */
async function handlePopup(msg) {
  switch (msg.type) {
    case "getState": {
      const [accounts, card, options] = await Promise.all([getAccounts(), getCard(), getOptions()]);
      return { ok: true, state: snapshot(), accounts, card, options, defaults: { DEFAULT_OPTIONS, DEFAULT_CARD }, limits: Core.LIMITS };
    }
    case "saveCard": {
      await chrome.storage.local.set({ [KEYS.card]: Object.assign({}, DEFAULT_CARD, msg.card || {}) });
      return { ok: true };
    }
    case "saveOptions": {
      await chrome.storage.local.set({ [KEYS.options]: Object.assign({}, DEFAULT_OPTIONS, msg.options || {}) });
      return { ok: true };
    }
    case "importAccounts": {
      const res = await importAccounts(msg.rawText || "");
      return Object.assign({ ok: true }, res);
    }
    case "deleteAccount": {
      const list = (await getAccounts()).filter((a) => a.email !== msg.email);
      await setAccounts(list);
      return { ok: true, total: list.length };
    }
    case "resetAccount": {
      const list = await getAccounts();
      for (const a of list) {
        if (a.email === msg.email) {
          a.status = "pending";
          a.message = "已重置";
        }
      }
      await setAccounts(list);
      return { ok: true };
    }
    case "clearAccounts": {
      await setAccounts([]);
      return { ok: true };
    }
    case "clearLogs": {
      S.logs = [];
      flush();
      return { ok: true };
    }
    case "focusTab": {
      if (!S.tabId) return { ok: false, error: "还没有工作标签页" };
      try {
        const tab = await chrome.tabs.get(S.tabId);
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    case "probeSession": {
      // 只为“读取当前登录账号”按钮服务，不启动流程
      if (S.running) return { ok: false, error: "任务运行中，稍后再读取" };
      const tabId = await ensureTab();
      const resolved = await resolveSessionAccount(tabId);
      if (!resolved) {
        S.session = { email: "", status: "error", message: "未检测到已登录账号", plan: "", expiry: "" };
        flush();
        return { ok: false, error: "未检测到已登录的 Google 账号：请先登录 Google 后重试" };
      }
      let plan = "";
      let expiry = "";
      let src = "";
      try {
        const ent = await readEntitlement(tabId, { email: resolved.email, password: "" });
        plan = ent.plan || "";
        expiry = ent.best || "";
        src = ent.bestSrc || "";
      } catch (e) {
        log("读取会员权益失败（不影响执行）: " + e.message, "warn");
      }
      S.session = { email: resolved.email, status: "pending", message: "已识别登录账号", plan, expiry };
      flush();
      log(
        `🔎 已识别当前登录账号：${resolved.email} | 套餐: ${plan || "未知"} | 权益截止: ${expiry || "未识别"}` +
          (src ? `（来源 ${src}）` : "")
      );
      return { ok: true, email: resolved.email, plan, expiry, source: src };
    }
    case "start": {
      if (S.running) return { ok: false, error: "队列已在运行中" };
      const opts = await getOptions();
      if (msg.options) {
        await chrome.storage.local.set({ [KEYS.options]: Object.assign({}, opts, msg.options) });
        Object.assign(opts, msg.options);
      }
      const mode = msg.mode || opts.runMode || "session";

      if (mode === "session") {
        const card = await getCard();
        const cardReady = String(card.number || "").replace(/\s+/g, "").length >= 12 && card.expMonth && card.expYear && card.cvc;
        if (!cardReady) {
          log("⚠️ 未填写支付卡：仅当该 Google 账号已保存可用付款方式时才能走完结账；否则请在【配置】里填卡", "warn");
        }
        runSession(opts).catch((e) => log("已登录账号流程异常: " + e.message, "error"));
        return { ok: true, mode: "session", queued: ["当前登录账号"] };
      }

      const accounts = await getAccounts();
      let emails = msg.emails && msg.emails.length ? msg.emails : accounts.filter((a) => a.status !== "completed").map((a) => a.email);
      if (!emails.length) emails = accounts.map((a) => a.email);
      if (!emails.length) return { ok: false, error: "请先导入账号，或切换到“当前登录账号”模式" };
      const card = await getCard();
      const needsCard = !(String(card.number || "").replace(/\s+/g, "").length >= 12 && card.expMonth && card.expYear && card.cvc);
      if (needsCard) return { ok: false, error: "请先填写完整的支付卡信息（卡号 / 有效期 / CVC）" };
      runQueue(emails).catch((e) => log("队列异常: " + e.message, "error"));
      return { ok: true, mode: "queue", queued: emails };
    }
    case "stop": {
      if (!S.running) return { ok: false, error: "当前没有运行中的任务" };
      S.stopping = true;
      log("⏹ 收到停止指令，正在结束当前步骤…", "warn");
      return { ok: true };
    }
    default:
      return { ok: false, error: "未知指令: " + msg.type };
  }
}

/* ---------------------------- 消息路由 -------------------------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.scope === "evt") {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    const evt = Object.assign({}, msg, { tabId, frameId: sender ? sender.frameId : null });
    delete evt.scope;
    if (evt.type === "log") {
      log(evt.note || "", evt.level || "info");
      return false;
    }
    emitLocal(evt);
    return false;
  }

  if (msg.scope === "popup") {
    handlePopup(msg)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  return false;
});

/* --------------------------- 保活 & 看门狗 ----------------------------- */
setInterval(() => {
  if (!S.running) return;
  // 任一扩展 API 调用都会重置 service worker 的空闲计时
  try {
    chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  } catch (e) {}
  S.heartbeat = Date.now();
}, 20000);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "gpro-watchdog") return;
  if (!S.running || S.resuming) return;
  if (Date.now() - S.heartbeat < 120000) return;
  S.resuming = true;
  try {
    log("⚠️ 检测到后台被浏览器休眠，正在恢复当前账号的剩余步骤…", "warn");
    const opts = await getOptions();
    let acc = null;
    if (S.mode === "session") {
      acc = { email: S.currentEmail || (S.session && S.session.email) || "当前登录账号", password: "", recovery: "", totp: "" };
      S.mode = "session";
      opts.autoLogin = false;
    } else {
      const accounts = await getAccounts();
      acc = accounts.find((a) => a.email === S.currentEmail) || null;
    }
    if (acc) {
      S.resuming = false;
      await runAccount(acc, opts, Math.max(1, S.stepIndex));
    }
  } catch (e) {
    log("恢复执行失败: " + e.message, "error");
  } finally {
    S.resuming = false;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.alarms.create("gpro-watchdog", { periodInMinutes: 1 });
  } catch (e) {}
  chrome.storage.local.set({ [KEYS.options]: DEFAULT_OPTIONS, [KEYS.card]: DEFAULT_CARD });
  log("扩展已安装/更新，配置默认值已写入");
});

chrome.runtime.onStartup.addListener(() => {
  try {
    chrome.alarms.create("gpro-watchdog", { periodInMinutes: 1 });
  } catch (e) {}
});

// 冷启动恢复上次状态展示
chrome.storage.local.get({ [KEYS.state]: null }).then((r) => {
  const old = r[KEYS.state];
  if (old && Array.isArray(old.logs)) S.logs = old.logs.slice(-200);
  S.lastShot = (old && old.lastShot) || null;
  flush();
});
