#!/usr/bin/env python3
"""Build the Delta Shores Community Association site into ./public.

Content lives in ./content:
  site.json            site-wide settings (nav, board, integrations)
  posts/<slug>.html    news posts   (header comment + HTML body)
  events/<slug>.html   events       (header comment + HTML body)
Page layouts live in ./templates; static files in ./static.

Usage: python3 build.py          build once
       python3 build.py --serve  build, then serve on http://localhost:8000
"""
import datetime as dt
import html
import json
import re
import shutil
import sys
import zoneinfo
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

ROOT = Path(__file__).parent
CONTENT, TEMPLATES, STATIC, OUT = (ROOT / p for p in ("content", "templates", "static", "public"))
TZ = zoneinfo.ZoneInfo("America/Los_Angeles")


def read_entry(path):
    raw = path.read_text(encoding="utf-8")
    meta = {}
    m = re.match(r"\s*<!--(.*?)-->\s*", raw, re.S)
    if m:
        for line in m.group(1).strip().splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip()
        raw = raw[m.end():]
    meta["slug"] = path.stem
    meta["body"] = raw.strip()
    return meta


def plain(s, n=None):
    t = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()
    if n and len(t) > n:
        t = t[:n].rsplit(" ", 1)[0] + "…"
    return t


def ics(ev, site):
    def f(d):
        return d.astimezone(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    loc = ", ".join(x for x in (ev.get("venue"), ev.get("address"), ev.get("city")) if x)
    esc = lambda s: s.replace("\\", "\\\\").replace(",", "\\,").replace(";", "\\;").replace("\n", "\\n")
    return "\r\n".join([
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//DSCA//Events//EN", "BEGIN:VEVENT",
        f"UID:{ev['slug']}@deltashorescommunity.com",
        f"DTSTAMP:{f(dt.datetime.now(TZ))}", f"DTSTART:{f(ev['start_dt'])}", f"DTEND:{f(ev['end_dt'])}",
        f"SUMMARY:{esc(ev['title'])}", f"LOCATION:{esc(loc)}",
        f"DESCRIPTION:{esc(plain(ev['body'], 600))}",
        f"URL:{site['url']}/events/{ev['slug']}", "END:VEVENT", "END:VCALENDAR", ""])


def build():
    site = json.loads((CONTENT / "site.json").read_text())
    site["year"] = dt.date.today().year
    now = dt.datetime.now(TZ)

    posts = [read_entry(p) for p in (CONTENT / "posts").glob("*.html")]
    for p in posts:
        p["date_obj"] = dt.date.fromisoformat(p["date"])
        p["excerpt"] = p.get("excerpt") or plain(p["body"], 180)
    posts.sort(key=lambda p: (p["date_obj"], p["slug"]), reverse=True)

    events = [read_entry(p) for p in (CONTENT / "events").glob("*.html")]
    for e in events:
        e["start_dt"] = dt.datetime.fromisoformat(e["start"]).astimezone(TZ)
        e["end_dt"] = dt.datetime.fromisoformat(e["end"]).astimezone(TZ)
        e["excerpt_html"] = e.get("excerpt", "")
        e["excerpt"] = plain(e["excerpt_html"], 200) or plain(e["body"], 160)
        e["categories"] = [c.strip() for c in e.get("categories", "").split(",") if c.strip()]
        e["tags"] = [c.strip() for c in e.get("tags", "").split(",") if c.strip()]
        e["is_online"] = "online" in (e.get("venue", "") + e["title"]).lower()
        q = lambda s: re.sub(r"\s+", "+", s)
        loc = ", ".join(x for x in (e.get("address"), e.get("city")) if x)
        e["map_url"] = f"https://www.google.com/maps/search/?api=1&query={q(loc)}" if e.get("address") else ""
        e["gcal_url"] = ("https://calendar.google.com/calendar/render?action=TEMPLATE"
                         f"&text={q(e['title'])}"
                         f"&dates={e['start_dt'].astimezone(dt.timezone.utc):%Y%m%dT%H%M%SZ}/"
                         f"{e['end_dt'].astimezone(dt.timezone.utc):%Y%m%dT%H%M%SZ}"
                         f"&location={q(', '.join(x for x in (e.get('venue'), loc) if x))}"
                         f"&details={q(site['url'] + '/events/' + e['slug'])}")
    upcoming = sorted([e for e in events if e["end_dt"] >= now], key=lambda e: e["start_dt"])
    past = sorted([e for e in events if e["end_dt"] < now], key=lambda e: e["start_dt"], reverse=True)

    env = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=select_autoescape(["html"]),
                      trim_blocks=True, lstrip_blocks=True)
    env.filters["plain"] = plain
    env.filters["day"] = lambda d: d.strftime("%A, %B %-d, %Y")
    env.filters["short"] = lambda d: d.strftime("%b %-d, %Y")
    env.filters["mon"] = lambda d: d.strftime("%b")
    env.filters["dnum"] = lambda d: d.strftime("%-d")
    env.filters["time"] = lambda d: d.strftime("%-I:%M %p")
    import hashlib
    asset_v = hashlib.md5((STATIC / "css" / "site.css").read_bytes()).hexdigest()[:10]
    g = dict(site=site, posts=posts, upcoming=upcoming, past=past, integ=site["integrations"], asset_v=asset_v)

    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(STATIC, OUT)

    def render(tpl, dest, **ctx):
        path = OUT / dest
        path.parent.mkdir(parents=True, exist_ok=True)
        rel = "/" if dest == "index.html" else "/" + dest.removesuffix(".html")
        ctx.setdefault("canonical", "" if dest == "404.html" else site["url"] + rel)
        path.write_text(env.get_template(tpl).render(**g, **ctx), encoding="utf-8")

    for page in sorted((TEMPLATES / "pages").glob("*.html")):
        name = page.stem
        render(f"pages/{page.name}", "index.html" if name == "home" else f"{name}.html", page=name)
    for p in posts:
        render("post.html", f"blog/{p['slug']}.html", post=p, page="blog")
    for e in events:
        render("event.html", f"events/{e['slug']}.html", ev=e, page="events")
        (OUT / "events" / f"{e['slug']}.ics").write_text(ics(e, site), encoding="utf-8")

    urls = ["/"] + [f"/{p.stem}" for p in (TEMPLATES / "pages").glob("*.html") if p.stem not in ("home", "404")]
    urls += [f"/blog/{p['slug']}" for p in posts] + [f"/events/{e['slug']}" for e in events]
    (OUT / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(f"  <url><loc>{site['url']}{u}</loc></url>\n" for u in sorted(urls)) + "</urlset>\n")
    (OUT / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {site['url']}/sitemap.xml\n")
    print(f"Built {len(posts)} posts, {len(upcoming)} upcoming + {len(past)} past events -> {OUT}")


if __name__ == "__main__":
    build()
    if "--serve" in sys.argv:
        import functools, http.server
        class H(http.server.SimpleHTTPRequestHandler):
            def do_GET(self):  # mimic Firebase cleanUrls
                p = self.path.split("?")[0]
                if p != "/" and "." not in p.rsplit("/", 1)[-1] and (OUT / (p.lstrip("/") + ".html")).exists():
                    self.path = p + ".html"
                return super().do_GET()
        http.server.ThreadingHTTPServer(("", 8000), functools.partial(H, directory=str(OUT))).serve_forever()
