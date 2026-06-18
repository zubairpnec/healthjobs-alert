const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const nodemailer = require("nodemailer");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "../public")));

// ── Upstash Redis ─────────────────────────────────────────────────────────────
const mem = {};
function kvMemory(method, key, value) {
  if (method === "get") return mem[key] ?? null;
  if (method === "set") { mem[key] = value; return "OK"; }
  if (method === "del") { delete mem[key]; return 1; }
  return null;
}
async function kv(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return kvMemory(method, ...args);
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

// ── Grade definitions (selectable in admin panel) ────────────────────────────
// Keywords below are derived from REAL listings on healthjobsuk.com/job_list/s2
// Real grade field examples seen on site:
//   "NHS Medical & Dental: Senior House Officer"
//   "NHS Medical & Dental: Junior Clinical Fellow (ST1 - 2)"
//   "NHS Medical & Dental: Specialty Doctor"
//   "Trust Grade ST1/2"
//   "NHS Medical & Dental: Local Appointment nodal point 3/4 (MT03/MT04)"  <- junior-ish fellow tier
//   "Junior Clinical Fellow" (also appears as job-title prefix)
//   Senior/exclude tier: "Consultant", "Locum Consultant", "Senior Clinical Fellow",
//   "Registrar ST4-6", "Specialist Grade", "Chief Registrar", nodal point 5+ (MT05+)
const GRADE_OPTIONS = {
  fy1:           { label: "FY1 (Foundation Year 1)",       keywords: ["fy1", "foundation year 1", "f1 doctor", "foundation doctor year 1"] },
  fy2:           { label: "FY2 (Foundation Year 2)",       keywords: ["fy2", "foundation year 2", "f2 doctor", "foundation doctor year 2"] },
  foundation:    { label: "Foundation Doctor (general)",   keywords: ["foundation doctor", "foundation programme", "foundation year"] },
  sho:           { label: "SHO (Senior House Officer)",    keywords: ["senior house officer", " sho ", " sho)", " sho-", "(sho)"] },
  st1_st2:       { label: "ST1 / ST2 (junior specialty)",  keywords: ["st1/2", "st1-2", "st1 - 2", "st1/st2", "(st1", "st 1/2", "trust grade st1", "ct1", "ct2", "core trainee", "core medical", "core surgical", "core psychiatry"] },
  junior_clinical_fellow: { label: "Junior Clinical Fellow", keywords: ["junior clinical fellow"] },
  clinical_fellow_general: { label: "Clinical Fellow (general, non-senior)", keywords: ["clinical fellow"] },
  trust_grade:   { label: "Trust Grade Doctor",             keywords: ["trust grade", "trust doctor"] },
  led_doctor:    { label: "LED (Locally Employed Doctor)",  keywords: ["led junior doctor", "locally employed doctor", " led "] },
  gp_trainee:    { label: "GP Trainee / GPST",              keywords: ["gp trainee", "gpst", "gp st1", "gp st2", "gp st3", "gp registrar trainee"] },
  house_officer: { label: "House Officer",                  keywords: ["house officer"] },
  junior_doctor: { label: "Junior Doctor (general)",        keywords: ["junior doctor", "junior fellow"] },
  nodal_3_4:     { label: "Local Appointment MT03 / MT04 (junior fellow tier)", keywords: ["nodal point 3", "nodal point 4", "(mt03)", "(mt04)", "mt03", "mt04"] },
  locum_junior:  { label: "Locum (junior grades only)",     keywords: ["locum sho", "locum fy", "locum f1", "locum f2", "locum junior"] },
  specialty_doctor: { label: "Specialty Doctor",            keywords: ["specialty doctor"] }
};

const DEFAULT_SELECTED_GRADES = ["fy1", "fy2", "foundation", "sho", "st1_st2", "junior_clinical_fellow", "trust_grade", "led_doctor", "gp_trainee", "house_officer", "junior_doctor", "nodal_3_4", "locum_junior", "specialty_doctor"];

// Senior/high-grade terms that ALWAYS exclude a job, no matter what else matches.
// This is a hard safety net — real listings show these terms reliably mark senior posts.
const HARD_EXCLUDE = [
  "consultant", "locum consultant", "senior clinical fellow", "specialist grade",
  "chief registrar", "registrar st3", "registrar st4", "registrar st5", "registrar st6",
  "registrar st7", "registrar st8", "st3-", "st4-", "st5-", "st6-", "st7-", "st8-",
  "st3 -", "st4 -", "(st3", "(st4", "(st5", "(st6", "(st7", "(st8",
  "nodal point 5", "nodal point 6", "nodal point 7", "nodal point 8",
  "(mt05)", "(mt06)", "(mt07)", "(mt08)", "mt05", "mt06", "mt07", "mt08",
  "training programme director", "tpd "
];

async function ensureDefaults() {
  if (!await dbGet("settings"))   await dbSet("settings",   { alertsEnabled:true, lastScan:null, totalJobsFound:0, totalAlertsSet:0, selectedGrades: DEFAULT_SELECTED_GRADES, salaryMin: DEFAULT_SALARY_MIN, salaryMax: DEFAULT_SALARY_MAX, salaryFilterEnabled: true });
  else {
    const s = await dbGet("settings");
    let changed = false;
    if (!s.selectedGrades) { s.selectedGrades = DEFAULT_SELECTED_GRADES; changed = true; }
    if (s.salaryMin === undefined) { s.salaryMin = DEFAULT_SALARY_MIN; changed = true; }
    if (s.salaryMax === undefined) { s.salaryMax = DEFAULT_SALARY_MAX; changed = true; }
    if (s.salaryFilterEnabled === undefined) { s.salaryFilterEnabled = true; changed = true; }
    if (changed) await dbSet("settings", s);
  }
  if (!await dbGet("recipients")) await dbSet("recipients", []);
  if (!await dbGet("seenJobs"))   await dbSet("seenJobs",   {});
  if (!await dbGet("alertLog"))   await dbSet("alertLog",   []);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const pw = process.env.ADMIN_PASSWORD || "admin123";
  if ((req.headers["x-admin-password"] || req.query.pw) !== pw) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── Job filter — driven entirely by selectedGrades, no hardcoded excludes ───
function shouldIncludeJob(title, grade, selectedGrades) {
  const combined = `${title} ${grade || ""}`.toLowerCase();

  // Hard safety net: these terms always mean a senior post, regardless of grade selection
  if (HARD_EXCLUDE.some(kw => combined.includes(kw))) return false;

  for (const key of selectedGrades) {
    const def = GRADE_OPTIONS[key];
    if (!def) continue;
    if (def.keywords.some(kw => combined.includes(kw))) return true;
  }
  return false;
}

// ── Salary filter ─────────────────────────────────────────────────────────────
// Real NHS pay bands (2026/27, England, basic salary, official NHS Employers /
// healthcareers.nhs.uk figures):
//   Foundation (FY1/FY2):        ~£40,190 – £45,994
//   Specialty training (CT/ST1-8, i.e. SHO/Trust Grade/Jr Clinical Fellow): £54,499 – £76,582
//   Specialty Doctor:            £63,696 – £102,689
//   Specialist Grade:            £104,401 – £115,341
//   Consultant:                  £113,565 – £150,569
// Junior-grade posts on this site realistically range ~£35,000–£80,000 once you
// include nodal-point variation, part-time pro-rata, and devolved-nation scales
// (which run lower than England). Default bounds set wide enough not to exclude
// genuine junior posts, but tight enough to filter out consultant-tier salaries.
const DEFAULT_SALARY_MIN = 35000;
const DEFAULT_SALARY_MAX = 80000;

// Extracts the highest plausible annual salary figure mentioned in a text blob.
// Real listings show salary as e.g. "£54,499 per annum" or "£63,696 - £102,689 per annum".
// We take the upper bound of any range so a post isn't wrongly excluded just because
// its starting salary looks low (specialty doctor posts start in-range but cap high).
function extractMaxSalary(text) {
  if (!text) return null;
  const matches = [...text.matchAll(/£\s?(\d{2,3}(?:,\d{3})|\d{4,6})/g)];
  if (!matches.length) return null;
  const values = matches.map(m => parseInt(m[1].replace(/,/g, ""), 10)).filter(n => n >= 10000 && n <= 250000);
  if (!values.length) return null;
  return Math.max(...values);
}

function passesSalaryFilter(text, salaryMin, salaryMax) {
  const max = extractMaxSalary(text);
  // If we can't find a salary figure at all, don't block the job on salary grounds —
  // grade-keyword matching is the primary filter; salary is a secondary safety net.
  if (max === null) return true;
  return max >= salaryMin && max <= salaryMax;
}

// ── Scraper ───────────────────────────────────────────────────────────────────
// Correctly scoped to the Medical and Dental sector only (s2)
const SEARCH_URL = "https://www.healthjobsuk.com/job_list/s2";

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
    const rawHtmlLength = data.length;
    const totalJobLinksFound = $("a[href*='/job/']").length;

    // Real job URLs on this site always match /job/.../<Slug>-v<digits>
    // e.g. https://www.healthjobsuk.com/job/UK/Oxfordshire/Oxford/.../Trauma-v7967801
    $("a[href*='/job/']").each((i, el) => {
      const $a = $(el);
      const href = $a.attr("href") || "";
      const jobIdMatch = href.match(/-v(\d+)(?:["'?]|$)/) || href.match(/\/job\/.*?(\d{6,})/);
      if (!jobIdMatch) return; // not a real job listing link (could be nav/footer link)

      const jobId = jobIdMatch[1];
      // Title is usually the link's title attribute (cleanest) or its text content
      let title = ($a.attr("title") || $a.text() || "").trim();
      // Strip leading "More information about " noise sometimes present in title attrs
      title = title.replace(/^More information about\s*/i, "").trim();
      if (!title || title.length < 4) return;

      // Try to find grade/employer/location/speciality from the surrounding list item or row
      const $container = $a.closest("li, tr, article, .job-result, div").first();
      const containerText = $container.text().replace(/\s+/g, " ").trim();

      // "grade" holds the FULL container text — used internally for keyword/salary
      // matching, since we can't reliably isolate individual fields by CSS class.
      const grade = containerText;

      // Build a short, clean snippet for email display: try to isolate the
      // "Speciality: X" and "Salary: £Y" portions, which are consistently labelled
      // in the real page text and safe to extract via regex.
      const specialityMatch = containerText.match(/Speciality:\s*([^£]+?)(?=Salary:|$)/i);
      const salaryMatch = containerText.match(/Salary:\s*([^]*?)$/i);
      const displaySnippet = [
        specialityMatch ? `Speciality: ${specialityMatch[1].trim()}` : null,
        salaryMatch ? `Salary: ${salaryMatch[1].trim().substring(0, 80)}` : null
      ].filter(Boolean).join(" · ");

      // Try to extract employer + location from the pattern consistently seen on
      // the real site: "<Employer Name> , <Location>Speciality: ...". The employer
      // name is frequently duplicated in the raw text (logo alt-text + visible text),
      // so we dedupe a repeated employer name if present.
      const employerLocMatch = containerText.match(/([A-Z][A-Za-z&,.'’\- ]{4,60}?)\s*,\s*([A-Za-z&,.'’\- ]{2,40}?)Speciality:/);
      let employer = employerLocMatch ? employerLocMatch[1].trim() : "";
      const location = employerLocMatch ? employerLocMatch[2].trim() : "";
      // If the employer name appears twice back-to-back (e.g. "X Trust X Trust"), keep one copy
      const halfLen = Math.floor(employer.length / 2);
      if (halfLen > 5 && employer.substring(0, halfLen).trim() === employer.substring(halfLen).trim()) {
        employer = employer.substring(0, halfLen).trim();
      }

      jobs.push({
        id: jobId,
        title,
        employer,
        location,
        grade,
        displaySnippet,
        closing: "",
        url: href.startsWith("http") ? href.split("?")[0] : `https://www.healthjobsuk.com${href}`.split("?")[0]
      });
    });

    // De-duplicate by job ID (same job can appear via multiple link wrappers)
    const seen = new Set();
    const deduped = jobs.filter(j => {
      if (seen.has(j.id)) return false;
      seen.add(j.id);
      return true;
    });

    return { jobs: deduped, rawHtmlLength, totalJobLinksFound };
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

  const jobCards = newJobs.map(j => `
    <div style="padding:16px;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:12px;">
      <a href="${j.url}" style="color:#0d9488;font-weight:600;font-size:15px;text-decoration:none;">${j.title}</a>
      ${j.employer ? `<div style="font-size:13px;color:#374151;margin-top:4px;">${j.employer}${j.location ? " · " + j.location : ""}</div>` : ""}
      ${j.displaySnippet ? `<div style="font-size:12px;color:#6b7280;margin-top:6px;">${j.displaySnippet}</div>` : ""}
    </div>`).join("");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:24px;">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
  <div style="background:linear-gradient(135deg,#0f5132,#0d9488);padding:28px 32px;">
    <h1 style="color:#fff;margin:0;font-size:22px;">🩺 New Junior Doctor Jobs</h1>
    <p style="color:#bbf7d0;margin:6px 0 0;">${newJobs.length} new position${newJobs.length > 1 ? "s" : ""} on HealthJobsUK</p>
  </div>
  <div style="padding:24px 32px;">
    ${jobCards}
    <div style="margin-top:12px;padding:16px;background:#f0fdfa;border-radius:8px;border-left:4px solid #0d9488;">
      <p style="margin:0;font-size:13px;color:#374151;"><strong>Tip:</strong> Apply early — junior NHS posts fill quickly.<br>
      <a href="https://www.healthjobsuk.com/job_list/s2" style="color:#0d9488;">View all Medical &amp; Dental vacancies →</a></p>
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
      from: `"HealthJobs Alert 🩺" <${process.env.GMAIL_USER}>`,
      to: recipient.email,
      subject: `🩺 ${newJobs.length} New Junior Doctor Job${newJobs.length > 1 ? "s" : ""} on HealthJobsUK`,
      html
    });
    return true;
  } catch (err) {
    console.error("[Email] Failed:", err.message);
    return false;
  }
}

async function sendConfirmationEmail(email) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return false;
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
  try {
    await transporter.sendMail({
      from: `"HealthJobs Alert 🩺" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: "✅ You're subscribed to HealthJobs Alerts",
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;">
        <h2 style="color:#0f5132;">✅ Subscription Confirmed</h2>
        <p>You'll now receive alerts for new junior doctor vacancies on HealthJobsUK, based on the grades currently configured.</p>
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

  const diag = { rawJobsFound: 0, afterGradeFilter: 0, afterSalaryFilter: 0, newAfterDedup: 0, sampleTitles: [], error: null, rawHtmlLength: 0, totalJobLinksFound: 0 };

  const { jobs, error, rawHtmlLength, totalJobLinksFound } = await scrapeJobs();
  diag.rawJobsFound = jobs.length;
  diag.sampleTitles = jobs.slice(0, 5).map(j => j.title);
  diag.rawHtmlLength = rawHtmlLength || 0;
  diag.totalJobLinksFound = totalJobLinksFound || 0;

  if (error) {
    diag.error = error;
    settings.lastError = error;
    settings.lastDiagnostics = diag;
    await dbSet("settings", settings);
    return;
  }

  const selectedGrades = settings.selectedGrades || DEFAULT_SELECTED_GRADES;
  const salaryMin = settings.salaryMin ?? DEFAULT_SALARY_MIN;
  const salaryMax = settings.salaryMax ?? DEFAULT_SALARY_MAX;
  const salaryFilterEnabled = settings.salaryFilterEnabled !== false;

  const gradeFiltered = jobs.filter(j => shouldIncludeJob(j.title, j.grade, selectedGrades));
  diag.afterGradeFilter = gradeFiltered.length;

  const filtered = salaryFilterEnabled
    ? gradeFiltered.filter(j => passesSalaryFilter(j.grade, salaryMin, salaryMax))
    : gradeFiltered;
  diag.afterSalaryFilter = filtered.length;

  const seenJobs = (await dbGet("seenJobs")) || {};
  const newJobs = filtered.filter(j => !seenJobs[j.id]);
  diag.newAfterDedup = newJobs.length;

  settings.lastError = null;
  settings.lastDiagnostics = diag;
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

// ── PUBLIC routes ─────────────────────────────────────────────────────────────
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

app.get("/api/grade-options", (req, res) => {
  const list = Object.entries(GRADE_OPTIONS).map(([key, v]) => ({ key, label: v.label }));
  res.json(list);
});

app.all("/api/scan", async (req, res) => {
  res.json({ ok: true, message: "Scan triggered", time: new Date().toISOString() });
  runScan().catch(console.error);
});

// ── ADMIN routes ──────────────────────────────────────────────────────────────
app.get("/api/admin/status", adminAuth, async (req, res) => {
  const settings = await dbGet("settings");
  const recipients = await dbGet("recipients");
  const seenJobs = await dbGet("seenJobs");
  const alertLog = (await dbGet("alertLog")) || [];
  res.json({ settings, recipients, seenJobsCount: Object.keys(seenJobs || {}).length, recentAlerts: alertLog.slice(0, 20), gradeOptions: Object.entries(GRADE_OPTIONS).map(([key, v]) => ({ key, label: v.label })) });
});

app.get("/api/admin/recipients", adminAuth, async (req, res) => res.json(await dbGet("recipients") || []));

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
    location: "London", displaySnippet: "Speciality: General Medicine · Salary: £40,257 per annum", url: "https://www.healthjobsuk.com/job_list/s2"
  }]);
  res.json({ sent });
});

app.get("/api/admin/alerts", adminAuth, async (req, res) => res.json(await dbGet("alertLog") || []));

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../public/index.html")));

// ── Boot ──────────────────────────────────────────────────────────────────────
let initialized = false;
async function ensureInit() { if (!initialized) { await ensureDefaults(); initialized = true; } }
const handler = async (req, res) => { await ensureInit(); return app(req, res); };
module.exports = handler;
if (!process.env.VERCEL) { ensureInit().then(() => app.listen(3000, () => console.log("[Server] http://localhost:3000"))); }
