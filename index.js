const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const storage = require("node-persist");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "../public")));

// ── Storage init ──────────────────────────────────────────────────────────────
const STORAGE_DIR = process.env.VERCEL ? "/tmp/.data" : path.join(__dirname, "../.data");

async function initStorage() {
  await storage.init({ dir: STORAGE_DIR, forgiveParseErrors: true });

  const recipients = await storage.getItem("recipients");
  if (!recipients) {
    await storage.setItem("recipients", [
      { id: "1", email: "zubairpnec@gmail.com", active: true, type: "email" }
    ]);
  }

  const seenJobs = await storage.getItem("seenJobs");
  if (!seenJobs) await storage.setItem("seenJobs", {});

  const alertLog = await storage.getItem("alertLog");
  if (!alertLog) await storage.setItem("alertLog", []);

  const settings = await storage.getItem("settings");
  if (!settings) {
    await storage.setItem("settings", {
      scanInterval: 1,
      alertsEnabled: true,
      lastScan: null,
      totalJobsFound: 0,
      totalAlertsSet: 0
    });
  }
}

// ── Job filters ───────────────────────────────────────────────────────────────
const EXCLUDE_KEYWORDS = [
  "consultant", "registrar", "senior", "sr.", "sr ",
  "director", "lead", "head of", "chief", "specialist",
  "associate specialist", "specialty registrar", "locum consultant",
  "clinical director", "medical director", "professor"
];

const INCLUDE_GRADE_KEYWORDS = [
  "foundation", "junior", "fy1", "fy2", "f1", "f2",
  "sho", "ct1", "ct2", "ct3", "core trainee",
  "gp trainee", "gp st", "gpst",
  "trust grade", "trust doctor", "clinical fellow",
  "junior clinical fellow", "house officer",
  "junior doctor", "trainee", "locum sho",
  "staff grade", "specialty doctor",
  "associate dentist", "dental core trainee", "dct",
  "foundation dentist", "vt", "vocational trainee"
];

function isExcluded(title) {
  const t = title.toLowerCase();
  return EXCLUDE_KEYWORDS.some(kw => t.includes(kw));
}

function isIncluded(title) {
  const t = title.toLowerCase();
  // If no specific grade keywords, still allow if not excluded (catch-all for non-senior roles)
  return INCLUDE_GRADE_KEYWORDS.some(kw => t.includes(kw));
}

function shouldIncludeJob(title, grade) {
  const combined = `${title} ${grade || ""}`.toLowerCase();
  if (EXCLUDE_KEYWORDS.some(kw => combined.includes(kw))) return false;
  // Include if it matches a junior keyword OR if grade field looks junior
  if (INCLUDE_GRADE_KEYWORDS.some(kw => combined.includes(kw))) return true;
  // If no grade info available, include if not explicitly senior
  return true;
}

// ── Scraper ───────────────────────────────────────────────────────────────────
const SEARCH_URL =
  "https://www.healthjobsuk.com/job_list?JobSearch_q=&JobSearch_d=&JobSearch_g=&JobSearch_re=_POST&JobSearch_re_0=1&JobSearch_re_1=1-_-_-&JobSearch_re_2=1-_-_--_-_-&JobSearch_Submit=Search&_tr=JobSearch&_ts=716";

