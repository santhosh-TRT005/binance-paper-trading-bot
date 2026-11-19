"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const express = require("express");
const session = require("express-session");
const ccxtPromise = import("ccxt").then((module) => module.default);

const BASE = __dirname;
const DATA_DIR = path.resolve(process.env.BOT_DATA_DIR || path.join(BASE, "data"));
const STATE_FILE = path.join(DATA_DIR, "dashboard.json");
const LOG_FILE = path.join(DATA_DIR, "bot.log");
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const encryptionKey = Buffer.from(process.env.APP_ENCRYPTION_KEY || "", "base64");
if (!APP_PASSWORD || !SESSION_SECRET || encryptionKey.length !== 32) {
  throw new Error("Set APP_PASSWORD, SESSION_SECRET, and a base64 32-byte APP_ENCRYPTION_KEY before starting.");
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { desired: false, pid: null, apiKey: null, apiSecret: null }; }
}

function saveState(next) {
  const current = loadState();
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...current, ...next }), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

function decrypt(value) {
  if (!value) return "";
  const [ivText, tagText, dataText] = value.split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataText, "base64")), decipher.final()]).toString("utf8");
}

function credentials() {
  const state = loadState();
  try { return { key: decrypt(state.apiKey), secret: decrypt(state.apiSecret) }; }
  catch { return { key: "", secret: "" }; }
}

function isBotRunning(pid = loadState().pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    if (process.platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("bot.js");
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).includes("bot.js");
  } catch { return false; }
}

let launchLock = false;
function startBot() {
  if (launchLock) return;
  launchLock = true;
  try {
    const current = loadState();
    if (isBotRunning(current.pid)) {
      saveState({ desired: true });
      return;
    }
    const creds = credentials();
    if (!creds.key || !creds.secret) throw new Error("Save Binance Futures Demo API credentials first.");
    const logFd = fs.openSync(LOG_FILE, "a", 0o600);
    const child = spawn(process.execPath, [path.join(BASE, "bot.js")], {
      cwd: BASE,
      detached: true,
      env: { ...process.env, BINANCE_DEMO_API_KEY: creds.key, BINANCE_DEMO_SECRET_KEY: creds.secret },
      stdio: ["ignore", logFd, logFd],
    });
    fs.closeSync(logFd);
    child.unref();
    saveState({ pid: child.pid, desired: true });
  } finally {
    launchLock = false;
  }
}

