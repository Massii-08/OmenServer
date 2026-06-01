# Design — Auto-adressage des serveurs de jeu (« mini-Minestrator »)

- **Date** : 2026-06-01
- **Statut** : Design validé (forme globale + décisions UX), prêt pour relecture puis `writing-plans`
- **Branche** : `feat/server-auto-addressing` (dédiée, isolée du travail mc-agent)
- **Auteur** : Massii_08 + Claude
- **Lié à** : `backend/game_server/*`, `backend/auth/permissions.py`

---

## 1. Objectif

Donner à chaque serveur de jeu créé sur OmenServer une **adresse personnalisée en lettres**
(ex. `survie.play.omenserver.org`) **attribuée automatiquement à la création**, tout en **cachant
l'IP maison de l'Omen** — exactement l'expérience « adresse dédiée » de Minestrator, mais
auto-hébergée.

**Le joueur ne fait rien** : il tape l'adresse dans Minecraft et se connecte. Toute la
mécanique (proxy, DNS, routage) est invisible pour lui et gérée côté serveur.

---

## 2. Périmètre & modèle de confiance

- **Multi-tenant de confiance** : la création de serveurs est déjà réservée par le RBAC existant
  (`backend/auth/permissions.py`) aux rôles **modérateur**, **développeur** et **admin**.
  L'inscription est **sur invitation uniquement** → pas de public anonyme.
- **Quotas** (état désiré, à appliquer) : **modérateur = 1 serveur**, **développeur = 1 serveur**,
  **admin = illimité**. Donc chaque non-admin a **au plus 1 alias**.
- **Hors périmètre (YAGNI)** :
  - Anti-abus / isolation anti-tenant-hostile (pas de public anonyme).
  - Lobby / réseau inter-serveurs (Velocity le permettra plus tard, pas maintenant).
  - Bedrock / UDP (phase ultérieure, via Geyser ou relais UDP).
  - Forge/Fabric en première itération (forwarding spécifique → phase ultérieure ; **Paper d'abord**).

---

## 3. Décisions validées

| Décision | Choix retenu |
|---|---|
| Architecture | VPS relais (thin TCP) + **WireGuard** + **Velocity sur l'Omen** + **wildcard DNS** |
| Relais public | **Oracle Cloud Always Free** (gratuit) — abstrait derrière `AddressProvider`, donc remplaçable |
| Zone DNS | **`*.play.omenserver.org`** (wildcard) → adresses `<alias>.play.omenserver.org` |
| Nommage | L'utilisateur **tape son nom** à la création ; **auto-slug** si vide ; **renommable** ensuite |
| Velocity | Tourne **en conteneur Docker** sur l'Omen (pas de dépendance Java sur l'hôte) |

> Le préfixe `play.` (vs `*.omenserver.org` direct) **confine le wildcard** : il ne capture que
> `*.play.omenserver.org`, donc les sous-domaines « app » sous `omenserver.org` (panel via tunnel
> Cloudflare, etc.) ne sont **jamais** affectés. Convention MC classique (`play.hypixel.net`).

---

## 4. Architecture & topologie

```
Joueur tape :  survie.play.omenserver.org
   │
   ▼  DNS wildcard *.play.omenserver.org  →  IP publique du VPS Oracle   (créé UNE fois)
VPS Oracle (IP publique)  ── relais TCP transparent :25565 ──┐
   │  (nftables DNAT ou socat, sans état)                    │ WireGuard (tunnel chiffré, initié par l'Omen)
   ▼                                                          │
Omen : conteneur Velocity écoute :25565  ◄───────────────────┘
   │   lit le hostname ("survie") dans le handshake Minecraft
   │   → forced-host → conteneur backend correspondant
   ▼
Conteneur MC "survie" (port interne, online-mode=false + forwarding secret, jamais exposé)
```

### Pourquoi ce découpage

- **L'Omen n'ouvre AUCUN port entrant.** Le tunnel WireGuard est **initié par l'Omen** (sortant) →
  l'IP maison n'est **jamais** dans le DNS et reste injoignable directement (marche même en CGNAT,
  même si l'Omen actuel n'est pas en CGNAT — IP publique `86.x` confirmée).
- **Velocity tourne sur l'Omen** (et non sur le VPS) → le panel (qui tourne sur l'Omen) gère sa
  config **en local**, sans pousser de config à distance. Intégration simple.
