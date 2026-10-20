// @ts-check
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// getpickleballers.app: a static site on GitHub Pages. The join and live
// pages in public/ are copies of the app's own pages and need no build.
export default defineConfig({
  site: 'https://getpickleballers.app',
  integrations: [
    sitemap({
      // The two app pages are noindex and carry a token after the #.
      filter: (page) => !page.endsWith('/join.html') && !page.endsWith('/live.html'),
    }),
  ],
});
