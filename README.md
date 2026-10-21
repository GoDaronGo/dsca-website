# Delta Shores Community Association website

Static site for deltashorescommunity.com, built with a small Python script and hosted on Firebase Hosting (free Spark plan).

## How it's organized

| Path | What it holds |
|---|---|
| `content/site.json` | Site name, navigation, board members, social links, and the integration settings (Zeffy, Sender, Google Form) |
| `content/posts/` | One file per news post: a header comment (title, date, image, excerpt) followed by the HTML body |
| `content/events/` | One file per event: header comment (title, start, end, venue, address) followed by the HTML body |
| `templates/` | Page layouts (Jinja2). `templates/pages/` are the fixed pages |
| `static/` | CSS, images, by-laws PDF — copied as-is |
| `public/` | Build output (not committed) |

Events sort themselves into **Upcoming** and **Past** by date at build time, and each one gets an "Add to calendar" file.

## Add a news post

Create `content/posts/my-post-slug.html`:

```html
<!--
title: My post title
date: 2026-11-01
author: Daron Go
image: /img/site/my-image.webp
excerpt: One-sentence summary for the news list.
-->
<p>Post body here.</p>
```

## Add an event

Create `content/events/my-event-slug.html`:

```html
<!--
title: Community Meeting
start: 2026-11-18T18:00:00-08:00
end: 2026-11-18T19:30:00-08:00
venue: Casa Flores
address: 8304 Delta Shores Circle South
city: Sacramento, CA 95832
-->
<p>Event details here.</p>
```

## Build and preview

```sh
pip install -r requirements.txt
python3 build.py --serve   # http://localhost:8000
```

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`, which builds and deploys to Firebase. Manual deploy: `python3 build.py && firebase deploy --only hosting`.

Old Squarespace URLs (`/contact-us`, `/home`, the by-laws PDF path) redirect to their new homes via `firebase.json`; event and blog URLs are unchanged.

## Integrations to connect

Fill in `content/site.json → integrations` and rebuild:

- `zeffy_donation_form_url` — Zeffy donation form embed link (Donate page)
- `sender_signup_form_url` — Sender hosted sign-up form link (mailing list blocks)
- `contact_form_action` + `contact_form_fields` — Google Form `formResponse` URL and entry IDs (Contact page)

Until a value is set, the page shows a "not connected yet" note instead.
