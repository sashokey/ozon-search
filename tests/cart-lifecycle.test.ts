import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import { listing } from './fixtures/listing.ts';

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ['--mute-audio'] }); });
after(async () => { await browser.close(); });

for (const artifact of ['compiled', 'user']) {
  void test(`${artifact}: cancels pending cart expiry when leaving the listing`, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: listing() }));
      await page.goto('https://www.ozon.ru/category/supermarket-25000/');
      await page.evaluate(() => {
        const active = new Set<number>();
        Reflect.defineProperty(window, 'ozonCartTimers', { value: active });
        const set = window.setTimeout.bind(window);
        const clear = window.clearTimeout.bind(window);
        Reflect.defineProperty(window, 'setTimeout', { value: function (handler: TimerHandler, delay?: number, ...args: unknown[]) {
          const id: unknown = Reflect.apply(set, window, [handler, delay, ...args]);
          if (typeof id !== 'number') throw new Error('Missing browser timer');
          if (delay === 8000) active.add(id);
          return id;
        } });
        Reflect.defineProperty(window, 'clearTimeout', { value: function (id?: number) {
          if (id !== undefined) active.delete(id);
          Reflect.apply(clear, window, [id]);
        } });
      });
      await page.addScriptTag({ content: await readFile(new URL(artifact === 'compiled' ? '../.build/ozon-search.js' : '../ozon-search.user.js', import.meta.url), 'utf8') });
      await page.locator('#card101 button').click();
      const count = () => page.evaluate(() => {
        const timers: unknown = Reflect.get(window, 'ozonCartTimers');
        if (!(timers instanceof Set)) throw new Error('Missing cart timers');
        return timers.size;
      });
      assert.equal(await count(), 1);
      await page.evaluate(() => { history.pushState({}, '', '/product/example-101/'); });
      assert.equal(await count(), 0);
    } finally { await context.close(); }
  });
}
