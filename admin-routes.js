const crypto = require("crypto");

const CONFIG = {
  adminEmail: process.env.ADMIN_EMAIL || "admin@discigo.com",
  adminPassword: process.env.ADMIN_PASSWORD || "change-me-now",
  users: "users",
  tasks: "tasks",
};

module.exports = function (app, db) {
  const sessions = new Map();
  const TTL = 2 * 60 * 60 * 1000;

  // ---- find which columns really exist in your database ----
  const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  const userCols = columns(CONFIG.users);
  const taskCols = columns(CONFIG.tasks);
  const pick = (cols, names) => names.find(n => cols.includes(n)) || null;

  const taskUserId = pick(taskCols, ["user_id", "userId", "owner_id", "uid"]);
  const createdCol = pick(userCols, ["created_at", "createdAt", "joined_at", "date"]);
  const userField = name => (userCols.includes(name) ? `u.${name}` : "NULL");

  console.log("Admin panel: users columns =", userCols.join(", "));
  console.log("Admin panel: tasks columns =", taskCols.join(", "));

  const safeEqual = (a, b) => {
    const x = crypto.createHash("sha256").update(String(a)).digest();
    const y = crypto.createHash("sha256").update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
  };

  const getToken = req => {
    const m = (req.headers.cookie || "").match(/(?:^|;\s*)admin_token=([a-f0-9]+)/);
    return m && m[1];
  };

  function requireAdmin(req, res, next) {
    const t = getToken(req);
    const exp = t && sessions.get(t);
    if (!exp || exp < Date.now()) return res.status(401).json({ error: "Admin sign in required" });
    next();
  }

  app.post("/api/admin/login", (req, res) => {
    const { email, password } = req.body || {};
    if (!safeEqual(email || "", CONFIG.adminEmail) | !safeEqual(password || "", CONFIG.adminPassword)) {
      return res.status(401).json({ error: "Wrong admin email or password" });
    }
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + TTL);
    res.setHeader("Set-Cookie", `admin_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL / 1000}`);
    res.json({ ok: true });
  });

  app.post("/api/admin/logout", (req, res) => {
    sessions.delete(getToken(req));
    res.setHeader("Set-Cookie", "admin_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    res.json({ ok: true });
  });

  app.get("/api/admin/stats", requireAdmin, (req, res) => {
    const U = CONFIG.users, T = CONFIG.tasks;
    const users = db.prepare(`SELECT COUNT(*) AS n FROM ${U}`).get().n;
    const tasks = db.prepare(`SELECT COUNT(*) AS n FROM ${T}`).get().n;
    const done = taskCols.includes("done")
      ? db.prepare(`SELECT COUNT(*) AS n FROM ${T} WHERE done = 1`).get().n
      : 0;

    let newThisWeek = 0, signups = [];
    if (createdCol) {
      const C = createdCol;
      const rows = db.prepare(`SELECT date(${C}) AS d, COUNT(*) AS n FROM ${U} WHERE ${C} IS NOT NULL GROUP BY date(${C})`).all();
      const byDay = Object.fromEntries(rows.map(r => [r.d, r.n]));
      for (let i = 13; i >= 0; i--) {
        const date = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
        signups.push({ date, count: byDay[date] || 0 });
        if (i < 7) newThisWeek += byDay[date] || 0;
      }
    }
    res.json({ users, tasks, done, newThisWeek, signups });
  });

  app.get("/api/admin/users", requireAdmin, (req, res) => {
    const U = CONFIG.users, T = CONFIG.tasks;
    const taskCount = taskUserId ? `(SELECT COUNT(*) FROM ${T} t WHERE t.${taskUserId} = u.id)` : "0";
    const doneCount = taskUserId && taskCols.includes("done")
      ? `(SELECT COUNT(*) FROM ${T} t WHERE t.${taskUserId} = u.id AND t.done = 1)` : "0";
    const rows = db.prepare(`
      SELECT u.id, ${userField("name")} AS name, ${userField("email")} AS email,
             ${userField("gender")} AS gender, ${userField("goal")} AS goal,
             ${userField("avatar")} AS avatar, ${createdCol ? "u." + createdCol : "NULL"} AS createdAt,
             ${taskCount} AS taskCount, ${doneCount} AS doneCount
      FROM ${U} u ORDER BY u.id DESC`).all();
    res.json(rows);
  });

  app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const remove = db.transaction(() => {
      if (taskUserId) db.prepare(`DELETE FROM ${CONFIG.tasks} WHERE ${taskUserId} = ?`).run(id);
      return db.prepare(`DELETE FROM ${CONFIG.users} WHERE id = ?`).run(id);
    });
    const r = remove();
    if (!r.changes) return res.status(404).json({ error: "User not found" });
    res.json({ ok: true });
  });

  app.get("/api/admin/tasks", requireAdmin, (req, res) => {
    const T = CONFIG.tasks, U = CONFIG.users;
    const join = taskUserId ? `LEFT JOIN ${U} u ON u.id = t.${taskUserId}` : "";
    const userName = taskUserId ? "u.name" : "NULL";
    const field = n => (taskCols.includes(n) ? `t.${n}` : "NULL");
    const rows = db.prepare(`
      SELECT t.id, ${field("name")} AS name, ${field("hours")} AS hours,
             ${field("done")} AS done, ${userName} AS userName
      FROM ${T} t ${join} ORDER BY t.id DESC`).all();
    res.json(rows);
  });

  app.delete("/api/admin/tasks/:id", requireAdmin, (req, res) => {
    const r = db.prepare(`DELETE FROM ${CONFIG.tasks} WHERE id = ?`).run(Number(req.params.id));
    if (!r.changes) return res.status(404).json({ error: "Task not found" });
    res.json({ ok: true });
  });
};