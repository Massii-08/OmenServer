# Auto-adressage serveurs — Phase 1 (Fondation infra) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faire qu'un joueur se connecte à `test.play.omenserver.org` et tombe sur un serveur MC tournant sur l'Omen, **sans que l'IP maison soit visible** — chaîne complète câblée à la main pour 1 serveur, **zéro code panel**.

**Architecture :** `Joueur → wildcard DNS → VPS Oracle (IP publique, relais TCP) → WireGuard → mc-router (Docker, Omen) → backend MC`. Le VPS ne fait que forwarder ; mc-router route par hostname ; l'Omen n'ouvre aucun port entrant (WireGuard sortant).

**Tech Stack :** Oracle Cloud Always Free (Ampere ARM, Ubuntu), WireGuard, nftables, `itzg/mc-router` (Docker), `itzg/minecraft-server` (Paper), Cloudflare DNS.

> **⚠️ Écart assumé vs la spec** : la spec (`docs/superpowers/specs/2026-06-01-mc-server-auto-addressing-design.md`) parlait de **Velocity + modern forwarding**. Ce plan utilise **`mc-router`** à la place : même résultat (routage par hostname, IP cachée) mais backends inchangés (`online-mode=true`, pas de secret), et API REST pour l'automatisation Phase 2. Velocity reste l'option « vrai réseau/lobby » de la Phase 4. **La spec sera réalignée** (§3/§4/§7/§11).

> **Légende d'exécution** : 🧑 = Massii (comptes/consoles/sudo) · 🤖 = Claude via SSH `massii08@192.168.68.75` (Docker sur l'Omen sans sudo — `massii08` est dans le groupe docker).

---

## Paramètres à collecter (remplis au fur et à mesure)

| Param | Comment l'obtenir | Valeur |
|---|---|---|
| `VPS_PUBLIC_IP` | IP publique de l'instance Oracle (Task 1) | `____` |
| `VPS_WG_PRIV` / `VPS_WG_PUB` | générées Task 2 sur le VPS | `____` |
| `OMEN_WG_PRIV` / `OMEN_WG_PUB` | générées Task 2 sur l'Omen | `____` |
| Réseau WG | fixé : VPS = `10.8.0.1/24`, Omen = `10.8.0.2/24` | fixe |
| Port jeu | fixé : `25565` (TCP) ; WG : `51820` (UDP) | fixe |

---

## Task 1 — Provisionner le VPS Oracle Always Free  🧑

**Files:** aucun (infra cloud).

- [ ] **Step 1 : Créer le compte + l'instance**
  Console Oracle Cloud → *Always Free* → Compute → Create Instance :
  - Image : **Ubuntu 22.04 (ou 24.04)**, Shape : **VM.Standard.A1.Flex** (Ampere ARM, gratuit), 1 OCPU / 6 Go suffisent.
  - Ajouter ta **clé SSH publique** (celle du Mac : `~/.ssh/id_ed25519.pub`).
  - Noter l'**IP publique** assignée → `VPS_PUBLIC_IP`.

