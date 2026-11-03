Violentmonkey userscript for Ozon desktop listings. It adds rating and review-count ranges below the native price filter and a «За 30 минут» switch on Ozon Fresh. Filters combine and apply to loaded cards, including items added while scrolling. Ozon determines the final delivery options in the cart.

Install [Violentmonkey](https://violentmonkey.github.io/get-it/), open the [userscript](https://raw.githubusercontent.com/sashokey/ozon-search/master/ozon-search.user.js), and confirm installation. Enable `Allow User Scripts` for Violentmonkey if required, then reload Ozon.

Clear the rating minimum and review limits, set the rating maximum to 5, and turn off the delivery switch to show all loaded products. An empty maximum review count means no upper limit. Changing the search or category resets the ranges. Keyboard input, validation, draft focus, native filter replacement, and delivery-state caching are preserved.

The authoritative source is [ozon-search.src.ts](ozon-search.src.ts). The generated `.user.js` is an ES2022 classic script compiled with esbuild and minified with Terser. Its metadata is preserved outside the generated wrapper. Native Navigation API events drive route changes; observers are scoped to the inspected Ozon application and filter/grid widgets, stop on product/cart/account routes, and recover after asynchronous root replacement. No URL polling is used.

Use Node.js 24:

```sh
npm ci --ignore-scripts
npx playwright install --with-deps chromium
npm run build
npm run check
```

`check` runs type-aware lint, strict type checking, syntax/metadata/build reproducibility checks, 52 browser tests against both readable compiled and minified artifacts, and sensitivity checks for rating and Fresh filtering. Fixtures use the inspected Ozon structure and do not use a live account. GitHub Actions runs the same checks on pushes and pull requests.

All authored TypeScript, including tests and helpers, uses `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and type-aware unsafe-operation lint rules. `allowJs` is disabled. `skipLibCheck` applies only to overlapping third-party browser declarations; authored files remain checked. Dependencies and tool versions are pinned in `package-lock.json`.
