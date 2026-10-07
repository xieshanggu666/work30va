"use strict";
/* 单日膳食多维约束求解：
   热量区间 / 宏量营养素供能比 / 微量营养素达标 / 预算上限 / 过敏原与限次约束。
   毛重计价与克重调整，营养素按可食部折算。 */

const { FOODS, getFood, nutrientsFor, costFor, NUTRIENT_ORDER } = require("./foods");
const { getRequirement } = require("./requirements");

const MEALS = ["breakfast", "lunch", "dinner"];
const MEAL_LABEL = { breakfast: "早餐", lunch: "午餐", dinner: "晚餐" };

const K = { PROTEIN: 4, FAT: 9, CARB: 4 }; // 供能系数 kcal/g
const FAT_RATIO = [0.20, 0.30];
const PROTEIN_RATIO = [0.10, 0.20];
const CARB_RATIO = [0.50, 0.65];
const KCAL_TOL = 0.05;

/* 早餐模板：主食 + 蛋奶 + 水果 */
const BREAKFAST_SLOTS = [
  { role: "staple", pool: ["oatmeal", "millet", "whole_wheat_bread", "steamed_bun", "sweet_potato"], grams: 200 },
  { role: "dairy_egg", pool: ["egg", "milk_full", "yogurt", "soymilk"], grams: 120 },
  { role: "fruit", pool: ["apple", "banana", "orange", "pear", "kiwi"], grams: 150 },
];

/* 午/晚餐模板：主食 + 蛋白质主菜 + 蔬菜×2 + 油脂 */
const LUNCH_SLOTS = [
  { role: "staple", pool: ["rice_long", "brown_rice", "buckwheat", "spaghetti", "steamed_bun"], grams: 220 },
  { role: "protein", pool: ["chicken_breast", "pork_lean", "beef_tenderloin", "salmon", "bass", "shrimp", "tofu_north"], grams: 120 },
  { role: "veg_a", pool: ["broccoli", "spinach", "cabbage", "red_cabbage", "asparagus", "carrot"], grams: 110 },
  { role: "veg_b", pool: ["tomato", "cucumber", "green_pepper", "mushroom", "eggplant", "pumpkin"], grams: 110 },
  { role: "oil", pool: ["olive_oil", "sesame_oil", "linseed_oil"], grams: 6 },
];

const DINNER_SLOTS = [
  { role: "staple", pool: ["rice_round", "brown_rice", "sweet_potato", "corn", "potato"], grams: 180 },
  { role: "protein", pool: ["chicken_thigh", "beef_brisket", "lamb_lean", "cod", "scallop", "tofu_south", "yuba", "pork_liver"], grams: 100 },
  { role: "veg_a", pool: ["celery", "lettuce", "white_gourd", "pumpkin", "cabbage", "onion"], grams: 110 },
  { role: "veg_b", pool: ["cucumber", "tomato", "green_pepper", "carrot", "mushroom", "broccoli"], grams: 110 },
  { role: "oil", pool: ["olive_oil", "sesame_oil"], grams: 6 },
];

const SNACK_SLOT = { role: "nut", pool: ["peanut", "walnut", "almond"], grams: 10 };

const MIN_GRAMS = { staple: 60, dairy_egg: 40, protein: 40, veg_a: 40, veg_b: 40, oil: 2, fruit: 40, nut: 3 };

function kcalOf(n) { return K.PROTEIN * n.protein + K.FAT * n.fat + K.CARB * n.carb; }

function round1(x) { return Math.round(x * 10) / 10; }

function poolOf(slot, dayPools, meal) {
  if (!dayPools) return slot.pool;
  const keyMap = {
    breakfast_staple: "breakfast_staple",
    lunch_staple: "lunch_staple",
    dinner_staple: "dinner_staple",
    lunch_protein: "lunch_protein",
    dinner_protein: "dinner_protein",
    breakfast_fruit: "fruit",
    lunch_veg_a: "veg", lunch_veg_b: "veg",
    dinner_veg_a: "veg", dinner_veg_b: "veg",
  };
  const key = keyMap[meal + "_" + slot.role];
  return (key && dayPools[key]) ? dayPools[key] : slot.pool;
}

