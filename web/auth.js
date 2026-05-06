const form = document.getElementById("auth-form");
const errorEl = document.getElementById("auth-error");

const ERROR_MESSAGES = {
  invalid_email: "that doesn't look like a valid email",
  password_too_short: "password must be at least 8 characters",
  password_too_long: "password is too long",
  missing_credentials: "fill in both email and password",
  invalid_credentials: "wrong email or password",
  email_taken: "that email is already registered",
  hash_failed: "couldn't create the account, try again",
  db_error: "database error, try again in a moment",
  network_error: "network error",
};

function showError(code) {
  errorEl.textContent = ERROR_MESSAGES[code] || (code ? `error: ${code}` : "something went wrong");
  errorEl.hidden = false;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.hidden = true;

  const fd = new FormData(form);
  const body = JSON.stringify({ email: fd.get("email"), password: fd.get("password") });
  const endpoint = form.dataset.endpoint;

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (_e) {
    showError("network_error");
    return;
  }

  let data = null;
  try { data = await res.json(); } catch (_e) { data = null; }

  if (!res.ok) {
    showError(data && data.error);
    return;
  }
  window.location.href = "/";
});
