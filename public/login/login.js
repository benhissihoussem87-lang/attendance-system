const form = document.getElementById('loginForm');
const status = document.getElementById('loginStatus');

form.addEventListener('submit', async event => {
  event.preventDefault();
  status.textContent = 'Signing in.';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        email: document.getElementById('email').value,
        password: document.getElementById('password').value
      })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error((body.details && body.details.error) || body.message || 'login_failed');
    }
    window.location.assign('/app/');
  } catch (err) {
    status.textContent = 'Login failed: ' + (err && err.message ? err.message : 'unknown error');
  }
});