function pick(slot, taken, excludeIds, dayPools, meal) {
  const base = poolOf(slot, dayPools, meal);
  const pool = base.filter(id => !taken.has(id) && !excludeIds.has(id));
  if (pool.length === 0) return null;
  return getFood(pool[0]);
}

function buildItems(params, req) {
  const excludeIds = new Set(params.exclude || []);
  const taken = new Set();
  const items = [];
  const weeklyUsed = params.weekly_used || {};
  const dayPools = params.day_pools || null;

  const tryAdd = (slot, meal) => {
    const food = pick(slot, taken, excludeIds, dayPools, meal);
    if (!food) return false;
    const used = weeklyUsed[food.id] || 0;
    if (food.weekly_limit && used >= food.weekly_limit) return false;
    if (food.allergens.some(a => params.allergens.includes(a))) return false;
    taken.add(food.id);
    items.push({ meal, role: slot.role, food_id: food.id, name: food.name, grams: slot.grams, pool: poolOf(slot, dayPools, meal) });
    return true;
  };

  BREAKFAST_SLOTS.forEach(s => tryAdd(s, "breakfast"));
  LUNCH_SLOTS.forEach(s => tryAdd(s, "lunch"));
  DINNER_SLOTS.forEach(s => tryAdd(s, "dinner"));
  tryAdd(SNACK_SLOT, "breakfast");

  /* 蛋白质主菜若全部被排除，退化为仅素食可食的组合 */
  const proteinCount = items.filter(i => i.role === "protein").length;
  if (proteinCount === 0) {
    const vegExtra = getFood("tofu_south");
    if (vegExtra && !excludeIds.has(vegExtra.id)) {
      items.push({ meal: "lunch", role: "protein", food_id: vegExtra.id, name: vegExtra.name, grams: 120 });
    }
  }
  return items;
}

function totalOf(items) {
  const t = { cost: 0 };
  for (const k of NUTRIENT_ORDER) t[k] = 0;
  for (const it of items) {
    const f = getFood(it.food_id);
    const n = nutrientsFor(f, it.grams);
    for (const k of NUTRIENT_ORDER) t[k] += n[k];
    t.cost += costFor(f, it.grams);
  }
  return t;
}

function ratios(t) {
  const kcal = t.kcal || 1;
  return {
    fat: (t.fat * K.FAT) / kcal,
    protein: (t.protein * K.PROTEIN) / kcal,
    carb: (t.carb * K.CARB) / kcal,
  };
}