- [ ] **Step 2 : Ouvrir les ports dans la Security List Oracle** (pare-feu *cloud*, séparé de l'OS)
  VCN → Security Lists → Default → Add Ingress Rules :
  - Source `0.0.0.0/0`, **UDP**, port **51820** (WireGuard).
  - Source `0.0.0.0/0`, **TCP**, port **25565** (jeu).

- [ ] **Step 3 : ⚠️ Débloquer l'iptables interne de l'image Oracle**
  Les images Ubuntu Oracle embarquent un iptables qui **DROP tout sauf SSH**. Sur le VPS :
  Run :
  ```bash
  sudo iptables -I INPUT -p udp --dport 51820 -j ACCEPT
  sudo iptables -I INPUT -p tcp --dport 25565 -j ACCEPT
  sudo netfilter-persistent save   # persiste au reboot (paquet iptables-persistent)
  ```
  Expected : pas d'erreur ; `sudo iptables -L INPUT -n | grep -E '51820|25565'` montre les 2 règles ACCEPT.

- [ ] **Step 4 : Vérifier l'accès**
  Run (depuis le Mac) : `ssh ubuntu@<VPS_PUBLIC_IP> "echo OK; lsb_release -d"`
  Expected : `OK` + la version Ubuntu.

---

## Task 2 — Tunnel WireGuard Omen ↔ VPS  🧑 (VPS) + 🤖 (Omen)

**Files:**
- Create (VPS) : `/etc/wireguard/wg0.conf`
- Create (Omen) : `/etc/wireguard/wg0.conf`

- [ ] **Step 1 : Installer WireGuard des 2 côtés**
  Run (VPS) : `sudo apt update && sudo apt install -y wireguard`
  Run (Omen, 🧑 car sudo) : `sudo apt install -y wireguard`
  Expected : `wg` disponible (`wg --version`).

- [ ] **Step 2 : Générer les clés (chaque hôte)**
  Run (VPS) : `wg genkey | tee /tmp/priv | wg pubkey > /tmp/pub; echo "PRIV=$(cat /tmp/priv)"; echo "PUB=$(cat /tmp/pub)"`
  Run (Omen) : idem.
  Reporter `VPS_WG_PRIV/PUB` et `OMEN_WG_PRIV/PUB` dans le tableau des paramètres.

- [ ] **Step 3 : Config VPS** (`/etc/wireguard/wg0.conf`, le VPS écoute)
  ```ini
  [Interface]
  Address = 10.8.0.1/24
  ListenPort = 51820
  PrivateKey = <VPS_WG_PRIV>

  [Peer]
  # Omen (initie le tunnel ; pas d'Endpoint, appris au handshake)
  PublicKey = <OMEN_WG_PUB>
  AllowedIPs = 10.8.0.2/32
  ```

- [ ] **Step 4 : Config Omen** (`/etc/wireguard/wg0.conf`, l'Omen sort vers le VPS)
  ```ini
  [Interface]
  Address = 10.8.0.2/24
  PrivateKey = <OMEN_WG_PRIV>

  [Peer]
  PublicKey = <VPS_WG_PUB>
  Endpoint = <VPS_PUBLIC_IP>:51820
  AllowedIPs = 10.8.0.1/32
  PersistentKeepalive = 25
  ```

- [ ] **Step 5 : Monter le tunnel des 2 côtés**
  Run (VPS) : `sudo systemctl enable --now wg-quick@wg0`
  Run (Omen, 🧑) : `sudo systemctl enable --now wg-quick@wg0`
  Expected : `sudo wg show` affiche un `latest handshake` récent des 2 côtés.

- [ ] **Step 6 : Vérifier la connectivité du tunnel**
  Run (VPS) : `ping -c2 10.8.0.2`  — Expected : réponses (l'Omen via WG).
  Run (Omen) : `ping -c2 10.8.0.1`  — Expected : réponses (le VPS via WG).

---

## Task 3 — Relais TCP sur le VPS (nftables DNAT)  🧑

**Files:** Create (VPS) : `/etc/nftables.conf` (ou règles ajoutées).

- [ ] **Step 1 : Activer le forwarding IP**
  Run (VPS) :
  ```bash
  echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-forward.conf
  sudo sysctl --system
  ```
  Expected : `net.ipv4.ip_forward = 1`.

- [ ] **Step 2 : DNAT :25565 public → Omen (10.8.0.2) via WG**
  Run (VPS) :
  ```bash
  sudo nft add table ip natrelay
  sudo nft add chain ip natrelay prerouting '{ type nat hook prerouting priority -100; }'
  sudo nft add chain ip natrelay postrouting '{ type nat hook postrouting priority 100; }'
  sudo nft add rule ip natrelay prerouting tcp dport 25565 dnat to 10.8.0.2:25565
  sudo nft add rule ip natrelay postrouting ip daddr 10.8.0.2 tcp dport 25565 masquerade
  sudo bash -c 'nft list table ip natrelay > /etc/nftables-relay.conf'
  ```
  Expected : `sudo nft list table ip natrelay` montre les 2 règles. (Persistance : charger `/etc/nftables-relay.conf` au boot via un drop-in systemd — étape de durcissement, OK plus tard.)

- [ ] **Step 3 : Vérifier le chemin VPS→Omen** (mc-router pas encore up → on teste juste la route après Task 4)
  Note : la vérif réelle se fait en Task 7. Ici on s'assure juste que les règles sont chargées.

---

## Task 4 — mc-router en Docker sur l'Omen  🤖 (SSH)

**Files:** aucun fichier repo ; conteneur Docker + réseau Docker.

- [ ] **Step 1 : Créer un réseau Docker partagé pour le routage**
  Run (Omen, via SSH) : `docker network create mc-net 2>/dev/null || echo "déjà créé"`
  Expected : un ID réseau, ou « déjà créé ».

- [ ] **Step 2 : Lancer mc-router (écoute :25565 sur l'Omen, route par hostname)**
  Run (Omen, via SSH) :
  ```bash
  docker run -d --name omen-mc-router --restart unless-stopped \
    --network mc-net \
    -p 25565:25565 -p 26666:26666 \
    -e MAPPING='test.play.omenserver.org=omen-minecraft-test:25565' \
    -e API_BINDING=:26666 \
    itzg/mc-router
  ```
  - `:25565` = entrée jeu (cible du DNAT VPS) ; `:26666` = API REST (Phase 2).
  - `MAPPING` = la route de test (hostname → conteneur backend:port interne).
  Expected : `docker ps | grep mc-router` → `Up`.

- [ ] **Step 3 : Vérifier le démarrage + la route**
  Run (Omen, via SSH) :
  ```bash
  docker logs omen-mc-router 2>&1 | tail -15
  curl -s http://localhost:26666/routes
  ```
  Expected : logs sans erreur ; `/routes` renvoie le JSON `{"test.play.omenserver.org":"omen-minecraft-test:25565"}`.

---

## Task 5 — Backend MC de test branché sur mc-router  🤖 (SSH)

**Files:** conteneur Docker `omen-minecraft-test` (existe déjà, éteint).

- [ ] **Step 1 : Connecter le backend au réseau mc-net + le démarrer**
  Run (Omen, via SSH) :
  ```bash
  docker network connect mc-net omen-minecraft-test 2>/dev/null || echo "déjà connecté"
  docker start omen-minecraft-test
  ```
  Expected : conteneur `Up`. (Le serveur écoute son port interne **25565** ; mc-router le joint par le nom `omen-minecraft-test:25565` sur `mc-net` — **pas besoin** d'exposer un port hôte.)

- [ ] **Step 2 : Attendre que le serveur soit prêt**
  Run (Omen, via SSH) : `docker logs -f omen-minecraft-test 2>&1 | grep -m1 'Done ('`
  Expected : ligne `Done (XXs)! For help, type "help"` (serveur prêt).

- [ ] **Step 3 : Vérifier le routage interne mc-router → backend**
  Run (Omen, via SSH) : `docker exec omen-mc-router wget -qO- http://localhost:26666/routes`
  Expected : la route `test.play.omenserver.org` présente ; logs mc-router prêts à router.

---

## Task 6 — Wildcard DNS  🧑

**Files:** aucun (Cloudflare).

- [ ] **Step 1 : Créer l'enregistrement wildcard**
  Cloudflare → zone `omenserver.org` → DNS → Add record :
  - Type **A**, Name **`*.play`**, IPv4 **`<VPS_PUBLIC_IP>`**, Proxy **DNS only (nuage GRIS)**, TTL Auto.

- [ ] **Step 2 : Vérifier la résolution**
  Run (depuis le Mac) : `nslookup test.play.omenserver.org`
  Expected : répond **`<VPS_PUBLIC_IP>`** (pas l'IP de l'Omen).

---

## Task 7 — Validation end-to-end (critère de sortie Phase 1)  🧑 + 🤖

- [ ] **Step 1 : Test IP cachée**
  Run (Mac) : `nslookup test.play.omenserver.org`
  Expected : **IP du VPS**, jamais `86.111.136.174` (l'Omen). ✅ Preuve que l'IP maison est cachée.

- [ ] **Step 2 : Test du chemin réseau complet** (avant le client lourd)
  Run (Mac) : `nc -vz test.play.omenserver.org 25565`
  Expected : `succeeded` / `open` (Mac → VPS:25565 → WG → mc-router → backend).

- [ ] **Step 3 : Connexion réelle Minecraft**  🧑
  Minecraft Java 1.21 → Multijoueur → Ajouter un serveur → adresse `test.play.omenserver.org` → Rejoindre.
  Expected : **connexion réussie** sur le serveur de test, IP de l'Omen invisible.

- [ ] **Step 4 : Confirmer le routage par hostname**  🤖
  Run (Omen, via SSH) : `docker logs omen-mc-router 2>&1 | tail -5`
  Expected : ligne montrant une connexion routée `test.play.omenserver.org → omen-minecraft-test`.

- [ ] **Step 5 : Commit du plan + bilan Phase 1**
  ```bash
  # sur la branche feat/server-auto-addressing (ou son worktree)
  git add docs/superpowers/plans/2026-06-01-server-auto-addressing-phase1-infra.md
  git commit -m "docs(server-addressing): plan Phase 1 (infra mc-router/WireGuard/Oracle)"
  ```

**✅ Critère de sortie Phase 1** : Steps 1 + 3 verts → un joueur joue via `test.play.omenserver.org` avec l'IP de l'Omen cachée. On passe alors à la **Phase 2** (automatisation panel : `AddressProvider` qui pilote l'API mc-router `:26666`).

---

## Auto-revue (writing-plans)

- **Couverture spec** : Topologie (§4) → Tasks 1-6 ; IP cachée (§1/§7) → Task 7 Step 1 ; relais remplaçable (§12) → VPS bête (Task 3) + abstraction prévue Phase 2. Sécurité (§7) : backends **non exposés** (pas de port hôte, joints via `mc-net` interne) → Task 5 Step 1. **Écart documenté** : Velocity → mc-router (online-mode reste `true`, plus simple ET plus sûr par défaut ; secret de forwarding **supprimé** du périmètre Phase 1-3).
- **Placeholders** : les `<VPS_PUBLIC_IP>` / `<*_WG_*>` sont des **paramètres runtime** (générés en Task 1-2), pas des TODO — chacun a sa procédure d'obtention dans le tableau.
- **Cohérence** : port jeu `25565` et port API `26666` constants partout ; réseau WG `10.8.0.1/0.2` constant ; `omen-minecraft-test` = le backend de test existant, réutilisé.
- **Hors périmètre Phase 1** (rappel) : automatisation panel, renommage, UI, quotas → Phases 2-3. Persistance nftables/anti-reclaim Oracle = durcissement, noté mais non bloquant pour valider la chaîne.
