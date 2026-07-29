# -*- coding: utf-8 -*-
"""Cree le coffre Obsidian Market Pulse sur l'Omen."""
import os, json, datetime

ROOT = os.path.expanduser("~/market-vault")

VENUES = [
  # id, nom, pays, indice, symbole, tz, ouverture locale, pause dejeuner, sources locales
  ("nyse","NYSE","Stati Uniti","NYSE Composite","^NYA","America/New_York","09:30",None,
   ["CNBC Mercati","CNBC Economia","MarketWatch","Yahoo Finance"]),
  ("nasdaq","Nasdaq","Stati Uniti","Nasdaq Composite","^IXIC","America/New_York","09:30",None,
   ["CNBC Mercati","MarketWatch","Barron's"]),
  ("jpx","JPX","Giappone","Nikkei 225","^N225","Asia/Tokyo","09:00","11:30-12:30",
   ["Japan Times business","NHK business","Kyodo"]),
  ("euronext","Euronext","Area euro (NL, FR, BE, PT, IE, IT, NO)","Euronext 100","^N100","Europe/Paris","09:00",None,
   ["Il Sole 24 Ore","ANSA Economia","Les Echos marches","ABC Bourse","FD (NL)"]),
  ("hkex","HKEX","Hong Kong","Hang Seng","^HSI","Asia/Hong_Kong","09:30","12:00-13:00",
   ["SCMP business","HKEJ","RTHK"]),
  ("sse","SSE","Cina (Shanghai)","Shanghai Composite","000001.SS","Asia/Shanghai","09:30","11:30-13:00",
   ["Caixin","Yicai","Shanghai Securities News"]),
  ("lse","LSE","Regno Unito","FTSE 100","^FTSE","Europe/London","08:00",None,
   ["Financial Times","Guardian business","BBC business","City AM"]),
  ("nse","NSE","India","Nifty 50","^NSEI","Asia/Kolkata","09:15",None,
   ["Economic Times","Livemint","Business Standard"]),
  ("szse","SZSE","Cina (Shenzhen)","Shenzhen Component","399001.SZ","Asia/Shanghai","09:30","11:30-13:00",
   ["Caixin","Yicai"]),
  ("db","Deutsche Boerse","Germania","DAX","^GDAXI","Europe/Berlin","09:00",None,
   ["Handelsblatt Finanzen","Manager Magazin","Tagesschau Wirtschaft","finanzen.net"]),
]

# Euronext : les places qu'il regroupe, avec leur indice propre (tous sondes OK)
EURONEXT_SUB = [
  ("Amsterdam","AEX","^AEX","Europe/Amsterdam"), ("Parigi","CAC 40","^FCHI","Europe/Paris"),
  ("Bruxelles","BEL 20","^BFX","Europe/Brussels"), ("Lisbona","PSI 20","PSI20.LS","Europe/Lisbon"),
  ("Dublino","ISEQ","^ISEQ","Europe/Dublin"), ("Milano","FTSE MIB","FTSEMIB.MI","Europe/Rome"),
  ("Oslo","OSEBX","OSEBX.OL","Europe/Oslo"),
]

TEMI = [
  ("inflazione","Inflation — indices de prix, attentes, effet sur les taux"),
  ("banche-centrali","Banques centrales — BCE, Fed, BoJ, BoE, PBoC, RBI"),
  ("dazi-e-commercio","Droits de douane et commerce international"),
  ("semiconduttori","Semi-conducteurs — la chaine qui relie Seoul, Taipei, Tokyo et le Nasdaq"),
  ("energia","Energie — petrole, gaz, electricite"),
  ("utili-societari","Resultats d'entreprises — saisons de publication"),
  ("tassi-e-obbligazioni","Taux et obligations — courbes, spreads, BTP"),
  ("valute","Devises — EUR/USD, USD/JPY, CNY"),
]

def w(path, text):
    d = os.path.dirname(path)
    if d: os.makedirs(d, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)

for d in ("10 - Borse","20 - Giornaliero","30 - Temi","40 - Fonti","90 - Meta"):
    os.makedirs(os.path.join(ROOT, d), exist_ok=True)

