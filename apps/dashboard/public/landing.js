const SESSION_TOKEN_KEY = "pulsewatch-session";
const PRODUCTION_API_BASE = "https://reputation.orangecloud.vn/api";

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

function isLocalHost() {
  const host = window.location.hostname || "127.0.0.1";
  return location.port === "8788" || host === "localhost" || host === "127.0.0.1";
}

function resolveApiBase() {
  try {
    const stored = localStorage.getItem("apiBase");
    if (stored) {
      const url = new URL(stored);
      if (!(location.protocol === "https:" && url.protocol === "http:")) return stored.replace(/\/$/, "");
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

function setAuthMode(signedIn, email = "") {
  document.querySelectorAll("[data-auth-guest]").forEach((node) => {
    node.hidden = signedIn;
    node.classList.toggle("hidden", signedIn);
  });
  document.querySelectorAll("[data-auth-user]").forEach((node) => {
    node.hidden = !signedIn;
    node.classList.toggle("hidden", !signedIn);
    if (node.matches(".nav-account") && email) {
      node.textContent = email;
    }
  });
  document.body.classList.toggle("is-signed-in", signedIn);
}

async function refreshLandingAuth() {
  const token = getSessionToken();
  if (!token) {
    setAuthMode(false);
    return;
  }
  try {
    const response = await fetch(`${resolveApiBase()}/v1/me`, {
      credentials: "include",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`
      }
    });
    if (!response.ok) throw new Error("auth");
    const data = await response.json();
    const email = data?.user?.email || "Account";
    setAuthMode(true, email);
  } catch {
    setAuthMode(false);
  }
}

refreshLandingAuth();
