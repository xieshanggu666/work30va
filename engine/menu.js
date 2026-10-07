"use strict";
/* 周菜单生成：7 天 × 三餐，蛋白质来源逐日轮换、主食轮换、相邻天不重复食材，
   肝脏全周至多 1 次，输出每日营养汇总与多样性统计。
   planRange 支持从周中续配：传入已消耗天数、当前库存与剩余采购预算，
   后续日期优先消耗库存食材，并按边际采购成本受预算约束。 */

const { FOODS, getFood } = require("./foods");
const { planDay } = require("./constraints");

const DAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

const STAPLE_ROTATION = [
  ["rice_long", "brown_rice"], ["oatmeal", "steamed_bun"], ["buckwheat", "rice_long"],
  ["sweet_potato", "corn"], ["spaghetti", "brown_rice"], ["millet", "whole_wheat_bread"],
  ["rice_round", "potato"],
];

const LUNCH_STAPLE = ["rice_long", "brown_rice", "buckwheat", "spaghetti", "steamed_bun"];
const DINNER_STAPLE = ["rice_round", "brown_rice", "sweet_potato", "corn", "potato"];

const PROTEIN_KINDS = [
  { kind: "禽肉", ids: ["chicken_breast", "chicken_thigh"] },
  { kind: "猪肉", ids: ["pork_lean", "pork_liver"] },
  { kind: "牛肉", ids: ["beef_tenderloin", "beef_brisket"] },
  { kind: "羊肉", ids: ["lamb_lean"] },
  { kind: "鱼类", ids: ["salmon", "cod", "bass"] },
  { kind: "虾贝", ids: ["shrimp", "scallop"] },
  { kind: "豆制品", ids: ["tofu_north", "tofu_south", "yuba", "soybean"] },
];

const VEG_ROTATION = [
  ["broccoli", "tomato", "cucumber", "carrot"],
  ["spinach", "mushroom", "green_pepper", "white_gourd"],
  ["cabbage", "eggplant", "pumpkin", "onion"],
  ["red_cabbage", "celery", "lettuce", "broccoli"],
  ["asparagus", "cucumber", "tomato", "spinach"],
  ["carrot", "white_gourd", "mushroom", "cabbage"],
  ["lettuce", "pumpkin", "celery", "red_cabbage"],
];

const FRUIT_ROTATION = [
  ["apple", "banana"], ["orange", "pear"], ["kiwi", "grape"], ["strawberry", "apple"],
  ["blueberry", "orange"], ["banana", "pear"], ["grape", "kiwi"],
];

const ALL_PROTEIN = PROTEIN_KINDS.flatMap(k => k.ids);

/* 午餐蛋白按日轮换 kind；晚餐避开当日与次日午餐类别（保证次日午餐可用） */
function buildDayPools(d, params) {
  const staples = STAPLE_ROTATION[d % 7];
  const proteinKind = PROTEIN_KINDS[d % 7];
  const nextKind = PROTEIN_KINDS[(d + 1) % 7];
  const lunchProtein = proteinKind.ids.filter(id => id !== "pork_liver");
  let dinnerProtein = ALL_PROTEIN.filter(id => !proteinKind.ids.includes(id) && !nextKind.ids.includes(id));
  if (d === 1 && proteinKind.kind === "猪肉") {
    dinnerProtein = ["pork_liver"];
  }
  return {
    breakfast_staple: staples,
    lunch_staple: [LUNCH_STAPLE[d % LUNCH_STAPLE.length], LUNCH_STAPLE[(d + 2) % LUNCH_STAPLE.length]],
    dinner_staple: [DINNER_STAPLE[(d + 1) % DINNER_STAPLE.length], DINNER_STAPLE[(d + 3) % DINNER_STAPLE.length]],
    lunch_protein: lunchProtein,
    dinner_protein: dinnerProtein,
    veg: VEG_ROTATION[d % VEG_ROTATION.length],
    fruit: FRUIT_ROTATION[d % FRUIT_ROTATION.length],
  };
}

function toDayEntry(d, result) {
  return {
    day: d, day_name: DAY_NAMES[d],
    items: result.items, totals: result.totals, ratios: result.ratios,
    adequacy: result.adequacy, cost: result.totals.cost,
    purchase_cost: result.totals.purchase_cost,
    feasible: result.feasible, reasons: result.reasons || [],
  };
}

/* 区间求解：consumed[d] 为 true 的日期跳过（占位 null），从 start_day 起续配。
   stock_map 按规划日逐项扣减；purchase_budget 为剩余天数共享的边际采购预算总额。 */
