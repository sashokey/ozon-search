export const priceFilter = `<section><h3>Цена</h3><div filter-key="currency_price"><label><span><input type="text" aria-label="Цена от"></span></label><label><span><input type="text" aria-label="Цена до"></span></label></div></section>`;

export function product(id: string, rating: string | null, reviews: string | null, delivery = 'За 30 минут') {
  const stars = rating === null ? '' : `<span><svg style="color:var(--graphicRating)"></svg><span>${rating}</span></span>`;
  const count = reviews === null ? '' : `<span><svg><path d="M8.546 3C11.93 3 12 4 12 5"></path></svg><span>${reviews} отзывов</span></span>`;
  return `<article class="tile-root" id="${id}"><a href="/product/example-${id.replace(/\D/g, '')}/">Product ${id}</a>${stars}${count}<button>${delivery}</button></article>`;
}

export const initialProducts = product('card101', '4,7', '400') + product('card102', '4,8', '25', 'Завтра') + product('card103', '4,2', '300') + product('card104', '5', '900') + product('card105', null, null, 'Завтра');

export function listing(products = initialProducts) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body><div id="__ozon"><div id="layoutPage"><aside data-widget="filtersDesktop">${priceFilter}</aside><main data-widget="tileGridDesktop">${products}</main></div></div></body></html>`;
}

