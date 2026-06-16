const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const nodemailer = require("nodemailer");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "../public")));

// ── Upstash Redis (persistent storage) ───────────────────────────────────────
async function kv(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    // Fallback to in-memory for local dev
    return kvMemory(method, ...args);
  }
  const res = await axios.post(`${url}/${[method, ...args.map(a => typeof a === "object" ? JSON.stringify(a) : a)].join("/")}`,
    null, { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 });
  return res.data.result;
}

// In-memory fallback for local dev
const mem = {};
function kvMemory(method, key, value) {
  if (method === "get") return mem[key] ?? null;
  if (method === "set") { mem[key] = value; return "OK"; }
  if (method === "del") { delete mem[key]; return 1; }
  return null;
}

async function dbGet(key) {
  try {
    const val = await kv("get", key);
    if (!val) return null;
    return typeof val === "string" ? JSON.parse(val) : val;
  } catch { return null; }
}

async function dbSet(key, value) {
  try { await kv("set", key, JSON.stringify(value)); } catch (e) { console.error("dbSet error:", e.message); }
}

// ── Init defaults ─────────────────────────────────────────────────────────────
async function ensureDefaults() {
  const settings = await dbGet("settings");
  if (!settings) {
    await dbSet("settings", {
      alertsEnabled: true, lastScan: null,
      totalJobsFound: 0, totalAlertsSet: 0
    });
  }
  const recipients = await dbGet("recipients");
  if (!recipients) {
    await dbSet("recipients", [
      { id: "1", email: "zubairpnec@gmail.com", active: true, addedAt: new Date().toISOString() }
    ]);
  }
  const seen = await dbGet("seenJobs");
  if (!seen) await dbSet("seenJobs", {});
  const log = await dbGet("alertLog");
  if (!log) await dbSet("alertLog", []);
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const adminPass = process.env.ADMIN_PASSWORD || "admin123";
  const auth = req.headers["x-admin-password"] || req.query.pw;
  if (auth !== adminPass) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── Job filters ───────────────────────────────────────────────────────────────
const EXCLUDE_SENIORITY = [
  "consultant", "registrar", "senior", "sr.", "sr ",
  "director", "head of", "chief", "professor",
  "associate specialist", "specialty registrar", "locum consultant",
  "clinical director", "medical director",
  "st3", "st4", "st5", "st6", "st7", "st8"
];

const EXCLUDE_PROFESSIONS = [
  "dent", "dental", "dentist", "orthodont",
  "nurse", "nursing", "midwife", "midwifery",
  "health visitor", "district nurse", "practice nurse",
  "pharmacist", "pharmacy", "physiotherap", "radiograph",
  "occupational therapist", "speech", "dietitian", "podiatrist",
  "optometrist", "orthoptist", "paramedic", "ambulance",
  "biomedical scientist", "clinical scientist",
  "psychologist", "psychotherapist", "counsellor",
  "administrator", "receptionist", "porter", "cleaner",
  "manager", "coordinator", "secretary", "finance",
  "human resources", "it support", "engineer", "estates",
  "healthcare assistant", "hca", "support worker",
  "physician associate", "advanced nurse practitioner",
  "advanced clinical practitioner"
];

const INCLUDE_DOCTOR_GRADES = [
  "fy1", "fy2", "f1 ", "f2 ", "foundation year", "foundation doctor",
  "sho", "senior house officer",
  "ct1", "ct2", "ct3", "core trainee", "core medical", "core surgical",
  "gp trainee", "gpst", "gp st",
  "trust grade", "trust doctor", "clinical fellow",
  "junior clinical fellow", "house officer", "junior doctor",
  "locum sho", "locum fy", "st1", "st2",
  "staff grade doctor", "specialty doctor"
];

function shouldIncludeJob(title, grade) {
  const combined = `${title} ${grade || ""}`.toLowerCase();
  if (EXCLUDE_PROFESSIONS.some(kw => combined.includes(kw))) return false;
  if (EXCLUDE_SENIORITY.some(kw => combined.includes(kw))) return false;
  if (INCLUDE_DOCTOR_GRADES.some(kw => combined.includes(kw))) return true;
  if (combined.includes("doctor") || combined.includes("physician")) return true;
  return false;
}

// ── Scraper ───────────────────────────────────────────────────────────────────
const SEARCH_URL = "https://www.healthjobsuk.com/job_list?JobSearch_q=&JobSearch_d=&JobSearch_g=&JobSearch_re=_POST&JobSearch_re_0=1&JobSearch_re_1=1-_-_-&JobSearch_re_2=1-_-_--_-_-&JobSearch_Submit=Search&_tr=JobSearch&_ts=716";

async function scrapeJobs() {
  try {
    const { data } = await axios.get(SEARCH_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.5",
        "Cache-Control": "no-cache"
      },
      timeout: 20000
    });

    const $ = cheerio.load(data);
    const jobs = [];

    $(".job, .vacancy, article.job-result, .search-result-item, [class*='job-listing'], [class*='vacancy-item']").each((i, el) => {
      const $el = $(el);
      const titleEl = $el.find("h2, h3, .job-title, .vacancy-title, a[href*='/job/'], a[href*='/vacancy/']").first();
      const title = titleEl.text().trim();
      const href = titleEl.attr("href") || $el.find("a").first().attr("href") || "";
      const employer = $el.find(".employer, .trust, .organisation, [class*='employer']").first().text().trim();
      const location = $el.find(".location, [class*='location']").first().text().trim();
      const grade = $el.find(".grade, .band, [class*='grade'], [class*='band']").first().text().trim();
      const closing = $el.find(".closing, .deadline, [class*='closing'], [class*='date']").first().text().trim();
      const jobId = href.match(/\/(\d+)/)?.[1] || `${title}-${employer}`.replace(/\s+/g, "-").toLowerCase().substring(0, 80);
      if (title && jobId) jobs.push({ id: jobId, title, employer, location, grade, closing, url: href.startsWith("http") ? href : `https://www.healthjobsuk.com${href}` });
    });

    if (jobs.length === 0) {
      $("a[href*='/job/'], a[href*='/vacancy/'], a[href*='job_view']").each((i, el) => {
        const title = $(el).text().trim();
        const href = $(el).attr("href") || "";
        const jobId = href.match(/[?&](?:id|job_id|JobID)=(\d+)/)?.[1] || href.match(/\/(\d+)/)?.[1];
        if (title && title.length > 5 && jobId)
          jobs.push({ id: jobId, title, employer: "", location: "", grade: "", closing: "", url: href.startsWith("http") ? href : `https://www.healthjobsuk.com${href}` });
      });
    }

    if (jobs.length === 0) {
      $("table tr").each((i, el) => {
        if (i === 0) return;
        const cells = $(el).find("td");
        if (cells.length < 2) return;
        const link = cells.eq(0).find("a").first();
        const title = link.text().trim();
        const href = link.attr("href") || "";
        const jobId = href.match(/\d+/)?.[0] || `job-${i}`;
        if (title && title.length > 5)
          jobs.push({ id: jobId, title, employer: cells.eq(1).text().trim(), location: cells.eq(2)?.text().trim() || "", grade: cells.eq(3)?.text().trim() || "", closing: cells.eq(4)?.text().trim() || "", url: href.startsWith("http") ? href : `https://www.healthjobsuk.com${href}` });
      });
    }

    return { jobs };
  } catch (err) {
    console.error("[Scraper] Error:", err.message);
    return { jobs: [], error: err.message };
  }
}

