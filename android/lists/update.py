#!/usr/bin/env python3
"""Rebuild the category block lists bundled into the APK.

    python3 -I android/lists/update.py [--wikidata-csv FILE]

--wikidata-csv uses a saved result of WIKIDATA_QUERY (CSV, column "site")
instead of querying, for when the query service is down or rate-limiting.

Writes app/src/main/assets/lists/{news,adult}.txt: one domain per line;
a site is in the category if its host is listed or is a subdomain of one.

Sources:
  adult  HaGeZi NSFW (https://github.com/hagezi/dns-blocklists), the adult
         list used by NextDNS, AdGuard and most Pi-hole setups.
  news   Université Toulouse Capitole UT1 "press" category
         (https://dsi.ut-capitole.fr/blacklists/, via its GitHub mirror), used by SquidGuard and
         pfSense, plus Wikidata's official websites of newspapers, news
         websites, news agencies and news magazines. UT1 alone is mostly
         French; Wikidata brings in the BBC, Reuters, the FT and so on.
"""
import collections
import csv
import io
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "app", "src", "main", "assets", "lists")
UA = {"User-Agent": "life-blocklist-builder/1.0"}

HAGEZI_NSFW = "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/nsfw-onlydomains.txt"
# UT1's own GitHub mirror (the university server is often down or slow).
UT1_PRESS = "https://raw.githubusercontent.com/olbat/ut1-blacklists/master/blacklists/press/domains"
WIKIDATA = "https://query.wikidata.org/sparql"
# newspaper, daily newspaper, online newspaper, news website, news agency, news magazine
WIKIDATA_QUERY = """SELECT DISTINCT ?site WHERE {
  VALUES ?c { wd:Q11032 wd:Q1110794 wd:Q1153191 wd:Q17232649 wd:Q192283 wd:Q1684600 }
  ?item wdt:P31 ?c ; wdt:P856 ?site .
}"""

# Hosts that a news outlet's "official website" sometimes points into, but
# which are mostly something else: archives, libraries, platforms. Matched as
# the host itself or any parent domain.
NOT_NEWS = {
    # platforms
    "facebook.com", "instagram.com", "twitter.com", "x.com", "youtube.com", "tiktok.com",
    "linkedin.com", "t.me", "telegram.me", "vk.com", "ok.ru", "medium.com", "substack.com",
    "blogspot.com", "wordpress.com", "tumblr.com", "wix.com", "wixsite.com", "weebly.com",
    "squarespace.com", "github.com", "github.io", "google.com", "sites.google.com",
    "linktr.ee", "issuu.com", "calameo.com", "yumpu.com", "scribd.com", "apple.com",
    "spotify.com", "soundcloud.com", "flickr.com", "pinterest.com", "reddit.com",
    "wikipedia.org", "wikimedia.org", "wikidata.org", "yahoo.com", "msn.com", "microsoft.com",
    "amazon.com", "archive.org", "archive.ph", "archive.is",
    # newspaper archives and library catalogues
    "loc.gov", "newspapers.com", "newspaperarchive.com", "newsbank.com", "proquest.com",
    "ebscohost.com", "lexisnexis.com", "lexis-nexis.com", "serialssolutions.com", "oclc.org",
    "hathitrust.org", "worldcat.org", "trove.nla.gov.au", "nla.gov.au", "bnf.fr", "bne.es",
    "onb.ac.at", "kansalliskirjasto.fi", "europeana.eu", "difmoe.eu", "delpher.nl",
    "britishnewspaperarchive.co.uk", "ufdc.ufl.edu", "uoregon.edu", "hkbu.edu.hk",
    "retronews.fr", "haw.nsk.hr", "digitalnc.org", "cdnc.ucr.edu",
}

# Outlets missing from both sources at the time of writing.
EXTRA_NEWS = {
    "news.sky.com", "thetimes.co.uk", "thetimes.com", "economist.com", "newstatesman.com",
    "spectator.co.uk", "news.ycombinator.com", "news.google.com", "theguardian.com",
}


def fetch(url, headers=None, data=None, tries=4):
    req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            # The Wikidata query service rate-limits hard at times.
            if e.code not in (429, 503) or attempt == tries - 1:
                raise
            wait = min(int(e.headers.get("Retry-After") or 65), 120)
            print(f"  {e.code} from {urllib.parse.urlsplit(url).hostname}, retrying in {wait}s", file=sys.stderr, flush=True)
            time.sleep(wait)


def clean(host):
    host = (host or "").strip().lower().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    if not host or "." not in host or " " in host or "/" in host or host.replace(".", "").isdigit():
        return None
    return host


def excluded(host):
    parts = host.split(".")
    return any(".".join(parts[i:]) in NOT_NEWS for i in range(len(parts) - 1))


def adult():
    text = fetch(HAGEZI_NSFW).decode()
    return {h for line in text.splitlines() if not line.startswith("#") and (h := clean(line))}


def ut1_press():
    text = fetch(UT1_PRESS).decode("utf-8", "replace")
    return {h for line in text.splitlines() if (h := clean(line))}


def wikidata_news(saved=None):
    if saved:
        text = open(saved, encoding="utf-8").read()
    else:
        url = WIKIDATA + "?" + urllib.parse.urlencode({"query": WIKIDATA_QUERY})
        text = fetch(url, {"Accept": "text/csv"}).decode()
    rows = csv.DictReader(io.StringIO(text))
    # Keep a host only if some outlet's website is its front page or a
    # section of it (/, /news, /en…), not a deep link into an archive.
    hosts = collections.defaultdict(bool)
    for r in rows:
        u = urllib.parse.urlsplit(r["site"].strip())
        host = clean(u.hostname)
        if not host or excluded(host):
            continue
        depth = len([p for p in u.path.split("/") if p])
        hosts[host] |= depth <= 1 and not u.query
    return {h for h, front in hosts.items() if front}


def write(name, domains, sources):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"{name}.txt")
    with open(path, "w") as f:
        f.write(f"# {name}: {len(domains)} domains, built {date.today()} by android/lists/update.py\n")
        for s in sources:
            f.write(f"# source: {s}\n")
        f.write("\n".join(sorted(domains)) + "\n")
    print(f"{name}: {len(domains)} → {os.path.relpath(path)}")


def main():
    saved = sys.argv[sys.argv.index("--wikidata-csv") + 1] if "--wikidata-csv" in sys.argv else None
    a = adult()
    write("adult", a, [HAGEZI_NSFW])
    news = (ut1_press() | wikidata_news(saved) | EXTRA_NEWS)
    news = {h for h in news if not excluded(h)} - a
    write("news", news, [UT1_PRESS, "Wikidata: official websites of news outlets", "EXTRA_NEWS in update.py"])


if __name__ == "__main__":
    sys.exit(main())
