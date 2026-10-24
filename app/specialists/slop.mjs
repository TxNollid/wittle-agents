// Deterministic AI-tell detector for the Anti-Slop Editor.
// Score = weighted hits per 100 words. Used as the pre-delivery gate and as the
// before/after number shown to the buyer.

export const SLOP_VERSION = 'slop-v1';

const PHRASES = [
  'delve', 'delves', 'delving', 'tapestry', 'testament to', 'in today\'s fast-paced', 'in today\'s digital',
  'ever-evolving', 'ever-changing', 'navigate the complexities', 'navigating the complexities', 'unlock the power',
  'unleash', 'elevate your', 'game-changer', 'game changer', 'seamless', 'seamlessly', 'robust', 'leverage',
  'cutting-edge', 'revolutionize', 'revolutionizing', 'embark on', 'journey', 'realm', 'landscape',
  'it\'s important to note', 'it is important to note', 'it\'s worth noting', 'it is worth noting',
  'in conclusion', 'in summary', 'ultimately,', 'moreover,', 'furthermore,', 'additionally,',
  'whether you\'re', 'look no further', 'dive into', 'deep dive', 'harness', 'empower', 'foster',
  'pivotal', 'paramount', 'meticulous', 'meticulously', 'vibrant', 'bustling', 'boasts', 'nestled',
  'a myriad of', 'plethora', 'synergy', 'holistic', 'transformative', 'unparalleled', 'next level',
  'i hope this helps', 'great question', 'let\'s dive', 'buckle up', 'here\'s the thing', 'the best part?',
];

const PATTERNS = [
  { rule: 'not_just_but', weight: 2, re: /\bnot (?:just|only|merely) [^.!?\n]{1,60}?,? but (?:also )?/gi },
  { rule: 'its_not_x_its_y', weight: 2, re: /\b(?:it'?s|this is|that'?s) not (?:about )?[^.!?\n]{1,40}?[.,;—-]+\s*(?:it'?s|this is|that'?s) /gi },
  { rule: 'em_dash', weight: 1, re: /—/g },
  { rule: 'colon_reveal', weight: 1, re: /\b(?:the result|the answer|the secret|the truth|the catch|here'?s why)\s*\?|:\s*(?:the result|the answer)\b/gi },
  { rule: 'emoji_bullet', weight: 1, re: /^\s*(?:[\u{1F300}-\u{1FAFF}✅✨\u{1F680}])\s/gmu },
  { rule: 'triple_adjective', weight: 1, re: /\b(\w+), (\w+),? and (\w+) (?:solutions?|experiences?|platforms?|tools?|approach)\b/gi },
  { rule: 'rhetorical_q_open', weight: 1, re: /^(?:ever wondered|have you ever|what if i told you|imagine)\b/gim },
  { rule: 'hashtag_pile', weight: 1, re: /(?:#\w+\s*){3,}/g },
];

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const PHRASE_RES = PHRASES.map((p) => ({
  rule: `phrase:${p}`, weight: 1,
  re: new RegExp(`(?<![\\w])${escapeRe(p).replace(/'/g, "['’]")}(?![\\w])`, 'gi'),
}));

export function wordCount(text) {
  return (text.match(/[\p{L}\p{N}'’-]+/gu) || []).length;
}

export function scoreSlop(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  const hits = [];
  for (const { rule, weight, re } of [...PHRASE_RES, ...PATTERNS]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) hits.push({ rule, weight, match: m[0].trim(), index: m.index });
  }
  hits.sort((a, b) => a.index - b.index);
  const words = wordCount(text);
  const weighted = hits.reduce((n, h) => n + h.weight, 0);
  const score = words === 0 ? 0 : Math.round((weighted / words) * 1000) / 10;
  return { version: SLOP_VERSION, words, weighted, score, hits };
}

// Facts the rewrite must keep verbatim: numbers, URLs, emails, @handles, "quoted" strings.
export function extractFacts(text) {
  const facts = new Set();
  const add = (re) => { for (const m of text.matchAll(re)) facts.add(m[0].replace(/[.,;:!?)]+$/, '')); };
  add(/https?:\/\/[^\s<>"')]+/g);
  add(/[\w.+-]+@[\w-]+\.[\w.-]+/g);
  add(/(?<![\w@])@[A-Za-z0-9_]{2,}/g);
  add(/["“][^"”\n]{2,80}["”]/g);
  // Numbers last, skipping ones already inside a URL/email fact.
  const covered = [...facts].join(' ');
  for (const m of text.matchAll(/(?<![\w.])[$€£]?\d[\d,]*(?:\.\d+)?%?/g)) {
    const n = m[0].replace(/[.,]+$/, '');
    if (!covered.includes(n) || /[$€£%]/.test(n)) facts.add(n);
  }
  return [...facts];
}

function normQuotes(s) { return s.replace(/[“”]/g, '"'); }

export const DEFAULT_LIMITS = { maxScore: 2.0, maxWords: 600 };

// Pre-delivery gate. Returns { ok, reasons[], before, after, missingFacts[] }.
export function checkRewrite(original, rewrite, limits = DEFAULT_LIMITS) {
  const reasons = [];
  const before = scoreSlop(original);
  const after = scoreSlop(rewrite);
  if (before.words > limits.maxWords) reasons.push(`original exceeds ${limits.maxWords} words`);
  if (after.words === 0) reasons.push('rewrite is empty');
  if (after.score > limits.maxScore) reasons.push(`rewrite slop score ${after.score} > cap ${limits.maxScore}`);
  if (before.weighted > 0 && after.score >= before.score) reasons.push('rewrite does not reduce slop score');
  if (after.words > Math.max(before.words * 1.25, before.words + 20)) reasons.push('rewrite is padded (>25% longer)');
  const rw = normQuotes(rewrite);
  const missingFacts = extractFacts(original).filter((f) => !rw.includes(normQuotes(f)));
  if (missingFacts.length) reasons.push(`rewrite drops facts: ${missingFacts.join(', ')}`);
  return { ok: reasons.length === 0, reasons, before, after, missingFacts };
}
