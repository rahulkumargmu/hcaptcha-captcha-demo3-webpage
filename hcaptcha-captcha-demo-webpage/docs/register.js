// docs/register.js  (also works if you move it to /public)
(() => {
  // ⬇️ Replace with your actual Vercel deployment URL (no trailing slash)
  const VERCEL_BASE = 'https://<your-project>.vercel.app';

  const isGithubPages = location.hostname.endsWith('.github.io');
  // Always hit the serverless route /api/register
  const API_URL = (isGithubPages ? VERCEL_BASE : '') + '/api/register';

  function getHcaptchaToken() {
    if (window.hcaptcha && typeof hcaptcha.getResponse === 'function') {
      return hcaptcha.getResponse();
    }
    const el = document.querySelector('textarea[name="h-captcha-response"]');
    return el ? el.value : '';
  }

  function resetHcaptcha() {
    if (window.hcaptcha && typeof hcaptcha.reset === 'function') {
      hcaptcha.reset();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('registerForm');
    const submitBtn = form.querySelector('button[type="submit"]');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const name = document.getElementById('registerName').value.trim();
      const email = document.getElementById('registerEmail').value.trim();
      const password = document.getElementById('registerPassword').value;
      const confirmPassword = document.getElementById('registerConfirmPassword').value;

      if (!name || !email || !password) {
        alert('Please fill out all required fields.');
        return;
      }
      if (password !== confirmPassword) {
        alert('Passwords do not match.');
        return;
      }

      const token = getHcaptchaToken();
      if (!token) {
        alert('Please complete the hCaptcha challenge.');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';

      try {
        const resp = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, password, token })
        });
        const result = await resp.json();

        if (result.success) {
          alert('Registration successful!');
          form.reset();
          resetHcaptcha();
        } else {
          alert('Registration failed: ' + (result.message || 'Unknown error.'));
          resetHcaptcha();
        }
      } catch (err) {
        console.error('Register error:', err);
        alert('Network or server error. Please try again.');
        resetHcaptcha();
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Register';
      }
    });
  });
})();
