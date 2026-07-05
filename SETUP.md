# ScaleLab AI — Sales Pipeline Setup

This app stores leads in Google Sheets. One-time setup takes about 10 minutes.

---

## Step 1 — Create the Google Sheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new spreadsheet
2. Rename the default "Sheet1" tab to exactly: **Leads**
3. Copy the spreadsheet ID from the URL:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`
4. Save this ID — you'll need it in Step 4

The app will automatically create the header row on first launch.

---

## Step 2 — Create a Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Click the project dropdown → **New Project**
3. Name it `ScaleLab Pipeline` → **Create**
4. Make sure the new project is selected

---

## Step 3 — Enable the Sheets API + Create Credentials

**Enable the API:**
1. In the left sidebar → **APIs & Services** → **Library**
2. Search for `Google Sheets API` → click it → **Enable**

**Create an API Key:**
1. **APIs & Services** → **Credentials** → **Create Credentials** → **API key**
2. Copy the key, then click **Edit API Key**
3. Under *Application restrictions* → **HTTP referrers**
4. Add your allowed origins:
   - `http://localhost:*` (for local testing)
   - `https://your-site.netlify.app` (once deployed)
5. Under *API restrictions* → **Restrict key** → select `Google Sheets API`
6. Save

**Create an OAuth 2.0 Client ID:**
1. **Credentials** → **Create Credentials** → **OAuth client ID**
2. If prompted, configure the OAuth consent screen first:
   - User type: **External**
   - App name: `ScaleLab Pipeline`
   - Add your email as a test user
   - Scopes: add `https://www.googleapis.com/auth/spreadsheets`
3. Back in Create OAuth client ID:
   - Application type: **Web application**
   - Name: `ScaleLab Pipeline`
   - Authorised JavaScript origins — add:
     - `http://localhost:8080` (or whatever port you use locally)
     - `https://your-site.netlify.app`
4. Click **Create** → copy the **Client ID**

---

## Step 4 — Fill in GOOGLE_CONFIG

Open `index.html` and find this block near the top of the `<script>` tag:

```javascript
const GOOGLE_CONFIG = {
  CLIENT_ID:      'PASTE_HERE',
  API_KEY:        'PASTE_HERE',
  SPREADSHEET_ID: 'PASTE_HERE',
  SHEET_NAME:     'Leads'
};
```

Replace the three `'PASTE_HERE'` values with your credentials:

```javascript
const GOOGLE_CONFIG = {
  CLIENT_ID:      '123456789-abc.apps.googleusercontent.com',
  API_KEY:        'AIzaSy...',
  SPREADSHEET_ID: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
  SHEET_NAME:     'Leads'
};
```

---

## Step 5 — Serve the app (don't open as file://)

Google OAuth does **not** work when opened directly as a `file://` URL.
You must serve it over HTTP, even locally:

```bash
# Option A — Node (if installed)
npx serve .

# Option B — Python
python -m http.server 8080

# Option C — Deploy to Netlify
# Drag the folder to netlify.com/drop
```

Then open `http://localhost:8080` (or your Netlify URL) in your browser.

---

## Step 6 — First Launch

1. Open the app — you'll see the **Sign in with Google** screen
2. Click **Sign in with Google** and grant Sheets access
3. If you had leads in localStorage from the previous version, they'll be automatically migrated to your Sheet on first sign-in
4. After that, every add/edit/delete syncs instantly to the Sheet

---

## Sheet Structure Reference

The app manages these 17 columns in the **Leads** sheet:

| Column | Field |
|--------|-------|
| A | id |
| B | type (realtor / trade) |
| C | first |
| D | last |
| E | brokerage |
| F | tradeType |
| G | company |
| H | city |
| I | cityTrade |
| J | phone |
| K | email |
| L | website |
| M | stage |
| N | priority |
| O | followup |
| P | notes |
| Q | created |

Do not rearrange or rename these columns — the app reads by position.

---

## Fallback

If something goes wrong, `index-backup-localstorage.html` is a full working copy of the previous version that runs from localStorage with no Google account required.
