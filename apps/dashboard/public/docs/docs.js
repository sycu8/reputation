import { initTheme } from "../theme.js";

const toast = document.querySelector("#toast");
const copyBtn = document.querySelector("#copyBaseBtn");

function notify(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 2400);
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    notify("Copied to clipboard");
  } catch {
    notify("Copy failed — select the URL manually");
  }
}

function resolveDefaultBase() {
  const host = window.location.hostname || "127.0.0.1";
  if (location.port === "8788" || host === "localhost" || host === "127.0.0.1") {
    return `http://${host}:8787`;
  }
  if (host.endsWith(".workers.dev")) {
    return "https://reputa-api-production.sycu-lee.workers.dev";
  }
  return "https://reputation.orangecloud.vn/api";
}

const defaultBase = resolveDefaultBase();
const display = document.querySelector("#baseUrlDisplay");
if (display) display.textContent = defaultBase;
copyBtn?.setAttribute("data-copy", defaultBase);

copyBtn?.addEventListener("click", () => {
  copyText(copyBtn.getAttribute("data-copy") || defaultBase);
});

document.querySelectorAll(".code-block").forEach((block) => {
  block.addEventListener("dblclick", () => {
    copyText(block.querySelector("code")?.textContent || "");
  });
});

const tocLinks = [...document.querySelectorAll(".toc a")];
const sections = tocLinks
  .map((link) => document.querySelector(link.getAttribute("href") || ""))
  .filter(Boolean);

function syncToc() {
  const offset = window.scrollY + 120;
  let current = sections[0];
  for (const section of sections) {
    if (section.offsetTop <= offset) current = section;
  }
  tocLinks.forEach((link) => {
    link.classList.toggle("active", link.getAttribute("href") === `#${current?.id}`);
  });
}

window.addEventListener("scroll", syncToc, { passive: true });
syncToc();
initTheme();
