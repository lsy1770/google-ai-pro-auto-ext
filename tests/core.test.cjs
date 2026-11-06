/* 单元测试：核心纯函数（令牌配置 / 日期数学 / 零元核验 / TOTP）
 * 运行：node --test browser_extension/tests/core.test.cjs
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../core.js");

test("buildConfig 生成与 automation_engine 一致的 full_items", () => {
  const cfg = Core.buildConfig("layer1", "abcdefghijklmnopqrstuvwx");
  assert.equal(cfg.full_items.length, 2);
  assert.equal(cfg.full_items[0][0][0], Core.ITEM_AI);
  assert.equal(cfg.full_items[0][0][1], 21);
  assert.deepEqual(cfg.full_items[0][5], [Core.TOKENS["12m"]]);
  assert.equal(cfg.full_items[1][0][0], Core.ITEM_YT);
  assert.deepEqual(cfg.full_items[1][5], [Core.TOKENS.yt]);
  assert.deepEqual(cfg.ear8, [null, 5, null, null, null, ["abcdefghijklmnopqrstuvwx"]]);
});

test("buildConfig 无订阅 ID 时 ear8 为 null（由拦截器自动继承）", () => {
  const cfg = Core.buildConfig("layer2", null, "6m_ss");
  assert.equal(cfg.ear8, null);
  assert.deepEqual(cfg.full_items[0][5], [Core.TOKENS["6m_ss"]]);
});

test("layer3 备用令牌", () => {
  const cfg = Core.buildConfig("layer3", null, "6m_2");
  assert.deepEqual(cfg.full_items[0][5], [Core.TOKENS["6m_2"]]);
  assert.equal(cfg.layer, "layer3");
});

test("addMonths 处理月末", () => {
  assert.equal(Core.addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(Core.addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(Core.addMonths("2026-11-06", 12), "2027-11-06");
  assert.equal(Core.addMonths("2027-11-06", 6), "2028-05-06");
});

test("parseDate 支持中英文格式", () => {
  assert.equal(Core.parseDate("2028年10月5日"), "2028-10-05");
  assert.equal(Core.parseDate("Oct 5, 2028"), "2028-10-05");
  assert.equal(Core.parseDate("5 October 2028"), "2028-10-05");
  assert.equal(Core.parseDate("2028-10-05"), "2028-10-05");
  assert.equal(Core.parseDate("2028-02-30"), null);
});

test("pickEntitlement 优先取带标签的日期", () => {
  const text = [
    "Google AI Pro (5 TB)",
    "订阅编号 1234",
    "续订日期：2028年10月5日",
    "账单历史 2026年11月6日"
  ].join("\n");
  assert.equal(Core.pickEntitlement(text), "2028-10-05");
});

test("pickEntitlement 识别试用结束/有效期文案（Google One 侧）", () => {
  assert.equal(Core.pickEntitlement("您的免费试用将于 2027年11月6日 结束"), "2027-11-06");
  assert.equal(Core.pickEntitlement("会员有效期至：2027年11月6日"), "2027-11-06");
  assert.equal(Core.pickEntitlement("Trial ends on Nov 6, 2027"), "2027-11-06");
  assert.equal(Core.pickEntitlement("下次付款日期：2026年12月6日"), "2026-12-06");
});

test("meetsTarget 容忍 Google 账期误差（7 天）", () => {
  assert.equal(Core.meetsTarget("2027-11-06", "2027-11-06"), true);
  assert.equal(Core.meetsTarget("2027-11-10", "2027-11-06"), true);
  assert.equal(Core.meetsTarget("2027-11-01", "2027-11-06"), true); // 差 5 天，可接受
  assert.equal(Core.meetsTarget("2026-12-06", "2027-11-06"), false); // 月付的"下一个账期"不算 12 个月
  assert.equal(Core.meetsTarget(null, "2027-11-06"), false);
});

test("月付账号场景：Play 显示下一个账期时不应该被判为已达标", () => {
  const today = "2026-11-06";
  const playNextPayment = "2026-12-06";
  const target12 = Core.addMonths(today, 12);
  assert.equal(target12, "2027-11-06");
  assert.equal(Core.meetsTarget(playNextPayment, target12), false);
  // Google One 显示试用结束日时才算达标
  assert.equal(Core.meetsTarget("2027-11-06", target12), true);
});

test("pickEntitlement 退化为最大日期", () => {
  const text = "Google AI Pro | 2026年11月6日 | 2028年4月5日";
  assert.equal(Core.pickEntitlement(text), "2028-04-05");
});

test("monthsBetween 计算整数月", () => {
  assert.equal(Core.monthsBetween("2026-11-06", "2028-11-06"), 24);
  assert.equal(Core.monthsBetween("2026-11-06", "2027-11-05"), 11);
});

test("zeroDueProof 识别明确的 0 元", () => {
  const ok = Core.zeroDueProof("今日应付\nUS$0.00\n之后每月 US$19.99");
  assert.equal(ok.safe, true);
  const bad = Core.zeroDueProof("Total today: US$19.99");
  assert.equal(bad.safe, false);
  const missing = Core.zeroDueProof("免费试用 1 个月");
  assert.equal(missing.safe, false);
});

test("guardCheck 严格与宽松模式", () => {
  const text = "免费试用 1 个月，之后按 US$19.99/月收费";
  assert.equal(Core.guardCheck(text, true).ok, false);
  assert.equal(Core.guardCheck(text, false).ok, true);
  assert.equal(Core.guardCheck("今日应付 US$0.00", true).ok, true);
  assert.equal(Core.guardCheck("请立即付款 US$9.99", false).ok, false);
});

test("TOTP 与 RFC 6238 向量一致（6 位）", async () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890"
  const code = await Core.totp(secret, 59000);
  assert.equal(code, "287082");
});

test("planName 识别套餐", () => {
  assert.equal(Core.planName("Google AI Pro (5 TB)"), "Google AI Pro (5 TB)");
  assert.equal(Core.planName("Google AI Ultra 20 TB"), "Google AI Ultra (20 TB)");
});

test("isCanceled 识别取消状态", () => {
  assert.equal(Core.isCanceled("已取消 · 重新订阅"), true);
  assert.equal(Core.isCanceled("订阅中，续订日期 2028年10月5日"), false);
});
