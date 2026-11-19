# Binance Futures Demo Bot

The active app is implemented in Node.js and uses CCXT's Binance Futures Demo endpoint. The earlier Python files (`bot.py`, `dashboard.py`, and `requirements.txt`) are retained as reference; the Render Docker image runs `bot.js` and `dashboard.js` only. No API credentials are stored in the repository.

## Web dashboard and 24/7 hosting

`dashboard.js` provides a password-protected website to save demo API credentials, start and stop the bot, and inspect recent logs. Credentials are encrypted with AES-256-GCM before they are written to the persistent disk.

`render.yaml` configures a single Render web service in Singapore, a health check, a persistent disk, and generated session/encryption secrets. Render requires a paid service for persistent disks; the disk preserves encrypted credentials and bot state across restarts. See [Render persistent disk docs](https://render.com/docs/disks) and [Render web service docs](https://render.com/docs/web-services).

To deploy, connect this private GitHub repository to Render and create a Blueprint from the repo. Set `APP_PASSWORD` to a strong unique password when prompted. Render generates `SESSION_SECRET` and `APP_ENCRYPTION_KEY`. After deployment, open the HTTPS service URL, sign in, enter **Binance Futures Demo** API credentials, and press Start.

Keep `APP_ENCRYPTION_KEY` unchanged and backed up securely; losing or changing it makes saved credentials unreadable. Keep the Render service at one instance. Use demo API keys with futures trading permission and no withdrawal permission. Do not enter live Binance API credentials.

## Trading settings

| Setting | Value |
|---|---:|
| Timeframe | 30m |
| Trade direction | Both |
| Fast EMA / Slow EMA | 9 / 21 |
| RSI length / middle line | 14 / 50 |
| Minimum EMA gap | $5 |
| Slope lookback / minimum move | 4 bars / $2.5 |
| Stop buffer | $6 |
| Risk/reward multiplier | 3.7 |
| Active session | 07:00–20:00 UTC |

The RSI middle-line setting of 50 appears in the TradingView UI but is not used in the supplied Pine entry conditions, which use RSI > 55 for longs and RSI < 45 for shorts.

VWAP resets daily in UTC in the Node.js implementation. TradingView's session anchoring can differ, so VWAP values may not match exactly. Market order fills also differ from TradingView's backtest close price.

## Run locally

Use Node.js 20 or newer:

```sh
npm install
export BINANCE_DEMO_API_KEY='your-demo-api-key'
export BINANCE_DEMO_SECRET_KEY='your-demo-secret'
node bot.js
```

For the dashboard, set `APP_PASSWORD`, `SESSION_SECRET`, and `APP_ENCRYPTION_KEY` in the environment. Generate the encryption key with:

```sh
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))'
```

Then run `npm start`. For local HTTP only, set `COOKIE_SECURE=0`; public hosting must use HTTPS.

The default symbol is `XAU/USDT:USDT`. The bot checks whether the symbol is available in Binance Futures Demo and stops if it is not. You can select a supported USDⓈ-M demo market with `SYMBOL`. `ORDER_QTY` defaults to `0.01` and can be overridden in the environment. `TRADE_DIR` accepts `Both`, `Long Only`, or `Short Only` and defaults to `Both`. During 07:00–20:00 UTC, the bot checks each completed 30-minute candle once and polls every 20 seconds.
