import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { initialProducts, listing, priceFilter, product } from './fixtures/listing.ts';

import { chromium, type Browser, type Page } from 'playwright';
let browser: Browser;

before(async () => {
  browser = await chromium.launch({
    headless: true,
    args: ['--mute-audio']
  });
});

after(async () => { await browser.close(); });

interface ListingOptions {
  products?: string;
  path?: string;
  session?: unknown;
  prepare?: (page: Page) => Promise<void>;
}

async function withListing(artifact: string, run: (page: Page, code: string) => Promise<void>, options: ListingOptions = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const code = await readFile(new URL(artifact === 'compiled' ? '../.build/ozon-search.js' : '../ozon-search.user.js', import.meta.url), 'utf8');
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: listing(options.products ?? initialProducts) }));
  await page.goto(`https://www.ozon.ru${options.path ?? '/category/example-123/'}`);
  if (options.session) await page.evaluate(value => sessionStorage.setItem('ozon-rating-range', JSON.stringify(value)), options.session);
  if (options.prepare) await options.prepare(page);
  await page.addScriptTag({ content: code });
  await page.getByRole('spinbutton', { name: 'Оценка от', exact: true }).waitFor();
  try {
    await run(page, code);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

async function input(page: Page, name: string, value: string) {
  const control = page.getByRole('spinbutton', { name, exact: true });
  await control.fill(value);
  await control.press('Enter');
}

async function visibleCards(page: Page, expected: string[]) {
  await page.waitForFunction(expected => {
    const ids = [...document.querySelectorAll('.tile-root')].filter(card => getComputedStyle(card).display !== 'none').map(card => card.id);
    return JSON.stringify(ids) === JSON.stringify(expected);
  }, expected, { timeout: 2500 });
  assert.deepEqual(await page.locator('.tile-root:visible').evaluateAll(cards => cards.map(card => card.id)), expected);
}

async function trackResources(page: Page) {
  await page.evaluate(() => {
    const resources = { listeners: 0, observers: 0, callbacks: 0, active: new Set<MutationObserver>(), intervals: new Set<number>(), intervalTicks: 0 };
    Reflect.defineProperty(window, 'ozonTestResources', { value: resources });
    const add: unknown = Reflect.get(EventTarget.prototype, 'addEventListener');
    if (typeof add !== 'function') throw new Error('Missing native listener API');
    EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
      if (this === document || this === window || this === window.navigation) resources.listeners++;
      Reflect.apply(add, this, [type, callback, options]);
    };
    window.MutationObserver = class extends MutationObserver {
      constructor(callback: MutationCallback) {
        super((records, observer) => { resources.callbacks++; callback(records, observer); });
        resources.observers++;
      }
      override observe(target: Node, options?: MutationObserverInit) {
        super.observe(target, options);
        resources.active.add(this);
      }
      override disconnect() { super.disconnect(); resources.active.delete(this); }
    };
    const interval = window.setInterval.bind(window);
    const clear = window.clearInterval.bind(window);
    Reflect.defineProperty(window, 'setInterval', { value: function (callback: TimerHandler, timeout?: number, ...args: unknown[]) {
      const id: unknown = Reflect.apply(interval, window, [callback, timeout, ...args]);
      if (typeof id !== 'number') throw new Error('Invalid browser timer');
      resources.intervals.add(id);
      return id;
    } });
    Reflect.defineProperty(window, 'clearInterval', { value: function (id?: number) {
      if (id !== undefined) resources.intervals.delete(id);
      Reflect.apply(clear, window, [id]);
    } });
    const push: unknown = Reflect.get(history, 'pushState');
    const replace: unknown = Reflect.get(history, 'replaceState');
    Reflect.defineProperty(window, 'originalHistoryMethods', { value: [push, replace] });
  });
}

