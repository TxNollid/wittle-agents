export const campaignKeys = Object.freeze(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]);
export function sanitizeCampaign(input) {
  const result = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  for (const key of campaignKeys) {
    if (typeof input[key] !== "string") continue;
    const value = input[key].replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    if (value) result[key] = value;
  }
  return result;
}
export function normalizeSignup(input) {
  if (!input || typeof input.email !== "string") throw new Error("INVALID_EMAIL");
  const email = input.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s\u0000-\u001f\u007f<>@]+@[^\s\u0000-\u001f\u007f<>@]+\.[^\s\u0000-\u001f\u007f<>@]+$/u.test(email))
    throw new Error("INVALID_EMAIL");
  return { email, utm: sanitizeCampaign(input.utm) };
}
