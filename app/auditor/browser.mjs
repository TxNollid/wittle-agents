import { publicFetch, publicUrl } from './network.mjs';

export async function createBrowserAdapter({ executablePath, maxRequests = 120, maxTotalBytes = 12_000_000, fixturePages } = {}) {
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 120 ||
      !Number.isInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > 12_000_000) throw new Error('INVALID_BROWSER_LIMITS');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  let requests = 0;
  let bytes = 0;
  const budget = { requests: 0, bytes: 0, maxRequests, maxBytes: maxTotalBytes };
  return {
    evidence_kind: fixturePages ? 'fixture' : 'public_browser',
    async observe({ url, viewport, signal }) {
      signal.throwIfAborted();
      const context = await browser.newContext({
        viewport: viewport === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false,
      });
      const abort = () => { void context.close(); };
      signal.addEventListener('abort', abort, { once: true });
      let main;
      const failures = [];
      try {
        const page = await context.newPage();
        await context.route('**/*', async route => {
          try {
            const request = route.request();
            if (request.method() !== 'GET' || ++requests > maxRequests) throw new Error('REQUEST_LIMIT');
            if (request.isNavigationRequest() && (request.frame() !== page.mainFrame() || main)) throw new Error('EXTRA_NAVIGATION_BLOCKED');
            publicUrl(request.url());
            const fixture = fixturePages?.[request.url()];
            const response = fixturePages
              ? fixture ? { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(fixture), url: request.url() }
                : { status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('Fixture page missing'), url: request.url() }
              : await publicFetch(request.url(), { signal, maxBytes: 2_000_000, budget });
            bytes += response.body.length;
            if (bytes > maxTotalBytes) throw new Error('BYTE_LIMIT');
            if (request.isNavigationRequest()) main = response;
            await route.fulfill({ status: response.status, body: response.body,
              headers: { 'content-type': String(response.headers['content-type'] || 'application/octet-stream') } });
          } catch (error) {
            failures.push(error.message);
            await route.abort().catch(() => {});
          }
        });
        await page.goto(url, { waitUntil: 'networkidle', timeout: 15_000 });
        if (!main || main.status >= 400) throw new Error(`PAGE_UNAVAILABLE_${main?.status || 'NETWORK'}`);
        if (!(main.headers['content-type'] || '').includes('text/html')) throw new Error('NOT_HTML');
        const facts = await page.evaluate(() => {
          const visible = element => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
          const snippet = element => element.outerHTML.slice(0, 240);
          const password = Boolean(document.querySelector('input[type=password]'));
          const issues = [];
          if (!document.title.trim()) issues.push({ rule: 'missing-title', selector: 'head > title', observation: 'The rendered document has no non-empty title.', priority: 2 });
          if (!document.documentElement.lang.trim()) issues.push({ rule: 'missing-language', selector: 'html', observation: 'The html element has no lang value.', priority: 2 });
          const missingAlt = [...document.images].filter(image => visible(image) && !image.hasAttribute('alt') && image.getAttribute('role') !== 'presentation');
          if (missingAlt.length) issues.push({ rule: 'missing-image-alt', selector: 'img:not([alt])', observation: `${missingAlt.length} visible image(s) have no alt attribute. Example: ${snippet(missingAlt[0])}`, priority: 2 });
          const unnamed = [...document.querySelectorAll('button,input:not([type=hidden]):not([type=password]),select,textarea')].filter(element => {
            if (!visible(element)) return false;
            const references = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
            return !(element.getAttribute('aria-label') || '').trim() && !references.some(id => document.getElementById(id)?.textContent.trim()) &&
              !element.labels?.length && !(element.tagName === 'BUTTON' && element.textContent.trim()) &&
              !(['submit', 'button', 'reset'].includes(element.type) && element.value.trim()) && !element.getAttribute('title');
          });
          if (unnamed.length) issues.push({ rule: 'unnamed-control', selector: 'button,input,select,textarea', observation: `${unnamed.length} visible control(s) have no detected text/label. Example: ${snippet(unnamed[0])}`, priority: 1 });
          const overflow = document.documentElement.scrollWidth - window.innerWidth;
          if (overflow > 8) issues.push({ rule: 'horizontal-overflow', selector: 'html', observation: `Document scrollWidth ${document.documentElement.scrollWidth}px exceeds viewport ${window.innerWidth}px by ${overflow}px.`, priority: 1 });
          return { password, title: document.title.slice(0, 200), issues, width: innerWidth, document_width: document.documentElement.scrollWidth };
        });
        if (facts.password) throw new Error('AUTHENTICATED_SITE_UNSUPPORTED');
        if (failures.length) facts.issues = facts.issues.filter(issue => issue.rule !== 'horizontal-overflow');
        return { url, final_url: main.url, viewport, observed_at: new Date().toISOString(), facts, complete: failures.length === 0,
          limitations: ['JavaScript disabled; no interactive, logged-in or performance audit.', ...failures.map(failure => `Blocked/failed subresource: ${failure}`)] };
      } finally {
        signal.removeEventListener('abort', abort);
        await context.close();
      }
    },
    async close() { await browser.close(); },
  };
}