async function scrapeJobs() {
  try {
    const { data } = await axios.get(SEARCH_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.5",
        "Cache-Control": "no-cache"
      },
      timeout: 15000
    });

    const $ = cheerio.load(data);
    const jobs = [];

    // HealthJobsUK job listing selectors
    $(".job, .vacancy, article.job-result, .search-result-item, [class*='job-listing'], [class*='vacancy-item']").each((i, el) => {
      const $el = $(el);
      const titleEl = $el.find("h2, h3, .job-title, .vacancy-title, a[href*='/job/'], a[href*='/vacancy/']").first();
      const title = titleEl.text().trim();
      const href = titleEl.attr("href") || $el.find("a").first().attr("href") || "";
      const employer = $el.find(".employer, .trust, .organisation, [class*='employer'], [class*='trust']").first().text().trim();
      const location = $el.find(".location, [class*='location']").first().text().trim();
      const grade = $el.find(".grade, .band, [class*='grade'], [class*='band'], .pay-grade").first().text().trim();
      const closing = $el.find(".closing, .deadline, [class*='closing'], [class*='date']").first().text().trim();
      const jobId = href.match(/\/(\d+)/)?.[1] || `${title}-${employer}`.replace(/\s+/g, "-").toLowerCase();

      if (title && jobId) {
        jobs.push({ id: jobId, title, employer, location, grade, closing, url: href.startsWith("http") ? href : `https://www.healthjobsuk.com${href}` });
      }
    });

    // Fallback: try generic link-based scraping if the above finds nothing
    if (jobs.length === 0) {
      $("a[href*='/job/'], a[href*='/vacancy/'], a[href*='job_view']").each((i, el) => {
        const $el = $(el);
        const title = $el.text().trim();
        const href = $el.attr("href") || "";
        const jobId = href.match(/[?&](?:id|job_id|JobID)=(\d+)/)?.[1] || href.match(/\/(\d+)/)?.[1];
        const $row = $el.closest("tr, li, div, article");
        const rowText = $row.text();
        const employer = "";
        const location = "";
        const grade = "";

        if (title && title.length > 5 && jobId) {
          jobs.push({
            id: jobId,
            title,
            employer,
            location,
            grade,
            closing: "",
            url: href.startsWith("http") ? href : `https://www.healthjobsuk.com${href}`
          });
        }
      });
    }

    // Also try table rows (common pattern on NHS job boards)
    if (jobs.length === 0) {
      $("table tr").each((i, el) => {
        if (i === 0) return; // skip header
        const $el = $(el);
        const cells = $el.find("td");
        if (cells.length < 2) return;
        const titleCell = cells.eq(0);
        const link = titleCell.find("a").first();
        const title = link.text().trim() || titleCell.text().trim();
        const href = link.attr("href") || "";
        const jobId = href.match(/\d+/)?.[0] || `job-${i}`;
        const employer = cells.eq(1).text().trim();
        const location = cells.eq(2)?.text().trim() || "";
        const grade = cells.eq(3)?.text().trim() || "";
        const closing = cells.eq(4)?.text().trim() || "";

        if (title && title.length > 5) {
          jobs.push({
            id: jobId,
            title,
            employer,
            location,
            grade,
            closing,
            url: href.startsWith("http") ? href : `https://www.healthjobsuk.com${href}`
          });
        }
      });
    }

    return { jobs, raw: data.substring(0, 500) }; // return snippet for debugging
  } catch (err) {
    console.error("[Scraper] Error:", err.message);
    return { jobs: [], error: err.message };
  }
}

// ── Email sender ──────────────────────────────────────────────────────────────
function createTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
}

async function sendEmailAlert(recipient, newJobs) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.warn("[Email] Gmail credentials not set — skipping email send");
    return false;
  }

  const transporter = createTransporter();
  const jobRows = newJobs
    .map(
      j => `
      <tr style="border-bottom:1px solid #e5e7eb;">
        <td style="padding:12px 8px;">
          <a href="${j.url}" style="color:#0f6cbd;font-weight:600;text-decoration:none;">${j.title}</a>
          ${j.grade ? `<br><span style="font-size:12px;color:#6b7280;">${j.grade}</span>` : ""}
        </td>
        <td style="padding:12px 8px;color:#374151;">${j.employer || "—"}</td>
        <td style="padding:12px 8px;color:#374151;">${j.location || "—"}</td>
        <td style="padding:12px 8px;color:#374151;">${j.closing || "—"}</td>
      </tr>`
    )
    .join("");

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:24px;">
  <div style="max-width:700px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:linear-gradient(135deg,#0f4c8a,#1e7fc4);padding:28px 32px;">
      <h1 style="color:#fff;margin:0;font-size:22px;">🏥 New Medical/Dental Jobs Found</h1>
      <p style="color:#bfdbfe;margin:6px 0 0;">${newJobs.length} new junior/non-senior position${newJobs.length > 1 ? "s" : ""} on HealthJobsUK</p>
    </div>
    <div style="padding:24px 32px;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead>
          <tr style="background:#f8fafc;">
            <th style="padding:10px 8px;text-align:left;color:#6b7280;font-weight:600;font-size:12px;text-transform:uppercase;">Job Title</th>
            <th style="padding:10px 8px;text-align:left;color:#6b7280;font-weight:600;font-size:12px;text-transform:uppercase;">Employer</th>
            <th style="padding:10px 8px;text-align:left;color:#6b7280;font-weight:600;font-size:12px;text-transform:uppercase;">Location</th>
            <th style="padding:10px 8px;text-align:left;color:#6b7280;font-weight:600;font-size:12px;text-transform:uppercase;">Closing</th>
          </tr>
        </thead>
        <tbody>${jobRows}</tbody>
      </table>
      <div style="margin-top:24px;padding:16px;background:#f0f9ff;border-radius:8px;border-left:4px solid #0f6cbd;">
        <p style="margin:0;font-size:13px;color:#374151;">
          <strong>Tip:</strong> Apply as early as possible — junior NHS posts fill quickly.<br>
          <a href="https://www.healthjobsuk.com/job_list?JobSearch_re=_POST&JobSearch_re_0=1" style="color:#0f6cbd;">View all vacancies →</a>
        </p>
      </div>
    </div>
    <div style="padding:16px 32px;background:#f8fafc;border-top:1px solid #e5e7eb;">
      <p style="margin:0;font-size:12px;color:#9ca3af;">Sent by HealthJobsUK Alert System · <a href="#" style="color:#9ca3af;">Manage alerts</a></p>
    </div>
  </div>
