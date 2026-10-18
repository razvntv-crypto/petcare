// Sends Petcare's care reminders (vaccines, deworming, flea & tick...).
// The app saves an encrypted copy of your items to schedule.enc (only the phone and this
// workflow know PETCARE_KEY). Once a day, at the alert time set in the app, this script
// checks what is coming up and sends one push if something is due. Nothing to set here per item.
import webpush from "web-push";
import fs from "node:fs";
import { webcrypto as wc } from "node:crypto";

const { PETCARE_KEY, TEST } = process.env;
const LAST = ".github/last-sent";
const test = TEST === "true";
// Leaves a short, non-secret status note the app can show (only for tests and errors).
const report = (ok, msg) => { try { fs.writeFileSync(".github/status", JSON.stringify({ at: new Date().toISOString(), ok, test, msg }) + "\n"); } catch {} };

if (!fs.existsSync("schedule.enc")) { console.log("No schedule yet: turn on notifications in the app first."); process.exit(0); }
if (!PETCARE_KEY) { report(false, "The PETCARE_KEY secret is missing on GitHub."); console.log("PETCARE_KEY secret is missing: copy it from the app (Settings > Notifications) into Settings > Secrets and variables > Actions."); process.exit(0); }

const b64 = s => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
let cfg;
try {
  const box = JSON.parse(fs.readFileSync("schedule.enc", "utf8"));
  const key = await wc.subtle.importKey("raw", b64(PETCARE_KEY.trim()), "AES-GCM", false, ["decrypt"]);
  const plain = await wc.subtle.decrypt({ name: "AES-GCM", iv: b64(box.iv) }, key, b64(box.ct));
  cfg = JSON.parse(Buffer.from(plain).toString("utf8"));
} catch (e) {
  report(false, "The PETCARE_KEY secret on GitHub doesn't match this app's key. Copy the key again and update the secret.");
  console.error("Could not read schedule.enc. The PETCARE_KEY secret probably doesn't match the key in the app; copy it again.");
  process.exit(1);
}

const TZ = cfg.tz || "Europe/Bucharest";
const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
const g = t => parts.find(p => p.type === t).value;
const today = `${g("year")}-${g("month")}-${g("day")}`, hour = +g("hour"), nowMin = hour * 60 + +g("minute");
const last = fs.existsSync(LAST) ? fs.readFileSync(LAST, "utf8").trim() : "";
console.log(`Local ${today} ${hour}:xx (${TZ}), alert hour ${cfg.hour}, last sent ${last || "never"}`);

const day = s => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const diff = s => Math.round((day(s) - day(today)) / 864e5);
const when = n => n === 0 ? "today" : n === 1 ? "tomorrow" : n > 1 ? `in ${n} days` : `${-n} day${n === -1 ? "" : "s"} overdue`;
const fmtDate = s => new Date(day(s)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const what = (it, n) => n < 0 ? `${when(n)}` : `due ${when(n)}`;
const line = (it, n) => `${it.pet} · ${it.n} ${what(it, n)}`;

const alerts = Array.isArray(cfg.alerts) && cfg.alerts.length ? cfg.alerts : [3, 1, 0];
const due = (cfg.items || [])
  .filter(it => !it.paused && it.d)
  .map(it => ({ it, n: diff(it.d) }))
  .filter(({ n }) => alerts.includes(n) || (n < 0 && n >= -3))
  .sort((a, b) => a.n - b.n);

// Daily meds: one push per dose time, unless it was already ticked in the app.
// A dose is still sent up to 4 hours after its time if the check runs late (GitHub's own schedule often does).
const MEDS = ".github/meds-sent";
let medSent = [];
try { const j = JSON.parse(fs.readFileSync(MEDS, "utf8")); if (j.d === today) medSent = j.k || []; } catch {}
const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const medDue = [];
for (const m of cfg.meds || []) {
  if ((m.start && m.start > today) || (m.end && m.end < today)) continue;
  const given = m.given && m.given.d === today ? m.given.t || [] : [];
  for (const t of m.times || []) {
    const k = `${m.id}|${t}`, late = nowMin - toMin(t);
    if (late >= 0 && late <= 240 && !given.includes(t) && !medSent.includes(k)) medDue.push({ m, t, k });
  }
}

const payloads = [];
let careSent = false;
if (test) {
  const next = (cfg.items || []).filter(it => !it.paused && it.d && diff(it.d) >= 0).sort((a, b) => a.d < b.d ? -1 : 1)[0];
  const meds = (cfg.meds || []).filter(m => !(m.end && m.end < today));
  const medTxt = meds.length ? meds.map(m => `${m.pet} · ${m.n} at ${(m.times || []).join(", ")}`).join("\n") : "";
  const careTxt = next ? "Next care: " + line(next, diff(next.d)) + " (" + fmtDate(next.d) + ")" : "";
  payloads.push({ title: "You're all set ✓", body: [medTxt ? "Daily meds:\n" + medTxt : "", careTxt].filter(Boolean).join("\n") || "Nothing scheduled yet.", tag: "petcare-test" });
} else {
  if (hour >= cfg.hour && last !== today && due.length) {
    careSent = true;
    payloads.push(due.length === 1
      ? { title: `${due[0].it.pet} · ${due[0].it.n}`, body: what(due[0].it, due[0].n).replace(/^./, c => c.toUpperCase()) + " (" + fmtDate(due[0].it.d) + ")", tag: "petcare-" + today }
      : { title: `${due.length} pet care reminders`, body: due.map(({ it, n }) => line(it, n)).join("\n"), tag: "petcare-" + today });
  }
  if (medDue.length) {
    payloads.push(medDue.length === 1
      ? { title: `${medDue[0].m.pet} · ${medDue[0].m.n}`, body: `Time for ${medDue[0].m.dose ? medDue[0].m.dose : "the dose"} (${medDue[0].t})`, tag: "petcare-med-" + medDue[0].k }
      : { title: "Medication time", body: medDue.map(({ m, t }) => `${m.pet} · ${m.n}${m.dose ? " · " + m.dose : ""} (${t})`).join("\n"), tag: "petcare-med-" + today + nowMin });
  }
  if (!payloads.length) { console.log("Nothing to send right now."); process.exit(0); }
}

if (!cfg.sub || !cfg.vapid) { if (test) report(false, "Notifications are not turned on in the app."); console.log("Notifications are not turned on in the app yet."); process.exit(0); }
webpush.setVapidDetails("mailto:noreply@petcare.app", cfg.vapid.pub, cfg.vapid.priv);
for (const payload of payloads) {
  try {
    await webpush.sendNotification(cfg.sub, JSON.stringify(payload), { TTL: 3 * 3600, urgency: "high" });
    console.log("Sent:", payload.title, "|", payload.body.replace(/\n/g, " / "));
  } catch (e) {
    report(false, e.statusCode === 404 || e.statusCode === 410 ? "This phone's subscription expired. Turn notifications off and on again." : "Apple rejected the push (" + (e.statusCode || "") + " " + String(e.body || e.message).slice(0, 120) + ").");
    if (e.statusCode === 404 || e.statusCode === 410) console.error("The phone's subscription expired. Open Petcare > Settings and turn notifications on again.");
    else console.error("Push failed:", e.statusCode || "", e.body || e.message);
    process.exit(1);
  }
}
if (test) report(true, "Test notification sent.");
if (careSent) fs.writeFileSync(LAST, today + "\n");
if (medDue.length) fs.writeFileSync(MEDS, JSON.stringify({ d: today, k: medSent.concat(medDue.map(x => x.k)) }) + "\n");