function stopBot() {
  const state = loadState();
  if (isBotRunning(state.pid)) {
    try { process.kill(-Number(state.pid), "SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  saveState({ desired: false, pid: null });
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function loginPage(csrf, error = "") {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bot dashboard login</title>
<style>body{font:16px system-ui;background:#f4f6f8;margin:0}.box{max-width:380px;margin:12vh auto;background:white;padding:28px;border-radius:14px;box-shadow:0 8px 32px #0001}input,button{font:inherit;padding:12px;width:100%;box-sizing:border-box;margin:8px 0}button{background:#172554;color:white;border:0;border-radius:8px}</style>
<form class="box" method="post" action="/login"><h1>Binance Demo Bot</h1><p>Sign in to control the bot.</p><input type="hidden" name="csrf" value="${htmlEscape(csrf)}"><input type="password" name="password" placeholder="Dashboard password" required autofocus><button>Sign in</button>${error ? `<p>${htmlEscape(error)}</p>` : ""}</form>`;
}

function dashboardPage({ csrf, running, saved, logs, message }) {
  const tag = running ? "RUNNING" : "STOPPED";
  const tagStyle = running ? "background:#dcfce7;color:#166534" : "background:#e5e7eb;color:#374151";
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Binance Demo Bot</title>
<style>body{font:15px system-ui;background:#f4f6f8;color:#182230;margin:0}.wrap{max-width:920px;margin:30px auto;padding:0 16px}.card{background:#fff;padding:22px;border-radius:14px;margin:16px 0;box-shadow:0 4px 20px #0000000d}h1{margin-bottom:4px}.tag{display:inline-block;padding:5px 10px;border-radius:20px;${tagStyle}}input,button{font:inherit;padding:11px;border-radius:8px;border:1px solid #cbd5e1}input{display:block;width:100%;box-sizing:border-box;margin:6px 0 12px}button{cursor:pointer;background:#172554;color:white;border:0;margin-right:8px}.stop{background:#991b1b}.muted{color:#64748b;font-size:13px}pre{white-space:pre-wrap;word-break:break-word;background:#101827;color:#dbeafe;padding:14px;border-radius:8px;max-height:360px;overflow:auto}.flash{background:#fef3c7;padding:10px;border-radius:8px}.stats{display:flex;gap:12px;flex-wrap:wrap}.stat{min-width:170px;flex:1;background:#f8fafc;border-radius:10px;padding:15px}.stat strong{display:block;font-size:23px;margin-top:4px}#chart{width:100%;height:360px;display:block}.chart-wrap{overflow:hidden}</style></head><body><main class="wrap">
<h1>Binance Futures Demo Bot</h1><p>Paper trading only · XAU/USDT:USDT · 30m</p><p class="tag" id="bot-status">${tag}</p>${message ? `<p class="flash">${htmlEscape(message)}</p>` : ""}
<section class="card"><h2>Account &amp; bot status</h2><div class="stats"><div class="stat">Bot status<strong id="overview-bot">${tag}</strong></div><div class="stat">Live XAUUSDT<strong id="live-price">—</strong></div><div class="stat">Futures USDT total<strong id="usdt-total">—</strong></div><div class="stat">Available USDT<strong id="usdt-free">—</strong></div><div class="stat">Used USDT<strong id="usdt-used">—</strong></div></div><p class="muted" id="overview-note">Loading Binance Futures Demo account…</p></section>
<section class="card chart-wrap"><h2>XAUUSDT Futures · 30 minute</h2><div class="muted" id="chart-status">Loading demo market candles…</div><div class="muted" id="socket-status">Connecting to Binance live market stream…</div><svg id="chart" role="img" aria-label="XAUUSDT live 30 minute candlestick chart" viewBox="0 0 880 360" preserveAspectRatio="none"></svg></section>
<section class="card"><h2>Demo API credentials</h2><p class="muted">Encrypted before storage. Use Binance Futures Demo API keys only; never paste live keys here.</p><form method="post" action="/credentials"><input type="hidden" name="csrf" value="${htmlEscape(csrf)}"><label>API key<input name="api_key" autocomplete="off" placeholder="${saved ? "Saved; leave blank to keep current" : "Demo API key"}"></label><label>API secret<input name="api_secret" type="password" autocomplete="new-password" placeholder="${saved ? "Saved; leave blank to keep current" : "Demo API secret"}"></label><button>Save credentials</button></form></section>
<section class="card"><h2>Bot control</h2><p>Configured: <span id="configured">${saved ? "Yes" : "No"}</span></p><form method="post" action="/start" style="display:inline"><input type="hidden" name="csrf" value="${htmlEscape(csrf)}"><button ${running || !saved ? "disabled" : ""}>Start bot</button></form><form method="post" action="/stop" style="display:inline"><input type="hidden" name="csrf" value="${htmlEscape(csrf)}"><button class="stop" ${!running ? "disabled" : ""}>Stop bot</button></form><form method="post" action="/logout" style="display:inline"><input type="hidden" name="csrf" value="${htmlEscape(csrf)}"><button>Log out</button></form><p class="muted">Bot polls every 20 seconds. Keep this host online to maintain 24/7 operation.</p></section>
<section class="card"><h2>Recent bot log</h2><pre id="bot-log">${htmlEscape(logs)}</pre></section></main>
<script>
const fmt=v=>Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});let chartBars=[];
async function refreshOverview(){try{const r=await fetch('/api/overview');const d=await r.json();document.getElementById('overview-bot').textContent=d.status;document.getElementById('bot-status').textContent=d.status;document.getElementById('configured').textContent=d.configured?'Yes':'No';document.getElementById('usdt-total').textContent=d.balance?fmt(d.balance.total):'—';document.getElementById('usdt-free').textContent=d.balance?fmt(d.balance.free):'—';document.getElementById('usdt-used').textContent=d.balance?fmt(d.balance.used):'—';document.getElementById('overview-note').textContent=d.balance?'Binance Futures Demo · refreshed '+new Date().toLocaleTimeString():d.note;document.getElementById('bot-log').textContent=d.logs||'No bot output yet.'}catch(e){document.getElementById('overview-note').textContent='Unable to refresh account status: '+e.message}}
function drawChart(bars){const svg=document.getElementById('chart');svg.replaceChildren();if(!bars||bars.length<2)return;const W=880,H=360,p={l:12,r:72,t:14,b:24},values=bars.flatMap(c=>[c[2],c[3]]),min=Math.min(...values),max=Math.max(...values),span=max-min||1,xw=(W-p.l-p.r)/bars.length,y=v=>p.t+(max-v)/span*(H-p.t-p.b),make=(name,attrs)=>{const e=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [k,v]of Object.entries(attrs))e.setAttribute(k,v);svg.append(e);return e};for(let n=0;n<4;n++){const yy=p.t+n*(H-p.t-p.b)/3;make('line',{x1:p.l,y1:yy,x2:W-p.r,y2:yy,stroke:'#e2e8f0'});const t=make('text',{x:W-p.r+7,y:yy+4,fill:'#64748b','font-size':11});t.textContent=fmt(max-n*span/3)}bars.forEach((c,i)=>{const x=p.l+i*xw+xw/2,color=c[4]>=c[1]?'#16a34a':'#dc2626';make('line',{x1:x,y1:y(c[2]),x2:x,y2:y(c[3]),stroke:color,'stroke-width':1.3});make('rect',{x:x-Math.max(2,xw*.28),y:Math.min(y(c[1]),y(c[4])),width:Math.max(3,xw*.56),height:Math.max(1,Math.abs(y(c[1])-y(c[4]))),fill:color,rx:1})});const last=bars.at(-1),label=make('text',{x:W-p.r+7,y:y(last[4])-5,fill:last[4]>=last[1]?'#15803d':'#b91c1c','font-size':12,'font-weight':700});label.textContent=fmt(last[4]);document.getElementById('chart-status').textContent='Binance Futures Demo · 30m candles · updated '+new Date().toLocaleTimeString()}
async function refreshChart(){try{const r=await fetch('/api/chart');const d=await r.json();if(d.candles?.length){chartBars=d.candles;drawChart(chartBars)}else document.getElementById('chart-status').textContent=d.error||'No candles returned.'}catch(e){document.getElementById('chart-status').textContent='Chart error: '+e.message}}
function connectMarketSocket(){const s=new WebSocket('wss://demo-fstream.binance.com/market/stream?streams=xauusdt@aggTrade/xauusdt@kline_30m');s.onopen=()=>{document.getElementById('socket-status').textContent='Live WebSocket connected · price and active candle update in real time'};s.onmessage=e=>{try{const msg=JSON.parse(e.data),d=msg.data;if(d.e==='aggTrade'){document.getElementById('live-price').textContent=fmt(d.p)}else if(d.e==='kline'){const k=d.k,c=[k.t,Number(k.o),Number(k.h),Number(k.l),Number(k.c),Number(k.v)],last=chartBars.at(-1);if(last&&last[0]===c[0])chartBars[chartBars.length-1]=c;else{chartBars.push(c);if(chartBars.length>60)chartBars.shift()}drawChart(chartBars);document.getElementById('live-price').textContent=fmt(k.c)}}catch(_){}};s.onerror=()=>{document.getElementById('socket-status').textContent='Live WebSocket error · reconnecting…'};s.onclose=()=>{document.getElementById('socket-status').textContent='Live WebSocket disconnected · reconnecting in 5 seconds…';setTimeout(connectMarketSocket,5000)}}
refreshOverview();refreshChart();connectMarketSocket();setInterval(refreshOverview,15000);setInterval(refreshChart,60000);
</script></body></html>`;
}

const app = express();
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
app.use(session({
  name: "bot.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.COOKIE_SECURE === "1", maxAge: 60 * 60 * 1000 },
}));

function isAuthenticated(req) { return req.session.loggedIn === true; }
function requireAuth(req, res, next) {
  if (!isAuthenticated(req)) return res.redirect("/login");
  next();
}
function requireCsrf(req, res, next) {
  const sent = Buffer.from(String(req.body.csrf || ""));
  const expected = Buffer.from(String(req.session.csrf || ""));
  if (!sent.length || sent.length !== expected.length || !crypto.timingSafeEqual(sent, expected)) {
    return res.status(400).send("Invalid form token.");
  }
  next();
}

app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
app.get("/api/overview", requireAuth, async (_req, res) => {
  const state = loadState();
  const creds = credentials();
  const running = isBotRunning(state.pid);
  let balance = null;
  let note = creds.key ? "Unable to fetch Binance Futures Demo balance." : "Save Binance Futures Demo API credentials to load USDT balance.";
  if (creds.key && creds.secret) {
    try {
      const ccxt = await ccxtPromise;
      const exchange = new ccxt.binance({ apiKey: creds.key, secret: creds.secret, enableRateLimit: true, options: { defaultType: "future" } });
      exchange.enableDemoTrading(true);
      const result = await exchange.fetchBalance();
      const usdt = result.USDT || {};
      balance = { total: Number(usdt.total || 0), free: Number(usdt.free || 0), used: Number(usdt.used || 0) };
      note = "";
    } catch (error) { note = `Balance error: ${error.message}`; }
  }
  const logs = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8").slice(-12_000) : "No bot output yet.";
  res.json({ status: running ? "RUNNING" : "STOPPED", configured: Boolean(creds.key), balance, note, logs });
});
app.get("/api/chart", requireAuth, async (_req, res) => {
  try {
    const ccxt = await ccxtPromise;
    const exchange = new ccxt.binance({ enableRateLimit: true, options: { defaultType: "future" } });
    exchange.enableDemoTrading(true);
    const candles = await exchange.fetchOHLCV("XAU/USDT:USDT", "30m", undefined, 60);
    res.json({ candles });
  } catch (error) {
    res.json({ candles: [], error: `Unable to load Binance Futures Demo XAUUSDT candles: ${error.message}` });
  }
});
app.get("/login", (req, res) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString("hex");
  res.send(loginPage(req.session.csrf));
});
app.post("/login", requireCsrf, (req, res) => {
  const provided = Buffer.from(String(req.body.password || ""));
  const expected = Buffer.from(APP_PASSWORD);
  const valid = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  if (!valid) {
    req.session.csrf = crypto.randomBytes(32).toString("hex");
    return res.status(401).send(loginPage(req.session.csrf, "Password did not match."));
  }
  req.session.regenerate((error) => {
    if (error) return res.status(500).send("Unable to start session.");
    req.session.loggedIn = true;
    req.session.csrf = crypto.randomBytes(32).toString("hex");
    req.session.cookie.maxAge = 60 * 60 * 1000;
    res.redirect("/");
  });
});

app.get("/", requireAuth, (req, res) => {
  let state = loadState();
  let running = isBotRunning(state.pid);
  if (state.desired && !running) {
    try { startBot(); running = true; }
    catch { saveState({ desired: false }); }
  }
  const logs = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8").slice(-12_000) : "No bot output yet.";
  res.send(dashboardPage({ csrf: req.session.csrf, running, saved: Boolean(credentials().key), logs, message: req.session.message || "" }));
  delete req.session.message;
});

app.post("/credentials", requireAuth, requireCsrf, (req, res) => {
  if (isBotRunning()) req.session.message = "Stop the bot before changing credentials.";
  else {
    const key = String(req.body.api_key || "").trim();
    const secret = String(req.body.api_secret || "").trim();
    if (key || secret) {
      if (!key || !secret) req.session.message = "Enter both the API key and secret.";
      else {
        const state = loadState();
        saveState({ apiKey: encrypt(key), apiSecret: encrypt(secret) });
        req.session.message = "Demo credentials saved encrypted on this host.";
      }
    } else req.session.message = "No changes made.";
  }
  res.redirect("/");
});

app.post("/start", requireAuth, requireCsrf, (req, res) => {
  try { startBot(); req.session.message = "Bot started. Check the log for exchange errors."; }
  catch (error) { req.session.message = error.message; }
  res.redirect("/");
});
app.post("/stop", requireAuth, requireCsrf, (req, res) => {
  try { stopBot(); req.session.message = "Stop requested."; }
  catch (error) { req.session.message = error.message; }
  res.redirect("/");
});
app.post("/logout", requireAuth, requireCsrf, (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

if (loadState().desired) {
  try { startBot(); }
  catch (error) { console.error("Could not restore bot after dashboard start:", error.message); saveState({ desired: false }); }
}

const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => console.log(`Dashboard listening on port ${port}`));