function adjust(items, req, budget, params) {
  const foodOf = id => getFood(id);
  const excludeSet = new Set(params.exclude || []);
  const allergenSet = new Set(params.allergens || []);
  const low = req.kcal * (1 - KCAL_TOL);
  const high = req.kcal * (1 + KCAL_TOL);

  let changed = true;
  let iters = 0;
  while (changed && iters < 400) {
    changed = false;
    iters++;
    const t = totalOf(items);
    const kcal = t.kcal;
    const r = ratios(t);

    /* 1. 热量不足：按当前宏量短板分派加量目标 */
    if (kcal < low) {
      const r2 = ratios(t);
      let pick = null;
      const oilPick = items.filter(i => i.role === "oil" && i.grams < 60)
        .sort((a, b) => foodOf(b.food_id).per100g.fat - foodOf(a.food_id).per100g.fat)[0];
      const nutPick = items.filter(i => i.role === "nut" && i.grams < 30)
        .sort((a, b) => foodOf(b.food_id).per100g.fat - foodOf(a.food_id).per100g.fat)[0];
      if (r2.fat < FAT_RATIO[0] + 0.02) {
        pick = oilPick || nutPick;
      }
      if (!pick && r2.carb > CARB_RATIO[1] - 0.02) {
        pick = oilPick || items.filter(i => ["protein", "dairy_egg"].includes(i.role) && i.grams < 300)
          .sort((a, b) => foodOf(b.food_id).per100g.kcal - foodOf(a.food_id).per100g.kcal)[0];
      }
      if (!pick) {
        pick = items.filter(i => ["staple", "fruit", "nut", "dairy_egg", "protein"].includes(i.role))
          .map(i => {
            const f = foodOf(i.food_id);
            const cap = i.role === "nut" ? 30 : 750;
            const pure = f.per100g.kcal - 0.35 * f.per100g.protein * K.PROTEIN - 1.2 * f.per100g.fat * K.FAT;
            return { it: i, s: pure / f.cost, cap };
          })
          .filter(x => x.it.grams < x.cap).sort((a, b) => b.s - a.s)[0];
        if (pick) pick = pick.it;
      }
      if (pick) { pick.grams += 25; changed = true; }
      continue;
    }
    /* 2. 热量超标：先减能量密度最高者 */
    if (kcal > high) {
      const targets = items
        .filter(i => i.grams - 15 >= MIN_GRAMS[i.role])
        .sort((a, b) => foodOf(b.food_id).per100g.kcal - foodOf(a.food_id).per100g.kcal);
      if (targets.length) { targets[0].grams -= 15; changed = true; }
      continue;
    }
    /* 3. 蛋白质总量不足 */
    if (t.protein < req.protein) {
      const targets = items
        .filter(i => ["protein", "dairy_egg", "staple"].includes(i.role) && i.grams < 300)
        .sort((a, b) => foodOf(b.food_id).per100g.protein - foodOf(a.food_id).per100g.protein);
      if (targets.length) { targets[0].grams += 10; changed = true; }
      continue;
    }
    /* 4. 脂肪供能比超限 */
    if (r.fat > FAT_RATIO[1]) {
      const highFat = items
        .filter(i => i.role === "oil" || foodOf(i.food_id).per100g.fat >= 8)
        .filter(i => i.grams - 3 >= MIN_GRAMS[i.role]);
      if (highFat.length) { highFat[0].grams -= 3; changed = true; }
      else {
        const staple = items.filter(i => i.role === "staple" && i.grams < 400);
        if (staple.length) { staple[0].grams += 25; changed = true; }
      }
      continue;
    }
    /* 5. 脂肪供能比过低 */
    if (r.fat < FAT_RATIO[0]) {
      const oil = items.filter(i => i.role === "oil" && i.grams < 25);
      if (oil.length) { oil[0].grams += 2; changed = true; }
      continue;
    }
    /* 6. 蛋白质供能比超限：减高蛋白食材 */
    if (r.protein > PROTEIN_RATIO[1]) {
      const highP = items
        .filter(i => i.role === "protein" || i.role === "dairy_egg")
        .filter(i => i.grams - 15 >= MIN_GRAMS[i.role])
        .sort((a, b) => foodOf(b.food_id).per100g.protein - foodOf(a.food_id).per100g.protein);
      if (highP.length) { highP[0].grams -= 15; changed = true; }
      continue;
    }
    /* 7. 碳水化合物供能比超限 */
    if (r.carb > CARB_RATIO[1]) {
      const staple = items
        .filter(i => i.role === "staple" && i.grams - 20 >= MIN_GRAMS[i.role])
        .sort((a, b) => foodOf(b.food_id).per100g.carb - foodOf(a.food_id).per100g.carb);
      if (staple.length) { staple[0].grams -= 20; changed = true; }
      continue;
    }
    /* 8. 碳水化合物供能比过低 */
    if (r.carb < CARB_RATIO[0]) {
      const staple = items.filter(i => i.role === "staple" && i.grams < 450);
      if (staple.length) { staple[0].grams += 25; changed = true; }
      continue;
    }
    /* 9. 预算超限：最贵项优先替换为同类更便宜食材，无替代再压缩克重 */
    if (budget != null && t.cost > budget) {
      const used = new Set(items.map(i => i.food_id));
      const costly = items
        .map((it, idx) => ({ it, idx }))
        .filter(x => x.it.grams >= MIN_GRAMS[x.it.role])
        .sort((a, b) => costFor(foodOf(b.it.food_id), b.it.grams) - costFor(foodOf(a.it.food_id), a.it.grams));
      if (costly.length) {
        const x = costly[0];
        const f = foodOf(x.it.food_id);
        const alternates = FOODS.filter(c =>
          c.cost < f.cost &&
          (!x.it.pool || x.it.pool.includes(c.id)) &&
          !used.has(c.id) &&
          !c.allergens.some(a => allergenSet.has(a)) &&
          !excludeSet.has(c.id) &&
          (!c.weekly_limit || (params.weekly_used || {})[c.id] < c.weekly_limit)
        ).sort((a, b) => b.cost - a.cost);
        if (alternates.length) {
          const alt = alternates[0];
          used.delete(x.it.food_id);
          x.it.food_id = alt.id;
          x.it.name = alt.name;
          used.add(alt.id);
          changed = true;
        } else if (x.it.grams - 10 >= MIN_GRAMS[x.it.role]) {
          x.it.grams -= 10;
          changed = true;
        }
      }
      continue;
    }
  }
  return items;
}

