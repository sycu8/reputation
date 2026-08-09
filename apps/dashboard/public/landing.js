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
