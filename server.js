require("dotenv").config();

const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const bcrypt = require("bcryptjs");
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const TOKEN_TTL = "1h";
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const categories = ["Notice", "Event", "Exam", "Result", "Download"];
const frontendOrigins = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const noticeSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    category: { type: String, required: true, enum: categories },
    description: { type: String, required: true, trim: true, maxlength: 10000 },
    fileUrl: { type: String, trim: true, maxlength: 2048 },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
    createdAt: { type: Date, default: Date.now }
  },
  { versionKey: false }
);
noticeSchema.index({ category: 1, createdAt: -1 });

const adminSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    sessionVersion: { type: Number, default: 0 },
    resetTokenHash: { type: String, select: false },
    resetTokenExpiresAt: { type: Date, select: false }
  },
  { versionKey: false }
);

const Notice = mongoose.model("Notice", noticeSchema);
const Admin = mongoose.model("Admin", adminSchema);

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    },
    referrerPolicy: { policy: "no-referrer" }
  })
);
app.use((req, res, next) => {
  const origin = req.get("Origin");
  const sameOrigin = origin && origin === `${req.protocol}://${req.get("host")}`;
  if (origin && !sameOrigin && !frontendOrigins.includes(origin)) {
    res.status(403).json({ error: "This origin is not allowed to access the API." });
    return;
  }
  if (origin) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false, limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({ status: connected ? "ok" : "unavailable" });
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function createToken(admin) {
  return jwt.sign(
    { sub: admin.id, username: admin.username, ver: admin.sessionVersion || 0 },
    process.env.JWT_SECRET,
    {
      expiresIn: TOKEN_TTL
    }
  );
}

const requireAdmin = asyncRoute(async (req, res, next) => {
  const authorization = req.get("Authorization") || "";
  const match = authorization.match(/^Bearer ([^\s]+)$/);
  const token = match?.[1];
  if (!token) {
    res.status(401).json({ error: "Admin sign-in required." });
    return;
  }

  let claims;
  try {
    claims = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    res.status(401).json({ error: "Your admin session has expired. Please sign in again." });
    return;
  }

  const admin = await Admin.findById(claims.sub);
  if (!admin || admin.username !== claims.username || admin.sessionVersion !== claims.ver) {
    res.status(401).json({ error: "Your admin session has expired. Please sign in again." });
    return;
  }
  req.admin = { sub: admin.id, username: admin.username };
  next();
});

function noticePayload(body) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const category = typeof body.category === "string" ? body.category : "";
  const rawFileUrl = typeof body.fileUrl === "string" ? body.fileUrl.trim() : "";

  if (!title || title.length > 160) throw new HttpError(400, "Title is required and must be 160 characters or fewer.");
  if (!description || description.length > 10000) {
    throw new HttpError(400, "Description is required and must be 10,000 characters or fewer.");
  }
  if (!categories.includes(category)) throw new HttpError(400, "Choose a valid notice category.");

  let fileUrl;
  if (rawFileUrl) {
    if (rawFileUrl.length > 2048) throw new HttpError(400, "PDF link must be 2,048 characters or fewer.");
    let parsedUrl;
    try {
      parsedUrl = new URL(rawFileUrl);
    } catch {
      throw new HttpError(400, "Enter a valid public PDF link.");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      throw new HttpError(400, "PDF link must be a public HTTP or HTTPS URL.");
    }
    fileUrl = parsedUrl.href;
  }

  return { title, description, category, fileUrl };
}

function safeNotice(notice) {
  const { _id, title, description, category, fileUrl, postedBy, createdAt } = notice;
  return {
    id: String(_id),
    title,
    description,
    category,
    fileUrl: fileUrl || null,
    postedBy: postedBy ? String(postedBy) : null,
    createdAt,
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

app.get(
  "/api/notices",
  asyncRoute(async (req, res) => {
    const filter = {};
    if (req.query.category && req.query.category !== "All") {
      if (!categories.includes(req.query.category)) throw new HttpError(400, "Choose a valid notice category.");
      filter.category = req.query.category;
    }
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (search.length > 100) throw new HttpError(400, "Search must be 100 characters or fewer.");
    if (search) {
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchPattern = new RegExp(escapedSearch, "i");
      filter.$or = [{ title: searchPattern }, { description: searchPattern }];
    }

    const sortOrder = req.query.sort === "oldest" ? 1 : -1;
    if (req.query.sort && !["newest", "oldest"].includes(req.query.sort)) {
      throw new HttpError(400, "Choose newest or oldest sorting.");
    }
    const notices = await Notice.find(filter).sort({ createdAt: sortOrder }).lean();
    res.json(notices.map(safeNotice));
  })
);

app.get(
  "/api/notices/:id",
  asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, "Notice not found.");
    const notice = await Notice.findById(req.params.id).lean();
    if (!notice) throw new HttpError(404, "Notice not found.");
    res.json(safeNotice(notice));
  })
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Try again in 15 minutes." }
});

const recoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many recovery attempts. Please wait 15 minutes and try again." }
});

app.use("/api/admin", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.post(
  "/api/admin/login",
  loginLimiter,
  asyncRoute(async (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== "string" || typeof password !== "string" || password.length > 128) {
      throw new HttpError(400, "Enter your username and password.");
    }

    const admin = await Admin.findOne({ username });
    const passwordMatches = await bcrypt.compare(password, admin?.password || process.env.ADMIN_PASSWORD_HASH);
    if (!admin || !passwordMatches) {
      throw new HttpError(401, "Incorrect username or password.");
    }

    res.json({ username: admin.username, token: createToken(admin) });
  })
);

app.post(
  "/api/admin/forgot-password",
  recoveryLimiter,
  asyncRoute(async (req, res) => {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpError(400, "Enter a valid email address.");
    }
    if (!isEmailRecoveryConfigured()) {
      throw new HttpError(503, "Password recovery is not configured. Contact the website administrator.");
    }

    const responseMessage = "If the address matches the admin account, a password reset link will be sent.";
    const admin = await Admin.findOne({ username: process.env.ADMIN_USERNAME });
    if (admin && email === process.env.ADMIN_EMAIL.trim().toLowerCase()) {
      const resetToken = randomBytes(32).toString("hex");
      admin.resetTokenHash = hashResetToken(resetToken);
      admin.resetTokenExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      await admin.save();

      const resetUrl = new URL(process.env.FRONTEND_URL);
      resetUrl.searchParams.set("resetToken", resetToken);
      try {
        await mailer.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: process.env.ADMIN_EMAIL,
          subject: "Reset your NoticeHub admin password",
          text: `Use this one-time link to reset your NoticeHub password. It expires in 30 minutes:\n\n${resetUrl.href}\n\nIf you did not request this, you can ignore this email.`,
          html: `<p>Use this one-time link to reset your NoticeHub password. It expires in 30 minutes.</p><p><a href="${resetUrl.href.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">Reset admin password</a></p><p>If you did not request this, you can ignore this email.</p>`
        });
      } catch (error) {
        await Admin.updateOne(
          { _id: admin.id, resetTokenHash: hashResetToken(resetToken) },
          { $unset: { resetTokenHash: 1, resetTokenExpiresAt: 1 } }
        );
        console.error("Could not send admin password recovery email:", error.message);
      }
    }

    res.status(202).json({ message: responseMessage });
  })
);

app.post(
  "/api/admin/reset-password",
  recoveryLimiter,
  asyncRoute(async (req, res) => {
    const { token, password } = req.body;
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
      throw new HttpError(400, "This password reset link is invalid or has expired.");
    }
    if (
      typeof password !== "string" ||
      Array.from(password).length < 12 ||
      Buffer.byteLength(password, "utf8") > 72
    ) {
      throw new HttpError(400, "Use a password with at least 12 characters and no more than 72 UTF-8 bytes.");
    }

    const resetTokenHash = hashResetToken(token);
    const admin = await Admin.findOne({
      username: process.env.ADMIN_USERNAME,
      resetTokenHash,
      resetTokenExpiresAt: { $gt: new Date() }
    }).select("_id");
    if (!admin) throw new HttpError(400, "This password reset link is invalid or has expired.");

    const newPasswordHash = await bcrypt.hash(password, 12);
    const result = await Admin.updateOne({
      _id: admin.id,
      resetTokenHash,
      resetTokenExpiresAt: { $gt: new Date() }
    }, {
      $set: { password: newPasswordHash },
      $unset: { resetTokenHash: 1, resetTokenExpiresAt: 1 },
      $inc: { sessionVersion: 1 }
    });
    if (result.modifiedCount !== 1) throw new HttpError(400, "This password reset link is invalid or has expired.");
    res.json({ message: "Password updated. Sign in with your new password." });
  })
);