function adequacyOf(totals, req) {
  const map = [
    ["kcal", totals.kcal, req.kcal],
    ["protein", totals.protein, req.protein],
    ["fiber", totals.fiber, req.fiber],
    ["calcium", totals.calcium, req.calcium],
    ["iron", totals.iron, req.iron],
    ["vitA", totals.vitA, req.vitA],
    ["vitC", totals.vitC, req.vitC],
    ["vitD", totals.vitD, req.vitD],
    ["potassium", totals.potassium, req.potassium],
  ];
  const out = {};
  for (const [k, v, target] of map) {
    out[k] = { value: round1(v), target, pct: Math.round((v / target) * 100) };
  }
  out.sodium = { value: round1(totals.sodium), max: req.sodium_max, pct: Math.round((totals.sodium / req.sodium_max) * 100) };
  return out;
}

function planDay(params) {
  const req = getRequirement(params.profile);
  const budget = params.budget == null ? null : Number(params.budget);
  const items = buildItems(params, req);

  const poolCount = FOODS.filter(f =>
    !f.allergens.some(a => params.allergens.includes(a)) &&
    !(params.exclude || []).includes(f.id)
  ).length;
  if (poolCount === 0) {
    return { feasible: false, reason: "可用食材为空：过敏原与排除项覆盖全部食材", items: [], totals: null, adequacy: null };
  }
  if (items.length < 10) {
    return { feasible: false, reason: "可用食材过少，无法构成完整三餐", items: [], totals: null, adequacy: null };
  }

  adjust(items, req, budget, params);

  const totals = totalOf(items);
  const r = ratios(totals);
  const low = req.kcal * (1 - KCAL_TOL);
  const high = req.kcal * (1 + KCAL_TOL);
  const kcalOk = totals.kcal >= low && totals.kcal <= high;
  const fatOk = r.fat >= FAT_RATIO[0] && r.fat <= FAT_RATIO[1];
  const proteinOk = r.protein >= PROTEIN_RATIO[0] && r.protein <= PROTEIN_RATIO[1];
  const budgetOk = budget == null || totals.cost <= budget * 1.02;

  const output = {
    feasible: kcalOk && fatOk && proteinOk && budgetOk,
    reasons: [],
    items: items.map(it => {
      const f = getFood(it.food_id);
      return {
        meal: it.meal, meal_label: MEAL_LABEL[it.meal], role: it.role,
        food_id: it.food_id, name: it.name, grams: it.grams,
        cost: round1(costFor(f, it.grams)),
      };
    }),
    totals: roundTotals(totals),
    ratios: { fat: r.fat, protein: r.protein, carb: r.carb },
    adequacy: adequacyOf(totals, req),
  };
  if (!kcalOk) output.reasons.push("热量未落在目标区间");
  if (!fatOk) output.reasons.push("脂肪供能比偏离 20%-30% 区间");
  if (!proteinOk) output.reasons.push("蛋白质供能比偏离 10%-20% 区间");
  if (!budgetOk) output.reasons.push("预算超限");
  return output;
}

function roundTotals(t) {
  const out = { cost: round1(t.cost) };
  for (const k of NUTRIENT_ORDER) out[k] = round1(t[k]);
  return out;
}

module.exports = { planDay, ratios, totalOf, adequacyOf, MEALS, MEAL_LABEL, K };
