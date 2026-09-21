require('dotenv').config();

const express = require('express');
const https = require('https');
const path = require('path');

const app = express();

const HCAPTCHA_SECRET = process.env.HCAPTCHA_SECRET;
const HCAPTCHA_SITEKEY = process.env.HCAPTCHA_SITEKEY;

const users = []; // demo storage

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Home
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Optional: users page
app.get('/users', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'users.html'));
});

// Registration route (hCaptcha validation enforced).
// /api/register matches the frontend and the Vercel serverless handler.
function handleRegister(req, res) {
  const { name, email, password, token } = req.body;

  if (!name || !email || !password || !token) {
    return res.json({ success: false, message: 'Missing required fields or CAPTCHA token.' });
  }

  if (!HCAPTCHA_SECRET) {
    return res.status(500).json({
      success: false,
      message: 'Server not configured. Set HCAPTCHA_SECRET in .env.'
    });
  }

  // log the token so you can see it
  console.log('hCaptcha token:', token);

  // Build x-www-form-urlencoded body for hCaptcha /siteverify
  const body = new URLSearchParams({
    secret: HCAPTCHA_SECRET,
    response: token,
    // sitekey is optional for /siteverify, but allowed; remoteip recommended
    // sitekey: HCAPTCHA_SITEKEY,
    remoteip: req.ip
  }).toString();

  const options = {
    hostname: 'api.hcaptcha.com',
    path: '/siteverify',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  const verifyReq = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', (chunk) => (data += chunk));
    apiRes.on('end', () => {
      try {
        const result = JSON.parse(data);
        if (result.success) {
          const exists = users.find((u) => u.email === email);
          if (exists) {
            return res.json({ success: false, message: 'Email is already registered.' });
          }
          users.push({ name, email, password });
          console.log(`New user registered: ${email}`);
          return res.json({ success: true, message: 'Registration successful.' });
        } else {
          console.warn('hCaptcha failed:', result['error-codes']);
          return res.json({
            success: false,
            message: 'CAPTCHA verification failed. Please try again.'
          });
        }
      } catch (err) {
        console.error('Error parsing hCaptcha response:', err);
        return res.json({ success: false, message: 'Error verifying CAPTCHA.' });
      }
    });
  });

  verifyReq.on('error', (err) => {
    console.error('Verification request error:', err);
    res.json({ success: false, message: 'Verification service error.' });
  });

  verifyReq.write(body);
  verifyReq.end();
}

app.post('/register', handleRegister);
app.post('/api/register', handleRegister);

// Run locally
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

module.exports = app;