function planRange(params) {
  const days = [];
  const weeklyUsed = { ...(params.weekly_used || {}) };
  let prevIds = new Set(params.prev_ids || []);
  const stock = { ...(params.stock_map || {}) };
  const startDay = Math.max(0, Math.min(6, params.start_day || 0));
  const consumed = params.consumed_days || null;
  const plannedDays = [];
  for (let d = startDay; d < 7; d++) {
    if (consumed && consumed[d]) continue;
    plannedDays.push(d);
  }

  /* 默认每日独立预算（旧行为）；显式传 purchase_budget 时改为剩余天数共享预算池 */
  const pooledBudget = params.purchase_budget != null ? Number(params.purchase_budget) : null;
  let remainingBudget = pooledBudget != null
    ? pooledBudget
    : (params.budget != null ? Number(params.budget) * Math.max(plannedDays.length, 1) : null);
  const hasStock = Object.values(stock).some(g => g > 0);

  for (let d = 0; d < 7; d++) {
    if (d < startDay || (consumed && consumed[d])) {
      days.push(null);
      continue;
    }
    const dayPools = buildDayPools(d, params);
    const left = plannedDays.filter(x => x >= d).length;
    const dayBudget = pooledBudget != null ? remainingBudget / left : params.budget;
    /* 相邻不重复：库存按"当日已扣减"快照参与选择，使前日食材在次日视为无库存。
       三段式重试：库存+相邻严格 → 仅库存（放宽相邻）→ 全部放宽（标记不可行原因）。 */
    const baseDayParams = {
      ...params,
      budget: dayBudget,
      weekly_used: weeklyUsed,
      day_pools: dayPools,
    };
    const runDay = (stage) => {
      const snap = { ...stock };
      prevIds.forEach(id => { snap[id] = 0; });
      if (stage === 2) {
        /* 允许采购补缺口：完整排除前日食材（旧周菜单相邻不重复行为），库存仅作同类替换抵扣 */
        return planDay({ ...baseDayParams, exclude: [...(params.exclude || []), ...prevIds], stock_map: snap });
      }
      if (stage === 0) {
        /* 库存严格 + 相邻严格 */
        return planDay({ ...baseDayParams, exclude: [...(params.exclude || []), ...prevIds], stock_map: snap, stock_only: true });
      }
      /* stage1：仅库存，放宽相邻约束（库存不足以支撑完整轮换时的中间轮） */
      return planDay({ ...baseDayParams, exclude: [...(params.exclude || [])], stock_map: snap, stock_only: true });
    };
    let result;
    if (hasStock) {
      result = runDay(0);
      if (!result.feasible) result = runDay(1);
      if (!result.feasible) result = runDay(2);
    } else {
      result = runDay(2);
    }
    result.items.forEach(it => {
      weeklyUsed[it.food_id] = (weeklyUsed[it.food_id] || 0) + 1;
      stock[it.food_id] = Math.max(0, (stock[it.food_id] || 0) - it.grams);
    });
    if (remainingBudget != null) {
      remainingBudget = Math.max(0, remainingBudget - result.totals.purchase_cost);
    }
    prevIds = new Set(result.items.map(i => i.food_id));
    days.push(toDayEntry(d, result));
  }

  return {
    days,
    planned_days: plannedDays,
    stock_after: stock,
    remaining_budget: remainingBudget,
    planned_purchase_cost: Math.round(
      days.reduce((s, d) => s + (d ? d.purchase_cost : 0), 0) * 100
    ) / 100,
    feasible: days.every(x => x === null || x.feasible),
  };
}

function diversityOf(days) {
  const valid = days.filter(Boolean);
  const allIds = [];
  for (const day of valid) for (const it of day.items) allIds.push(it.food_id);
  const unique = new Set(allIds);
  const counts = {};
  allIds.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
  const repeats = allIds.length - unique.size;
  const proteinKindsUsed = new Set();
  for (const day of valid) {
    for (const it of day.items) {
      const kind = PROTEIN_KINDS.find(k => k.ids.includes(it.food_id));
      if (kind && it.role === "protein") proteinKindsUsed.add(kind.kind);
    }
  }
  return {
    unique_foods: unique.size,
    total_servings: allIds.length,
    repeat_servings: repeats,
    protein_kinds: proteinKindsUsed.size,
    protein_kinds_max: PROTEIN_KINDS.length,
    liver_count: (counts["pork_liver"] || 0),
  };
}

function weekPlan(params) {
  const r = planRange(params);
  const days = r.days;
  return {
    days,
    diversity: diversityOf(days),
    weekly_cost: Math.round(days.reduce((s, d) => s + d.cost, 0) * 100) / 100,
    weekly_purchase_cost: Math.round(days.reduce((s, d) => s + d.purchase_cost, 0) * 100) / 100,
    feasible: days.every(x => x.feasible),
  };
}

module.exports = { weekPlan, planRange, diversityOf, DAY_NAMES, STAPLE_ROTATION, PROTEIN_KINDS };
