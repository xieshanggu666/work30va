"use strict";
/* 家庭采购与库存管理：
   - 按周菜单聚合采购清单，支持家人分工（自动均衡分派 / 手动认领）
   - 确认到货：库存增加、实际支出计入周预算，过敏食材默认拦截
   - 按日消耗：扣减库存、报告缺货、已消耗计入周限次并触发清单重算
   - 续配后续菜单：优先消耗库存食材，剩余采购预算按边际成本约束
   状态以 JSON 持久化（原子写入），仅依赖 Node 原生模块。 */

const fs = require("fs");
const path = require("path");
const { FOODS, getFood, ALLERGENS, CATEGORY_LABEL } = require("./foods");
const { planRange, DAY_NAMES } = require("./menu");

function round2(x) { return Math.round(x * 100) / 100; }

function defaultState() {
  return {
    version: 1,
    members: [],
    settings: { profile: null, budget: 25, allergens: [], exclude: [] },
    lines: [],
    stock: {},
    spent: 0,
    opening_value: 0,
    week: null,
    events: [],
  };
}

function nowTs() { return new Date().toISOString(); }

function createHouseholdStore(options = {}) {
  const file = options.file || path.join(__dirname, "..", "data", "household.json");
  let state = defaultState();
  let seq = 0;
  const id = prefix => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const d = defaultState();
      state = {
        ...d,
        ...raw,
        settings: { ...d.settings, ...(raw.settings || {}) },
        members: Array.isArray(raw.members) ? raw.members : [],
        lines: Array.isArray(raw.lines) ? raw.lines : [],
        stock: raw.stock && typeof raw.stock === "object" ? raw.stock : {},
        events: Array.isArray(raw.events) ? raw.events : [],
      };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      state = defaultState();
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  function log(type, text) {
    state.events.unshift({ id: id("E"), ts: nowTs(), type, text });
    if (state.events.length > 200) state.events.length = 200;
  }

  function allergenSet() {
    return new Set((state.settings.allergens || []).filter(a => ALLERGENS.includes(a)));
  }

  function findLine(lineId) {
    const line = state.lines.find(l => l.id === lineId);
    if (!line) { const e = new Error("采购项不存在"); e.code = 404; throw e; }
    return line;
  }

  function assertMember(memberId) {
    if (memberId == null) return null;
    const m = state.members.find(x => x.id === memberId);
    if (!m) { const e = new Error("家庭成员不存在"); e.code = 404; throw e; }
    return m;
  }

  /* 按负载（待采购克重）选择最空闲成员 */
  function leastLoadedMember() {
    if (state.members.length === 0) return null;
    const load = {};
    state.members.forEach(m => { load[m.id] = 0; });
    for (const l of state.lines) {
      if (l.assignee && l.status === "pending" && load[l.assignee] != null) {
        load[l.assignee] += Math.max(0, l.need_grams - l.arrived_grams);
      }
    }
    return state.members.slice().sort((a, b) => load[a.id] - load[b.id])[0];
  }

  /* 汇总未消耗日期的食材需求；保留已有到货 / 分工信息，新需求自动分派 */
  function rebuildLines(reason) {
    const agg = new Map();
    if (state.week) {
      state.week.days.forEach((day, d) => {
        if (!day || state.week.consumed[d]) return;
        for (const it of day.items) {
          if (!getFood(it.food_id)) continue;
          const cur = agg.get(it.food_id) || { name: it.name, need_grams: 0, source_days: new Set() };
          cur.need_grams += it.grams;
          cur.source_days.add(d);
          agg.set(it.food_id, cur);
        }
      });
    }

    const kept = [];
    for (const [foodId, a] of agg) {
      const prev = state.lines.find(l => l.food_id === foodId);
      const line = prev ? { ...prev } : {
        id: id("L"), food_id: foodId, name: a.name,
        need_grams: 0, arrived_grams: 0, status: "pending",
        assignee: null, cost_actual: 0,
      };
      line.name = a.name;
      line.need_grams = Math.round(a.need_grams * 10) / 10;
      line.source_days = [...a.source_days].sort((x, y) => x - y);
      if (!prev) {
        const m = leastLoadedMember();
        line.assignee = m ? m.id : null;
      }
      if (line.status === "arrived" && line.arrived_grams < line.need_grams) line.status = "pending";
      kept.push(line);
    }
    state.lines = kept;
    if (reason) log("lines", reason);
  }

  /* ---------- 状态与设置 ---------- */
  function getState() {
    return JSON.parse(JSON.stringify(state));
  }

  function setSettings(patch = {}) {
    if (patch.budget != null) {
      const b = Number(patch.budget);
      if (!(b > 0)) { const e = new Error("预算必须为正数"); e.code = 400; throw e; }
      state.settings.budget = b;
    }
    if (Array.isArray(patch.allergens)) {
      state.settings.allergens = [...new Set(patch.allergens.filter(a => ALLERGENS.includes(a)))];
    }
    if (Array.isArray(patch.exclude)) {
      state.settings.exclude = [...new Set(patch.exclude.filter(f => getFood(f)))];
    }
    if (patch.profile && typeof patch.profile === "object") {
      state.settings.profile = {
        age_group: patch.profile.age_group || "adult_m",
        activity: patch.profile.activity || "moderate",
        goal: patch.profile.goal || "maintain",
      };
    }
    save();
    return getState();
  }

  /* ---------- 家庭成员 ---------- */
  function addMember(name) {
    name = String(name || "").trim();
    if (!name) { const e = new Error("成员姓名不能为空"); e.code = 400; throw e; }
    const m = { id: id("M"), name };
    state.members.push(m);
    log("member", `${name} 加入家庭采购`);
    save();
    return m;
  }

  function updateMember(memberId, name) {
    const m = assertMember(memberId);
    name = String(name || "").trim();
    if (!name) { const e = new Error("成员姓名不能为空"); e.code = 400; throw e; }
    log("member", `${m.name} 改名为 ${name}`);
    m.name = name;
    save();
    return m;
  }

  function removeMember(memberId) {
    const m = assertMember(memberId);
    state.members = state.members.filter(x => x.id !== memberId);
    let reassigned = 0;
    state.lines.forEach(l => {
      if (l.assignee === memberId) { l.assignee = null; reassigned++; }
    });
    log("member", `${m.name} 已移出，${reassigned} 项采购待重新分工`);
    save();
    return { reassigned };
  }

  function assignLine(lineId, memberId) {
    const line = findLine(lineId);
    if (memberId != null) assertMember(memberId);
    line.assignee = memberId == null ? null : memberId;
    const who = memberId == null ? "待认领" : state.members.find(m => m.id === memberId).name;
    log("assign", `${line.name} 分派给 ${who}`);
    save();
    return line;
  }

  function autoAssign() {
    const pending = state.lines.filter(l => l.status === "pending" && l.assignee == null);
    if (state.members.length === 0) {
      const e = new Error("请先添加家庭成员"); e.code = 400; throw e;
    }
    pending.forEach(line => {
      line.assignee = leastLoadedMember().id;
    });
    log("assign", `自动分工：${pending.length} 项采购已均衡分派`);
    save();
    return { assigned: pending.length, lines: state.lines };
  }

  /* ---------- 周菜单 ---------- */
  function attachWeek(weekResult, params = {}) {
    if (!weekResult || !Array.isArray(weekResult.days) || weekResult.days.length !== 7) {
      const e = new Error("周菜单数据不完整（需 7 天）"); e.code = 400; throw e;
    }
    const days = weekResult.days.map((day, d) => {
      if (!day || !Array.isArray(day.items)) return null;
      const items = day.items
        .filter(it => getFood(it.food_id))
        .map(it => ({ ...it, grams: Number(it.grams) || 0 }));
      if (!items.length) return null;
      return { ...day, day: d, day_name: DAY_NAMES[d], items };
    });
    if (days.some(d => d === null)) {
      const e = new Error("周菜单含无效日期，无法生成采购清单"); e.code = 400; throw e;
    }
    state.week = {
      params: {
        profile: params.profile || state.settings.profile,
        budget: Number(params.budget) || state.settings.budget,
        allergens: Array.isArray(params.allergens) ? params.allergens : state.settings.allergens,
        exclude: Array.isArray(params.exclude) ? params.exclude : state.settings.exclude,
      },
      days,
      consumed: [false, false, false, false, false, false, false],
      attached_at: nowTs(),
    };
    state.lines = [];
    state.spent = 0;
    rebuildLines();
    log("week", "已按周菜单生成采购清单");
    save();
    return getState();
  }

  function assertWeek() {
    if (!state.week) { const e = new Error("尚未生成周菜单，请先生成并载入一周菜单"); e.code = 400; throw e; }
    return state.week;
  }

  /* ---------- 到货 / 入库 ---------- */
  function allergenBlocked(food) {
    const blocked = food.allergens.filter(a => allergenSet().has(a));
    return blocked;
  }

  function arrive(lineId, opts = {}) {
    const line = findLine(lineId);
    if (line.status === "arrived") { const e = new Error("该项已确认到货"); e.code = 400; throw e; }
    const food = getFood(line.food_id);
    const blocked = allergenBlocked(food);
    if (blocked.length && !opts.force) {
      const e = new Error(`${line.name} 含家庭需规避的过敏原：${blocked.join("、")}（force=true 可强制）`);
      e.code = 409; e.blocked = blocked; throw e;
    }
    const remaining = Math.max(0, line.need_grams - line.arrived_grams);
    const amount = opts.arrived_grams == null ? remaining : Math.max(0, Number(opts.arrived_grams));
    if (!(amount > 0)) { const e = new Error("到货数量必须大于 0"); e.code = 400; throw e; }
    const cost = opts.cost == null ? round2(food.cost * amount / 100) : round2(Number(opts.cost));
    if (!(cost >= 0)) { const e = new Error("实际花费非法"); e.code = 400; throw e; }

    state.stock[food.id] = Math.round(((state.stock[food.id] || 0) + amount) * 10) / 10;
    line.arrived_grams = Math.round((line.arrived_grams + amount) * 10) / 10;
    line.cost_actual = round2((line.cost_actual || 0) + cost);
    line.arrived_at = nowTs();
    if (line.arrived_grams >= line.need_grams - 1e-6) line.status = "arrived";
    state.spent = round2(state.spent + cost);
    log("arrive", `${line.name} 到货 ${amount}g，花费 ¥${cost.toFixed(2)}${blocked.length ? "（含过敏原，强制入库）" : ""}`);
    save();
    return { line, stock_grams: state.stock[food.id], spent: state.spent };
  }

  /* 期初库存 / 临时补采入库；期初库存不计入本周采购支出 */
  function stockIn(foodId, grams, opts = {}) {
    const food = getFood(foodId);
    if (!food) { const e = new Error("食材不存在"); e.code = 400; throw e; }
    const amount = Number(grams);
    if (!(amount > 0)) { const e = new Error("入库数量必须大于 0"); e.code = 400; throw e; }
    const blocked = allergenBlocked(food);
    if (blocked.length && !opts.force) {
      const e = new Error(`${food.name} 含家庭需规避的过敏原：${blocked.join("、")}（force=true 可强制）`);
      e.code = 409; e.blocked = blocked; throw e;
    }
    const kind = opts.kind === "opening" ? "opening" : "purchase";
    const catalogValue = round2(food.cost * amount / 100);
    const cost = opts.cost == null ? catalogValue : round2(Number(opts.cost));
    state.stock[food.id] = Math.round(((state.stock[food.id] || 0) + amount) * 10) / 10;
    if (kind === "opening") {
      state.opening_value = round2(state.opening_value + cost);
    } else {
      state.spent = round2(state.spent + cost);
    }
    log("stock", `${kind === "opening" ? "期初库存" : "临时补采"}：${food.name} ${amount}g${kind === "purchase" ? `，¥${cost.toFixed(2)}` : ""}${blocked.length ? "（含过敏原，强制入库）" : ""}`);
    save();
    return { food_id: food.id, stock_grams: state.stock[food.id], spent: state.spent };
  }

  /* ---------- 按日消耗 ---------- */
  function consumeDay(dayIndex) {
    const week = assertWeek();
    const d = Number(dayIndex);
    if (!(d >= 0 && d < 7)) { const e = new Error("日期序号需在 0-6"); e.code = 400; throw e; }
    if (week.consumed[d]) { const e = new Error(`${DAY_NAMES[d]} 已标记消耗`); e.code = 400; throw e; }
    const day = week.days[d];

    const shortfall = [];
    const allergenHits = [];
    const avoided = allergenSet();
    for (const it of day.items) {
      const food = getFood(it.food_id);
      const hit = food.allergens.filter(a => avoided.has(a));
      if (hit.length) allergenHits.push({ food_id: it.food_id, name: it.name, allergens: hit });
      const available = state.stock[it.food_id] || 0;
      const used = Math.min(available, it.grams);
      const short = round2(it.grams - used);
      if (short > 0.05) {
        shortfall.push({ food_id: it.food_id, name: it.name, needed: it.grams, available: round2(available), short_grams: short });
      }
      state.stock[it.food_id] = round2(Math.max(0, available - it.grams));
    }
    week.consumed[d] = true;
    week.last_consumed_at = nowTs();
    rebuildLines(`${DAY_NAMES[d]} 食材已消耗，采购清单已按后续配餐重算`);
    log("consume", `确认 ${DAY_NAMES[d]} 三餐消耗${shortfall.length ? `，${shortfall.length} 项库存不足` : ""}`);
    save();
    return { day: d, day_name: DAY_NAMES[d], shortfall, allergenHits, stock: state.stock };
  }

  function undoConsume(dayIndex) {
    const week = assertWeek();
    const d = Number(dayIndex);
    if (!(d >= 0 && d < 7)) { const e = new Error("日期序号需在 0-6"); e.code = 400; throw e; }
    if (!week.consumed[d]) { const e = new Error(`${DAY_NAMES[d]} 尚未消耗`); e.code = 400; throw e; }
    for (const it of week.days[d].items) {
      state.stock[it.food_id] = round2((state.stock[it.food_id] || 0) + it.grams);
    }
    week.consumed[d] = false;
    rebuildLines(`撤销 ${DAY_NAMES[d]} 消耗，库存已回退`);
    save();
    return { day: d, stock: state.stock };
  }

  /* ---------- 后续配餐 ---------- */
  function planRemaining() {
    const week = assertWeek();
    const startDay = week.consumed.findIndex(c => !c);
    if (startDay === -1) { const e = new Error("本周 7 天均已消耗，请重新生成周菜单"); e.code = 400; throw e; }

    const weeklyUsed = {};
    let prevIds = [];
    for (let d = 0; d < startDay; d++) {
      if (!week.days[d]) continue;
      for (const it of week.days[d].items) {
        weeklyUsed[it.food_id] = (weeklyUsed[it.food_id] || 0) + 1;
        prevIds = week.days[d].items.map(i => i.food_id);
      }
    }
    const params = {
      profile: state.settings.profile || week.params.profile,
      allergens: state.settings.allergens,
      exclude: state.settings.exclude,
    };
    const purchaseBudget = Math.max(0, state.settings.budget * 7 - state.spent);

    const r = planRange({
      ...params,
      budget: state.settings.budget,
      start_day: startDay,
      consumed_days: week.consumed,
      weekly_used: weeklyUsed,
      prev_ids: prevIds,
      stock_map: { ...state.stock },
      purchase_budget: purchaseBudget,
    });

    r.days.forEach((entry, d) => {
      if (entry) week.days[d] = entry;
    });
    rebuildLines(`已根据库存与剩余预算续配 ${DAY_NAMES[startDay]}起的菜单`);
    save();
    return {
      start_day: startDay,
      start_day_name: DAY_NAMES[startDay],
      days: week.days,
      consumed: week.consumed,
      planned_days: r.planned_days,
      remaining_budget: round2(r.remaining_budget),
      planned_purchase_cost: r.planned_purchase_cost,
      stock_after: r.stock_after,
      feasible: r.feasible,
    };
  }

  /* ---------- 汇总视图（预算 / 库存 / 分工 / 规避同步） ---------- */
  function summary() {
    const s = state;
    const weeklyBudget = s.settings.budget * 7;
    const lines = s.lines.map(l => ({ ...l }));
    let pendingCost = 0;
    for (const l of lines) {
      if (l.status !== "pending") continue;
      const food = getFood(l.food_id);
      pendingCost += food.cost * Math.max(0, l.need_grams - l.arrived_grams) / 100;
    }
    pendingCost = round2(pendingCost);

    const avoided = allergenSet();
    const stockItems = Object.entries(s.stock)
      .filter(([, g]) => g > 0.05)
      .map(([foodId, grams]) => {
        const f = getFood(foodId);
        if (!f) return null;
        const hit = f.allergens.filter(a => avoided.has(a));
        return {
          food_id: foodId, name: f.name, cat: f.cat, cat_label: CATEGORY_LABEL[f.cat] || f.cat,
          grams: round2(grams), value: round2(f.cost * grams / 100),
          allergens: f.allergens, allergen_hit: hit,
        };
      })
      .filter(Boolean);
    const stockValue = round2(stockItems.reduce((sum, x) => sum + x.value, 0));

    const byMember = {};
    s.members.forEach(m => {
      byMember[m.id] = { member_id: m.id, name: m.name, pending: 0, arrived: 0, pending_grams: 0 };
    });
    let pendingCount = 0, arrivedCount = 0, unassignedCount = 0;
    for (const l of lines) {
      if (l.status === "pending") pendingCount++; else arrivedCount++;
      if (l.status === "pending" && l.assignee == null) unassignedCount++;
      if (l.assignee && byMember[l.assignee]) {
        const bucket = byMember[l.assignee];
        if (l.status === "pending") { bucket.pending++; bucket.pending_grams += Math.max(0, l.need_grams - l.arrived_grams); }
        else bucket.arrived++;
      }
    }

    /* 未来需求与库存的缺口：用于缺货预警（续配前也能看到） */
    const needByFood = {};
    if (s.week) {
      s.week.days.forEach((day, d) => {
        if (!day || s.week.consumed[d]) return;
        day.items.forEach(it => { needByFood[it.food_id] = (needByFood[it.food_id] || 0) + it.grams; });
      });
    }
    const shortages = Object.entries(needByFood)
      .map(([foodId, need]) => {
        const have = s.stock[foodId] || 0;
        const short = round2(need - have);
        return short > 0.05 ? { food_id: foodId, name: getFood(foodId).name, need_grams: round2(need), stock_grams: round2(have), short_grams: short } : null;
      })
      .filter(Boolean);

    const consumedCount = s.week ? s.week.consumed.filter(Boolean).length : 0;
    const warnings = [];
    if (s.spent > weeklyBudget * 1.02) warnings.push(`本周采购支出 ¥${s.spent.toFixed(2)} 已超周预算 ¥${weeklyBudget.toFixed(2)}`);
    else if (round2(s.spent + pendingCost) > weeklyBudget * 1.02) warnings.push(`按待采购项估算将超周预算：预计支出 ¥${(s.spent + pendingCost).toFixed(2)} / ¥${weeklyBudget.toFixed(2)}`);
    if (unassignedCount > 0) warnings.push(`${unassignedCount} 项采购尚未分工`);
    const allergenStock = stockItems.filter(x => x.allergen_hit.length);
    if (allergenStock.length) warnings.push(`库存中含过敏原食材：${allergenStock.map(x => x.name).join("、")}`);

    return {
      members: s.members,
      settings: s.settings,
      day_names: DAY_NAMES,
      lines,
      assignments: Object.values(byMember),
      stock: stockItems,
      week_attached: !!s.week,
      consumed: s.week ? s.week.consumed : null,
      consumed_count: consumedCount,
      days: s.week ? s.week.days : null,
      budget: {
        daily: s.settings.budget,
        weekly: round2(weeklyBudget),
        spent: round2(s.spent),
        opening_value: round2(s.opening_value),
        pending_estimated: pendingCost,
        remaining: round2(weeklyBudget - s.spent),
        projected_total: round2(s.spent + pendingCost),
        over_budget: s.spent > weeklyBudget * 1.02,
        projected_over: round2(s.spent + pendingCost) > weeklyBudget * 1.02,
      },
      stock_value: stockValue,
      pending_count: pendingCount,
      arrived_count: arrivedCount,
      unassigned_count: unassignedCount,
      shortages,
      warnings,
      events: s.events.slice(0, 30),
    };
  }

  load();
  return {
    getState, setSettings,
    addMember, updateMember, removeMember,
    assignLine, autoAssign,
    attachWeek, arrive, stockIn,
    consumeDay, undoConsume, planRemaining,
    summary,
  };
}

module.exports = { createHouseholdStore };
