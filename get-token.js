try { require('dotenv').config(); } catch (_) {}

const { google } = require('googleapis');
const express    = require('express');
const fs         = require('fs');
const path       = require('path');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback';
const TOKEN_PATH    = path.join(__dirname, 'token.json');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in environment.');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt:      'consent',
  scope: [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/spreadsheets',
  ],
});

console.log('\n────────────────────────────────────────────────');
console.log('  Gmail + Sheets OAuth2 token generator');
console.log('────────────────────────────────────────────────');
console.log('\n1. Open this URL in your browser:\n');
console.log('  ', authUrl);
console.log('\n2. Sign in and grant access.');
console.log('3. You will be redirected to localhost — the script will finish automatically.\n');

const app = express();

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    res.status(400).send('Missing code parameter.');
    console.error('[Error] No code in callback query params.');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log('token.json saved successfully.');
    console.log('  Path:', TOKEN_PATH);
    if (tokens.refresh_token) {
      console.log('  Refresh token: present');
    } else {
      console.warn('  Warning: no refresh_token in response — re-run with a fresh Google sign-in (prompt=consent ensures it is issued).');
    }
    res.send('<h2>Done! token.json saved. You can close this tab.</h2>');
    server.close(() => process.exit(0));
  } catch (e) {
    console.error('[Error] Token exchange failed:', e.message);
    res.status(500).send('Token exchange failed: ' + e.message);
    server.close(() => process.exit(1));
  }
});

const server = app.listen(3000, () => {
  console.log('Waiting for OAuth2 callback on http://localhost:3000/oauth2callback ...\n');
});
