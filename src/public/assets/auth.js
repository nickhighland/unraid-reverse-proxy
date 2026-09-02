import { api, BRAND_SVG } from './common.js';

document.getElementById('mark').innerHTML = BRAND_SVG;

const form = document.getElementById('form');
const errorBox = document.getElementById('error');
const submit = document.getElementById('submit');
const isSetup = form.dataset.mode === 'setup';

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  if (isSetup) {
    const confirm = document.getElementById('confirm').value;
    if (password !== confirm) {
      showError('The two passwords do not match.');
      return;
    }
  }

  submit.disabled = true;
  submit.textContent = isSetup ? 'Creating…' : 'Signing in…';
  try {
    await api(isSetup ? '/api/setup' : '/api/login', {
      method: 'POST',
      body: { username, password },
    });
    const next = new URLSearchParams(location.search).get('next');
    location.href = next && next.startsWith('/') ? next : '/admin';
  } catch (err) {
    showError(err.message);
    submit.disabled = false;
    submit.textContent = isSetup ? 'Create account' : 'Sign in';
  }
});