# --- une note permanente par place ---
for vid, nom, pays, indice, sym, tz, ouv, pause, sources in VENUES:
    links = " · ".join("[[%s]]" % t for t, _ in TEMI[:4])
    extra = ""
    if vid == "euronext":
        extra = ("\n## Places regroupees\n\n"
                 "Euronext est **un seul operateur pour sept pays** — c'est la subtilite de cette "
                 "entree : Milan en fait partie, donc la bourse du grand-pere est ici.\n\n"
                 "| Place | Indice | Symbole | Fuseau |\n|---|---|---|---|\n"
                 + "\n".join("| %s | %s | `%s` | %s |" % s for s in EURONEXT_SUB) + "\n")
    w(os.path.join(ROOT, "10 - Borse", "%s.md" % nom),
"""---
tags: [borsa]
id: %s
symbol: %s
tz: %s
opens: "%s"
---
# %s — %s

| | |
|---|---|
| Indice suivi | %s (`%s`) |
| Fuseau | %s |
| Ouverture | %s locale%s |
| Sources locales | %s |
%s
## Ce que j'ai compris

*(Cette section grossit chaque jour. J'y note ce qui fait bouger cette place :
qui la mene, a quoi elle reagit, ce qui la relie aux autres.)*

## Ce qui la relie aux autres

%s

## Briefings

```dataview
LIST FROM "20 - Giornaliero" WHERE contains(file.name, "%s")
```
""" % (vid, sym, tz, ouv, nom, pays, indice, sym, tz, ouv,
       (" · pause dejeuner %s" % pause) if pause else "",
       ", ".join(sources), extra, links, nom))

# --- pages theme ---
for slug, desc in TEMI:
    w(os.path.join(ROOT, "30 - Temi", "%s.md" % slug),
"""---
tags: [tema]
---
# %s

%s

## Pourquoi ca compte

*(a remplir au fil des briefings)*

## Ou ca apparait

```dataview
LIST FROM [[%s]] AND "20 - Giornaliero"
```
""" % (slug, desc, slug))

# --- index ---
w(os.path.join(ROOT, "00 - Indice.md"),
"""# Market Pulse — coffre de connaissance

Ce coffre est ma **memoire de travail** sur les marches. Chaque briefing quotidien y depose une
note ; les notes pointent vers les places et vers les themes, si bien que les liens se tissent
tout seuls. Au bout de quelques semaines, ouvrir [[inflazione]] montre toutes les fois ou le
sujet a touche une place, et laquelle a bouge en premier.

## Les dix places suivies

%s

## Themes transverses

%s

## Conventions

- Une note de briefing = `20 - Giornaliero/AAAA-MM-JJ — <Place>.md`
- Elle cite **toujours** ses sources en lien, et lie les themes evoques
- Les faits sont dates ; ce qui est incertain est marque comme tel
- **Aucun conseil d'investissement** nulle part dans ce coffre — c'est la regle du projet
""" % ("\n".join("- [[%s]] — %s (%s, ouvre %s)" % (n, p, s, o) for _, n, p, _, s, _, o, _, _ in VENUES),
       "\n".join("- [[%s]]" % t for t, _ in TEMI)))

w(os.path.join(ROOT, "90 - Meta", "Pieges de sources.md"),
"""---
tags: [meta]
---
# Pieges de sources (mesures, pas supposes)

- **Un « HTTP 200 » ne prouve pas qu'un flux est vivant.** Mesures reelles : MarketWatch
  `marketpulse` = 13 mois, `nl.investing.com` = 85 jours, `abmfn.nl` = 6 mois. Toujours lire la
  date du premier item.
- **Un 429 qu'on provoque soi-meme ne prouve rien.** Espacer >= 60 s avant de conclure.
- **200 avec corps vide**, et **200 avec des `<pubDate/>` vides** (fraicheur immesurable).
- **Le premier item n'est pas le plus recent** : wallstreet-online ouvre sur une publicite.
- **Dates mal etiquetees** : ABC Bourse marque « GMT » en publiant en heure de Paris.
- **Toujours un fichier temporaire NEUF par sonde** : sur un 302 a corps vide, curl ne reecrit
  pas le fichier et on analyse le flux precedent -> faux positif.
- Reddit `.json` = 403, mais `.rss` multireddit rend **100 posts en une requete**.
- X : payload Relay, **cles non quotees**, horodatage `created_at_ms`.
""")

print("Coffre cree :", ROOT)
for base, dirs, files in os.walk(ROOT):
    for f in sorted(files):
        print("  ", os.path.relpath(os.path.join(base, f), ROOT))
