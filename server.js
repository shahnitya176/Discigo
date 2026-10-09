// DiScigo server - run with: node server.js
const express = require("express");
const session = require("express-session");
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === "production";

// Warn if default secret is used in production
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-key-change-me";
if (isProd && SESSION_SECRET === "dev-secret-key-change-me") {
  console.warn("WARNING: You must set a secure SESSION_SECRET in production!");
}

/* ---------------- DATABASE ---------------- */
const db = new DatabaseSync(path.join(__dirname, "discigo.db"));

db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL UNIQUE,
    password    TEXT NOT NULL,
    daily_goal  REAL DEFAULT 4,
    avatar      TEXT
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL,
    name     TEXT NOT NULL,
    hours    REAL DEFAULT 1,
    done     INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

/* ---------------- MIDDLEWARE ---------------- */
// Reduced payload limit (use multipart uploads if you need large files)
app.use(express.json({ limit: "500kb" }));
require("./admin-routes")(app, db); 
if (isProd) {
  app.set("trust proxy", 1); // Needed if running behind Nginx / Cloudflare
}

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd, // Only send over HTTPS in production
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      sameSite: "lax",
    },
  })
);

// Prevent caching for API responses
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Auth Guard
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }
  next();
}

app.get("/api/version", (req, res) => {
  res.json({ server: "v3", ok: true });
});

/* ---------------- AUTH ---------------- */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post("/api/signup", async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const email = (req.body.email || "").trim().toLowerCase();
    const password = req.body.password || "";
    const rawGoal = parseFloat(req.body.goal);
    const goal = Number.isFinite(rawGoal) && rawGoal >= 0 ? rawGoal : 4;

    if (!name || !email || !password) {
      return res.status(400).json({ error: "All fields are required" });
    }
    if (name.length > 50) {
      return res.status(400).json({ error: "Name must be 50 characters or fewer" });
    }
    if (!EMAIL_REGEX.test(email) || email.length > 100) {
      return res.status(400).json({ error: "Invalid email address format" });
    }
    if (password.length < 6 || password.length > 100) {
      return res.status(400).json({ error: "Password must be between 6 and 100 characters" });
    }

    const hash = await bcrypt.hash(password, 10);

    const result = db
      .prepare("INSERT INTO users (name, email, password, daily_goal) VALUES (?, ?, ?, ?)")
      .run(name, email, hash, goal);

    // Regenerate session ID to prevent session fixation
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: "Session creation error" });
      req.session.userId = Number(result.lastInsertRowid);
      res.json({ ok: true });
    });
  } catch (err) {
    if (
      err.code === "SQLITE_CONSTRAINT_UNIQUE" ||
      err.code === "SQLITE_CONSTRAINT" ||
      (err.message && err.message.includes("UNIQUE constraint failed"))
    ) {
      return res.status(400).json({ error: "Email already registered" });
    }
    console.error("Signup error:", err);
    res.status(500).json({ error: "Server error during registration" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const password = req.body.password || "";

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    // Regenerate session to protect against session fixation attacks
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: "Session creation error" });
      req.session.userId = user.id;
      res.json({ ok: true });
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error during login" });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    res.clearCookie("connect.sid"); // Clean up browser cookie
    res.json({ ok: true });
  });
});

/* ---------------- PROFILE ---------------- */
app.get("/api/me", requireLogin, (req, res) => {
  const me = db
    .prepare("SELECT id, name, email, daily_goal, avatar FROM users WHERE id = ?")
    .get(req.session.userId);

  if (!me) return res.status(401).json({ error: "Not logged in" });
  res.json(me);
});

app.patch("/api/avatar", requireLogin, (req, res) => {
  const avatar = typeof req.body.avatar === "string" ? req.body.avatar : null;
  // Limit avatar string to ~150KB to prevent database bloat
  if (avatar && avatar.length > 200000) {
    return res.status(400).json({ error: "Avatar image is too large (max 150KB)" });
  }
  db.prepare("UPDATE users SET avatar = ? WHERE id = ?").run(avatar, req.session.userId);
  res.json({ ok: true });
});

app.patch("/api/goal", requireLogin, (req, res) => {
  const rawGoal = parseFloat(req.body.goal);
  const goal = Number.isFinite(rawGoal) && rawGoal >= 0 ? rawGoal : 0;
  db.prepare("UPDATE users SET daily_goal = ? WHERE id = ?").run(goal, req.session.userId);
  res.json({ ok: true });
});

/* ---------------- TASKS ---------------- */
app.get("/api/tasks", requireLogin, (req, res) => {
  const rows = db
    .prepare("SELECT id, name, hours, done FROM tasks WHERE user_id = ? ORDER BY id")
    .all(req.session.userId);
  res.json(rows);
});

app.post("/api/tasks", requireLogin, (req, res) => {
  const name = (req.body.name || "").trim();
  const rawHours = parseFloat(req.body.hours);
  const hours = Number.isFinite(rawHours) && rawHours >= 0.1 ? Math.min(rawHours, 24) : 1;

  if (!name) return res.status(400).json({ error: "Task name required" });
  if (name.length > 200) return res.status(400).json({ error: "Task name too long (max 200 chars)" });

  const info = db
    .prepare("INSERT INTO tasks (user_id, name, hours) VALUES (?, ?, ?)")
    .run(req.session.userId, name, hours);

  res.json({ id: Number(info.lastInsertRowid), name, hours, done: 0 });
});

// Clear finished tasks (must precede :id route)
app.delete("/api/tasks", requireLogin, (req, res) => {
  const info = db
    .prepare("DELETE FROM tasks WHERE done = 1 AND user_id = ?")
    .run(req.session.userId);
  res.json({ ok: true, deleted: info.changes });
});

app.patch("/api/tasks/:id", requireLogin, (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  if (isNaN(taskId)) return res.status(400).json({ error: "Invalid task ID" });

  db.prepare("UPDATE tasks SET done = ? WHERE id = ? AND user_id = ?").run(
    req.body.done ? 1 : 0,
    taskId,
    req.session.userId
  );

  res.json({ ok: true });
});

app.delete("/api/tasks/:id", requireLogin, (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  if (isNaN(taskId)) return res.status(400).json({ error: "Invalid task ID" });

  const info = db
    .prepare("DELETE FROM tasks WHERE id = ? AND user_id = ?")
    .run(taskId, req.session.userId);

  res.json({ ok: true, deleted: info.changes });
});

/* ---------------- STATIC FILES ---------------- */
const publicDir = path.join(__dirname, "public");
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

app.use(express.static(publicDir));
app.get("/", (req, res) => {
  const homeFile = path.join(publicDir, "home.html");
  if (fs.existsSync(homeFile)) {
    res.sendFile(homeFile);
  } else {
    res.send("DiScigo API is running. Place home.html in public/ directory.");
  }
});

/* ---------------- CLEAN SHUTDOWN ---------------- */
process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`DiScigo running at http://localhost:${PORT}`);
});