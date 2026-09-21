export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }
  const { name, email, password, token } = req.body || {};
  if (!name || !email || !password || !token) {
    return res
      .status(400)
      .json({ success: false, message: 'Missing required fields or CAPTCHA token.' });
  }
  const secret = process.env.HCAPTCHA_SECRET;
  if (!secret) {
    return res.status(500).json({ success: false, message: 'Server not configured.' });
  }
  // real client IP if present
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    '';

  const body = new URLSearchParams({
    secret,
    response: token,
    remoteip: ip
  });

  try {
    const verify = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const result = await verify.json();

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: 'CAPTCHA verification failed.',
        errors: result['error-codes'] || []
      });
    }
    return res.status(200).json({ success: true, message: 'Registration successful.' });
  } catch (err) {
    return res.status(502).json({ success: false, message: 'Verification service error.' });
  }
}