- **Le VPS reste « bête »** : un simple relais TCP de `:25565` vers l'Omen via WireGuard. Stateless,
  trivial à reconstruire, **remplaçable** (Oracle → VPS payant → autre) sans toucher au panel.
- **Le wildcard** `*.play.omenserver.org` couvre **tous** les serveurs futurs → **aucun
  enregistrement DNS à créer par serveur**. Le panel ne touche jamais au DNS.

### Composants (unités isolées)

| Unité | Rôle | Dépend de |
|---|---|---|
| **VPS relais** (Oracle) | Reçoit le trafic public `:25565`, le forwarde à l'Omen via WG | IP publique, WireGuard |
| **WireGuard** | Tunnel chiffré Omen↔VPS, initié par l'Omen | clés WG |
| **Velocity** (conteneur Docker, Omen) | Route chaque hostname vers le bon backend (forced-hosts) | config montée en volume |
| **Backends MC** (conteneurs) | Les serveurs de jeu (Paper, online-mode=false + secret) | Velocity |
| **`AddressProvider`** (Python, panel) | Interface assign/release ; impl `VelocityAddressProvider` | Velocity config + reload |
| **Service alias** (Python) | Validation, slug, unicité, quota | DB `GameServer.connect_alias` |
| **DNS wildcard** | `*.play.omenserver.org` → IP VPS (grey cloud, one-time) | Cloudflare |

---

## 5. Modèle de données

- On réutilise le champ **déjà présent** `GameServer.connect_alias` (`String(100)`,
  *« Alias de connexion (remplace l'IP réelle) »*).
- Il stocke **uniquement la partie gauche** : `survie` (le domaine `.play.omenserver.org` est
  implicite).
- **Contrainte d'unicité globale** sur `connect_alias` (deux serveurs ne peuvent pas partager une
  adresse). Migration : ajout d'un index unique (via le pattern try/except SQLite du startup
  `main.py`).
- La **config Velocity reste la source de vérité du routage** ; `connect_alias` est la source de
  vérité de l'affichage et de l'unicité côté métier.

---

## 6. Flux de données

### Création d'un serveur (Phase 2)
1. `create_server` : port auto-assigné (logique **existante**), conteneur MC créé.
2. **Service alias** : l'utilisateur a saisi `survie` → validation (`^[a-z0-9-]{3,30}$`, non réservé,
   libre). Si vide → slug auto `<slug(nom)>-<suffixe4>`.
3. Le conteneur est configuré **Paper + online-mode=false + Velocity modern forwarding (secret)**.
4. `AddressProvider.assign(server, alias)` : ajoute le forced-host
   `survie.play.omenserver.org → <backend>` à la config Velocity + **reload**. La cible `<backend>`
   est l'adresse **Docker-interne** du conteneur (Velocity étant lui-même conteneurisé) : réseau
   Docker partagé + nom de conteneur, ou `host.docker.internal:<port_hôte>` — **pas** `127.0.0.1`
   (qui désignerait le conteneur Velocity lui-même).
5. `connect_alias = "survie"` persisté. L'UI affiche `survie.play.omenserver.org`.

### Connexion d'un joueur
`survie.play.omenserver.org` → wildcard DNS → VPS → WireGuard → Velocity (lit `survie`) → conteneur.

### Suppression d'un serveur
`delete_server` → `AddressProvider.release(server)` → forced-host retiré + reload Velocity →
`connect_alias` libéré.

### Renommage
Endpoint dédié (propriétaire ou admin) → re-valide l'unicité → release ancien + assign nouveau.

---

## 7. Sécurité

- **Velocity modern forwarding (secret partagé)** : l'authentification Mojang est faite par Velocity ;
  les backends tournent en `online-mode=false` mais **n'acceptent que les connexions signées par le
  secret Velocity** → un joueur ne peut pas spoofer ni joindre un backend directement.
- **Backends jamais exposés** : ils n'écoutent que sur le réseau Docker interne de l'Omen, joignables
  uniquement par Velocity. Pas de port-forward, pas de binding `0.0.0.0` public (changement par
  rapport à la création actuelle qui bind `0.0.0.0` — cf. `docker_manager.py`).
- **Isolation légère (suffisante pour un cercle de confiance)** : un joueur ne peut atteindre un
  serveur **que** via Velocity ; il ne peut pas viser le backend d'un autre tenant.
