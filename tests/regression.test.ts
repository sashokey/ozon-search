import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import { listing } from './fixtures/listing.ts';

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ['--mute-audio'] }); });
after(async () => { await browser.close(); });

for (const artifact of ['compiled', 'user']) {
  void test(`${artifact}: resumes after an asynchronous listing root replacement`, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: listing() }));
      await page.goto('https://www.ozon.ru/category/example-123/');
      await page.addScriptTag({ content: await readFile(new URL(artifact === 'compiled' ? '../.build/ozon-search.js' : '../ozon-search.user.js', import.meta.url), 'utf8') });
      await page.getByRole('spinbutton', { name: 'Оценка от', exact: true }).waitFor();
      await page.evaluate(() => {
        const root = document.getElementById('layoutPage');
        if (!root) throw new Error('Missing listing root');
        const replacement = root.cloneNode(true);
        if (!(replacement instanceof HTMLElement)) throw new Error('Missing replacement root');
        replacement.querySelectorAll('[data-ozr], [data-ozr-empty]').forEach(node => node.remove());
        const html = replacement.outerHTML;
        history.pushState({}, '', '/category/returned-456/');
        root.remove();
        window.setTimeout(() => { document.getElementById('__ozon')?.insertAdjacentHTML('beforeend', html); }, 100);
      });
      await page.getByRole('spinbutton', { name: 'Оценка от', exact: true }).waitFor({ timeout: 1500 });
      assert.equal(await page.locator('[data-ozr]').count(), 2);
    } finally { await context.close(); }
  });

  void test(`${artifact}: releases mutation observers outside listing routes`, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body><div id="layoutPage"><main>Product detail</main></div></body></html>' }));
      await page.goto('https://www.ozon.ru/product/example-101/');
      await page.evaluate(() => {
        const active = new Set<MutationObserver>();
        Reflect.defineProperty(window, 'ozonRegressionResources', { value: { active } });
        window.MutationObserver = class extends MutationObserver {
          override observe(target: Node, options?: MutationObserverInit) {
            super.observe(target, options);
            if (target === document.body || target instanceof HTMLElement && target.id === 'layoutPage') active.add(this);
          }
          override disconnect() {
            super.disconnect();
            active.delete(this);
          }
        };
      });
      await page.addScriptTag({ content: await readFile(new URL(artifact === 'compiled' ? '../.build/ozon-search.js' : '../ozon-search.user.js', import.meta.url), 'utf8') });
      const active = await page.evaluate(() => {
        const resource: unknown = Reflect.get(window, 'ozonRegressionResources');
        if (typeof resource !== 'object' || resource === null || !('active' in resource) || !(resource.active instanceof Set)) throw new Error('Missing fixture resources');
        return resource.active.size;
      });
      assert.equal(active, 0);
    } finally { await context.close(); }
  });
}
