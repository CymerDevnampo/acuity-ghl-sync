# Acuity → GHL Status Sync

Automatically moves GHL pipeline opportunities when Acuity appointment label colors change.

## Color → Pipeline Stage Mapping

| Acuity Color | GHL Pipeline Stage |
|---|---|
| 🟠 Orange | Follow-up |
| 🔵 Blue | Invoice Sent |
| 🟡 Yellow | Rescheduled |
| 🔴 Red | No Show |
| 🟢 Green | Completed |
| ⬜ Gray | In Progress |
| 🟣 Violet | Closed |

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Start the server
```bash
node index.js
```

### 3. Deploy to a public server
You need a public URL for Acuity webhooks. Options:
- **Railway** (recommended, free tier): https://railway.app
- **Render**: https://render.com
- **ngrok** (for testing): `npx ngrok http 3000`

### 4. Add Webhook in Acuity
1. Go to Acuity → **Integrations** → **Webhooks** → Edit
2. Add your server URL: `https://YOUR-SERVER.com/webhook/acuity`
3. Select events: ✅ Appointment Scheduled, ✅ Rescheduled, ✅ Changed, ✅ Canceled
4. Save

### 5. Make sure GHL Pipeline stages match EXACTLY
Your GHL pipeline must have stages named:
- `Follow-up`
- `Invoice Sent`
- `Rescheduled`
- `No Show`
- `Completed`
- `In Progress`
- `Closed`

Visit `http://YOUR-SERVER:3000/` to see what stages were found.

## How It Works

1. Staff changes color label on appointment in Acuity
2. Acuity fires webhook to this server
3. Server fetches full appointment details (including color)
4. Maps color → GHL stage name
5. Finds contact in GHL by email
6. Moves their pipeline opportunity to the matching stage
7. If no opportunity exists yet, creates one automatically

## Troubleshooting

- Check server logs for detailed output on each webhook
- Visit `/` endpoint to verify pipeline stages loaded correctly
- Make sure GHL stage names match exactly (case-sensitive)
