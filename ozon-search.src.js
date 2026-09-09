// ==UserScript==
// @name         Ozon - Rating and Review Filters
// @namespace    https://github.com/sashokey/ozon-search
// @version      1.0.1
// @description  Adds rating and review count ranges after the price filter. Filters loaded products and new items while scrolling.
// @match        https://www.ozon.ru/*
// @match        https://ozon.ru/*
// @run-at       document-idle
// @grant        none
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
  const panels = new Map(), cards = new Map(), grids = new Set(), dirty = new Set([document]);
  let context, values = ['', '5', '', ''], draft, focus, frame, timer, serial = 0;
  const style = document.createElement('style');
  style.id = ID + '-style';
  style.textContent = `
    [data-ozr-hidden]{display:none!important}
    [data-ozr-grid]{min-height:var(--ozr-height)!important}
    [data-ozr] [data-ozr-range]{margin-bottom:0}
    [data-ozr] [data-ozr-field] p{display:block;pointer-events:none}
    [data-ozr] [data-ozr-field]:has(input[aria-invalid="true"]){border-color:var(--ozAccentAlert,#f91155)}
    [data-ozr] [data-ozr-error]{color:var(--ozAccentAlert,#f91155);font-size:12px;line-height:16px;margin-top:8px}
    [data-ozr] [data-ozr-error]:empty{display:none}
    [data-ozr-empty]{box-sizing:border-box;padding:32px 24px;color:var(--textSecondary,#707f8d);font:inherit}
    [data-ozr-empty][hidden]{display:none}
  `;
  document.head.append(style);
  const empty = document.createElement('div');
  empty.dataset.ozrEmpty = '';
  empty.setAttribute('role', 'status');
  empty.hidden = true;

  function parse(value, index) {
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

  function syncContext() {
    const url = new URL(location.href);
    const next = url.pathname + '?' + ['text', 'miniapp'].map(k => url.searchParams.get(k) || '').join('&');
    if (context === next) return;
    context = next;
    draft = focus = null;
    values = ['', '5', '', ''];
    try {
      const saved = JSON.parse(sessionStorage.getItem(ID));
      if (saved?.context === context && Array.isArray(saved.values) && [2, 4].includes(saved.values.length) && saved.values.every(v => typeof v === 'string')) {
        const next = saved.values.length === 2 ? [...saved.values, '', ''] : saved.values;
        const [a, b, c, d] = next.map(parse);
        if (a <= b && c <= d) values = next;
      }
    } catch {}
    clearTimeout(timer);
    for (const panel of panels.values()) restore(panel);
    apply();
  }

  function paint(panel) {
    panel.inputs.forEach((input, i) => {
      const field = input.closest('[data-ozr-field]');
      const prefix = panel.prefixes[i];
      if (prefix) {
        field.classList.toggle(prefix + 'b4', document.activeElement === input);
        field.classList.toggle(prefix + 'b5', input.disabled);
        field.classList.toggle(prefix + 'b7', !!input.value);
        field.classList.toggle(prefix + 'b8', input.getAttribute('aria-invalid') === 'true');
      }
      const n = parse(input.value, panel.offset + i);
      if (Number.isFinite(n)) input.setAttribute('aria-valuenow', n);
      else input.removeAttribute('aria-valuenow');
    });
  }

  function validate(panel, show) {
    const nums = panel.inputs.map((input, i) => parse(input.value, panel.offset + i));
    const reversed = nums[0] > nums[1];
    const invalid = nums.map(n => Number.isNaN(n) || reversed);
    panel.inputs.forEach((input, i) => input.setAttribute('aria-invalid', String(show && invalid[i])));
    panel.error.textContent = show && invalid.some(Boolean)
      ? reversed ? '«От» не должно быть больше «До»' : panel.offset ? 'Введите целое число от 0' : 'Введите оценку от 0 до 5'
      : '';
    paint(panel);
    return invalid.some(Boolean) ? null : nums;
  }

  function restore(panel) {
    panel.inputs.forEach((input, i) => { input.value = values[panel.offset + i]; });
    validate(panel, false);
  }

  function commit(panel, normalize) {
    if (panel.inputs.some(input => input.disabled || input.readOnly)) return;
    const nums = validate(panel, normalize);
    if (!nums) return;
    values.splice(panel.offset, 2, ...nums.map((n, i) => (panel.offset || !i) && !panel.inputs[i].value.trim() ? '' : String(n)));
    if (normalize && draft?.offset === panel.offset) draft = null;
    save();
    for (const other of panels.values()) {
      if (other.offset === panel.offset && (normalize || other !== panel && !other.root.contains(document.activeElement))) restore(other);
    }
    apply();
  }

  function onEvent(event) {
    const panel = panels.get(event.target.closest('[data-ozr]'));
    if (!panel) return;
    const input = event.target.closest('input');
    if (!input) {
      if (event.type === 'click') event.target.closest('[data-ozr-field]')?.querySelector('input:not(:disabled)')?.focus();
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
      if (!event.isComposing && validate(panel, false)) timer = setTimeout(() => commit(panel, false), 450);
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
    if (event.type === 'keydown') {
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

  function mount(range) {
    if (range.closest('[data-ozr]') || range.querySelectorAll('input[type="text"]').length !== 2) return;
    let block = range.parentElement;
    const widget = range.closest('[data-widget]');
    while (block && block !== widget && !/^Цена(?:\s|$)/.test(block.firstElementChild?.textContent.trim() || '')) block = block.parentElement;
    if (!block || block === widget) return;
    let anchor = block;
    for (const offset of [0, 2]) anchor = mountPanel(range, block, anchor, offset);
  }

  function mountPanel(range, block, anchor, offset) {
    let panel = [...panels.values()].find(p => p.price === block && p.offset === offset && p.root.isConnected);
    if (!panel) {
      const root = block.cloneNode(false);
      root.dataset.ozr = '';
      root.removeAttribute('id');
      root.setAttribute('role', 'group');
      root.setAttribute('aria-label', offset ? 'Количество отзывов' : 'Оценка товара');
      const heading = block.firstElementChild.cloneNode(true);
      const title = [...heading.querySelectorAll('*'), heading].find(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim() === 'Цена'));
      if (!title) return anchor;
      title.textContent = offset ? 'Количество отзывов' : 'Оценка';
      title.title = offset ? 'По отзывам загруженных товаров. Пустое поле «До» — без ограничения.' : 'По оценкам загруженных товаров. При заданном диапазоне товары без оценки скрываются.';
      const copy = range.cloneNode(true);
      copy.removeAttribute('filter-key');
      copy.removeAttribute('filterkey');
      copy.removeAttribute('type');
      copy.dataset.ozrRange = '';
      copy.querySelectorAll('input[type="range"]').forEach(el => el.parentElement.remove());
      const body = range.parentElement === block ? copy : range.parentElement.cloneNode(false);
      if (body !== copy) body.append(copy);
      const error = document.createElement('div');
      error.dataset.ozrError = '';
      error.id = ID + '-error-' + ++serial;
      error.setAttribute('aria-live', 'polite');
      const inputs = [...copy.querySelectorAll('input')];
      const prefixes = inputs.map((input, i) => {
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
        const field = input.parentElement.parentElement;
        field.dataset.ozrField = '';
        return [...field.classList].find(c => /^f[\d_]+-a$/.test(c))?.slice(0, -1);
      });
      root.append(heading, body, error);
      panel = { root, price: block, inputs, prefixes, error, offset };
      panels.set(root, panel);
      restore(panel);
      if (draft?.offset === offset) {
        inputs.forEach((input, i) => { input.value = draft.values[i]; });
        validate(panel, false);
      }
      anchor.after(root);
      if (focus?.offset === offset) {
        const saved = focus, input = inputs[saved.index];
        input.focus({ preventScroll: true });
        input.setSelectionRange(saved.start, saved.end);
      }
    }
    [...range.querySelectorAll('input[type="text"]')].forEach((input, i) => {
      panel.inputs[i].disabled = input.disabled;
      panel.inputs[i].readOnly = input.readOnly;
    });
    paint(panel);
    return panel.root;
  }

  function metrics(card) {
    let rating = NaN, reviews = NaN, reviewFound = false;
    for (const span of card.querySelectorAll('svg + span')) {
      const icon = span.previousElementSibling;
      if (icon.getAttribute('style')?.includes('graphicRating') || icon.querySelector('path[d^="M8 2a1 1 0 0 1"]')) {
        const n = parse(span.textContent, 0);
        if (n > 0) rating = n;
      } else if (icon.querySelector('path[d^="M8.546 3C11.93"]') || /отзыв/i.test(span.textContent)) {
        const match = span.textContent.replace(/\s/g, '').match(/^(\d+)(?:отзыв(?:а|ов)?)?$/i);
        reviews = match ? parse(match[1], 2) : NaN;
        reviewFound = true;
      }
    }
    return { rating, reviews: !reviewFound && Number.isNaN(rating) ? 0 : reviews, grid: card.closest(GRID) };
  }

  function apply() {
    const [lo, hi, min, max] = values.map(parse);
    const rated = lo > 0 || hi < 5, reviewed = min > 0 || max < Infinity;
    const active = rated || reviewed;
    for (const grid of grids) {
      if (!active || !grid.isConnected) {
        grid.removeAttribute('data-ozr-grid');
        grid.style.removeProperty('--ozr-height');
        grids.delete(grid);
      }
    }
    const heights = new Map();
    for (const [card, { grid }] of cards) {
      if (!card.isConnected) { cards.delete(card); continue; }
      if (active && !grids.has(grid) && !heights.has(grid)) heights.set(grid, Math.ceil(grid.getBoundingClientRect().height));
    }
    for (const [grid, height] of heights) {
      grid.style.setProperty('--ozr-height', height + 'px');
      grid.setAttribute('data-ozr-grid', '');
      grids.add(grid);
    }
    let shown = 0;
    for (const [card, { rating, reviews }] of cards) {
      const hide = rated && !(rating >= lo && rating <= hi) || reviewed && !(reviews >= min && reviews <= max);
      if (card.hasAttribute('data-ozr-hidden') !== hide) card.toggleAttribute('data-ozr-hidden', hide);
      if (!hide) shown++;
    }
    empty.hidden = !active || !!shown || !cards.size;
    if (!empty.hidden) {
      const first = cards.keys().next().value.closest(GRID);
      if (empty.nextElementSibling !== first) first.before(empty);
      const text = 'Среди загруженных товаров нет подходящих под фильтры. Измените диапазоны или прокрутите ниже, чтобы загрузить ещё.';
      if (empty.textContent !== text) empty.textContent = text;
    }
  }

  function scan(scope, selector, visit) {
    if (scope.matches?.(selector)) visit(scope);
    scope.querySelectorAll?.(selector).forEach(visit);
  }

  function flush() {
    frame = 0;
    syncContext();
    for (const [root, panel] of panels) {
      if (!root.isConnected || !panel.price.isConnected) { root.remove(); panels.delete(root); }
    }
    for (const scope of dirty) {
      if (scope !== document && !scope.isConnected) continue;
      scan(scope, PRICE, mount);
      scan(scope, CARD, card => cards.set(card, metrics(card)));
    }
    dirty.clear();
    apply();
  }

  function schedule(scope) {
    dirty.add(scope);
    if (!frame) frame = requestAnimationFrame(flush);
  }

  for (const name of ['input', 'focusin', 'focusout', 'keydown', 'click']) document.addEventListener(name, onEvent);
  new MutationObserver(records => {
    for (const record of records) {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (!target || target.closest('[data-ozr], [data-ozr-empty]')) continue;
      const widget = target.closest('[data-widget="filtersDesktop"]');
      const card = target.closest(CARD);
      if (widget) schedule(widget);
      else if (card) schedule(card);
      else for (const node of record.addedNodes) if (node.nodeType === 1) schedule(node);
      if (record.removedNodes.length && (target.closest(GRID) || [...panels.values()].some(p => !p.root.isConnected))) schedule(target);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'readonly'] });
  addEventListener('popstate', () => schedule(document));
  flush();
})();