async function resources(page: Page) {
  return page.evaluate(() => {
    const value: unknown = Reflect.get(window, 'ozonTestResources');
    if (typeof value !== 'object' || value === null) throw new Error('Missing fixture resources');
    const listeners: unknown = Reflect.get(value, 'listeners');
    const observers: unknown = Reflect.get(value, 'observers');
    const intervalTicks: unknown = Reflect.get(value, 'intervalTicks');
    const intervals: unknown = Reflect.get(value, 'intervals');
    if (typeof listeners !== 'number' || typeof observers !== 'number' || typeof intervalTicks !== 'number' || !(intervals instanceof Set)) throw new Error('Invalid fixture resources');
    return { listeners, observers, intervalTicks, intervals: intervals.size, styles: document.querySelectorAll('#ozon-rating-range-style').length };
  });
}

for (const artifact of ['compiled', 'user']) {
  void test(`${artifact}: stays idle without URL polling and preserves resources on repeated execution`, () => withListing(artifact, async (page, code) => {
    const initial = await resources(page);
    await page.addScriptTag({ content: code });
    await page.addScriptTag({ content: code });
    assert.deepEqual(await resources(page), initial);
    await page.waitForTimeout(1200);
    const idle = await resources(page);
    assert.equal(idle.intervals, 0);
    assert.equal(idle.intervalTicks, 0);
    await input(page, 'Оценка от', '4.9');
    await visibleCards(page, ['card104']);
  }, { prepare: trackResources }));

  void test(`${artifact}: stays idle away from listings and resumes after target replacement`, () => withListing(artifact, async (page, code) => {
    await input(page, 'Оценка от', '4.9');
    await page.evaluate(() => {
      history.pushState({}, '', '/product/example-101/');
      document.body.replaceChildren();
    });
    await page.waitForTimeout(1200);
    assert.equal((await resources(page)).intervals, 0);
    assert.equal((await resources(page)).intervalTicks, 0);
    await page.evaluate(html => {
      history.pushState({}, '', '/category/returned-456/');
      document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
    }, listing());
    await page.getByRole('spinbutton', { name: 'Оценка от', exact: true }).waitFor();
    await page.addScriptTag({ content: code });
    assert.equal(await page.locator('[data-ozr]').count(), 2);
    await visibleCards(page, ['card101', 'card102', 'card103', 'card104', 'card105']);
    await input(page, 'Оценка от', '4.9');
    await visibleCards(page, ['card104']);
  }, { prepare: trackResources }));

  void test(`${artifact}: observes URL changes made through previously captured History methods`, () => withListing(artifact, async page => {
    await input(page, 'Оценка от', '4.9');
    await page.evaluate(() => {
      const saved: unknown = Reflect.get(window, 'originalHistoryMethods');
      if (!Array.isArray(saved)) throw new Error('Missing saved History API');
      const fn: unknown = saved[0];
      if (typeof fn !== 'function') throw new Error('Invalid saved History API');
      Reflect.apply(fn, history, [{ query: 'new' }, '', '/category/captured-456/']);
    });
    await visibleCards(page, ['card101', 'card102', 'card103', 'card104', 'card105']);
    await input(page, 'Оценка от', '4.9');
    await page.evaluate(() => {
      const saved: unknown = Reflect.get(window, 'originalHistoryMethods');
      if (!Array.isArray(saved)) throw new Error('Missing saved History API');
      const fn: unknown = saved[1];
      if (typeof fn !== 'function') throw new Error('Invalid saved History API');
      Reflect.apply(fn, history, [{ query: 'replacement' }, '', '/category/replaced-789/']);
    });
    await visibleCards(page, ['card101', 'card102', 'card103', 'card104', 'card105']);
    assert.equal(await page.evaluate(() => { const saved: unknown = Reflect.get(window, 'originalHistoryMethods'); return Array.isArray(saved) && history.pushState === saved[0] && history.replaceState === saved[1]; }), true);
  }, { prepare: trackResources }));

  void test(`${artifact}: responds to popstate without Navigation API support`, () => withListing(artifact, async page => {
    await input(page, 'Оценка от', '4.9');
    await page.evaluate(() => {
      history.replaceState({}, '', '/category/fallback-456/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await visibleCards(page, ['card101', 'card102', 'card103', 'card104', 'card105']);
    assert.equal((await resources(page)).intervals, 0);
  }, { prepare: async page => {
    await trackResources(page);
    await page.evaluate(() => { Object.defineProperty(window, 'navigation', { value: undefined, configurable: true }); });
  } }));

  void test(`${artifact}: leaves all products visible before a filter is selected`, () => withListing(artifact, page => visibleCards(page, ['card101', 'card102', 'card103', 'card104', 'card105'])));

  void test(`${artifact}: applies rating boundaries inclusively with decimal commas`, () => withListing(artifact, async page => {
    await input(page, 'Оценка от', '4,7');
    await input(page, 'Оценка до', '4,7');
    await visibleCards(page, ['card101']);
  }));

  void test(`${artifact}: combines rating and review ranges`, () => withListing(artifact, async page => {
    await input(page, 'Оценка от', '4.5');
    await input(page, 'Оценка до', '4.9');
    await input(page, 'Отзывы от', '100');
    await input(page, 'Отзывы до', '500');
    await visibleCards(page, ['card101']);
  }));

  void test(`${artifact}: hides unknown ratings only while a rating range is active`, () => withListing(artifact, async page => {
    await input(page, 'Оценка от', '4.5');
    await visibleCards(page, ['card101', 'card102', 'card104']);
    await input(page, 'Оценка от', '');
    await visibleCards(page, ['card101', 'card102', 'card103', 'card104', 'card105']);
  }));

  void test(`${artifact}: treats products without ratings or reviews as zero reviews`, () => withListing(artifact, async page => {
    await input(page, 'Отзывы до', '0');
    await visibleCards(page, ['card105']);
  }));

  void test(`${artifact}: preserves the last valid filter after a reversed range`, () => withListing(artifact, async page => {
    await input(page, 'Оценка от', '4.5');
    await input(page, 'Оценка до', '4.0');
    await visibleCards(page, ['card101', 'card102', 'card104']);
    assert.equal(await page.getByRole('spinbutton', { name: 'Оценка до', exact: true }).getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('[data-ozr-error]:visible').count(), 1);
  }));

  void test(`${artifact}: rejects invalid review input without changing visible products`, () => withListing(artifact, async page => {
    await input(page, 'Отзывы от', '100');
    await input(page, 'Отзывы до', '1.5');
    await visibleCards(page, ['card101', 'card103', 'card104']);
    assert.equal(await page.getByRole('spinbutton', { name: 'Отзывы до', exact: true }).getAttribute('aria-invalid'), 'true');
  }));

  void test(`${artifact}: parses the thin and nonbreaking spaces used by Ozon review counts`, () => withListing(artifact, async page => {
    await input(page, 'Отзывы от', '1000');
    await visibleCards(page, ['card106']);
  }, { products: product('card106', '4.8', '1\u2009234\u00a0') + product('card107', '4.8', '999') }));

  void test(`${artifact}: reads rating and review metrics independently of product brand labels`, () => withListing(artifact, async page => {
    await input(page, 'Оценка от', '4.9');
    await input(page, 'Отзывы от', '100');
    await visibleCards(page, ['card106']);
  }, { products: product('card106', '4.9', '9\u2009403').replace('<a ', '<span>Sony</span><a ') + product('card107', '4.5', '9\u2009403').replace('<a ', '<span>Ozon</span><a ') }));

  void test(`${artifact}: filters products appended during infinite scrolling`, () => withListing(artifact, async page => {
    await input(page, 'Оценка от', '4.9');
    await page.locator('[data-widget="tileGridDesktop"]').evaluate((grid, html) => grid.insertAdjacentHTML('beforeend', html), product('card106', '4.9', '250') + product('card107', '4.1', '500'));
    await visibleCards(page, ['card104', 'card106']);
  }));

  void test(`${artifact}: updates filtering when an existing card changes its rating`, () => withListing(artifact, async page => {
    await input(page, 'Оценка от', '4.9');
    await page.locator('#card101 svg + span').first().evaluate(span => { span.textContent = '4.9'; });
    await visibleCards(page, ['card101', 'card104']);
  }));

  void test(`${artifact}: remounts filters once after the native filter panel is replaced`, () => withListing(artifact, async page => {
    await input(page, 'Оценка от', '4.9');
    await page.locator('[data-widget="filtersDesktop"]').evaluate((widget, html) => { widget.innerHTML = html; }, priceFilter);
    await page.getByRole('spinbutton', { name: 'Оценка от', exact: true }).waitFor();
    assert.equal(await page.getByRole('spinbutton', { name: 'Оценка от', exact: true }).inputValue(), '4.9');
    assert.equal(await page.locator('[data-ozr]').count(), 2);
    await visibleCards(page, ['card104']);
  }));

  void test(`${artifact}: does not duplicate controls on repeated initialization`, () => withListing(artifact, async (page, code) => {
    await page.addScriptTag({ content: code });
    assert.equal(await page.locator('[data-ozr]').count(), 2);
    await input(page, 'Оценка от', '4.9');
    await visibleCards(page, ['card104']);
  }));

  void test(`${artifact}: resets ranges when the search context changes`, () => withListing(artifact, async page => {
    await input(page, 'Оценка от', '4.9');
    await page.evaluate(() => history.pushState({}, '', '/category/another-456/?text=new'));
    await visibleCards(page, ['card101', 'card102', 'card103', 'card104', 'card105']);
    assert.equal(await page.getByRole('spinbutton', { name: 'Оценка от', exact: true }).inputValue(), '');
  }));

  void test(`${artifact}: restores valid session ranges for the same category`, () => withListing(artifact, page => visibleCards(page, ['card101']), {
    session: { context: '/category/example-123/?&', values: ['4.5', '4.9', '100', '500'] }
  }));

  void test(`${artifact}: shows an empty result message and restores products after clearing filters`, () => withListing(artifact, async page => {
    await input(page, 'Отзывы от', '10000');
    await visibleCards(page, []);
    assert.equal(await page.getByRole('status').isVisible(), true);
    await input(page, 'Отзывы от', '');
    await visibleCards(page, ['card101', 'card102', 'card103', 'card104', 'card105']);
    assert.equal(await page.getByRole('status').isVisible(), false);
  }));

  void test(`${artifact}: limits Fresh products to the visible 30-minute delivery label`, () => withListing(artifact, async page => {
    await page.getByRole('switch', { name: 'За 30 минут', exact: true }).check();
    await visibleCards(page, ['card101', 'card103', 'card104']);
    await page.getByRole('switch', { name: 'За 30 минут', exact: true }).uncheck();
    await visibleCards(page, ['card101', 'card102', 'card103', 'card104', 'card105']);
  }, { path: '/category/supermarket-25000/' }));

  void test(`${artifact}: combines Fresh delivery with the selected rating and review ranges`, () => withListing(artifact, async page => {
    await input(page, 'Оценка от', '5');
    await input(page, 'Отзывы от', '20000');
    await page.getByRole('switch', { name: 'За 30 минут', exact: true }).check();
    await visibleCards(page, ['card106']);
    await page.getByRole('switch', { name: 'За 30 минут', exact: true }).uncheck();
    await visibleCards(page, ['card106', 'card107']);
  }, {
    path: '/category/supermarket-molochnye-produkty-i-yaytsa-9276000/?miniapp=supermarket&text=молоко',
    products: product('card106', '5.0', '20\u2009362') + product('card107', '5.0', '83\u2009710', 'За час') + product('card108', '4.9', '45\u2009000') + product('card109', '5.0', '19\u2009999')
  }));

  void test(`${artifact}: ignores a hidden fast-delivery button`, () => withListing(artifact, async page => {
    await page.getByRole('switch', { name: 'За 30 минут', exact: true }).check();
    await visibleCards(page, []);
  }, { path: '/category/supermarket-25000/', products: product('card106', '4.8', '100').replace('<button>', '<button hidden>') }));
}


