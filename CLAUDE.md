# getpickleballers.app

The website for **Pickleballers**, the iPhone and Apple Watch app in the
`pickleball-app` repo checked out beside this one. The plan for this site and
for the daily guide loop is [`docs/PLAN.md`](docs/PLAN.md); read it first.
The app-side half, and the decisions D-114 to D-116, are in
`../pickleball-app/docs/WEBSITE.md`.

## What's here

| Path | What |
| :-- | :-- |
| `src/pages/` | The landing page, the guides index, privacy, support, waitlist |
| `src/content/guides/*.md` | One Markdown file per guide. Frontmatter is typed in `src/content.config.ts`; a missing field fails the build |
| `src/layouts/`, `src/components/`, `src/styles/global.css` | The look: the app's tokens (Ink, Chalk, Ball, Court Blue, Coral) from `pickleball-app/docs/DESIGN.md` |
| `src/consts.ts` | The site's name, the support address, the waitlist form and App Store links. Empty strings mean "not yet" |
| `public/join.html`, `public/live.html`, `public/js/`, `public/css/` | **The app's own pages, copied byte for byte** from `pickleball-app`'s git history (the commit before D-99). The app shares `/join#<token>` and `/live#<token>`. Their spec is `pickleball-app/docs/LIVE_LINK.md` and D-58; change them only with that doc |
| `public/CNAME`, `public/robots.txt` | GitHub Pages' custom domain and the crawl rules |
| `docs/PLAN.md` | The plan: the site, the daily guide loop, the template, the phases, the setup steps |
| `seo/seed-queries.md` | The guide loop's phase-one list |
| `.github/workflows/deploy.yml` | Builds on every push and PR; publishes `main` to GitHub Pages |

## Rules

- **Never commit or push unless Jared asks.** The one planned exception is the
  daily guide loop on `web-guide-*` branches (D-116), once he has confirmed it.
- **Guides are true.** Rules of pickleball come from USA Pickleball's rulebook
  and `pickleball-app/docs/SCORING_RULES.md` (what the app enforces). The app's
  features come from `pickleball-app/docs/BUILD_STATUS.md`; never describe one
  that isn't built.
- **The voice** is `pickleball-app/docs/DESIGN.md`'s: short sentences, plain
  words, no exclamation marks, light pickleball language, no hype.
- **One CTA per guide**, after the bottom line, through `<AppCta />`.
- **No hardcoded group or company name.** The site is Pickleballers, nothing else.

## Run it

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # writes dist/, which the workflow publishes
```
