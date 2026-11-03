// ==UserScript==
// @name         Ozon - Rating and Review Filters
// @namespace    https://github.com/sashokey/ozon-search
// @version      1.1.4
// @description  Violentmonkey: adds rating and review ranges and a 30-minute delivery switch for Ozon Fresh. Filters loaded and newly loaded products.
// @match        https://www.ozon.ru/*
// @match        https://ozon.ru/*
// @run-at       document-idle
// @grant        none
// @inject-into  content
// @noframes
// @updateURL    https://raw.githubusercontent.com/sashokey/ozon-search/master/ozon-search.user.js
// @downloadURL  https://raw.githubusercontent.com/sashokey/ozon-search/master/ozon-search.user.js
// ==/UserScript==

(() => {
  'use strict';
  const ID = 'ozon-rating-range';
  if (document.getElementById(ID + '-style')) return;
  const PRICE = '[filter-key="currency_price"], [filterkey="currency_price"]';
  const GRID = '[data-widget="tileGridDesktop"]';
  const CARD = GRID + ' .tile-root';
  interface Panel {
    root: HTMLElement;
    price: HTMLElement;
    inputs: HTMLInputElement[];
    error: HTMLElement;
    offset: number;
  }
  interface Metrics {
    rating: number;
    reviews: number;
    key: string;
    delivery: boolean | null;
    quantity: boolean;
    grid: HTMLElement;
  }
  const deliveryPanels = new Map<HTMLElement, { anchor: HTMLElement; input: HTMLInputElement }>();
  const cartTimers = new Map<string, number>();
  const knownDelivery = new Map<string, boolean>(), pendingCart = new Map<string, number>(), measureGrids = new Set<HTMLElement>();
  const panels = new Map<HTMLElement, Panel>(), cards = new Map<HTMLElement, Metrics>(), grids = new Set<HTMLElement>(), dirty = new Set<ParentNode>([document]);
  let context: string | undefined;
  let values = ['', '5', '', ''];
  let draft: { offset: number; values: string[] } | null = null;
  let focus: { offset: number; index: number; start: number | null; end: number | null } | null = null;
  let frame = 0, timer: number | undefined, serial = 0;
  let activeRoot: HTMLElement | null = null;
  let routeRoot: HTMLElement | null = null;
  let freshOnly = false;
  try { freshOnly = sessionStorage.getItem(ID + '-fresh-only') === 'true'; } catch {}
  const style = document.createElement('style');
  style.id = ID + '-style';
  style.textContent = `
    [data-ozr-hidden]{display:none!important}
    [data-ozr-grid]{min-height:var(--ozr-height)!important}
    [data-ozr] [data-ozr-range]{margin-bottom:0}
    [data-ozr] [data-ozr-field] p{display:block;pointer-events:none}
    [data-ozr] [data-ozr-field][data-ozr-focus]{outline:1px solid var(--bgActionPrimary,#005bff)}
    [data-ozr] [data-ozr-field][data-ozr-value] p{visibility:hidden}
    [data-ozr] [data-ozr-field]:has(input[aria-invalid="true"]){border-color:var(--ozAccentAlert,#f91155)}
    [data-ozr] [data-ozr-error]{color:var(--ozAccentAlert,#f91155);font-size:12px;line-height:16px;margin-top:8px}
    [data-ozr] [data-ozr-error]:empty{display:none}
    [data-ozr-empty]{box-sizing:border-box;padding:32px 24px;color:var(--textSecondary,#707f8d);font:inherit}
    [data-ozr-empty][hidden]{display:none}
    [data-ozr-delivery]{display:block;box-sizing:border-box;flex:0 0 100%;width:100%;min-width:0;margin:0 0 24px;color:var(--ozTextPrimary,#001a34);font:inherit}
    [data-ozr-delivery] label{display:flex;box-sizing:border-box;align-items:center;justify-content:space-between;gap:16px;width:100%;margin:0;padding:0;position:relative;cursor:pointer;min-height:32px;color:inherit;font-family:inherit;font-size:16px;line-height:20px;font-weight:600}
    [data-ozr-delivery] input{position:absolute;right:0;top:50%;transform:translateY(-50%);width:44px;height:28px;margin:0;opacity:0;cursor:pointer}
    [data-ozr-switch]{display:block;box-sizing:content-box;flex:0 0 44px;width:44px;height:28px;margin:2px 0;border-radius:16px;background:var(--graphicNeutral,#dfe5ef);pointer-events:none}
    [data-ozr-switch]::after{content:"";display:block;width:24px;height:24px;margin:2px;border-radius:50%;background:#fff}
    [data-ozr-delivery] input:checked + [data-ozr-switch]{background:var(--bgActionPrimary,#005bff)}
    [data-ozr-delivery] input:checked + [data-ozr-switch]::after{transform:translateX(16px)}
    [data-ozr-delivery] input:focus-visible + [data-ozr-switch]{outline:2px solid var(--bgActionPrimary,#005bff);outline-offset:3px}
  `;
  document.head.append(style);
  const empty = document.createElement('div');
  empty.dataset.ozrEmpty = '';
  empty.setAttribute('role', 'status');
  empty.hidden = true;

  function parse(value: string, index: number) {
    const text = value.trim().replace(',', '.');
    if (!text) return index === 1 ? 5 : index === 3 ? Infinity : 0;
    if (index > 1) {
      const digits = text.replace(/\s/g, '');
      return /^\d+$/.test(digits) && Number.isSafeInteger(+digits) ? +digits : NaN;
    }
    return /^\d(?:\.\d*)?$/.test(text) && +text <= 5 ? +text : NaN;
  }

  function save() {
    try { sessionStorage.setItem(ID, JSON.stringify({ context, values })); } catch {}
  }

  function isFresh() {
    const url = new URL(location.href);
    if (/^\/(?:product|cart|my)(?:\/|$)/.test(url.pathname)) return false;
    return url.searchParams.get('miniapp') === 'supermarket'
      || url.pathname === '/category/supermarket-25000/'
      || !!document.querySelector('[data-widget="searchBarDesktop"] [title="Ozon fresh"]');
  }

  function mountDelivery() {
    const anchors = new Map<HTMLElement, boolean>();
    if (isFresh()) {
      for (const widget of document.querySelectorAll<HTMLElement>('[data-widget="filtersDesktop"]')) {
        const panel = [...panels.values()].find(p => p.offset === 2 && p.root.isConnected && widget.contains(p.root));
        anchors.set(panel?.root || widget, !panel);
      }
    }
    for (const [root, panel] of deliveryPanels) {
      if (!root.isConnected || !anchors.has(panel.anchor)) {
        root.remove();
        deliveryPanels.delete(root);
      }
    }
    for (const [anchor, prepend] of anchors) {
      if ([...deliveryPanels.values()].some(p => p.anchor === anchor)) continue;
      const root = document.createElement('div');
      root.dataset.ozr = '';
      root.dataset.ozrDelivery = '';
      const label = document.createElement('label');
      const title = document.createElement('span');
      title.textContent = 'За 30 минут';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('role', 'switch');
      input.checked = freshOnly;
      const track = document.createElement('span');
      track.dataset.ozrSwitch = '';
      track.setAttribute('aria-hidden', 'true');
      label.title = 'Показывать только товары с меткой «За 30 минут». Итоговые доставки определяет Ozon в корзине.';
      label.append(title, input, track);
      root.append(label);
      input.addEventListener('change', () => {
        freshOnly = input.checked;
        try { sessionStorage.setItem(ID + '-fresh-only', String(freshOnly)); } catch {}
        for (const panel of deliveryPanels.values()) panel.input.checked = freshOnly;
        schedule(document);
      });
      deliveryPanels.set(root, { anchor, input });
      if (prepend) anchor.prepend(root);
      else anchor.after(root);
    }
  }

  function normalizedText(element: Element | null) {
    return (element?.textContent ?? '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  }

  function productKey(card: HTMLElement) {
    const link = card.querySelector('a[href*="/product/"]');
    if (!link) return '';
    try { return new URL(link.getAttribute('href') ?? '', location.href).pathname.match(/\/product\/(?:[^/]*-)?(\d+)\/?$/)?.[1] || ''; } catch { return ''; }
  }

  function deliveryLabel(card: HTMLElement) {
    let fast: boolean | null = null;
    for (const button of card.querySelectorAll<HTMLElement>('button, [role="button"]')) {
      let hidden = false;
      for (let node: HTMLElement | null = button; node && node !== card; node = node.parentElement) {
        const css = getComputedStyle(node);
        if (node.hidden || node.getAttribute('aria-hidden') === 'true' || css.display === 'none' || css.visibility === 'hidden') { hidden = true; break; }
      }
      if (hidden) continue;
      const text = normalizedText(button);
      if (!/^(?:за\s|через\s|(?:сегодня|завтра|послезавтра)(?:\s|$))/i.test(text)) continue;
      if (!/^за 30 мин(?:ут)?\.?$/i.test(text)) return false;
      fast = true;
    }
    return fast;
  }

  function hasQuantity(card: HTMLElement) {
    return [...card.querySelectorAll('button')].some(button => {
      const parent = button.parentElement;
      return parent !== null && /^\d+$/.test(normalizedText(parent)) && Number(normalizedText(parent)) > 0
        && parent.querySelectorAll('button').length === 2
        && !!parent.querySelector('svg path[d^="M13.416 6.75"]')
        && !!parent.querySelector('svg path[d^="M8 1.333"]');
    });
  }

  function captureCart(event: Event) {
    if (!activeRoot) return;
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLElement>('button, [role="button"]');
    const card = button?.closest<HTMLElement>(CARD);
    if (!card || !button || !/^за 30 мин(?:ут)?\.?$/i.test(normalizedText(button))) return;
    const key = productKey(card);
    if (!key || deliveryLabel(card) !== true) return;
    knownDelivery.set(key, true);
    const deadline = Date.now() + 8000;
    pendingCart.set(key, deadline);
    clearTimeout(cartTimers.get(key));
    const expiry = window.setTimeout(() => {
      if (pendingCart.get(key) !== deadline) return;
      pendingCart.delete(key);
      cartTimers.delete(key);
      schedule(document);
    }, 8000);
    cartTimers.set(key, expiry);
  }

  function syncContext() {
    const url = new URL(location.href);
    const next = url.pathname + '?' + ['text', 'miniapp'].map(k => url.searchParams.get(k) || '').join('&');
    if (context === next) return;
    context = next;
    knownDelivery.clear();
    pendingCart.clear();
    for (const timer of cartTimers.values()) clearTimeout(timer);
    cartTimers.clear();
    dirty.add(document);
    draft = focus = null;
    values = ['', '5', '', ''];
    try {
      const stored = sessionStorage.getItem(ID);
      const saved: unknown = stored === null ? null : JSON.parse(stored);
      if (typeof saved === 'object' && saved !== null && 'context' in saved && saved.context === context && 'values' in saved && Array.isArray(saved.values) && [2, 4].includes(saved.values.length) && saved.values.every(v => typeof v === 'string')) {
        const strings = saved.values.filter((v): v is string => typeof v === 'string');
        const next = strings.length === 2 ? [...strings, '', ''] : strings;
        const [a = NaN, b = NaN, c = NaN, d = NaN] = next.map(parse);
        if (a <= b && c <= d) values = next;
      }
    } catch {}
    clearTimeout(timer);
    for (const panel of panels.values()) restore(panel);
  }

  function paint(panel: Panel) {
    panel.inputs.forEach((input, i) => {
      const field = input.closest<HTMLElement>('[data-ozr-field]');
      field?.toggleAttribute('data-ozr-focus', document.activeElement === input);
      field?.toggleAttribute('data-ozr-value', !!input.value);
      const n = parse(input.value, panel.offset + i);
      if (Number.isFinite(n)) input.setAttribute('aria-valuenow', String(n));
      else input.removeAttribute('aria-valuenow');
    });
  }

  function validate(panel: Panel, show: boolean) {
    const nums = panel.inputs.map((input, i) => parse(input.value, panel.offset + i));
    const reversed = (nums[0] ?? NaN) > (nums[1] ?? NaN);
    const invalid = nums.map(n => Number.isNaN(n) || reversed);
    panel.inputs.forEach((input, i) => input.setAttribute('aria-invalid', String(show && invalid[i])));
    panel.error.textContent = show && invalid.some(Boolean)
      ? reversed ? '«От» не должно быть больше «До»' : panel.offset ? 'Введите целое число от 0' : 'Введите оценку от 0 до 5'
      : '';
    paint(panel);
    return invalid.some(Boolean) ? null : nums;
  }

  function restore(panel: Panel) {
    panel.inputs.forEach((input, i) => { input.value = values[panel.offset + i] ?? ''; });
    validate(panel, false);
  }

  function commit(panel: Panel, normalize: boolean) {
    if (panel.inputs.some(input => input.disabled || input.readOnly)) return;
    const nums = validate(panel, normalize);
    if (!nums) return;
    values.splice(panel.offset, 2, ...nums.map((n, i) => (panel.offset || !i) && !panel.inputs[i]?.value.trim() ? '' : String(n)));
    if (normalize && draft?.offset === panel.offset) draft = null;
    save();
    for (const other of panels.values()) {
      if (other.offset === panel.offset && (normalize || other !== panel && !other.root.contains(document.activeElement))) restore(other);
    }
    apply();
  }

  function onEvent(event: Event) {
    if (!(event.target instanceof Element)) return;
    const root = event.target.closest<HTMLElement>('[data-ozr]');
    const panel = root ? panels.get(root) : undefined;
    if (!panel) return;
    const input = event.target.closest('input');
    if (!input) {
      if (event.type === 'click') event.target.closest('[data-ozr-field]')?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus();
      return;
    }
    if (event.type === 'focusin') {
      focus = { offset: panel.offset, index: panel.inputs.indexOf(input), start: input.selectionStart, end: input.selectionEnd };
      paint(panel);
    }
    if (input.disabled || input.readOnly) return;
    if (event.type === 'input') {
      draft = { offset: panel.offset, values: panel.inputs.map(input => input.value) };
      focus = { offset: panel.offset, index: panel.inputs.indexOf(input), start: input.selectionStart, end: input.selectionEnd };
      clearTimeout(timer);
      if (!(event instanceof InputEvent && event.isComposing) && validate(panel, false)) timer = window.setTimeout(() => commit(panel, false), 450);
    }
    if (event.type === 'focusout') {
      const previous = focus;
      queueMicrotask(() => {
        if (!panel.root.isConnected) return;
        if (focus === previous) focus = null;
        clearTimeout(timer);
        commit(panel, true);
      });
    }
    if (event instanceof KeyboardEvent && event.type === 'keydown') {
      if (event.key === 'Escape') {
        event.preventDefault();
        clearTimeout(timer);
        draft = null;
        restore(panel);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        clearTimeout(timer);
        commit(panel, true);
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const n = parse(input.value, panel.offset + panel.inputs.indexOf(input));
        if (Number.isFinite(n)) {
          const scale = panel.offset ? 1 : 10;
          input.value = String(Math.max(0, Math.min(panel.offset ? Number.MAX_SAFE_INTEGER : 50, Math.round(n * scale) + (event.key === 'ArrowUp' ? 1 : -1))) / scale);
          clearTimeout(timer);
          commit(panel, true);
        }
      }
    }
  }

  function mount(range: HTMLElement) {
    if (range.closest('[data-ozr]') || range.querySelectorAll('input[type="text"]').length !== 2) return;
    let block = range.parentElement;
    const widget = range.closest('[data-widget]');
    while (block && block !== widget && !/^Цена(?:\s|$)/.test(block.firstElementChild?.textContent?.trim() || '')) block = block.parentElement;
    if (!block || block === widget) return;
    let anchor = block;
    for (const offset of [0, 2]) anchor = mountPanel(range, block, anchor, offset);
  }

  function mountPanel(range: HTMLElement, block: HTMLElement, anchor: HTMLElement, offset: number): HTMLElement {
    let panel = [...panels.values()].find(p => p.price === block && p.offset === offset && p.root.isConnected);
    if (!panel) {
      const root = block.cloneNode(false);
      if (!(root instanceof HTMLElement)) return anchor;
      root.dataset.ozr = '';
      root.removeAttribute('id');
      root.setAttribute('role', 'group');
      root.setAttribute('aria-label', offset ? 'Количество отзывов' : 'Оценка товара');
      const heading = block.firstElementChild?.cloneNode(true);
      if (!(heading instanceof HTMLElement)) return anchor;
      const title = [...heading.querySelectorAll('*'), heading].find(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent?.trim() === 'Цена'));
      if (!(title instanceof HTMLElement)) return anchor;
      title.textContent = offset ? 'Количество отзывов' : 'Оценка';
      title.title = offset ? 'По отзывам загруженных товаров. Пустое поле «До» — без ограничения.' : 'По оценкам загруженных товаров. При заданном диапазоне товары без оценки скрываются.';
      const copy = range.cloneNode(true);
      if (!(copy instanceof HTMLElement)) return anchor;
      copy.removeAttribute('filter-key');
      copy.removeAttribute('filterkey');
      copy.removeAttribute('type');
      copy.dataset.ozrRange = '';
      copy.querySelectorAll('input[type="range"]').forEach(el => el.parentElement?.remove());
      const body = range.parentElement === block ? copy : range.parentElement?.cloneNode(false);
      if (!(body instanceof HTMLElement)) return anchor;
      if (body !== copy) body.append(copy);
      const error = document.createElement('div');
      error.dataset.ozrError = '';
      error.id = ID + '-error-' + ++serial;
      error.setAttribute('aria-live', 'polite');
      const inputs = [...copy.querySelectorAll('input')];
      if (inputs.length !== 2) return anchor;
      inputs.forEach((input, i) => {
        input.removeAttribute('id');
        input.removeAttribute('name');
        input.removeAttribute('value');
        input.removeAttribute('maxlength');
        input.inputMode = offset ? 'numeric' : 'decimal';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('role', 'spinbutton');
        input.setAttribute('aria-label', (offset ? 'Отзывы' : 'Оценка') + (i ? ' до' : ' от'));
        input.setAttribute('aria-valuemin', '0');
        if (offset) input.removeAttribute('aria-valuemax');
        else input.setAttribute('aria-valuemax', '5');
        input.setAttribute('aria-describedby', error.id);
        const field = input.parentElement?.parentElement;
        if (field) field.dataset.ozrField = '';
      });
      root.append(heading, body, error);
      panel = { root, price: block, inputs, error, offset };
      panels.set(root, panel);
      restore(panel);
      if (draft?.offset === offset) {
        inputs.forEach((input, i) => { input.value = draft?.values[i] ?? ''; });
        validate(panel, false);
      }
      anchor.after(root);
      if (focus?.offset === offset) {
        const saved = focus, input = inputs[saved.index];
        input?.focus({ preventScroll: true });
        input?.setSelectionRange(saved.start, saved.end);
      }
    }
    [...range.querySelectorAll<HTMLInputElement>('input[type="text"]')].forEach((input, i) => {
      const own = panel.inputs[i];
      if (own) { own.disabled = input.disabled; own.readOnly = input.readOnly; }
    });
    paint(panel);
    return panel.root;
  }

  function metrics(card: HTMLElement): Metrics | null {
    let rating = NaN, reviews = NaN, reviewFound = false;
    for (const span of card.querySelectorAll('svg + span')) {
      const icon = span.previousElementSibling;
      if (!icon) continue;
      if (icon.getAttribute('style')?.includes('graphicRating') || icon.querySelector('path[d^="M8 2a1 1 0 0 1"]')) {
        const n = parse(span.textContent ?? '', 0);
        if (n > 0) rating = n;
      } else if (icon.querySelector('path[d^="M8.546 3C11.93"]') || /отзыв/i.test(span.textContent ?? '')) {
        const match = (span.textContent ?? '').replace(/\s/g, '').match(/^(\d+)(?:отзыв(?:а|ов)?)?$/i);
        reviews = match ? parse(match[1] ?? '', 2) : NaN;
        reviewFound = true;
      }
    }
    const grid = card.closest<HTMLElement>(GRID);
    if (!grid) return null;
    const key = productKey(card), delivery = deliveryLabel(card);
    if (key && delivery !== null) knownDelivery.set(key, delivery);
    return { rating, reviews: !reviewFound && Number.isNaN(rating) ? 0 : reviews, key, delivery, quantity: hasQuantity(card), grid };
  }

  function apply() {
    const [lo = 0, hi = 5, min = 0, max = Infinity] = values.map(parse);
    const rated = lo > 0 || hi < 5, reviewed = min > 0 || max < Infinity;
    const delivery = freshOnly && isFresh() && deliveryPanels.size > 0;
    const active = rated || reviewed || delivery;
    for (const grid of grids) {
      if (!active || !grid.isConnected) {
        grid.removeAttribute('data-ozr-grid');
        grid.style.removeProperty('--ozr-height');
        grids.delete(grid);
      }
    }
    const heights = new Map<HTMLElement, number>();
    for (const [card, { grid }] of cards) {
      if (!card.isConnected || !card.matches(CARD)) { card.removeAttribute('data-ozr-hidden'); cards.delete(card); measureGrids.add(grid); continue; }
      if (active && (!grids.has(grid) || measureGrids.has(grid))) heights.set(grid, 0);
    }
    for (const [card, { grid }] of cards) {
      if (heights.has(grid)) card.removeAttribute('data-ozr-hidden');
    }
    for (const grid of heights.keys()) {
      grid.removeAttribute('data-ozr-grid');
      grid.style.removeProperty('--ozr-height');
      heights.set(grid, Math.ceil(grid.getBoundingClientRect().height));
    }
    for (const [grid, height] of heights) {
      grid.style.setProperty('--ozr-height', height + 'px');
      grid.setAttribute('data-ozr-grid', '');
      grids.add(grid);
    }
    let shown = 0, total = 0, first: HTMLElement | undefined;
    measureGrids.clear();
    for (const [card, { rating, reviews, key, delivery: label, quantity, grid }] of cards) {
      const fast = label === true || label === null && knownDelivery.get(key) === true && (quantity || (pendingCart.get(key) || 0) > Date.now());
      const hide = delivery && !fast || rated && !(rating >= lo && rating <= hi) || reviewed && !(reviews >= min && reviews <= max);
      if (card.hasAttribute('data-ozr-hidden') !== hide) card.toggleAttribute('data-ozr-hidden', hide);
      if (active) {
        total++;
        first ||= grid;
        if (!hide) shown++;
      }
    }
    empty.hidden = !active || !!shown || !total;
    if (!empty.hidden && first) {
      if (empty.nextElementSibling !== first) first.before(empty);
      const text = 'Среди загруженных товаров нет подходящих под фильтры. Измените фильтры или прокрутите ниже, чтобы загрузить ещё.';
      if (empty.textContent !== text) empty.textContent = text;
    }
  }

  function scan(scope: ParentNode, selector: string, visit: (element: HTMLElement) => void) {
    if (scope === document) { if (!activeRoot) return; scope = activeRoot; }
    if (scope instanceof HTMLElement && scope.matches(selector)) visit(scope);
    for (const element of scope.querySelectorAll(selector)) if (element instanceof HTMLElement) visit(element);
  }

  function flush() {
    frame = 0;
    syncContext();
    for (const [root, panel] of panels) {
      if (!root.isConnected || !panel.price.isConnected) { root.remove(); panels.delete(root); }
    }
    for (const scope of dirty) {
      if (scope instanceof Node && scope !== document && !scope.isConnected) continue;
      scan(scope, PRICE, mount);
      scan(scope, CARD, card => {
        const previous = cards.get(card), next = metrics(card);
        if (!next) return;
        if (!previous || previous.grid !== next.grid) {
          measureGrids.add(next.grid);
          if (previous) measureGrids.add(previous.grid);
        }
        cards.set(card, next);
      });
    }
    dirty.clear();
    mountDelivery();
    apply();
  }

  function schedule(scope: ParentNode) {
    if (!activeRoot) return;
    dirty.add(scope);
    if (!frame) frame = requestAnimationFrame(flush);
  }

  for (const name of ['input', 'focusin', 'focusout', 'keydown', 'click']) document.addEventListener(name, onEvent);
  document.addEventListener('click', captureCart, true);
  const widgetObserver = new MutationObserver(records => {
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!target || target.closest('[data-ozr], [data-ozr-empty]')) continue;
      const widget = target.closest<HTMLElement>('[data-widget="filtersDesktop"]');
      const card = target.closest<HTMLElement>(CARD);
      if (widget) schedule(widget);
      else if (card) schedule(card);
      else for (const node of record.addedNodes) if (node instanceof HTMLElement) schedule(node);
      if (record.removedNodes.length && target.closest(GRID)) schedule(target);
    }
  });
  const structureObserver = new MutationObserver(records => {
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (target?.closest('[data-ozr], [data-ozr-empty]')) continue;
      const changed = [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && !node.matches('[data-ozr], [data-ozr-empty]') && (node.matches(PRICE + ', ' + GRID + ', [data-widget="filtersDesktop"]') || !!node.querySelector(PRICE + ', ' + GRID + ', [data-widget="filtersDesktop"]')));
      if (changed) { observeWidgets(); schedule(document); }
    }
  });

  function observeWidgets() {
    widgetObserver.disconnect();
    if (!activeRoot) return;
    for (const widget of activeRoot.querySelectorAll('[data-widget="filtersDesktop"], ' + GRID)) {
      widgetObserver.observe(widget, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'readonly', 'href', 'hidden', 'aria-hidden', 'style'] });
    }
  }

  const rootObserver = new MutationObserver(() => {
    if (document.getElementById('layoutPage') !== activeRoot) start();
  });

  function stop(keepRootObserver = false) {
    if (!keepRootObserver) { rootObserver.disconnect(); routeRoot = null; }
    structureObserver.disconnect();
    widgetObserver.disconnect();
    activeRoot = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    clearTimeout(timer);
    for (const root of panels.keys()) root.remove();
    panels.clear();
    for (const root of deliveryPanels.keys()) root.remove();
    deliveryPanels.clear();
    for (const card of cards.keys()) card.removeAttribute('data-ozr-hidden');
    cards.clear();
    for (const grid of grids) { grid.removeAttribute('data-ozr-grid'); grid.style.removeProperty('--ozr-height'); }
    grids.clear();
    measureGrids.clear();
    knownDelivery.clear();
    pendingCart.clear();
    for (const timer of cartTimers.values()) clearTimeout(timer);
    cartTimers.clear();
    dirty.clear();
    empty.remove();
    draft = focus = null;
  }

  function start() {
    if (/^\/(?:product|cart|my)(?:\/|$)/.test(location.pathname)) { stop(); return; }
    const app = document.getElementById('__ozon');
    if (app !== routeRoot) {
      stop();
      routeRoot = app;
      if (app) rootObserver.observe(app, { childList: true });
    }
    const root = document.getElementById('layoutPage');
    if (!root) { stop(true); return; }
    if (activeRoot !== root) {
      stop(true);
      activeRoot = root;
      structureObserver.observe(root, { childList: true, subtree: true });
      observeWidgets();
    }
    schedule(root);
  }

  addEventListener('resize', () => {
    if (!activeRoot) return;
    for (const grid of grids) measureGrids.add(grid);
    schedule(activeRoot);
  });
  let lastUrl = location.href;
  const navigate = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    stop();
    frame = requestAnimationFrame(() => { frame = 0; start(); });
  };
  if (window.navigation) window.navigation.addEventListener('currententrychange', navigate);
  else addEventListener('popstate', navigate);
  addEventListener('pageshow', start);
  addEventListener('pagehide', () => { stop(); });
  start();
})();
