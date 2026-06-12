# 🏥 HealthJobs Alert

Monitors [HealthJobsUK](https://www.healthjobsuk.com) every minute for new **junior/non-senior medical and dental vacancies** and sends email (or Telegram) alerts when new jobs are posted.

## Features

- ✅ Scans every 60 seconds
- ✅ Filters out Consultant, Registrar, Senior, Director roles
- ✅ Targets FY1/FY2, SHO, CT1/CT2, Trust Grade, Clinical Fellow, GP Trainee, etc.
- ✅ Never alerts on the same job twice
- ✅ Email alerts via Gmail
- ✅ Optional Telegram alerts
- ✅ Dashboard to manage recipients (add/remove/pause)
- ✅ Test email button
- ✅ Deployable to Vercel (free tier)

---

## 🚀 Deploy to Vercel (Free)

### Step 1 — Upload to GitHub

1. Create a new GitHub repo (e.g. `healthjobs-alert`)
2. Upload all these files to it (drag-and-drop in GitHub UI, or use Git)

### Step 2 — Connect to Vercel

1. Go to [vercel.com](https://vercel.com) → Sign up free
2. Click **Add New → Project**
3. Import your GitHub repo
4. Click **Deploy** (don't change any settings)

### Step 3 — Set Environment Variables

In Vercel dashboard → your project → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `GMAIL_USER` | `your_gmail@gmail.com` |
| `GMAIL_APP_PASSWORD` | Your Gmail App Password (16 chars, no spaces) |

**How to get a Gmail App Password:**
1. Go to [myaccount.google.com/security](https://myaccount.google.com/security)
2. Enable 2-Step Verification (if not already)
3. Search "App passwords" → Create one for "Mail"
4. Copy the 16-character password

### Step 4 — Redeploy

After setting env vars, go to **Deployments → Redeploy** (top right). Your app is now live!

---

## ⚠️ Important Note on Vercel Free Tier

Vercel's free tier runs **serverless functions** — they don't keep a persistent process running 24/7. This means the built-in cron scheduler won't fire automatically on Vercel.

**Solution — Use a free external cron service to ping your app:**

1. Go to [cron-job.org](https://cron-job.org) (free)
2. Create a new cron job:
   - URL: `https://your-app.vercel.app/api/scan`
   - Method: `POST`
   - Schedule: Every 1 minute
3. Done! This will trigger a scan every minute for free.

Alternatively, use [UptimeRobot](https://uptimerobot.com) with a HTTP(s) monitor on the same URL.

---

## 🖥️ Running Locally

```bash
npm install
cp .env.example .env
# Edit .env with your Gmail credentials
node api/index.js
```

Visit `http://localhost:3000`

---

## 📬 Adding More Recipients

From the dashboard:
- Click **Add Recipient**
- Choose Email or Telegram
- Enter email address or Telegram Chat ID
- Click **Add Recipient**

### Getting a Telegram Chat ID:
1. Message `@userinfobot` on Telegram
2. It replies with your Chat ID number
3. Create a bot via `@BotFather` → get the bot token
4. Set `TELEGRAM_BOT_TOKEN` env var in Vercel

---

## 🔧 Job Filters

**Excluded keywords:** consultant, registrar, senior, director, lead, head of, chief, specialist, associate specialist, clinical director, medical director

**Included grades:** FY1, FY2, Foundation, Junior, SHO, CT1, CT2, Core Trainee, GP Trainee, Trust Grade, Trust Doctor, Clinical Fellow, Junior Clinical Fellow, Staff Grade, Specialty Doctor, Dental Core Trainee, Foundation Dentist, Vocational Trainee

---

## 📁 File Structure

```
healthjobs-alert/
├── api/
│   └── index.js       ← Backend: scraper, scheduler, API
├── public/
│   └── index.html     ← Dashboard UI
├── .data/             ← Persistent storage (auto-created)
├── package.json
├── vercel.json
└── .env.example
```
