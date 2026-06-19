const express = require("express");
const axios = require("axios");
const nodemailer = require("nodemailer");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "../public")));

// ── Upstash Redis ─────────────────────────────────────────────────────────────
const mem = {};
function kvMem(method, key, value) {
  if (method === "get") return mem[key] ?? null;
  if (method === "set") { mem[key] = value; return "OK"; }
  if (method === "del") { delete mem[key]; return 1; }
  return null;
}
async function kv(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return kvMem(method, ...args);
  const res = await axios.post(
    `${url}/${[method, ...args.map(a => typeof a === "object" ? JSON.stringify(a) : a)].join("/")}`,
    null, { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
  );
  return res.data.result;
}
async function dbGet(key) {
  try { const v = await kv("get", key); if (!v) return null; return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; }
}
async function dbSet(key, value) {
  try { await kv("set", key, JSON.stringify(value)); } catch(e) { console.error("dbSet:", e.message); }
}

// ── Grade options (admin-selectable) ─────────────────────────────────────────
const GRADE_OPTIONS = {
  fy1:               { label: "FY1 (Foundation Year 1)",            keywords: ["fy1", "foundation year 1", "foundation doctor year 1"] },
  fy2:               { label: "FY2 (Foundation Year 2)",            keywords: ["fy2", "foundation year 2", "foundation doctor year 2"] },
  foundation:        { label: "Foundation Doctor (general)",        keywords: ["foundation doctor", "foundation programme", "foundation year"] },
  sho:               { label: "SHO (Senior House Officer)",         keywords: ["senior house officer", "sho"] },
  ct1_ct2:           { label: "CT1 / CT2 / Core Trainee",           keywords: ["ct1", "ct2", "core trainee", "core medical", "core surgical"] },
  st1_st2:           { label: "ST1 / ST2 (junior specialty)",       keywords: ["st1/2", "st1-2", "st1 - 2", "(st1", "st1/st2"] },
  junior_clin_fellow:{ label: "Junior Clinical Fellow",             keywords: ["junior clinical fellow"] },
  clinical_fellow:   { label: "Clinical Fellow (general)",          keywords: ["clinical fellow"] },
  trust_grade:       { label: "Trust Grade Doctor",                 keywords: ["trust grade", "trust doctor"] },
  led_doctor:        { label: "LED / Locally Employed Doctor",      keywords: ["led junior", "locally employed doctor"] },
  gp_trainee:        { label: "GP Trainee / GPST",                  keywords: ["gp trainee", "gpst", "gp st"] },
  house_officer:     { label: "House Officer",                      keywords: ["house officer"] },
  junior_doctor:     { label: "Junior Doctor (general)",            keywords: ["junior doctor", "junior fellow"] },
  nodal_3_4:         { label: "Local Appointment MT03 / MT04",      keywords: ["nodal point 3", "nodal point 4", "mt03", "mt04", "(mt03)", "(mt04)"] },
  locum_junior:      { label: "Locum (junior grades)",              keywords: ["locum sho", "locum fy", "locum junior"] },
  specialty_doctor:  { label: "Specialty Doctor",                   keywords: ["specialty doctor"] }
};

const DEFAULT_GRADES = Object.keys(GRADE_OPTIONS);
const DEFAULT_SALARY_MIN = 35000;
const DEFAULT_SALARY_MAX = 80000;

// Senior roles — ALWAYS excluded regardless of grade selection
const HARD_EXCLUDE = [
  "consultant", "locum consultant", "senior clinical fellow", "specialist grade",
  "chief registrar", "(st3", "(st4", "(st5", "(st6", "(st7", "(st8",
  "st3-", "st4-", "st5-", "st6-", "registrar st3", "registrar st4", "registrar st5",
  "nodal point 5", "nodal point 6", "nodal point 7", "nodal point 8",
  "mt05", "mt06", "mt07", "mt08", "(mt05)", "(mt06)", "(mt07)", "(mt08)",
  "training programme director"
];

async function ensureDefaults() {
  if (!await dbGet("settings")) await dbSet("settings", {
    alertsEnabled: true, lastScan: null, totalJobsFound: 0, totalAlertsSet: 0,
    selectedGrades: DEFAULT_GRADES, salaryMin: DEFAULT_SALARY_MIN,
    salaryMax: DEFAULT_SALARY_MAX, salaryFilterEnabled: true
  }); else {
    const s = await dbGet("settings");
    let changed = false;
    if (!s.selectedGrades) { s.selectedGrades = DEFAULT_GRADES; changed = true; }
    if (s.salaryMin === undefined) { s.salaryMin = DEFAULT_SALARY_MIN; changed = true; }
    if (s.salaryMax === undefined) { s.salaryMax = DEFAULT_SALARY_MAX; changed = true; }
    if (s.salaryFilterEnabled === undefined) { s.salaryFilterEnabled = true; changed = true; }
    if (changed) await dbSet("settings", s);
  }
  if (!await dbGet("recipients")) await dbSet("recipients", []);
  if (!await dbGet("seenJobs"))   await dbSet("seenJobs", {});
  if (!await dbGet("alertLog"))   await dbSet("alertLog", []);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const pw = process.env.ADMIN_PASSWORD || "admin123";
  if ((req.headers["x-admin-password"] || req.query.pw) !== pw) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── Filters ───────────────────────────────────────────────────────────────────
function shouldInclude(title, selectedGrades) {
  const t = title.toLowerCase();
  if (HARD_EXCLUDE.some(kw => t.includes(kw))) return false;
  for (const key of selectedGrades) {
    const def = GRADE_OPTIONS[key];
    if (def && def.keywords.some(kw => t.includes(kw))) return true;
  }
  return false;
}

function passesSalary(salaryLow, salaryHigh, min, max) {
  // salaryLow/salaryHigh come directly from the API as numbers
  if (!salaryLow && !salaryHigh) return true; // no salary data — don't filter out
  const low = parseFloat(salaryLow) || 0;
  const high = parseFloat(salaryHigh) || low;
  // Include if the LOW end of the salary range is within bounds
  // (avoids excluding Specialty Doctor posts that START in-range but cap high)
  return low >= min && low <= max;
}

// ── NHS Jobs XML API scraper ──────────────────────────────────────────────────
// jobs.nhs.uk provides a public XML API — no bot detection, no scraping needed.
// Endpoint: https://www.jobs.nhs.uk/api/v1/search_xml?keyword=X&page=N
// Returns structured XML with fields: id, jobTitle, organisationName,
// salaryMin, salaryMax, closingDate, postedDate, jobUrl, locationName
// We search multiple junior-grade keywords to cast a wide net, then filter.
const SEARCH_KEYWORDS = [
  "junior clinical fellow",
  "trust grade doctor",
  "foundation doctor",
  "SHO senior house officer",
  "specialty doctor",
  "locally employed doctor",
  "GP trainee",
  "core trainee"
];

function parseXmlJobs(xmlText) {
  const jobs = [];
  // Extract all <job> blocks
  const jobBlocks = [...xmlText.matchAll(/<job>([\s\S]*?)<\/job>/gi)];
  for (const block of jobBlocks) {
    const inner = block[1];
    const get = (tag) => {
      const m = inner.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
    };
    const id = get("id") || get("jobId") || get("vacancyId");
    const title = get("jobTitle") || get("title");
    const employer = get("organisationName") || get("employer");
    const location = get("locationName") || get("location");
    const salaryMin = get("salaryMin") || get("salary");
    const salaryMax = get("salaryMax");
    const closing = get("closingDate");
    const url = get("jobUrl") || get("url");
    if (id && title) {
      jobs.push({ id, title, employer, location, salaryMin, salaryMax, closing, url });
    }
  }
  return jobs;
}

async function scrapeJobs() {
  const allJobs = [];
  const seenIds = new Set();
  let totalLinks = 0;
  let error = null;

  for (const keyword of SEARCH_KEYWORDS) {
    try {
      const { data } = await axios.get("https://www.jobs.nhs.uk/api/v1/search_xml", {
        params: { keyword, page: 1 },
        headers: { "Accept": "application/xml, text/xml, */*", "User-Agent": "Mozilla/5.0" },
        timeout: 15000
      });
      const text = typeof data === "string" ? data : JSON.stringify(data);
      const jobs = parseXmlJobs(text);
      totalLinks += jobs.length;
      for (const j of jobs) {
        if (!seenIds.has(j.id)) { seenIds.add(j.id); allJobs.push(j); }
      }
      // small delay between requests
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      error = e.message;
      console.error(`[Scraper] keyword="${keyword}" error:`, e.message);
    }
  }

  return { jobs: allJobs, rawHtmlLength: totalLinks * 200, totalJobLinksFound: totalLinks, error: allJobs.length === 0 ? error : null };
}

// ── Email ─────────────────────────────────────────────────────────────────────
async function sendEmailAlert(recipient, jobs) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return false;
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });

  const cards = jobs.map(j => {
    const salaryText = j.salaryMin ? `£${parseFloat(j.salaryMin).toLocaleString()}${j.salaryMax && j.salaryMax !== j.salaryMin ? ` – £${parseFloat(j.salaryMax).toLocaleString()}` : ""} per annum` : "";
    return `
    <div style="padding:16px;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:12px;">
      <a href="${j.url}" style="color:#0d9488;font-weight:600;font-size:15px;text-decoration:none;">${j.title}</a>
      ${j.employer ? `<div style="font-size:13px;color:#374151;margin-top:4px;">${j.employer}${j.location ? " · " + j.location : ""}</div>` : ""}
      <div style="font-size:12px;color:#6b7280;margin-top:6px;display:flex;gap:16px;flex-wrap:wrap;">
        ${salaryText ? `<span>💷 ${salaryText}</span>` : ""}
        ${j.closing ? `<span>📅 Closes ${j.closing}</span>` : ""}
      </div>
    </div>`;
  }).join("");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:24px;">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
  <div style="background:linear-gradient(135deg,#0f5132,#0d9488);padding:28px 32px;">
    <h1 style="color:#fff;margin:0;font-size:22px;">🩺 New Junior Doctor Jobs</h1>
    <p style="color:#bbf7d0;margin:6px 0 0;">${jobs.length} new position${jobs.length > 1 ? "s" : ""} on NHS Jobs</p>
  </div>
  <div style="padding:24px 32px;">
    ${cards}
    <div style="margin-top:12px;padding:16px;background:#f0fdfa;border-radius:8px;border-left:4px solid #0d9488;font-size:13px;color:#374151;">
      <strong>Tip:</strong> Apply early — junior NHS posts fill quickly.<br>
      <a href="https://www.jobs.nhs.uk/candidate/search/results?keyword=junior+doctor&language=en" style="color:#0d9488;">View all on NHS Jobs →</a>
    </div>
    <div style="margin-top:12px;padding:10px;background:#fff7ed;border-radius:8px;font-size:12px;color:#92400e;">
      To unsubscribe, reply to this email with "unsubscribe" in the subject.
    </div>
  </div>
  <div style="padding:16px 32px;background:#f8fafc;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:12px;color:#9ca3af;">NHS Jobs Alert · Junior Medical Vacancies · UK</p>
  </div>
