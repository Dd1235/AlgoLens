const tabs = document.querySelectorAll(".auth-tab");
const loginForm = document.getElementById("login-form");
const signupForm = document.getElementById("signup-form");
const loginError = document.getElementById("login-error");
const signupError = document.getElementById("signup-error");

const ERROR_MESSAGES = {
  invalid_email: "that doesn't look like a valid email",
  password_too_short: "password must be at least 8 characters",
  password_too_long: "password is too long",
  missing_credentials: "fill in both email and password",
  invalid_credentials: "wrong email or password",
  email_taken: "that email is already registered",
  hash_failed: "couldn't create the account, try again",
  db_error: "database error, try again in a moment",
  auth_required: "please log in",
};

function humanizeError(code) {
  return ERROR_MESSAGES[code] || (code ? `error: ${code}` : "something went wrong");
}

function showError(el, code) {
  el.textContent = humanizeError(code);
  el.hidden = false;
}

function hideError(el) {
  el.hidden = true;
  el.textContent = "";
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const which = tab.dataset.tab;
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    loginForm.hidden = which !== "login";
    signupForm.hidden = which !== "signup";
    hideError(loginError);
    hideError(signupError);
  });
});

async function postCreds(url, form, errorEl) {
  hideError(errorEl);
  const fd = new FormData(form);
  const body = JSON.stringify({ email: fd.get("email"), password: fd.get("password") });
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (_e) {
    showError(errorEl, "network_error");
    return;
  }
  let data = null;
  try { data = await res.json(); } catch (_e) { data = null; }
  if (!res.ok) {
    showError(errorEl, data && data.error);
    return;
  }
  window.location.href = "/";
}

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  postCreds("/api/auth/login", loginForm, loginError);
});

signupForm.addEventListener("submit", (e) => {
  e.preventDefault();
  postCreds("/api/auth/signup", signupForm, signupError);
});
