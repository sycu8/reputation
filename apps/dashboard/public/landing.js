const SESSION_TOKEN_KEY = "pulsewatch-session";
const SESSION_EMAIL_KEY = "pulsewatch-session-email";
const PRODUCTION_API_BASE = "https://reputa-api-production.sycu-lee.workers.dev";
const CUSTOM_HOST_API_BASE = "https://reputation.orangecloud.vn/api";

const year = document.querySelector("#year");
if (year) year.textContent = String(new Date().getFullYear());

const toggle = document.querySelector("#navToggle");
const mobileNav = document.querySelector("#mobileNav");
toggle?.addEventListener("click", () => {
  const open = toggle.getAttribute("aria-expanded") === "true";
  toggle.setAttribute("aria-expanded", open ? "false" : "true");
  if (mobileNav) mobileNav.hidden = open;
});

mobileNav?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    if (!mobileNav || !toggle) return;
    mobileNav.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  });
});

const reveals = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.16, rootMargin: "0px 0px -8% 0px" }
  );
  reveals.forEach((node, index) => {
    node.style.transitionDelay = `${Math.min(index % 5, 4) * 60}ms`;
    observer.observe(node);
  });
} else {
  reveals.forEach((node) => node.classList.add("is-visible"));
}

document.addEventListener("click", (event) => {
  const action = event.target.closest(".btn, .text-link, .nav-links a");
  if (!action) return;
  action.classList.add("is-pressed");
  window.setTimeout(() => action.classList.remove("is-pressed"), 180);
});

function isLocalHost() {
  const host = window.location.hostname || "127.0.0.1";
  return location.port === "8788" || host === "localhost" || host === "127.0.0.1";
}

function resolveApiBase() {
  try {
    const stored = localStorage.getItem("apiBase");
    if (stored) {
      const url = new URL(stored);
      const custom = new URL(CUSTOM_HOST_API_BASE);
      if (location.protocol === "https:" && url.protocol === "http:") {
        /* ignore insecure override */
      } else if (
        url.hostname === custom.hostname
        && url.pathname.replace(/\/$/, "") === custom.pathname.replace(/\/$/, "")
      ) {
        localStorage.setItem("apiBase", PRODUCTION_API_BASE);
        return PRODUCTION_API_BASE;
      } else {
        return stored.replace(/\/$/, "");
      }
    }
  } catch {
    /* ignore */
  }
  if (isLocalHost()) {
    const host = window.location.hostname || "127.0.0.1";
    return `http://${host}:8787`;
  }
  return PRODUCTION_API_BASE;
}

function getSessionToken() {
  try {
    return sessionStorage.getItem(SESSION_TOKEN_KEY) || localStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

function getCachedEmail() {
  try {
    return sessionStorage.getItem(SESSION_EMAIL_KEY) || localStorage.getItem(SESSION_EMAIL_KEY) || "";
  } catch {
    return "";
  }
}

function setCachedEmail(email) {
  try {
    if (email) {
      sessionStorage.setItem(SESSION_EMAIL_KEY, email);
      localStorage.setItem(SESSION_EMAIL_KEY, email);
    } else {
      sessionStorage.removeItem(SESSION_EMAIL_KEY);
      localStorage.removeItem(SESSION_EMAIL_KEY);
    }
  } catch {
    /* ignore */
  }
}

function setAuthMode(signedIn, email = "") {
  document.querySelectorAll("[data-auth-guest]").forEach((node) => {
    node.hidden = signedIn;
    node.classList.toggle("hidden", signedIn);
  });
  document.querySelectorAll("[data-auth-user]").forEach((node) => {
    node.hidden = !signedIn;
    node.classList.toggle("hidden", !signedIn);
    if (node.matches("[data-auth-email]") && email) {
      node.textContent = email;
      node.setAttribute("title", email);
    }
  });
  document.body.classList.toggle("is-signed-in", signedIn);
  document.body.classList.add("auth-chrome-ready");
}

async function refreshLandingAuth() {
  const token = getSessionToken();
  if (!token) {
    setCachedEmail("");
    setAuthMode(false);
    return;
  }

  const cached = getCachedEmail();
  // Optimistic signed-in chrome so homepage CTAs update without waiting on /v1/me.
  setAuthMode(true, cached || "Account");

  try {
    const response = await fetch(`${resolveApiBase()}/v1/me`, {
      credentials: "include",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`
      }
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        setCachedEmail("");
        setAuthMode(false);
        return;
      }
      throw new Error("auth");
    }
    const data = await response.json();
    const email = data?.user?.email || cached || "Account";
    setCachedEmail(email === "Account" ? "" : email);
    setAuthMode(true, email);
  } catch {
    // Network blip: keep optimistic signed-in chrome when a session token exists.
    setAuthMode(true, cached || "Account");
  }
}

refreshLandingAuth();
window.addEventListener("pageshow", () => {
  refreshLandingAuth();
});
window.addEventListener("focus", () => {
  refreshLandingAuth();
});
window.addEventListener("storage", (event) => {
  if (event.key === SESSION_TOKEN_KEY || event.key === SESSION_EMAIL_KEY) {
    refreshLandingAuth();
  }
});