// ── Email ─────────────────────────────────────────────────────────────────────
async function sendEmailAlert(recipient, newJobs) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return false;
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });

  const jobRows = newJobs.map(j => `
    <tr style="border-bottom:1px solid #e5e7eb;">
      <td style="padding:12px 8px;"><a href="${j.url}" style="color:#0f6cbd;font-weight:600;text-decoration:none;">${j.title}</a>${j.grade ? `<br><span style="font-size:12px;color:#6b7280;">${j.grade}</span>` : ""}</td>
      <td style="padding:12px 8px;color:#374151;">${j.employer || "—"}</td>
      <td style="padding:12px 8px;color:#374151;">${j.location || "—"}</td>
      <td style="padding:12px 8px;color:#374151;">${j.closing || "—"}</td>
    </tr>`).join("");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:24px;">
<div style="max-width:700px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
  <div style="background:linear-gradient(135deg,#0f4c8a,#1e7fc4);padding:28px 32px;">
    <h1 style="color:#fff;margin:0;font-size:22px;">🏥 New Junior Doctor Jobs</h1>
    <p style="color:#bfdbfe;margin:6px 0 0;">${newJobs.length} new position${newJobs.length > 1 ? "s" : ""} on HealthJobsUK</p>
  </div>
  <div style="padding:24px 32px;">
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead><tr style="background:#f8fafc;">
        <th style="padding:10px 8px;text-align:left;color:#6b7280;font-weight:600;font-size:12px;text-transform:uppercase;">Job Title</th>
        <th style="padding:10px 8px;text-align:left;color:#6b7280;font-weight:600;font-size:12px;text-transform:uppercase;">Employer</th>
        <th style="padding:10px 8px;text-align:left;color:#6b7280;font-weight:600;font-size:12px;text-transform:uppercase;">Location</th>
        <th style="padding:10px 8px;text-align:left;color:#6b7280;font-weight:600;font-size:12px;text-transform:uppercase;">Closing</th>
      </tr></thead>
      <tbody>${jobRows}</tbody>
    </table>
    <div style="margin-top:24px;padding:16px;background:#f0f9ff;border-radius:8px;border-left:4px solid #0f6cbd;">
      <p style="margin:0;font-size:13px;color:#374151;"><strong>Tip:</strong> Apply early — junior NHS posts fill quickly.<br>
      <a href="https://www.healthjobsuk.com/job_list?JobSearch_re=_POST&JobSearch_re_0=1" style="color:#0f6cbd;">View all vacancies →</a></p>
    </div>
    <div style="margin-top:16px;padding:12px;background:#fff7ed;border-radius:8px;border-left:4px solid #fb923c;font-size:12px;color:#92400e;">
      To unsubscribe, reply to this email with "unsubscribe" in the subject.
    </div>
  </div>
  <div style="padding:16px 32px;background:#f8fafc;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;">HealthJobsUK Alert · Junior Medical Vacancies · UK</p>
  </div>
