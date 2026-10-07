"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const foodsMod = require("./engine/foods");
const { getRequirement, PROFILE_KEYS, ACTIVITY_KEYS, GOAL_KEYS } = require("./engine/requirements");
const { planDay } = require("./engine/constraints");
const { weekPlan, DAY_NAMES } = require("./engine/menu");

const arg = process.argv.find(a => a.startsWith("--port="));
const PORT = arg ? parseInt(arg.slice(7), 10) : parseInt(process.env.PORT || "8074", 10);
const WEB = path.join(__dirname, "web");
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
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`nutrition-planner running at http://127.0.0.1:${PORT}`);
});