- **Le secret de forwarding** est stocké **hors git** (fichier secret / variable d'env), comme les
  autres secrets du projet.
- **DNS confiné** : grâce au préfixe `*.play.omenserver.org`, le wildcard ne capture que les
  sous-domaines sous `play.` → aucun risque pour les sous-domaines app sous `omenserver.org`. (Caveat
  du `*.omenserver.org` direct résolu par ce choix.)

---

## 8. Gestion d'erreurs

| Cas | Comportement |
|---|---|
| VPS ou WireGuard down | Serveurs injoignables (dégradé), mais aucune fuite d'IP ; health-check Velocity ; statut remonté au panel |
| Collision d'alias | Erreur de validation (409) + suggestion d'un alias libre |
| Reload Velocity échoue | **Rollback** : l'alias n'est pas persisté, le forced-host est retiré (opération transactionnelle) |
| Quota dépassé | 403/409 selon le pattern RBAC existant |
| Alias réservé (apex, `www`, sous-domaines app connus) | Rejeté par une liste de réservés |

---

## 9. Tests

- **Unitaires (pytest, style `backend/bots/tests/`)** :
  - Service alias : slug, regex, réservés, unicité, quota par rôle.
  - `AddressProvider` avec Velocity **mocké** : assign/release ajoutent/retirent le bon forced-host,
    rollback si reload échoue.
  - Hooks `create_server` / `delete_server` : alias attribué/libéré.
- **Génération de config Velocity** : snapshot du fichier produit (forced-hosts attendus).
- **Validation manuelle Phase 1** (critère de sortie) : un joueur se connecte réellement via
  `test.play.omenserver.org`, et **`nslookup test.play.omenserver.org` retourne l'IP du VPS, pas
  celle de l'Omen** (preuve que l'IP est cachée).

---

## 10. Phases (build multi-séances)

| Phase | Contenu | Critère de sortie |
|---|---|---|
| **1 — Fondation infra** (manuel, 1 serveur, **zéro code panel**) | VPS Oracle + WireGuard + conteneur Velocity sur l'Omen + wildcard DNS, câblés **à la main** pour 1 serveur test | Joueur connecté via `test.play.omenserver.org`, IP cachée (vérifiée au `nslookup`) |
| **2 — Automatisation panel** | `AddressProvider` + `VelocityAddressProvider` + service alias + hooks create/delete + index unique + quotas | Créer un serveur = adresse attribuée et routée automatiquement |
| **3 — UI** | Onglet Accès : adresse affichée + bouton copier + renommer (propriétaire/admin) + i18n FR/EN/IT + cache-bust | « Feel Minestrator » complet dans le panel |
| **4 — Optionnel (plus tard)** | PROXY protocol (vraies IP joueurs dans les logs Velocity), Forge/Fabric forwarding, multi-VPS, lobby | — |

> **Règle** : on ne code **rien** (Phase 2) tant que la Phase 1 (infra) ne tourne pas end-to-end.
> C'est la partie la plus risquée → validée en premier, à la main, sur un serveur.

---

## 11. Déploiement & dépendances

- **VPS Oracle Always Free** : 1 instance, IP publique, WireGuard + relais TCP (nftables/socat).
  ⚠️ Quirks Oracle à gérer (carte à l'inscription, ARM, récupération d'instances inactives →
  astuces anti-reclaim type cron/charge légère).
- **WireGuard** sur l'Omen + le VPS (l'Omen initie le tunnel).
- **Velocity en conteneur Docker** sur l'Omen → **pas de dépendance Java sur l'hôte** (cohérent avec
  l'approche tout-Docker du projet). Config montée en volume, reload via la console Velocity
  (commande `velocity reload`, qui recharge `[forced-hosts]`).
- **Backends Paper** (`server_type=PAPER`) pour le modern forwarding en 1ʳᵉ itération.
- **DNS** : 1 enregistrement wildcard `*.play.omenserver.org` → IP VPS (grey cloud / DNS-only),
  one-time.

---

## 12. Ce qui rend le choix réversible

Le panel ne connaît que l'interface **`AddressProvider`**. Le relais concret (Velocity+Oracle
aujourd'hui) est branché derrière. Migrer plus tard vers un VPS payant, ou changer de stratégie de
relais, **ne touche pas** au code panel — seule l'implémentation du provider et l'infra changent.
