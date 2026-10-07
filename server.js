"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const foodsMod = require("./engine/foods");
const { getRequirement, PROFILE_KEYS, ACTIVITY_KEYS, GOAL_KEYS } = require("./engine/requirements");
const { planDay } = require("./engine/constraints");
const { weekPlan, DAY_NAMES } = require("./engine/menu");
const household = require("./engine/household");

const arg = process.argv.find(a => a.startsWith("--port="));
const PORT = arg ? parseInt(arg.slice(7), 10) : parseInt(process.env.PORT || "8074", 10);
const WEB = path.join(__dirname, "web");

/* ---------- 家庭采购库存状态持久化（单家庭实例，data/ 已在 .gitignore） ---------- */
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "household.json");

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const obj = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      const base = household.emptyHousehold();
      const merged = Object.assign(base, obj);
      if (!Number.isInteger(merged.next_member_id)) merged.next_member_id = 1;
      return merged;
    }
  } catch (e) {
    console.error("家庭状态文件损坏，已重置：", e.message);
  }
  return household.emptyHousehold();
}

let state = loadState();
let saveTimer = null;
function saveState() {
  /* 合并高频写入，落盘失败不阻断操作 */
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error("家庭状态保存失败：", e.message);
    }
  }, 120);
}

function hh(body) {
  saveState();
  return household.householdView(state);
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => {
      buf += c;
      if (buf.length > 2e6) req.destroy();
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
}

function sanitizeProfile(profile) {
  const p = profile || {};
  if (!PROFILE_KEYS[p.age_group]) p.age_group = "adult_m";
  if (!ACTIVITY_KEYS[p.activity]) p.activity = "moderate";
  if (!GOAL_KEYS[p.goal]) p.goal = "maintain";
  return p;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (p === "/api/system" && req.method === "GET") {
      return json(res, 200, { name: "nutrition-planner", version: 1, title: "家庭营养膳食规划系统" });
    }
    if (p === "/api/meta" && req.method === "GET") {
      return json(res, 200, {
        profiles: PROFILE_KEYS,
        activities: ACTIVITY_KEYS,
        goals: GOAL_KEYS,
        allergens: foodsMod.ALLERGENS,
        categories: foodsMod.CATEGORY_LABEL,
        units: foodsMod.NUTRIENT_UNIT,
        nutrient_labels: foodsMod.NUTRIENT_LABEL,
        nutrient_order: foodsMod.NUTRIENT_ORDER,
      });
    }
    if (p === "/api/foods" && req.method === "GET") {
      return json(res, 200, { foods: foodsMod.listFoods() });
    }
    if (p === "/api/plan" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const profile = sanitizeProfile(body.profile);
      const params = {
        profile,
        budget: body.budget,
        allergens: body.allergens || [],
        exclude: body.exclude || [],
        weekly_used: body.weekly_used || {},
      };
      /* 库存联动：在库食材优先、零边际采购成本 */
      if (body.stock && typeof body.stock === "object") params.stock = body.stock;
      const r = planDay(params);
      return json(res, 200, { ...r, requirement: getRequirement(profile), units: foodsMod.NUTRIENT_UNIT });
    }
    if (p === "/api/week" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const profile = sanitizeProfile(body.profile);
      const params = {
        profile,
        budget: body.budget,
        allergens: body.allergens || [],
        exclude: body.exclude || [],
        liver: body.liver,
      };
      if (body.weekly_used && typeof body.weekly_used === "object") params.weekly_used = body.weekly_used;
      if (body.stock && typeof body.stock === "object") params.stock = body.stock;
      const r = weekPlan(params);
      return json(res, 200, {
        ...r,
        day_names: DAY_NAMES,
        requirement: getRequirement(profile),
        units: foodsMod.NUTRIENT_UNIT,
        nutrient_labels: foodsMod.NUTRIENT_LABEL,
        nutrient_order: foodsMod.NUTRIENT_ORDER,
      });
    }

    /* ---------- 家庭采购与库存 ---------- */
    if (p === "/api/household" && req.method === "GET") {
      return json(res, 200, household.householdView(state));
    }
    if (p === "/api/household/budget" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const b = Number(body.weekly_budget);
      if (!(isFinite(b) && b >= 0)) return json(res, 400, { error: "周预算非法" });
      state.weekly_budget = Math.round(b * 100) / 100;
      return json(res, 200, hh());
    }
    if (p === "/api/household/members" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      household.addMember(state, body);
      return json(res, 200, hh());
    }
    let mm;
    if ((mm = p.match(/^\/api\/household\/members\/(\d+)$/)) && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      household.updateMember(state, Number(mm[1]), body);
      return json(res, 200, hh());
    }
    if ((mm = p.match(/^\/api\/household\/members\/(\d+)$/)) && req.method === "DELETE") {
      household.removeMember(state, Number(mm[1]));
      return json(res, 200, hh());
    }
    /* 依据周菜单生成 / 刷新采购清单并联动全家过敏原 */
    if (p === "/api/household/shopping/build" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const profile = sanitizeProfile(body.profile);
      const params = {
        profile,
        budget: body.budget,
        allergens: household.familyAllergens(state.members),
        exclude: body.exclude || [],
      };
      const sync = household.syncInputs(state);
      if (body.use_stock !== false) {
        params.stock = sync.stock;
        params.weekly_used = sync.weekly_used;
      }
      const plan = weekPlan(params);
      household.setWeek(state, params, plan);
      household.buildShoppingList(state, plan);
      return json(res, 200, { ...hh(), generated_week: plan });
    }
    if (p === "/api/household/shopping" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      household.addManualItem(state, body);
      return json(res, 200, hh());
    }
    if ((mm = p.match(/^\/api\/household\/shopping\/(\d+)\/assign$/)) && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      household.assignItem(state, Number(mm[1]), body.assignee == null ? null : Number(body.assignee));
      return json(res, 200, hh());
    }
    if ((mm = p.match(/^\/api\/household\/shopping\/(\d+)\/arrive$/)) && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      household.arriveItem(state, Number(mm[1]), body);
      return json(res, 200, hh());
    }
    if ((mm = p.match(/^\/api\/household\/shopping\/(\d+)$/)) && req.method === "DELETE") {
      household.removeItem(state, Number(mm[1]));
      return json(res, 200, hh());
    }
    /* 按配餐确认某天消耗（库存扣减 + 本周限次累计） */
    if ((mm = p.match(/^\/api\/household\/consume\/day\/(\d+)$/)) && req.method === "POST") {
      household.consumeDay(state, Number(mm[1]));
      return json(res, 200, hh());
    }
    if (p === "/api/household/consume" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      household.consume(state, body);
      return json(res, 200, hh());
    }
    if (p === "/api/household/stock" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      household.setManualStock(state, body.food_id, body.grams);
      return json(res, 200, hh());
    }
    if (p === "/api/household/cycle" && req.method === "POST") {
      household.startNewCycle(state);
      return json(res, 200, hh());
    }

    let f = p === "/" ? "/index.html" : p;
    const fp = path.normalize(path.join(WEB, f));
    if (!fp.startsWith(WEB)) return json(res, 403, { error: "forbidden" });
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ext = path.extname(fp).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      return fs.createReadStream(fp).pipe(res);
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof SyntaxError) return json(res, 400, { error: "请求体不是合法 JSON" });
    return json(res, 400, { error: e.message, code: e.code || null, deficits: e.deficits || null });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`nutrition-planner running at http://127.0.0.1:${PORT}`);
});