</body>
</html>`;

  try {
    await transporter.sendMail({
      from: `"HealthJobs Alert 🏥" <${process.env.GMAIL_USER}>`,
      to: recipient.email,
      subject: `🏥 ${newJobs.length} New Junior Medical Job${newJobs.length > 1 ? "s" : ""} on HealthJobsUK`,
      html
    });
    console.log(`[Email] Sent to ${recipient.email} — ${newJobs.length} jobs`);
    return true;
  } catch (err) {
    console.error("[Email] Send failed:", err.message);
    return false;
  }
}

// ── Telegram sender ───────────────────────────────────────────────────────────
async function sendTelegramAlert(recipient, newJobs) {
  if (!recipient.telegramChatId || !process.env.TELEGRAM_BOT_TOKEN) return false;
  const lines = newJobs.map(j => `• <a href="${j.url}">${j.title}</a>${j.employer ? `\n  📍 ${j.employer}` : ""}${j.grade ? `\n  🎓 ${j.grade}` : ""}`).join("\n\n");
  const text = `🏥 <b>${newJobs.length} New Junior Medical Job${newJobs.length > 1 ? "s" : ""}</b>\n\n${lines}`;
  try {
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: recipient.telegramChatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
    return true;
  } catch (err) {
    console.error("[Telegram] Send failed:", err.message);
    return false;
  }
}

// ── Core scan logic ───────────────────────────────────────────────────────────
async function runScan() {
  console.log(`[Scan] Starting at ${new Date().toISOString()}`);
  const settings = await storage.getItem("settings");
  settings.lastScan = new Date().toISOString();
  await storage.setItem("settings", settings);

  const { jobs, error } = await scrapeJobs();

  if (error) {
    console.error("[Scan] Scrape error:", error);
    settings.lastError = error;
    await storage.setItem("settings", settings);
    return;
  }

  console.log(`[Scan] Found ${jobs.length} total jobs before filtering`);

  // Filter jobs
  const filtered = jobs.filter(j => shouldIncludeJob(j.title, j.grade));
  console.log(`[Scan] ${filtered.length} jobs after filtering`);

  const seenJobs = (await storage.getItem("seenJobs")) || {};
  const newJobs = filtered.filter(j => !seenJobs[j.id]);

  if (newJobs.length === 0) {
    console.log("[Scan] No new jobs");
    return;
  }

  console.log(`[Scan] ${newJobs.length} NEW jobs detected`);

  // Mark as seen
  newJobs.forEach(j => {
    seenJobs[j.id] = { seenAt: new Date().toISOString(), title: j.title };
  });
  await storage.setItem("seenJobs", seenJobs);

  // Update stats
  settings.totalJobsFound = (settings.totalJobsFound || 0) + newJobs.length;
  await storage.setItem("settings", settings);

  if (!settings.alertsEnabled) {
    console.log("[Scan] Alerts paused — not sending");
    return;
  }

  // Send alerts
  const recipients = (await storage.getItem("recipients")) || [];
  const activeRecipients = recipients.filter(r => r.active);

  const alertLog = (await storage.getItem("alertLog")) || [];

  for (const recipient of activeRecipients) {
    let sent = false;
    if (recipient.type === "email") {
      sent = await sendEmailAlert(recipient, newJobs);
    } else if (recipient.type === "telegram") {
      sent = await sendTelegramAlert(recipient, newJobs);
    }

    alertLog.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      recipient: recipient.email || recipient.telegramChatId,
      type: recipient.type,
      jobCount: newJobs.length,
      jobs: newJobs.map(j => ({ id: j.id, title: j.title, url: j.url })),
      sent
    });
  }

  // Keep last 100 log entries
  await storage.setItem("alertLog", alertLog.slice(0, 100));
  settings.totalAlertsSet = (settings.totalAlertsSet || 0) + 1;
  await storage.setItem("settings", settings);
}

// ── API routes ────────────────────────────────────────────────────────────────

// Dashboard data
app.get("/api/status", async (req, res) => {
  const settings = await storage.getItem("settings");
  const recipients = await storage.getItem("recipients");
  const seenJobs = await storage.getItem("seenJobs");
  const alertLog = (await storage.getItem("alertLog")) || [];
  res.json({
    settings,
    recipients,
    seenJobsCount: Object.keys(seenJobs || {}).length,
    recentAlerts: alertLog.slice(0, 10)
  });
});

// Manually trigger scan
app.post("/api/scan", async (req, res) => {
  res.json({ message: "Scan triggered" });
  runScan();
});

// Recipients CRUD
app.get("/api/recipients", async (req, res) => {
  res.json(await storage.getItem("recipients") || []);
});

app.post("/api/recipients", async (req, res) => {
  const { email, type, telegramChatId } = req.body;
  if (!email && !telegramChatId) return res.status(400).json({ error: "Email or Telegram Chat ID required" });
  const recipients = (await storage.getItem("recipients")) || [];
  const newR = {
    id: Date.now().toString(),
    email: email || "",
    telegramChatId: telegramChatId || "",
    type: type || "email",
    active: true,
    addedAt: new Date().toISOString()
  };
  recipients.push(newR);
  await storage.setItem("recipients", recipients);
  res.json(newR);
});

app.patch("/api/recipients/:id", async (req, res) => {
  const recipients = (await storage.getItem("recipients")) || [];
  const idx = recipients.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  recipients[idx] = { ...recipients[idx], ...req.body };
  await storage.setItem("recipients", recipients);
  res.json(recipients[idx]);
});

app.delete("/api/recipients/:id", async (req, res) => {
  let recipients = (await storage.getItem("recipients")) || [];
  recipients = recipients.filter(r => r.id !== req.params.id);
  await storage.setItem("recipients", recipients);
  res.json({ ok: true });
});

// Settings
app.patch("/api/settings", async (req, res) => {
  const settings = (await storage.getItem("settings")) || {};
  const updated = { ...settings, ...req.body };
  await storage.setItem("settings", updated);
  res.json(updated);
});

// Alert log
app.get("/api/alerts", async (req, res) => {
  res.json((await storage.getItem("alertLog")) || []);
});

// Clear seen jobs (reset — will re-alert on next scan)
app.post("/api/reset-seen", async (req, res) => {
  await storage.setItem("seenJobs", {});
  res.json({ ok: true });
});

// Test email
app.post("/api/test-email", async (req, res) => {
  const { recipientId } = req.body;
  const recipients = (await storage.getItem("recipients")) || [];
  const recipient = recipients.find(r => r.id === recipientId);
  if (!recipient) return res.status(404).json({ error: "Recipient not found" });

  const testJob = {
    id: "test-123",
    title: "Foundation Year 1 Doctor (FY1) — Test Alert",
    employer: "NHS Test Trust",
    location: "London",
    grade: "FY1",
    closing: "30 Jun 2025",
    url: "https://www.healthjobsuk.com"
  };

  const sent = await sendEmailAlert(recipient, [testJob]);
  res.json({ sent });
});

// Serve dashboard for all other routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ── Start ─────────────────────────────────────────────────────────────────────
let initialized = false;

async function ensureInit() {
  if (!initialized) {
    await initStorage();
    initialized = true;
  }
}

// For local development: start the server normally
if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
  ensureInit().then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));
    cron.schedule("* * * * *", () => runScan().catch(console.error));
    setTimeout(() => runScan().catch(console.error), 3000);
  }).catch(console.error);
}

// For Vercel: wrap app to ensure storage is initialized on every cold start
const handler = async (req, res) => {
  await ensureInit();
  return app(req, res);
};

module.exports = handler;