</div></body></html>`;

  try {
    await transporter.sendMail({
      from: `"NHS Jobs Alert 🩺" <${process.env.GMAIL_USER}>`,
      to: recipient.email,
      subject: `🩺 ${jobs.length} New Junior Doctor Job${jobs.length > 1 ? "s" : ""} on NHS Jobs`,
      html
    });
    return true;
  } catch(e) { console.error("[Email]", e.message); return false; }
}

async function sendConfirmation(email) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;
  const t = nodemailer.createTransport({ service: "gmail", auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  try { await t.sendMail({ from: `"NHS Jobs Alert 🩺" <${process.env.GMAIL_USER}>`, to: email, subject: "✅ Subscribed to NHS Jobs Alerts", html: `<div style="font-family:sans-serif;padding:32px;max-width:500px;margin:0 auto"><h2 style="color:#0f5132">✅ You're subscribed!</h2><p>You'll receive alerts for new junior doctor vacancies on NHS Jobs matching your grade preferences.</p><p style="color:#6b7280;font-size:13px;">To unsubscribe, reply "unsubscribe" to any alert email.</p></div>` }); } catch {}
}

// ── Core scan ─────────────────────────────────────────────────────────────────
async function runScan() {
  console.log(`[Scan] ${new Date().toISOString()}`);
  const settings = (await dbGet("settings")) || {};
  settings.lastScan = new Date().toISOString();

  const diag = { rawJobsFound: 0, afterGradeFilter: 0, afterSalaryFilter: 0, newAfterDedup: 0, sampleTitles: [], error: null, rawHtmlLength: 0, totalJobLinksFound: 0 };

  const { jobs, error, rawHtmlLength, totalJobLinksFound } = await scrapeJobs();
  diag.rawJobsFound = jobs.length;
  diag.rawHtmlLength = rawHtmlLength || 0;
  diag.totalJobLinksFound = totalJobLinksFound || 0;
  diag.sampleTitles = jobs.slice(0, 5).map(j => j.title);

  if (error && jobs.length === 0) {
    diag.error = error;
    settings.lastDiagnostics = diag;
    await dbSet("settings", settings);
    return;
  }

  const selectedGrades = settings.selectedGrades || DEFAULT_GRADES;
  const salaryMin = settings.salaryMin ?? DEFAULT_SALARY_MIN;
  const salaryMax = settings.salaryMax ?? DEFAULT_SALARY_MAX;
  const salaryFilterEnabled = settings.salaryFilterEnabled !== false;

  const gradeFiltered = jobs.filter(j => shouldInclude(j.title, selectedGrades));
  diag.afterGradeFilter = gradeFiltered.length;

  const filtered = salaryFilterEnabled
    ? gradeFiltered.filter(j => passesSalary(j.salaryMin, j.salaryMax, salaryMin, salaryMax))
    : gradeFiltered;
  diag.afterSalaryFilter = filtered.length;

  const seenJobs = (await dbGet("seenJobs")) || {};
  const newJobs = filtered.filter(j => !seenJobs[j.id]);
  diag.newAfterDedup = newJobs.length;

  settings.lastDiagnostics = diag;
  settings.lastError = null;
  await dbSet("settings", settings);

  if (!newJobs.length) { console.log("[Scan] No new jobs", diag); return; }

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

// ── Public routes ─────────────────────────────────────────────────────────────
app.post("/api/subscribe", async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email required" });
  const recipients = (await dbGet("recipients")) || [];
  if (recipients.find(r => r.email.toLowerCase() === email.toLowerCase()))
    return res.json({ ok: true, message: "Already subscribed!" });
  recipients.push({ id: Date.now().toString(), email: email.toLowerCase().trim(), active: true, addedAt: new Date().toISOString() });
  await dbSet("recipients", recipients);
  await sendConfirmation(email);
  res.json({ ok: true, message: "Subscribed! Check your inbox for confirmation." });
});

app.all("/api/scan", async (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
  runScan().catch(console.error);
});

// ── Admin routes ──────────────────────────────────────────────────────────────
app.get("/api/admin/status", adminAuth, async (req, res) => {
  const settings = await dbGet("settings");
  const recipients = await dbGet("recipients");
  const seenJobs = await dbGet("seenJobs");
  const alertLog = (await dbGet("alertLog")) || [];
  res.json({ settings, recipients, seenJobsCount: Object.keys(seenJobs || {}).length, recentAlerts: alertLog.slice(0, 20), gradeOptions: Object.entries(GRADE_OPTIONS).map(([key, v]) => ({ key, label: v.label })) });
});

app.delete("/api/admin/recipients/:id", adminAuth, async (req, res) => {
  let r = (await dbGet("recipients")) || [];
  r = r.filter(x => x.id !== req.params.id);
  await dbSet("recipients", r); res.json({ ok: true });
});

app.patch("/api/admin/recipients/:id", adminAuth, async (req, res) => {
  const r = (await dbGet("recipients")) || [];
  const i = r.findIndex(x => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Not found" });
  r[i] = { ...r[i], ...req.body }; await dbSet("recipients", r); res.json(r[i]);
});

app.patch("/api/admin/settings", adminAuth, async (req, res) => {
  const s = (await dbGet("settings")) || {};
  const u = { ...s, ...req.body }; await dbSet("settings", u); res.json(u);
});

app.post("/api/admin/reset-seen", adminAuth, async (req, res) => {
  await dbSet("seenJobs", {}); res.json({ ok: true });
});

app.post("/api/admin/test-email", adminAuth, async (req, res) => {
  const { email } = req.body;
  const sent = await sendEmailAlert({ email }, [{
    id: "test", title: "Junior Clinical Fellow — Test Alert",
    employer: "NHS Test Trust", location: "London",
    salaryMin: "54499", salaryMax: "62831",
    closing: "30 Jun 2026", url: "https://www.jobs.nhs.uk"
  }]);
  res.json({ sent });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../public/index.html")));

// ── Boot ──────────────────────────────────────────────────────────────────────
let initialized = false;
async function ensureInit() { if (!initialized) { await ensureDefaults(); initialized = true; } }
const handler = async (req, res) => { await ensureInit(); return app(req, res); };
module.exports = handler;
if (!process.env.VERCEL) { ensureInit().then(() => app.listen(3000, () => console.log("[Server] http://localhost:3000"))); }
