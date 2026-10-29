(() => {
  const API_URL = '/api/register';

  let widgetId = null;
  let pendingFormData = null;

  // Experiment instrumentation: lifecycle markers for the VM comparison collector
  // (vmc/vmc-site-collector.js). A no-op when the collector is absent or switched off with
  // ?vmc=off, and it never throws into the application. Details carry lengths, never values.
  const mark = (type, details) => {
    try {
      if (typeof window.__vmcMark === 'function') window.__vmcMark(type, details || {});
    } catch (_) {
      // never affect the application
    }
  };

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
      mark('widget_reset', { source: 'register.js:before-hcaptcha.reset', widget_id: widgetId });
      hcaptcha.reset(widgetId);
      mark('widget_reset_completed', { source: 'register.js:after-hcaptcha.reset', widget_id: widgetId });
      pendingFormData = null;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Register';
    }
  }

  // hCaptcha calls these by name — must be on window
  window.onHcaptchaSuccess = (token) => {
    mark('hcaptcha_success_callback', {
      source: 'data-callback:onHcaptchaSuccess',
      widget_id: widgetId,
      token_length: typeof token === 'string' ? token.length : null,
      pending_form_data: !!pendingFormData
    });
    if (pendingFormData) submitRegistration(token);
  };
  window.onHcaptchaError = (err) => {
    mark('hcaptcha_error', { source: 'data-error-callback:onHcaptchaError', widget_id: widgetId, error: String(err) });
    console.error('hCaptcha error:', err);
    alert('CAPTCHA error. Please try again.');
    pendingFormData = null;
  };
  window.onHcaptchaExpired = () => {
    mark('hcaptcha_expired', { source: 'data-expired-callback:onHcaptchaExpired', widget_id: widgetId });
    pendingFormData = null;
  };

  // Documented render callbacks, used only for lifecycle markers. They are passed as render
  // parameters (not data-* attributes) so the widget container markup stays unchanged. The
  // close callback reports a dismissed challenge; it is never a successful completion.
  const onHcaptchaOpen = () => mark('challenge_opened', { source: 'render-param:open-callback', widget_id: widgetId });
  const onHcaptchaClose = () => mark('challenge_dismissed', { source: 'render-param:close-callback', widget_id: widgetId });
  const onHcaptchaChalExpired = () => mark('challenge_expired', { source: 'render-param:chalexpired-callback', widget_id: widgetId });

  // Same check as the DevTools command: typeof window.hsw === "function"
  function updateHswDialog() {
    const resultEl = document.getElementById('hswResult');
    const noteEl = document.getElementById('hswNote');
    if (!resultEl || !noteEl) return;

    const value = typeof window.hsw === 'function';
    resultEl.textContent = String(value);

    const hcaptchaFrame = [...document.querySelectorAll('iframe')].some((frame) =>
      (frame.src || '').includes('hcaptcha.html')
    );

    noteEl.textContent = hcaptchaFrame
      ? 'DevTools showed true with the console set to hcaptcha.html. This box reads the page window, and that frame stays separate.'
      : '';
  }

  // hCaptcha calls this once the SDK is ready
  window.onHcaptchaLoad = () => {
    widgetId = hcaptcha.render('hcaptcha-widget', {
      'open-callback': onHcaptchaOpen,
      'close-callback': onHcaptchaClose,
      'chalexpired-callback': onHcaptchaChalExpired
    });
    mark('widget_rendered', { source: 'register.js:after-hcaptcha.render', widget_id: widgetId });
    updateHswDialog();
  };

  document.addEventListener('DOMContentLoaded', () => {
    updateHswDialog();
    setInterval(updateHswDialog, 1000);

    const form = document.getElementById('registerForm');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const data = validateForm();
      if (!data) {
        mark('form_validation_failed', { source: 'register.js:submit-handler' });
        return;
      }
      pendingFormData = data;
      mark('before_hcaptcha_execute', { source: 'register.js:submit-handler-before-hcaptcha.execute', widget_id: widgetId });
      hcaptcha.execute(widgetId); // triggers the (silent or interactive) challenge
    });
  });
})();
