Tampermonkey userscript that adds product rating and review count ranges below the price filter on Ozon's desktop listings. Both filters apply together to loaded product cards, including new items loaded while scrolling.

Install [Tampermonkey](https://www.tampermonkey.net/), open the [userscript](https://raw.githubusercontent.com/sashokey/ozon-search/master/ozon-search.user.js), and confirm installation. Reload Ozon.

Enter minimum and maximum ratings from 0 to 5. Changes apply as you type or when you press Enter. Products without a rating are hidden when the range is narrower than 0-5. Clear the minimum and set the maximum to 5 to show all loaded products again.

Enter whole numbers from 0 for the review count. Leave either bound empty for no restriction on that side. Cards without ratings or reviews count as zero reviews; an unreadable count is hidden when the review filter is active. Clear both review fields to disable this filter. Ranges are kept for the current search during the browser tab's session.

While either filter is active, loaded grids retain their height so Ozon's virtual pagination does not repeatedly load pages when cards disappear. This can leave blank space below matching cards. If no loaded products match, change the ranges or scroll down to load more. Clearing both filters restores the normal layout.
