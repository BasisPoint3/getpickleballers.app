# getpickleballers.app

The website for the Pickleballers iOS app: the landing page, the guides, and
the app's invite (`/join#<token>`) and live score (`/live#<token>`) pages.
Built with [Astro](https://astro.build), published to GitHub Pages by the
workflow in `.github/workflows/deploy.yml`.

```bash
npm install
npm run dev
```

The plan, and the daily guide loop that writes to `src/content/guides/`, is
[`docs/PLAN.md`](docs/PLAN.md).