app.get(
  "/api/admin/session",
  requireAdmin,
  (req, res) => res.json({ username: req.admin.username })
);

app.post(
  "/api/admin/logout",
  requireAdmin,
  asyncRoute(async (req, res) => {
    await Admin.updateOne({ _id: req.admin.sub }, { $inc: { sessionVersion: 1 } });
    res.status(204).end();
  })
);

function hashResetToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function isEmailRecoveryConfigured() {
  return Boolean(
    process.env.ADMIN_EMAIL &&
    process.env.FRONTEND_URL &&
    process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );
}

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === "true",
  requireTLS: process.env.SMTP_SECURE !== "true",
  auth: process.env.SMTP_USER && process.env.SMTP_PASS
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined
});

app.post(
  "/api/notices",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const notice = new Notice({
      ...noticePayload(req.body),
      postedBy: req.admin.sub
    });
    await notice.save();
    res.status(201).json(safeNotice(notice));
  })
);

app.put(
  "/api/notices/:id",
  requireAdmin,
  asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, "Notice not found.");
    const notice = await Notice.findById(req.params.id);
    if (!notice) throw new HttpError(404, "Notice not found.");

    Object.assign(notice, noticePayload(req.body));
    await notice.save();
    res.json(safeNotice(notice));
  })
);

app.delete(
  "/api/notices/:id",
  requireAdmin,
  asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, "Notice not found.");
    const result = await Notice.findByIdAndDelete(req.params.id);
    if (!result) throw new HttpError(404, "Notice not found.");
    res.status(204).end();
  })
);

app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));

app.use((error, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

async function start() {
  const { MONGODB_URI, JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD_HASH } = process.env;
  if (!MONGODB_URI || !JWT_SECRET || !ADMIN_USERNAME || !ADMIN_PASSWORD_HASH) {
    throw new Error("Set MONGODB_URI, JWT_SECRET, ADMIN_USERNAME, and ADMIN_PASSWORD_HASH in .env.");
  }
  if (JWT_SECRET.length < 32) throw new Error("JWT_SECRET must be at least 32 characters long.");
  if (!/^\$2[aby]\$\d\d\$/.test(ADMIN_PASSWORD_HASH)) {
    throw new Error("ADMIN_PASSWORD_HASH must be a bcrypt hash. Generate one with npm run hash-password.");
  }
  if (process.env.NODE_ENV === "production" && !isEmailRecoveryConfigured()) {
    throw new Error("Configure ADMIN_EMAIL, FRONTEND_URL, SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS for password recovery.");
  }
  if (process.env.FRONTEND_URL) {
    const frontendUrl = new URL(process.env.FRONTEND_URL);
    if (!["http:", "https:"].includes(frontendUrl.protocol) || frontendUrl.username || frontendUrl.password) {
      throw new Error("FRONTEND_URL must be an HTTP or HTTPS URL without embedded credentials.");
    }
    if (process.env.NODE_ENV === "production" && frontendUrl.protocol !== "https:") {
      throw new Error("FRONTEND_URL must use HTTPS in production.");
    }
    if (process.env.NODE_ENV === "production" && !frontendOrigins.includes(frontendUrl.origin)) {
      throw new Error("FRONTEND_ORIGINS must include the exact origin from FRONTEND_URL.");
    }
  }
  if (process.env.SMTP_PORT && (!Number.isInteger(Number(process.env.SMTP_PORT)) ||
      Number(process.env.SMTP_PORT) < 1 || Number(process.env.SMTP_PORT) > 65535)) {
    throw new Error("SMTP_PORT must be a valid port number.");
  }
  if (process.env.SMTP_SECURE && !["true", "false"].includes(process.env.SMTP_SECURE)) {
    throw new Error("SMTP_SECURE must be true or false.");
  }
  if (process.env.ADMIN_EMAIL && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.ADMIN_EMAIL.trim())) {
    throw new Error("ADMIN_EMAIL must be a valid email address.");
  }

  await mongoose.connect(MONGODB_URI);
  const existingAdmin = await Admin.findOne({ username: ADMIN_USERNAME });
  if (!existingAdmin) {
    await Admin.create({
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD_HASH,
      sessionVersion: 0
    });
  }
  app.listen(PORT, () => console.log(`NoticeHub is running at http://localhost:${PORT}`));
}

start().catch((error) => {
  console.error("NoticeHub could not start:", error.message);
  process.exitCode = 1;
});
