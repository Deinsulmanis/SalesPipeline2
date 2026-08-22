'use strict';

require('dotenv').config();
const { google } = require('googleapis');
const express = require('express');
const fs = require('fs');
const path = require('path');

const arg = name => {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length).trim() || '';
};
const email = arg('email').toLowerCase();
const credentialsPath = arg('credentials');
if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Usage: npm run gmail:connect -- --email=name@example.com');
let downloaded = {};
if (credentialsPath) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(credentialsPath), 'utf8'));
  downloaded = parsed.web || parsed.installed || {};
}
const clientId = downloaded.client_id || process.env.GMAIL_SECONDARY_GOOGLE_CLIENT_ID;
const clientSecret = downloaded.client_secret || process.env.GMAIL_SECONDARY_GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) throw new Error('GMAIL_SECONDARY_GOOGLE_CLIENT_ID and GMAIL_SECONDARY_GOOGLE_CLIENT_SECRET are required');

const configuredRedirect = process.env.GMAIL_SECONDARY_GOOGLE_REDIRECT_URI || downloaded.redirect_uris?.find(uri => uri === 'http://localhost:3000/oauth2callback') || 'http://localhost:3000/oauth2callback';
const redirect = new URL(configuredRedirect);
if (redirect.hostname !== 'localhost') throw new Error('Secondary inbox onboarding requires a localhost GOOGLE_REDIRECT_URI');
const port = Number(redirect.port || 3000);
const redirectUri = redirect.toString();
const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const url = auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', login_hint: email, scope: ['https://www.googleapis.com/auth/gmail.modify'] });
const app = express();
let server;

app.get(redirect.pathname, async (req, res) => {
  try {
    const { tokens } = await auth.getToken(String(req.query.code || ''));
    if (!tokens.refresh_token) throw new Error('Google did not return a refresh token');
    auth.setCredentials(tokens);
    const profile = await google.gmail({ version: 'v1', auth }).users.getProfile({ userId: 'me' });
    const actual = String(profile.data.emailAddress || '').toLowerCase();
    if (actual !== email) throw new Error(`Authorized ${actual}, expected ${email}`);
    const dir = path.join(__dirname, '.gmail-tokens');
    fs.mkdirSync(dir, { recursive: true });
    const output = path.join(dir, `${email.replace(/[^a-z0-9.-]/g, '_')}.json`);
    fs.writeFileSync(output, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    res.send('<h2>Inbox verified. You can close this tab.</h2>');
    console.log(`Verified ${email}. Credential saved locally at ${output}`);
  } catch (error) {
    res.status(500).send('Authorization failed. Return to the terminal for details.');
    console.error(`Authorization failed: ${error.message}`);
  } finally { server.close(); }
});

server = app.listen(port, () => {
  console.log(`Authorize only ${email}. The credential will be stored outside git.`);
  console.log(url);
});
