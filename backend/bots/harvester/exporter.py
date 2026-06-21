"""Export client (P4) — assemble un package autonome (zip) que le client lance
chez lui : le moteur déterministe RÉUTILISÉ TEL QUEL + une config figée + un
serveur minimal (feed privé gated X-Feed-Key). **Zéro IA** (ni `llm.py` ni
`setup.py`). Pur : aucun réseau, juste de l'assemblage de fichiers -> testable
offline.

Arbo du zip (on réplique le chemin `backend/bots/harvester/` pour que les
imports absolus du moteur marchent SANS réécriture) :
    backend/__init__.py · backend/net_guard.py · backend/bots/__init__.py
    backend/bots/harvester/<modules runtime>
    config.json · serve.py · requirements.txt · README.md · .env.example
"""
import io
import json
import os
import zipfile

# Allowlist EXPLICITE des modules runtime à embarquer (exclut llm.py + setup.py
# = les seules étapes IA, jamais livrées au client).
EXPORT_HARVESTER_MODULES = [
    "__init__.py", "policy.py", "dom.py", "recipe.py", "crawl.py", "store.py",
    "fetch.py", "fetch_unblocker.py", "fetch_stealth.py", "unblocker_config.py",
    "telegram_config.py", "notify.py",
    "pacing.py", "robots.py", "engine.py", "config.py", "__main__.py",
]

# Modules backend hors-package dont dépend le moteur (anti-SSRF partagé).
EXPORT_BACKEND_MODULES = ["net_guard.py"]

SERVE_PY = '''\
"""Feed privé autonome — moissonne la cible (déterministe, ZÉRO IA) et expose
les données via une API privée protégée par une clé (header X-Feed-Key).

Lancer :  pip install -r requirements.txt  &&  python serve.py
Lire     :  curl -H "X-Feed-Key: <clé>" http://localhost:8077/data
"""
import csv
import io
import os
import secrets
import threading

import uvicorn
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import PlainTextResponse

from backend.bots.harvester.config import HarvestConfig
from backend.bots.harvester.__main__ import run_harvest
from backend.bots.harvester.store import Store

HERE = os.path.dirname(os.path.abspath(__file__))
STORE_PATH = os.path.join(HERE, "store.json")
cfg = HarvestConfig.load(HERE)
app = FastAPI(title="Harvester feed")


def _harvest():
    """Moissonne la cible une fois (low-and-slow). Relancer le process (ou
    supprimer store.json) pour re-moissonner."""
    st = Store(STORE_PATH)
    if st.next_todo() is None and not st.counts()["done"]:
        st.add_todo(cfg.url)
        st.save()
    run_harvest(HERE)


@app.on_event("startup")
def _startup():
    threading.Thread(target=_harvest, daemon=True).start()


@app.get("/status")
def status():
    counts = Store.load(STORE_PATH).counts() if os.path.isfile(STORE_PATH) else {}
    return {"url": cfg.url, "counts": counts}


@app.get("/data")
def data(format: str = "json", x_feed_key: str = Header(default=None)):
    if not x_feed_key or not secrets.compare_digest(x_feed_key, cfg.feed_key):
        raise HTTPException(status_code=401, detail="Invalid feed key")
    records = Store.load(STORE_PATH).records() if os.path.isfile(STORE_PATH) else []
    if format == "csv":
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=cfg.recipe.field_names(),
                           extrasaction="ignore")
        w.writeheader()
        for r in records:
            w.writerow(r)
        return PlainTextResponse(buf.getvalue(), media_type="text/csv")
    return {"count": len(records), "records": records}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8077")))
'''

REQUIREMENTS_TXT = "httpx>=0.24\nfastapi>=0.100\nuvicorn>=0.20\n"

ENV_EXAMPLE = '''\
# Tier "unblocker" (OPTIONNEL) — débloqueur Cloudflare managé.
# À définir seulement si la config utilise fetch_tier="unblocker".
# Exporte ces variables avant de lancer serve.py :
#   export HARVESTER_UNBLOCKER_ENDPOINT=https://api.zenrows.com/v1/
#   export HARVESTER_UNBLOCKER_KEY=ta_cle_provider
'''

README_MD = '''\
# Feed de données autonome

Moissonneur déterministe **autonome** (aucune IA à l'exécution) : il récolte une
cible web et expose les données via une **API privée** protégée par une clé.

- **Cible** : `__URL__`
- **Clé du feed (`X-Feed-Key`)** : `__FEED_KEY__`

## Lancer

```bash
pip install -r requirements.txt
python serve.py            # port 8077 par défaut (override : PORT=9000 python serve.py)
```

Au démarrage, le moissonneur tourne en arrière-plan (low-and-slow). Les données
s'accumulent dans `store.json`.

## Lire les données (API privée)

```bash
curl -H "X-Feed-Key: __FEED_KEY__" http://localhost:8077/data
curl -H "X-Feed-Key: __FEED_KEY__" "http://localhost:8077/data?format=csv"
curl http://localhost:8077/status        # progression (sans clé)
```

## Re-moissonner

Le feed fait une passe complète. Pour rafraîchir : redémarre le process, ou
supprime `store.json` puis relance.

## Tier "débloqueur" (optionnel)

Si la config utilise `fetch_tier="unblocker"`, renseigne ta clé provider via les
variables d'environnement (voir `.env.example`).

---
Généré par OmenServer · AI Harvester — runtime 100% déterministe.
'''


def build_export(config, package_dir=None):
    """Construit le zip standalone (bytes) à partir d'une config figée
    ``{url, recipe, plan, pacing, feed_key}``. ``package_dir`` = dossier du
    package harvester (défaut : celui de ce module)."""
    package_dir = package_dir or os.path.dirname(os.path.abspath(__file__))
    backend_dir = os.path.dirname(os.path.dirname(package_dir))  # .../backend

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        # shims de package (vides) pour que `backend` / `backend.bots` soient importables
        z.writestr("backend/__init__.py", "")
        z.writestr("backend/bots/__init__.py", "")
        # dépendances backend hors-package (anti-SSRF partagé). On ne bundle QUE
        # celles présentes (selon l'état du repo : net_guard n'existe pas partout).
        # La garde de test `no_unbundled_backend_imports` assure qu'un module
        # importé est forcément bundlé -> pas d'import cassé chez le client.
        for mod in EXPORT_BACKEND_MODULES:
            src = os.path.join(backend_dir, mod)
            if os.path.isfile(src):
                with open(src, "r", encoding="utf-8") as f:
                    z.writestr("backend/" + mod, f.read())
        # moteur déterministe (réutilisé tel quel)
        for mod in EXPORT_HARVESTER_MODULES:
            with open(os.path.join(package_dir, mod), "r", encoding="utf-8") as f:
                z.writestr("backend/bots/harvester/" + mod, f.read())
        # config figée + wrappers client
        z.writestr("config.json", json.dumps(config, ensure_ascii=False, indent=2))
        z.writestr("serve.py", SERVE_PY)
        z.writestr("requirements.txt", REQUIREMENTS_TXT)
        z.writestr(".env.example", ENV_EXAMPLE)
        readme = (README_MD
                  .replace("__FEED_KEY__", str(config.get("feed_key", "")))
                  .replace("__URL__", str(config.get("url", ""))))
        z.writestr("README.md", readme)
    return buf.getvalue()
