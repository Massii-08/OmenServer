# OmenServer Coach — l'extension TradingView

Le coach OmenServer, dans l'onglet TradingView : fiche du titre affiché, alertes
évaluées sur le prix live, ticket avec pré-check, mode scalp (ledger et
garde-fous), volet Bitcoin, et dessin des paris du coach sur le graphique.

**Manifest V3, vanilla JS, zéro build, zéro dépendance.** Le dossier se charge
tel quel dans Chrome.

---

## Installation (extension non empaquetée)

1. Ouvre `chrome://extensions`.
2. Active **Mode développeur** (en haut à droite).
3. **Charger l'extension non empaquetée** → choisis ce dossier
   (`tools/tv-coach-extension`).
4. Ouvre un graphique TradingView (`https://www.tradingview.com/chart/...`) :
   le panneau apparaît en bas à droite.

Après chaque modification de fichier : bouton **Actualiser** sur la carte de
l'extension dans `chrome://extensions`, puis recharge l'onglet TradingView.

## Connecter le token (aucun mot de passe ne passe par l'extension)

1. Ouvre `https://omenserver.org` et connecte-toi normalement.
2. Un bouton **« Connecter l'extension coach »** apparaît en bas à droite.
3. Clique : le token JWT du site (`localStorage.omenserver_token`) et la langue
   (`omen-lang`) sont copiés dans `chrome.storage.local`. Rien n'est copié sans
   ce clic.

Le token vaut 24 h. Expiré, le panneau affiche « reconnecte-toi sur
omenserver.org » : refais les trois étapes. Un collage manuel reste possible
dans les options.

## Options

`chrome://extensions` → OmenServer Coach → **Détails** → **Options de
l'extension** (ou le bouton « Options » dans l'en-tête du panneau).

| Réglage | Rôle |
|---|---|
| **Profil de frais** | `tv_paper`, `kraken_spot`, `kraken_futures`, `yuh`, `swissquote`, `ibkr`, `custom`. **Obligatoire** : tant qu'il est vide, un bandeau le réclame et le ticket refuse d'ouvrir un scalp. Aucun défaut caché. |
| Frais personnalisés | % par côté, utilisé par le profil `custom`. |
| Risque par trade | 1 % par défaut ; sert au calcul de la quantité par `POST /precheck`. |
| Langue | FR / IT / EN (celle d'OmenServer est reprise à la connexion). |
| Mode scalp auto | Bascule en mode scalp quand l'intervalle du graphique est 1, 2, 3 ou 5 minutes. |
| URL de l'Omen | `https://omenserver.org` par défaut, `http://localhost:8000` pour la vérification locale. |
| Token | Collage manuel (voie de secours). |

## Vérification locale

```bash
# 1. le serveur, dans TON terminal (tu veux les logs et le Ctrl+C)
cd "/Users/massimiliano/omenserver Project/Projet serveur"
venv/bin/python3 -m uvicorn backend.main:app --reload --port 8000

# 2. dans les options de l'extension : URL de l'Omen = http://localhost:8000
# 3. ouvre http://localhost:8000, connecte-toi, clique « Connecter l'extension coach »
# 4. ouvre un graphique TradingView : le panneau parle au serveur local
```

Les deux origines (`omenserver.org` et `localhost:8000`) sont déjà dans
`host_permissions` : rien d'autre à régler.

## Tests

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
node --test "tools/tv-coach-extension/tests/*.test.js"
```

Node 22. Le motif entre guillemets est volontaire : sur cette machine,
`node --test <dossier>/` essaie de charger le dossier comme un module et
échoue ; le motif de fichiers, lui, fonctionne (`node --test` sans argument,
lancé depuis ce dossier, marche aussi).

Ce qui est couvert : la table des symboles (miroir du serveur), les alertes
(hystérésis, one-shot), la parité des trois langues, le manifeste (JSON,
`world: "MAIN"`, permissions, fichiers cités présents), les commandes de
dessin, les barres/garde-fous/ledger du mode scalp, et un test de fumée qui
CHARGE vraiment `content.js` et `bridge.js` avec un DOM bouchon — sans objet
`chrome` : la voie dégradée doit tenir debout toute seule.

## Les fichiers

| Fichier | Rôle |
|---|---|
| `manifest.json` | MV3. `bridge.js` en `world: "MAIN"`, le panneau en monde isolé, `content-omen.js` sur OmenServer. |
| `bridge.js` | Monde MAIN : lit `TradingViewApi` (symbole, intervalle, prix du titre, bid/ask des pastilles), exécute les commandes de dessin, renvoie les déplacements de lignes. Ne voit ni token ni réseau. |
| `content.js` | Le panneau `omen-coach` en shadow DOM : état, rendu, alertes live, ticket, ledger, garde-fous, file de scalps. |
| `sw.js` | Service worker : token, appels HTTP, WebSocket `/ws/paper` (reconnexion 1→30 s), WebSocket Binance en mode scalp BTC, notifications. |
| `content-omen.js` | Le bouton « Connecter l'extension coach » sur omenserver.org. |
| `lib/symbols.js` | `BATS:AAPL → AAPL`, `SIX:NESN → NESN.SW`, `BINANCE:BTCUSDT.P → BTC-USD`, inconnu → `null`. Miroir de `brief.tv_to_yahoo`. |
| `lib/alerts.js` | Franchissement avec hystérésis 0,05 %, one-shot. |
| `lib/i18n.js` | FR / IT / EN, clés à parité stricte. |
| `lib/api.js` | Appels via le service worker + relève des travaux détachés (`{"job": id}` puis `GET /job/{id}` toutes les 3 s). |
| `lib/draw.js` | Construit les commandes de dessin (niveaux, paris du coach, repères de scalp). Tout texte posé commence par `⌂ coach`. |
| `lib/bars.js`, `lib/guards.js`, `lib/ledger.js` | Barres 1 min / ATR, garde-fous du scalp, ledger P&L (lot `ext-scalp`). |
| `panel.css` | Tokens Ion (sombre) et Givre (clair), `prefers-color-scheme`, 320 px, 70 vh, chiffres tabulaires. |

## Ce qu'il faut savoir

- **Le dessin exige d'être connecté à TradingView.** Sinon le panneau affiche
  « connecte-toi à TradingView pour le dessin » et n'essaie plus qu'une fois par
  titre. L'extension n'efface QUE les tracés qu'elle a posés.
- **Sélecteurs bid/ask** : ils vivent dans une seule constante commentée en tête
  de `bridge.js`. TradingView refond son interface régulièrement ; leur absence
  n'est pas une erreur, le prix continue d'être lu dans le titre de l'onglet.
- **Rien n'est bloquant** : garde-fous et avertissements informent, l'humain
  décide. Le serveur reste autoritaire (il recalcule `precheck` et `scalps`).
- **Omen injoignable** : la dernière fiche reçue reste affichée (horodatée), les
  alertes continuent d'être évaluées, le ticket se verrouille, et un scalp fermé
  part dans une file locale (`chrome.storage.local`) rejouée au prochain succès —
  jamais perdu, jamais dupliqué (`client_id`).
