(() => {
  const API_URL = '/api/register';

  let widgetId = null;
  let pendingFormData = null;

  // Form-data validator — runs before we trigger hCaptcha
  function validateForm() {
    const name = document.getElementById('registerName').value.trim();
    const email = document.getElementById('registerEmail').value.trim();
    const password = document.getElementById('registerPassword').value;
    const confirmPassword = document.getElementById('registerConfirmPassword').value;

    if (!name || !email || !password) {
      alert('Please fill out all required fields.');
      return null;
    }
    if (password !== confirmPassword) {
      alert('Passwords do not match.');
      return null;
    }
    return { name, email, password };
  }

  async function submitRegistration(token) {
    const submitBtn = document.querySelector('#registerForm button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...pendingFormData, token })
      });
      const result = await resp.json();

      if (result.success) {
        alert('Registration successful!');
        document.getElementById('registerForm').reset();
      } else {
        alert('Registration failed: ' + (result.message || 'Unknown error.'));
      }
    } catch (err) {
      console.error('Register error:', err);
      alert('Network or server error. Please try again.');
    } finally {
      hcaptcha.reset(widgetId);
      pendingFormData = null;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Register';
    }
  }

  // hCaptcha calls these by name — must be on window
  window.onHcaptchaSuccess = (token) => {
    if (pendingFormData) submitRegistration(token);
  };
  window.onHcaptchaError = (err) => {
    console.error('hCaptcha error:', err);
    alert('CAPTCHA error. Please try again.');
    pendingFormData = null;
  };
  window.onHcaptchaExpired = () => {
    pendingFormData = null;
  };

  // hCaptcha calls this once the SDK is ready
  window.onHcaptchaLoad = () => {
    widgetId = hcaptcha.render('hcaptcha-widget');
  };

  document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('registerForm');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const data = validateForm();
      if (!data) return;
      pendingFormData = data;
      hcaptcha.execute(widgetId); // triggers the (silent or interactive) challenge
    });
  });
})();
