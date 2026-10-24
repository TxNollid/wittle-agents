import { mountButterflies } from "./fieldglow-butterflies.js";
import { campaignKeys, sanitizeCampaign } from "./signup-fields.mjs";
export function campaignContext(search = "") {
  const params = new URLSearchParams(search);
  return sanitizeCampaign(Object.fromEntries(campaignKeys.map((key) => [key, params.get(key)])));
}

if (typeof document !== "undefined") {
  const context = campaignContext(location.search);
  for (const link of document.querySelectorAll("[data-campaign-link]")) {
    const target = new URL(link.getAttribute("href"), location.origin);
    const query = new URLSearchParams(context).toString();
    link.href = target.pathname + (query ? `?${query}` : "");
  }
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const staticMotion = new URLSearchParams(location.search).get("motion") === "static";
  const root = document.documentElement;
  const control = document.querySelector(".motion-toggle");
  if (control) {
    let paused = false;
    const update = () => {
      root.dataset.motionPaused = String(paused || reduced.matches || staticMotion || document.hidden);
      control.hidden = reduced.matches || staticMotion;
      control.setAttribute("aria-pressed", String(paused));
      control.textContent = paused ? "Resume motion" : "Pause motion";
    };
    control.addEventListener("click", () => { paused = !paused; update(); });
    reduced.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    update();
  }
  mountButterflies(document.querySelector(".page-shell"), {
    preset: "hero", count: 4, mobileCap: 3, startDelay: 0,
  });
  const form = document.querySelector(".signup-form");
  if (form) {
    const field = form.querySelector("#email");
    const button = form.querySelector("[type=submit]");
    const status = form.querySelector("#signup-status");
    let submitting = false;
    field.addEventListener("input", () => { field.removeAttribute("aria-invalid"); });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submitting || !form.reportValidity()) return;
      submitting = true;
      button.disabled = true;
      button.textContent = "Saving…";
      form.setAttribute("aria-busy", "true");
      status.dataset.state = "pending";
      status.textContent = "Saving your place…";
      try {
        const response = await fetch(form.action, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: field.value.trim(), utm: context }),
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        });
        const result = await response.json();
        if (!response.ok || result.saved !== true) {
          if (response.status === 400) {
            field.setAttribute("aria-invalid", "true");
            field.focus();
            throw new Error("email");
          }
          throw new Error("save");
        }
        status.dataset.state = "success";
        status.textContent = "You’re on the list. We’ll be in touch.";
        field.value = "";
      } catch (error) {
        status.dataset.state = "error";
        status.textContent = error.message === "email" ? "Please enter a valid email address." : "We couldn’t save your email. Please try again.";
      } finally {
        submitting = false;
        button.disabled = false;
        button.textContent = "Join the list";
        form.removeAttribute("aria-busy");
      }
    });
  }
}