</div></body></html>`;

  try {
    await transporter.sendMail({
      from: `"HealthJobs Alert 🏥" <${process.env.GMAIL_USER}>`,
      to: recipient.email,
      subject: `🏥 ${newJobs.length} New Junior Doctor Job${newJobs.length > 1 ? "s" : ""} on HealthJobsUK`,
      html
    });
    return true;
  } catch (err) {
    console.error("[Email] Failed:", err.message);
    return false;
  }
}

// ── Confirmation email ────────────────────────────────────────────────────────
async function sendConfirmationEmail(email) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return false;
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
  try {
    await transporter.sendMail({
      from: `"HealthJobs Alert 🏥" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: "✅ You're subscribed to HealthJobs Alerts",
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;">
        <h2 style="color:#0f4c8a;">✅ Subscription Confirmed</h2>
        <p>You'll now receive alerts for new <strong>junior doctor / non-senior medical</strong> vacancies on HealthJobsUK.</p>
        <p style="color:#6b7280;font-size:13px;">To unsubscribe at any time, reply to any alert email with "unsubscribe".</p>
      </div>`
    });
    return true;
  } catch { return false; }
}

// ── Core scan ─────────────────────────────────────────────────────────────────
async function runScan() {
  console.log(`[Scan] ${new Date().toISOString()}`);
  const settings = (await dbGet("settings")) || {};
  settings.lastScan = new Date().toISOString();
  await dbSet("settings", settings);

  const { jobs, error } = await scrapeJobs();
  if (error) { settings.lastError = error; await dbSet("settings", settings); return; }

  const filtered = jobs.filter(j => shouldIncludeJob(j.title, j.grade));
  const seenJobs = (await dbGet("seenJobs")) || {};
  const newJobs = filtered.filter(j => !seenJobs[j.id]);

  if (!newJobs.length) { console.log("[Scan] No new jobs"); return; }

  newJobs.forEach(j => { seenJobs[j.id] = { seenAt: new Date().toISOString(), title: j.title }; });
  await dbSet("seenJobs", seenJobs);

  settings.totalJobsFound = (settings.totalJobsFound || 0) + newJobs.length;
  await dbSet("settings", settings);

  if (!settings.alertsEnabled) return;

  const recipients = ((await dbGet("recipients")) || []).filter(r => r.active);
  const alertLog = (await dbGet("alertLog")) || [];

  for (const r of recipients) {
    const sent = await sendEmailAlert(r, newJobs);
    alertLog.unshift({ id: Date.now(), timestamp: new Date().toISOString(), recipient: r.email, jobCount: newJobs.length, jobs: newJobs.map(j => ({ id: j.id, title: j.title, url: j.url })), sent });
  }

  await dbSet("alertLog", alertLog.slice(0, 200));
  settings.totalAlertsSet = (settings.totalAlertsSet || 0) + 1;
  await dbSet("settings", settings);
  console.log(`[Scan] Alerted ${recipients.length} recipients about ${newJobs.length} jobs`);
}

// ── PUBLIC routes (no auth) ───────────────────────────────────────────────────

// Public subscribe
app.post("/api/subscribe", async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email required" });
  const recipients = (await dbGet("recipients")) || [];
  if (recipients.find(r => r.email.toLowerCase() === email.toLowerCase()))
    return res.json({ ok: true, message: "Already subscribed!" });
  const newR = { id: Date.now().toString(), email: email.toLowerCase().trim(), active: true, addedAt: new Date().toISOString() };
  recipients.push(newR);
  await dbSet("recipients", recipients);
  await sendConfirmationEmail(email);
  res.json({ ok: true, message: "Subscribed! Check your inbox for confirmation." });
});

// Trigger scan (called by cron-job.org)
app.post("/api/scan", async (req, res) => {
  res.json({ ok: true, message: "Scan triggered", time: new Date().toISOString() });
  runScan().catch(console.error);
});

// ── ADMIN routes (password protected) ────────────────────────────────────────
app.get("/api/admin/status", adminAuth, async (req, res) => {
  const settings = await dbGet("settings");
  const recipients = await dbGet("recipients");
  const seenJobs = await dbGet("seenJobs");
  const alertLog = (await dbGet("alertLog")) || [];
  res.json({ settings, recipients, seenJobsCount: Object.keys(seenJobs || {}).length, recentAlerts: alertLog.slice(0, 20) });
});

app.get("/api/admin/recipients", adminAuth, async (req, res) => {
  res.json(await dbGet("recipients") || []);
});

app.delete("/api/admin/recipients/:id", adminAuth, async (req, res) => {
  let recipients = (await dbGet("recipients")) || [];
  recipients = recipients.filter(r => r.id !== req.params.id);
  await dbSet("recipients", recipients);
  res.json({ ok: true });
});

app.patch("/api/admin/recipients/:id", adminAuth, async (req, res) => {
  const recipients = (await dbGet("recipients")) || [];
  const idx = recipients.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  recipients[idx] = { ...recipients[idx], ...req.body };
  await dbSet("recipients", recipients);
  res.json(recipients[idx]);
});

app.patch("/api/admin/settings", adminAuth, async (req, res) => {
  const settings = (await dbGet("settings")) || {};
  const updated = { ...settings, ...req.body };
  await dbSet("settings", updated);
  res.json(updated);
});

app.post("/api/admin/reset-seen", adminAuth, async (req, res) => {
  await dbSet("seenJobs", {});
  res.json({ ok: true });
});

app.post("/api/admin/test-email", adminAuth, async (req, res) => {
  const { email } = req.body;
  const sent = await sendEmailAlert({ email }, [{
    id: "test", title: "Foundation Year 1 (FY1) — Test Alert", employer: "NHS Test Trust",
    location: "London", grade: "FY1", closing: "30 Jun 2025", url: "https://www.healthjobsuk.com"
  }]);
  res.json({ sent });
});

app.get("/api/admin/alerts", adminAuth, async (req, res) => {
  res.json(await dbGet("alertLog") || []);
});

// Serve frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ── Boot ──────────────────────────────────────────────────────────────────────
let initialized = false;
async function ensureInit() {
  if (!initialized) { await ensureDefaults(); initialized = true; }
}

const handler = async (req, res) => { await ensureInit(); return app(req, res); };
module.exports = handler;

if (!process.env.VERCEL) {
  ensureInit().then(() => {
    app.listen(3000, () => console.log("[Server] http://localhost:3000"));
  });
}
