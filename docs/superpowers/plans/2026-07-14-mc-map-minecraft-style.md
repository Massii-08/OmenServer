# Carte du mappeur « item carte » Minecraft — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyler la carte du groupe de mappeurs (onglet Mapping) en « item carte » Minecraft : parchemin + couleurs de map officielles, sprites pixel-art par structure avec labels, retrait des trouvailles.

**Architecture:** 100 % frontend, un seul module touché (`frontend/js/bots_module.js`, fonctions `_mcaMap*`) + i18n + police pixel self-hostée. Aucun changement backend ni de format de données. Spec : `docs/superpowers/specs/2026-07-14-mc-map-minecraft-style-design.md`. Mockup validé (source des sprites et couleurs) : `docs/superpowers/mockups/2026-07-14-mc-map-directions.html` — **direction A**.

**Tech Stack:** Vanilla JS (canvas 2D), pas de framework, pas de tests unitaires frontend dans ce repo → la validation est : (a) parse-check `node -e "new Function(...)"` après chaque tâche (piège #28), (b) harness visuel local en Task 8 (stub Auth/Lang + fixture, Browser pane), (c) vérif prod post-deploy. Chaque tâche laisse le fichier parseable et committe.

**Versions cache-bust au moment de l'écriture (branche locale)** : `style.css?v=120`, `lang.js?v=243`, `bots_module.js?v=231`, `sw.js CACHE_NAME='omenserver-v134'`. ⚠️ Les valeurs qui font foi sont celles d'`origin/main` au moment du deploy (Task 9-10).

---

### Task 1: Branche isolée + police pixel

**Files:**
- Create: `frontend/fonts/press-start-2p-latin.woff2`
- Modify: `frontend/css/style.css` (fin de fichier)

- [ ] **Step 1: Worktree + branche**

Utiliser la skill `superpowers:using-git-worktrees` pour créer un worktree sur une branche `feat/mc-map-minecraft-style` basée sur `origin/main` (PAS sur `feat/oracle-dashboard`, chantier séparé) :

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git fetch origin
# via la skill worktree ; équivalent manuel :
git worktree add "../worktree-feat+mc-map-minecraft-style" -b feat/mc-map-minecraft-style origin/main
```

Toutes les tâches suivantes s'exécutent dans ce worktree.

- [ ] **Step 2: Copier la police (déjà téléchargée dans le scratchpad de session)**

```bash
mkdir -p frontend/fonts
cp "/private/tmp/claude-503/-Users-massimiliano-omenserver-Project-Projet-serveur/818f8943-c6f5-4836-b108-f1f3265a805f/scratchpad/psp-latin.woff2" frontend/fonts/press-start-2p-latin.woff2
```

Fallback si le scratchpad a disparu :

```bash
curl -s "https://fonts.gstatic.com/s/pressstart2p/v16/e3t4euO8T-267oIAQAu6jDQyK3nVivNm4I81.woff2" -o frontend/fonts/press-start-2p-latin.woff2
```

Vérifier : `ls -la frontend/fonts/` → ~4 704 octets. (Licence SIL OFL — redistribuable ; subset latin U+0000-00FF, couvre É/é/ô.)

- [ ] **Step 3: @font-face dans style.css**

Ajouter en fin de `frontend/css/style.css` :

```css
/* ─── MC Agent — carte du mappeur : police pixel (utilisée par le canvas uniquement) ─── */
@font-face {
  font-family: 'PSP';
  src: url('/fonts/press-start-2p-latin.woff2') format('woff2');
  font-display: swap;
}
```

Note : la CSP backend autorise déjà `font-src 'self' https://fonts.gstatic.com` (backend/main.py:109) — rien à changer.

- [ ] **Step 4: Commit**

```bash
git add frontend/fonts/press-start-2p-latin.woff2 frontend/css/style.css
git commit -m "feat(mc-map): police pixel Press Start 2P self-hostée (canvas carte)"
```

---

### Task 2: Sprites pixel-art + helpers dessin

**Files:**
- Modify: `frontend/js/bots_module.js` — insérer les constantes/helpers juste avant `_MCA_BIOME_RULES` (l.~2384)

- [ ] **Step 1: Extraire les 13 sprites du mockup validé**

Source de vérité : `docs/superpowers/mockups/2026-07-14-mc-map-directions.html`, bloc `var SPR = { ... };` (village, dungeon, monument, mineshaft, stronghold, ancient_city, ruined_portal, desert_pyramid, jungle_pyramid, pillager_outpost, shipwreck, fortress, cave — chaque entrée `{ p: {char: '#hex'}, g: [16 chaînes de 16 chars, '.' = transparent] }`).

Copier ce bloc **tel quel** dans `bots_module.js` comme propriété `_MCA_SPRITES` de l'objet BotsModule (adapter uniquement la syntaxe objet : `_MCA_SPRITES: { village: {...}, ..., cave: {...} },`). Exemple du format attendu (premier sprite, à reprendre à l'identique du mockup) :

```js
 // Sprites 16×16 des structures (mockup 2026-07-14 direction A) — '.' = transparent.
 _MCA_SPRITES: {
 village: { p: { R: '#8a4a24', r: '#5e2f14', W: '#e8dcc4', F: '#7fb4d8', f: '#5a88b0', D: '#6b4423', d: '#3a250f', S: '#b8a878' }, g: [
  '................',
  '.......rr.......',
  '......rRRr......',
  '.....rRRRRr.....',
  '....rRRRRRRr....',
  '...rRRRRRRRRr...',
  '..rRRRRRRRRRRr..',
  '.rRRRRRRRRRRRRr.',
  '.rr..........rr.',
  '..WWFFWWWWDDWW..',
  '..WWFFWWWWDdWW..',
  '..WWffWWWWDDWW..',
  '..WWWWWWWWDdWW..',
  '..WWWWWWWWDDWW..',
  '..SSSSSSSSSSSS..',
  '................'] },
 // … les 12 autres, copiés du mockup sans modification …
 },
```

- [ ] **Step 2: Helpers dessin + hash numérique + shade**

Ajouter juste après `_MCA_SPRITES` :

```js
 // Hash numérique rapide → [0,1) déterministe (grain/crans stables, pas de Math.random).
 _mcaHash2(a, b) {
 let h = ((a | 0) * 374761393 + (b | 0) * 668265263) | 0;
 h = ((h ^ (h >> 13)) * 1274126177) | 0;
 return ((h ^ (h >> 16)) >>> 0) / 4294967295;
 },

 // Multiplie la luminosité d'un '#rrggbb' (f ~ 0.8-1.2) → 'rgb(...)'.
 _mcaShade(hex, f) {
 const v = parseInt(hex.slice(1), 16);
 const r = Math.min(255, ((v >> 16) & 255) * f) | 0;
 const g = Math.min(255, ((v >> 8) & 255) * f) | 0;
 const b = Math.min(255, (v & 255) * f) | 0;
 return 'rgb(' + r + ',' + g + ',' + b + ')';
 },

 // Dessine un sprite 16×16 centré en (cx,cy), s px par pixel, ombre portée dure optionnelle.
 _mcaDrawSprite(ctx, name, cx, cy, s, withShadow) {
 const d = this._MCA_SPRITES[name];
 if (!d) return false;
 const g = d.g, p = d.p, ox = cx - 8 * s, oy = cy - 8 * s;
 if (withShadow) {
 ctx.fillStyle = 'rgba(0,0,0,0.45)';
 for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
 const ch = g[y] && g[y][x];
 if (ch && ch !== '.') ctx.fillRect(ox + x * s + s, oy + y * s + s, s, s);
 }
 }
 for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
 const ch = g[y] && g[y][x];
 if (ch && ch !== '.' && p[ch]) { ctx.fillStyle = p[ch]; ctx.fillRect(ox + x * s, oy + y * s, s, s); }
 }
 return true;
 },
```

- [ ] **Step 3: Parse-check**

```bash
node -e "new Function(require('fs').readFileSync('frontend/js/bots_module.js','utf8')); console.log('parse OK')"
```

Expected: `parse OK`

- [ ] **Step 4: Commit**

```bash
git add frontend/js/bots_module.js
git commit -m "feat(mc-map): 13 sprites pixel-art structures/grotte + helpers dessin"
```

---

### Task 3: Couleurs de biomes = map colors MC

**Files:**
- Modify: `frontend/js/bots_module.js:2384-2414` (`_MCA_BIOME_RULES` + `_mcaBiomeColor`)

- [ ] **Step 1: Remplacer les règles HSL par des map colors**

Remplacer intégralement `_MCA_BIOME_RULES` et `_mcaBiomeColor` (le commentaire au-dessus aussi) par :

```js
 // Couleur stable par biome — map colors « item carte » MC + jitter de luminosité hashé
 // (±4 %) pour distinguer les variantes ; fallback palette terre pour les biomes custom.
 // ⚠️ L'ORDRE compte (crimson/warped avant forest, badland avant desert, deep_dark avant cave).
 _MCA_BIOME_RULES: [
 [/crimson/, '#943F3F'],
 [/warped/, '#2E7A73'],
 [/nether|basalt|soul|magma|delta/, '#7A3327'],
 [/lush/, '#4C9E4C'],
 [/deep_dark|sculk/, '#10344A'],
 [/dripstone/, '#976D4D'],
 [/ocean|river|water|aquifer/, '#4040F0'],
 [/frozen|snow|ice|grove/, '#D8E2D8'],
 [/badland/, '#D87F33'],
 [/desert|beach|sand|dune/, '#F7E9A3'],
 [/jungle|bamboo/, '#2C9E1A'],
 [/swamp|mangrove|bog/, '#62703A'],
 [/savanna/, '#B8A94E'],
 [/taiga/, '#5C8A5A'],
 [/forest|wood|birch|cherry/, '#4C8A2E'],
 [/plain|meadow|field|pasture/, '#8AB84F'],
 [/mushroom/, '#8F7748'],
 [/peak|mountain|hill|slope|stony|windswept|gravel/, '#7A7A7A'],
 [/\bend\b|void|barren/, '#D8D0A8'],
 [/cave|deep/, '#5A4D3A'],
 ],

 _MCA_BIOME_FALLBACK: ['#8AB84F', '#976D4D', '#B8A94E', '#5C8A5A', '#7A7A7A', '#62703A'],

 _mcaBiomeColor(name) {
 const n = String(name).toLowerCase();
 const h = this._mcaHash('b:' + n);
 const jitter = 0.96 + (h % 9) / 100;
 for (const [re, hex] of this._MCA_BIOME_RULES) {
 if (re.test(n)) return this._mcaShade(hex, jitter);
 }
 return this._mcaShade(this._MCA_BIOME_FALLBACK[h % this._MCA_BIOME_FALLBACK.length], jitter);
 },
```

(`_mcaHash` string existant conservé — il sert ici et éventuellement ailleurs.)

- [ ] **Step 2: Parse-check** (même commande que Task 2 Step 3) → `parse OK`

- [ ] **Step 3: Commit**

```bash
git add frontend/js/bots_module.js
git commit -m "feat(mc-map): biomes en map colors Minecraft (3 mondes, fallback terre)"
```

---

### Task 4: i18n — noms des structures (FR/EN/IT) + helper

**Files:**
- Modify: `frontend/js/lang.js` (3 blocs langue — repérage : `grep -n "mcagent.map.caves" frontend/js/lang.js` donne les 3 zones)
- Modify: `frontend/js/bots_module.js` (helper `_mcaStructName`, à placer après `_structInitial` l.~1311)

- [ ] **Step 1: Ajouter 13 clés × 3 langues**

À côté des clés `mcagent.map.*` existantes de chaque bloc. FR :

```js
 'mcagent.map.struct.village': 'Village',
 'mcagent.map.struct.dungeon': 'Donjon',
 'mcagent.map.struct.monument': 'Monument',
 'mcagent.map.struct.ancient_city': 'Cité ancienne',
 'mcagent.map.struct.stronghold': 'Stronghold',
 'mcagent.map.struct.mineshaft': 'Mine abandonnée',
 'mcagent.map.struct.ruined_portal': 'Portail en ruine',
 'mcagent.map.struct.desert_pyramid': 'Pyramide',
 'mcagent.map.struct.jungle_pyramid': 'Temple jungle',
 'mcagent.map.struct.pillager_outpost': 'Avant-poste',
 'mcagent.map.struct.shipwreck': 'Épave',
 'mcagent.map.struct.fortress': 'Forteresse',
 'mcagent.map.struct.cave': 'Grotte',
```

EN :

```js
 'mcagent.map.struct.village': 'Village',
 'mcagent.map.struct.dungeon': 'Dungeon',
 'mcagent.map.struct.monument': 'Monument',
 'mcagent.map.struct.ancient_city': 'Ancient city',
 'mcagent.map.struct.stronghold': 'Stronghold',
 'mcagent.map.struct.mineshaft': 'Mineshaft',
 'mcagent.map.struct.ruined_portal': 'Ruined portal',
 'mcagent.map.struct.desert_pyramid': 'Pyramid',
 'mcagent.map.struct.jungle_pyramid': 'Jungle temple',
 'mcagent.map.struct.pillager_outpost': 'Outpost',
 'mcagent.map.struct.shipwreck': 'Shipwreck',
 'mcagent.map.struct.fortress': 'Fortress',
 'mcagent.map.struct.cave': 'Cave',
```

IT :

```js
 'mcagent.map.struct.village': 'Villaggio',
 'mcagent.map.struct.dungeon': 'Dungeon',
 'mcagent.map.struct.monument': 'Monumento',
 'mcagent.map.struct.ancient_city': 'Città antica',
 'mcagent.map.struct.stronghold': 'Stronghold',
 'mcagent.map.struct.mineshaft': 'Miniera abbandonata',
 'mcagent.map.struct.ruined_portal': 'Portale in rovina',
 'mcagent.map.struct.desert_pyramid': 'Piramide',
 'mcagent.map.struct.jungle_pyramid': 'Tempio della giungla',
 'mcagent.map.struct.pillager_outpost': 'Avamposto',
 'mcagent.map.struct.shipwreck': 'Relitto',
 'mcagent.map.struct.fortress': 'Fortezza',
 'mcagent.map.struct.cave': 'Grotta',
```

- [ ] **Step 2: Helper avec fallback (piège #12 : Lang.t rend la clé si absente)**

Dans `bots_module.js`, après `_structInitial` :

```js
 // Nom i18n d'un type de structure ; kind inconnu → kind lisible.
 _mcaStructName(kind) {
 const t = Lang.t('mcagent.map.struct.' + kind);
 return (t || '').startsWith('mcagent.') ? String(kind).replace(/_/g, ' ') : t;
 },
```

- [ ] **Step 3: Parse-check des 2 fichiers**

```bash
node -e "new Function(require('fs').readFileSync('frontend/js/bots_module.js','utf8')); new Function(require('fs').readFileSync('frontend/js/lang.js','utf8')); console.log('parse OK')"
```

Expected: `parse OK`

- [ ] **Step 4: Commit**

```bash
git add frontend/js/lang.js frontend/js/bots_module.js
git commit -m "feat(mc-map): noms i18n FR/EN/IT des 13 types de structures"
```

---

### Task 5: Refonte du rendu (`_mcaMapDraw` + habillage parchemin)

**Files:**
- Modify: `frontend/js/bots_module.js:2493-2613` (`_mcaMapDraw`, `_mcaMapScaleBar`) + nouveaux helpers `_mcaFrame`/`_mcaLabel`
- Modify: `frontend/js/bots_module.js:2075-2078` (`_renderGroupMap` — styles inline du conteneur carte)

- [ ] **Step 1: Styles conteneur (parchemin)**

Dans `_renderGroupMap`, remplacer les 3 lignes du bloc carte :

```js
 <div style="position:relative;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:#a8895c;">
 <canvas id="mca-map-canvas" style="display:block;width:100%;height:440px;cursor:grab;touch-action:none;"></canvas>
 <div id="mca-map-empty" style="position:absolute;inset:0;display:none;align-items:center;justify-content:center;text-align:center;padding:20px;color:#4a3216;font-weight:600;font-size:13px;pointer-events:none;"></div>
 <div id="mca-map-coords" style="position:absolute;left:16px;bottom:14px;font-family:var(--font-mono);font-size:11px;color:#f0e1b9;background:rgba(58,44,24,0.85);padding:2px 8px;border-radius:6px;pointer-events:none;"></div>
```

(seuls `background:#a8895c`, `color:#4a3216;font-weight:600` de l'empty, et `left:16px;bottom:14px;color:#f0e1b9;background:rgba(58,44,24,0.85)` des coords changent).

- [ ] **Step 2: Chargement de la police puis redraw**

Toujours dans `_renderGroupMap`, dans le bloc `if (viewerOpen) { ... }` (l.~2085), après `await this._mcaMapRefresh();` :

```js
 if (document.fonts && document.fonts.load) document.fonts.load('8px PSP').then(() => this._mcaMapDraw()).catch(() => {});
```

- [ ] **Step 3: Remplacer `_mcaMapDraw` intégralement**

```js
 _mcaMapDraw() {
 const m = this._mcaMapState();
 const cv = document.getElementById('mca-map-canvas');
 if (!cv) return;
 const dpr = window.devicePixelRatio || 1;
 const w = cv.clientWidth, h = cv.clientHeight;
 if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
 cv.width = Math.round(w * dpr);
 cv.height = Math.round(h * dpr);
 }
 const ctx = cv.getContext('2d');
 ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
 // parchemin nu = zone pas encore cartographiée
 ctx.fillStyle = '#d4bb8d';
 ctx.fillRect(0, 0, w, h);
 const v = m.view;
 const toX = (x) => (x - v.cx) * v.scale + w / 2;
 const toY = (z) => (z - v.cz) * v.scale + h / 2;
 const world = this._mcaMapWorld();
 if (!world) { this._mcaMapScaleBar(ctx, w, h); this._mcaFrame(ctx, w, h); return; }
 const hid = m.hidden;
 // 1. biomes — cases 128×128 en map colors + grain dithéré déterministe
 const cell = 128 * v.scale;
 for (const b of world.biomes || []) {
 const key = b.name || ('#' + b.id);
 if (hid['b:' + key]) continue;
 const x0 = toX(b.x), y0 = toY(b.z);
 if (x0 > w || y0 > h || x0 + cell < 0 || y0 + cell < 0) continue;
 const base = this._mcaBiomeColor(key);
 ctx.fillStyle = base;
 ctx.fillRect(x0, y0, cell + 0.5, cell + 0.5);
 if (cell >= 12) {
 const g = Math.max(6, cell / 16); // ≤ 256 sous-tuiles / cellule (garde-fou perf)
 const cellX = Math.round(b.x / 128), cellZ = Math.round(b.z / 128);
 for (let gy = 0, iy = 0; gy < cell; gy += g, iy++) {
 for (let gx = 0, ix = 0; gx < cell; gx += g, ix++) {
 const r = this._mcaHash2(cellX * 97 + ix, cellZ * 131 + iy);
 const f = r < 0.22 ? 0.92 : (r > 0.82 ? 1.07 : 0);
 if (f) {
 ctx.fillStyle = this._mcaShade(base, f);
 ctx.fillRect(x0 + gx, y0 + gy, Math.min(g, cell - gx), Math.min(g, cell - gy));
 }
 }
 }
 }
 }
 // ⚠️ _mcaShade attend '#rrggbb' : _mcaBiomeColor rend 'rgb(...)' → garder la base HEX.
 // (voir Step 4 : _mcaBiomeColor est scindée pour exposer la couleur hex de base)
 // 2. grille 128 discrète, encre brune
 if (v.scale >= 0.12) {
 ctx.strokeStyle = 'rgba(90,60,20,0.07)';
 ctx.lineWidth = 1;
 const step = cell;
 let gx = toX(Math.floor((v.cx - w / 2 / v.scale) / 128) * 128);
 for (; gx <= w; gx += step) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
 let gy = toY(Math.floor((v.cz - h / 2 / v.scale) / 128) * 128);
 for (; gy <= h; gy += step) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }
 }
 // 3. spawn (0,0) — curseur de map MC (losange blanc contour noir)
 const ox = toX(0), oy = toY(0);
 if (ox >= -10 && ox <= w + 10 && oy >= -10 && oy <= h + 10) {
 ctx.save();
 ctx.translate(ox, oy);
 ctx.rotate(Math.PI / 4);
 ctx.fillStyle = '#ffffff';
 ctx.strokeStyle = '#1a1a1a';
 ctx.lineWidth = 2;
 ctx.beginPath();
 ctx.rect(-5, -5, 10, 10);
 ctx.fill();
 ctx.stroke();
 ctx.restore();
 }
 // 4. grottes — sprite 'cave' (plus de triangles), pas de label (tooltip au survol)
 if (!hid.caves) {
 for (const c of world.caves || []) {
 const x = toX(c.x), y = toY(c.z);
 if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
 this._mcaDrawSprite(ctx, 'cave', x, y, 2, true);
 }
 }
 // 5. structures — sprite dédié + label parchemin au zoom ; kind inconnu → pastille+initiale
 const showLabels = cell >= 45;
 for (const st of world.structures || []) {
 if (hid['s:' + st.kind]) continue;
 const x = toX(st.x), y = toY(st.z);
 if (x < -24 || y < -24 || x > w + 24 || y > h + 24) continue;
 if (this._mcaDrawSprite(ctx, st.kind, x, y, 2, true)) {
 if (showLabels) this._mcaLabel(ctx, x + 22, y, this._mcaStructName(st.kind));
 } else {
 const col = this._structColor(st.kind);
 ctx.fillStyle = col;
 ctx.beginPath();
 ctx.arc(x, y, 6, 0, Math.PI * 2);
 ctx.fill();
 ctx.strokeStyle = 'rgba(26,20,10,0.9)';
 ctx.lineWidth = 1.2;
 ctx.stroke();
 ctx.fillStyle = '#1a140a';
 ctx.font = 'bold 8px var(--font-mono), monospace';
 ctx.textAlign = 'center';
 ctx.textBaseline = 'middle';
 ctx.fillText(this._structInitial(st.kind), x, y + 0.5);
 ctx.textAlign = 'left';
 if (showLabels) this._mcaLabel(ctx, x + 12, y, this._mcaStructName(st.kind));
 }
 }
 this._mcaMapScaleBar(ctx, w, h);
 this._mcaFrame(ctx, w, h);
 },
```

**Bloc finds : disparu** (l'ancien `// 5. trouvailles` n'est pas repris).

- [ ] **Step 4: Scinder `_mcaBiomeColor` pour exposer la base hex** (le grain shade la couleur de BASE, pas le rgb jitterné)

Remplacer la version de Task 3 par :

```js
 _mcaBiomeBase(name) {
 const n = String(name).toLowerCase();
 for (const [re, hex] of this._MCA_BIOME_RULES) {
 if (re.test(n)) return hex;
 }
 return this._MCA_BIOME_FALLBACK[this._mcaHash('b:' + n) % this._MCA_BIOME_FALLBACK.length];
 },

 _mcaBiomeColor(name) {
 const jitter = 0.96 + (this._mcaHash('b:' + String(name).toLowerCase()) % 9) / 100;
 return this._mcaShade(this._mcaBiomeBase(name), jitter);
 },
```

Et dans `_mcaMapDraw` (Step 3), le bloc biome utilise :

```js
 const baseHex = this._mcaBiomeBase(key);
 const jitter = 0.96 + (this._mcaHash('b:' + String(key).toLowerCase()) % 9) / 100;
 ctx.fillStyle = this._mcaShade(baseHex, jitter);
 ctx.fillRect(x0, y0, cell + 0.5, cell + 0.5);
 // … et dans le grain :
 ctx.fillStyle = this._mcaShade(baseHex, jitter * f);
```

(supprimer alors la ligne `const base = this._mcaBiomeColor(key);` et le commentaire ⚠️ du Step 3 — c'est la version finale).

- [ ] **Step 5: Ajouter `_mcaFrame` et `_mcaLabel`** (après `_mcaMapScaleBar`)

```js
 // Cadre « item carte » : pourtour parchemin sombre + crans pixel déterministes + liseré.
 _mcaFrame(ctx, w, h) {
 const k = 6, p = 12;
 ctx.fillStyle = '#a8895c';
 ctx.fillRect(0, 0, w, p);
 ctx.fillRect(0, h - p, w, p);
 ctx.fillRect(0, 0, p, h);
 ctx.fillRect(w - p, 0, p, h);
 for (let x = 0; x < w; x += k) {
 if (this._mcaHash2(x, 11) > 0.55) ctx.fillRect(x, p, k, k);
 if (this._mcaHash2(x, 13) > 0.55) ctx.fillRect(x, h - p - k, k, k);
 }
 for (let y = 0; y < h; y += k) {
 if (this._mcaHash2(15, y) > 0.55) ctx.fillRect(p, y, k, k);
 if (this._mcaHash2(17, y) > 0.55) ctx.fillRect(w - p - k, y, k, k);
 }
 ctx.strokeStyle = 'rgba(74,50,22,0.55)';
 ctx.lineWidth = 2;
 ctx.strokeRect(p + 2.5, p + 2.5, w - 2 * p - 5, h - 2 * p - 5);
 },

 // Étiquette parchemin : nom de structure à droite de l'icône (police pixel 8px).
 _mcaLabel(ctx, x, y, text) {
 ctx.font = '8px PSP, monospace';
 ctx.textAlign = 'left';
 ctx.textBaseline = 'middle';
 const tw = ctx.measureText(text).width;
 ctx.fillStyle = 'rgba(240,225,185,0.92)';
 ctx.strokeStyle = 'rgba(90,60,20,0.45)';
 ctx.lineWidth = 1;
 if (ctx.roundRect) {
 ctx.beginPath();
 ctx.roundRect(x, y - 8, tw + 12, 16, 4);
 ctx.fill();
 ctx.stroke();
 } else {
 ctx.fillRect(x, y - 8, tw + 12, 16);
 ctx.strokeRect(x + 0.5, y - 7.5, tw + 11, 15);
 }
 ctx.fillStyle = '#4a3216';
 ctx.fillText(text, x + 6, y + 1);
 },
```

- [ ] **Step 6: Restyler `_mcaMapScaleBar`** — remplacer les couleurs/fonte (structure identique) :

```js
 _mcaMapScaleBar(ctx, w, h) {
 const v = this._mcaMapState().view;
 let blocks = 128;
 let px = blocks * v.scale;
 while (px < 40 && blocks < 65536) { blocks *= 2; px = blocks * v.scale; }
 while (px > 180 && blocks > 16) { blocks /= 2; px = blocks * v.scale; }
 const x = w - px - 26, y = h - 26;
 ctx.strokeStyle = 'rgba(74,50,22,0.85)';
 ctx.lineWidth = 1.5;
 ctx.beginPath();
 ctx.moveTo(x, y); ctx.lineTo(x + px, y);
 ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4);
 ctx.moveTo(x + px, y - 4); ctx.lineTo(x + px, y + 4);
 ctx.stroke();
 ctx.fillStyle = 'rgba(74,50,22,0.9)';
 ctx.font = '8px PSP, monospace'; // ctx.font ne résout pas les vars CSS
 ctx.textAlign = 'center';
 ctx.fillText(String(blocks), x + px / 2, y - 8);
 ctx.textAlign = 'left';
 },
```

- [ ] **Step 7: Parse-check** → `parse OK`

- [ ] **Step 8: Commit**

```bash
git add frontend/js/bots_module.js
git commit -m "feat(mc-map): rendu item carte — parchemin, grain, curseur spawn, sprites + labels, finds retirés du dessin"
```

---

### Task 6: Fit / Sync / Tooltip (retrait finds + survol structures)

**Files:**
- Modify: `frontend/js/bots_module.js:2350-2374` (`_mcaMapFit`), `:2334-2336` (`_mcaMapSync`), `:2480-2491` (`_mcaMapCoords`)

- [ ] **Step 1: `_mcaMapFit` — les finds sortent de l'étendue**

Supprimer la ligne :

```js
 (world.finds || []).forEach((f) => seen(f.x, f.z, 0));
```

- [ ] **Step 2: `_mcaMapSync` — les finds sortent de l'empty-state**

Remplacer :

```js
 const has = !!world && ((world.biomes || []).length + (world.caves || []).length + (world.finds || []).length + (world.structures || []).length) > 0;
```

par :

```js
 const has = !!world && ((world.biomes || []).length + (world.caves || []).length + (world.structures || []).length) > 0;
```

- [ ] **Step 3: `_mcaMapCoords` — nom de la structure/grotte sous le curseur**

Remplacer la fonction entière par :

```js
 // Coords monde sous le curseur + biome de la cellule + structure/grotte proche (< 14 px écran).
 _mcaMapCoords(p, cv) {
 const el = document.getElementById('mca-map-coords');
 if (!el) return;
 const v = this._mcaMapState().view;
 const w = cv.clientWidth, h = cv.clientHeight;
 const wx = Math.round(v.cx + (p.x - w / 2) / v.scale);
 const wz = Math.round(v.cz + (p.y - h / 2) / v.scale);
 const cx = Math.floor(wx / 128) * 128, cz = Math.floor(wz / 128) * 128;
 const world = this._mcaMapWorld();
 const b = world ? (world.biomes || []).find((bb) => bb.x === cx && bb.z === cz) : null;
 let near = '';
 if (world) {
 const sx = (o) => (o.x - v.cx) * v.scale + w / 2;
 const sy = (o) => (o.z - v.cz) * v.scale + h / 2;
 let best = 14;
 for (const st of world.structures || []) {
 const d = Math.hypot(sx(st) - p.x, sy(st) - p.y);
 if (d < best) { best = d; near = this._mcaStructName(st.kind); }
 }
 for (const c of world.caves || []) {
 const d = Math.hypot(sx(c) - p.x, sy(c) - p.y);
 if (d < best) { best = d; near = this._mcaStructName('cave') + (typeof c.y === 'number' ? ' y ' + c.y : ''); }
 }
 }
 el.textContent = `x ${wx} · z ${wz}` + (b ? ` · ${b.name || ('#' + b.id)}` : '') + (near ? ` · ${near}` : '');
 },
```

- [ ] **Step 4: Parse-check** → `parse OK`

- [ ] **Step 5: Commit**

```bash
git add frontend/js/bots_module.js
git commit -m "feat(mc-map): tooltip structures/grottes au survol, finds hors fit/empty-state"
```

---

### Task 7: Légende (mini-icônes, plus de finds)

**Files:**
- Modify: `frontend/js/bots_module.js:2616-2659` (`_mcaMapLegend`) + suppression `_MCA_MAT_COLORS`/`_mcaMatColor` (l.2417-2431)

- [ ] **Step 1: Vérifier que `_mcaMatColor`/`_MCA_MAT_COLORS` n'ont pas d'autre usage**

```bash
grep -n "_mcaMatColor\|_MCA_MAT_COLORS" frontend/js/bots_module.js
```

Expected: uniquement leur définition (l.~2417-2431) + les usages dans `_mcaMapDraw` (déjà supprimés en Task 5) et `_mcaMapLegend` (supprimés au step suivant). ⚠️ `_oreColor` (l.1294, barres quota) est une fonction distincte — ne pas y toucher.

- [ ] **Step 2: Remplacer `_mcaMapLegend` intégralement + supprimer `_MCA_MAT_COLORS`/`_mcaMatColor`**

```js
 // Légende cliquable : chips biomes (swatch map color) / structures (mini-icône) / grottes.
 _mcaMapLegend() {
 const box = document.getElementById('mca-map-legend');
 if (!box) return;
 const m = this._mcaMapState();
 const world = this._mcaMapWorld();
 if (!world) { box.innerHTML = ''; return; }
 const counts = (arr, key) => {
 const o = {};
 (arr || []).forEach((e) => { const k = key(e); o[k] = (o[k] || 0) + 1; });
 return o;
 };
 const biomes = counts(world.biomes, (b) => b.name || ('#' + b.id));
 const structCounts = counts(world.structures, (st) => st.kind);
 const chip = (k, label, count, swatchHtml) => `<button type="button" data-k="${this._escapeHtml(k)}" class="mca-map-chip" style="display:inline-flex;align-items:center;gap:6px;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:999px;padding:3px 10px;margin:2px 6px 2px 0;font-size:12px;cursor:pointer;color:var(--text);opacity:${m.hidden[k] ? 0.35 : 1};">${swatchHtml}<span>${this._escapeHtml(label)}</span><span style="color:var(--text-dim);font-family:var(--font-mono);">${count}</span></button>`;
 const sq = (color) => `<span style="display:inline-block;width:10px;height:10px;background:${color};border-radius:3px;"></span>`;
 const ico = (kind) => this._MCA_SPRITES[kind]
 ? `<canvas class="mca-chip-ico" data-spr="${this._escapeHtml(kind)}" width="16" height="16" style="width:16px;height:16px;image-rendering:pixelated;"></canvas>`
 : sq(this._structColor(kind));
 const bioChips = Object.keys(biomes).sort((a, b) => biomes[b] - biomes[a] || a.localeCompare(b))
 .map((k) => chip('b:' + k, k, biomes[k], sq(this._mcaBiomeColor(k)))).join('');
 const structChips = Object.keys(structCounts).sort()
 .map((k) => chip('s:' + k, this._mcaStructName(k), structCounts[k], ico(k))).join('');
 const caveChip = (world.caves || []).length
 ? chip('caves', Lang.t('mcagent.map.caves'), (world.caves || []).length, ico('cave')) : '';
 const section = (title, chips) => chips
 ? `<div style="margin-bottom:6px;"><div style="font-size:11px;text-transform:uppercase;color:var(--text-dim);margin-bottom:3px;">${title}</div>${chips}</div>` : '';
 box.innerHTML =
 section(Lang.t('mcagent.map.biomes'), bioChips) +
 section(Lang.t('mcagent.map.structures'), structChips) +
 section(Lang.t('mcagent.map.caves'), caveChip);
 box.querySelectorAll('.mca-chip-ico').forEach((c) => {
 this._mcaDrawSprite(c.getContext('2d'), c.getAttribute('data-spr'), 8, 8, 1, false);
 });
 box.querySelectorAll('.mca-map-chip').forEach((el) => el.addEventListener('click', () => {
 const k = el.getAttribute('data-k');
 m.hidden[k] = !m.hidden[k];
 el.style.opacity = m.hidden[k] ? 0.35 : 1;
 this._mcaMapDraw();
 }));
 },
```

(la section finds et le paramètre `shape` disparaissent ; le swatch triangle grotte devient la mini-icône.)

- [ ] **Step 3: Parse-check + re-grep**

```bash
node -e "new Function(require('fs').readFileSync('frontend/js/bots_module.js','utf8')); console.log('parse OK')"
grep -c "_mcaMatColor\|_MCA_MAT_COLORS" frontend/js/bots_module.js
```

Expected: `parse OK` puis `0`.

- [ ] **Step 4: Commit**

```bash
git add frontend/js/bots_module.js
git commit -m "feat(mc-map): légende avec mini-icônes structures, section trouvailles supprimée"
```

---

### Task 8: Vérification visuelle locale (harness + Browser pane)

**Files:**
- Create (scratchpad, PAS dans le repo): `harness-mc-map.html`

- [ ] **Step 1: Écrire le harness**

Dans le scratchpad de session, `harness-mc-map.html` — il charge le **vrai** `bots_module.js` (copié/servi depuis le worktree), stubbe `Lang`/`Auth`, construit le DOM minimal de la carte et injecte une fixture au format réel (y compris des `finds` pour prouver qu'ils ne rendent plus) :

```html
<!doctype html><html><head><meta charset="utf-8">
<style>
  body { background:#0e0e10; margin:20px; }
  @font-face { font-family:'PSP'; src:url('fonts/press-start-2p-latin.woff2') format('woff2'); }
  :root { --bg-elev-2:#18181b; --border:#27272a; --text:#f4f4f5; --text-dim:#71717a; --font-mono:monospace; }
</style></head><body>
<div style="position:relative;border-radius:10px;overflow:hidden;background:#a8895c;width:1000px;">
  <canvas id="mca-map-canvas" style="display:block;width:100%;height:440px;"></canvas>
  <div id="mca-map-empty" style="display:none;"></div>
  <div id="mca-map-coords" style="position:absolute;left:16px;bottom:14px;font-size:11px;color:#f0e1b9;background:rgba(58,44,24,0.85);padding:2px 8px;border-radius:6px;"></div>
</div>
<div id="mca-map-legend" style="margin-top:10px;color:#fff;"></div>
<select id="mca-map-world" style="display:none;"></select><span id="mca-map-updated" style="display:none;"></span>
<script>
  window.Lang = { t: (k) => ({
    'mcagent.map.biomes':'Biomes','mcagent.map.structures':'Structures','mcagent.map.caves':'Grottes',
    'mcagent.map.struct.village':'Village','mcagent.map.struct.dungeon':'Donjon','mcagent.map.struct.monument':'Monument',
    'mcagent.map.struct.ancient_city':'Cité ancienne','mcagent.map.struct.stronghold':'Stronghold',
    'mcagent.map.struct.mineshaft':'Mine abandonnée','mcagent.map.struct.ruined_portal':'Portail en ruine',
    'mcagent.map.struct.desert_pyramid':'Pyramide','mcagent.map.struct.jungle_pyramid':'Temple jungle',
    'mcagent.map.struct.pillager_outpost':'Avant-poste','mcagent.map.struct.shipwreck':'Épave',
    'mcagent.map.struct.fortress':'Forteresse','mcagent.map.struct.cave':'Grotte',
    'mcagent.map.updated':'MAJ','mcagent.map.never':'jamais','common.locale':'fr-FR'
  }[k] || k) };
  window.Auth = { apiCall: async () => ({ json: async () => ({}) }) };
</script>
<script src="bots_module.js"></script>
<script>
  const biomes = [];
  const names = { O:'ocean', r:'river', b:'beach', p:'plains', f:'forest', j:'jungle', d:'desert', m:'stony_peaks', t:'snowy_taiga', v:'savanna', s:'swamp' };
  const GRID = ['OOmmmmmtttttffjj','OObmmmppttffffjj','OObppppprffffjjj','Obpppppprrpffjjj','Obpvvpprrdddjjss','OObvvrrdddddssss','OOObvrdddddsssss'];
  GRID.forEach((row, j) => row.split('').forEach((ch, i) => biomes.push({ x: i*128, z: j*128, name: names[ch] })));
  const FIXTURE = { updated_at: '2026-07-14T02:00:00Z', worlds: { overworld: {
    biomes,
    caves: [{x:660,y:-12,z:115},{x:1460,y:24,z:425},{x:980,y:-38,z:620}],
    structures: [
      {kind:'monument',x:170,z:700},{kind:'shipwreck',x:120,z:190},{kind:'village',x:590,z:350},
      {kind:'pillager_outpost',x:850,z:150},{kind:'mineshaft',x:460,z:75},{kind:'ancient_city',x:300,z:205},
      {kind:'dungeon',x:1350,z:330},{kind:'ruined_portal',x:1330,z:560},{kind:'desert_pyramid',x:1180,z:710},
      {kind:'jungle_pyramid',x:1760,z:330},{kind:'stronghold',x:760,z:530},{kind:'type_inconnu_test',x:1600,z:650}
    ],
    finds: [{material:'diamond',x:500,z:500},{material:'oak_log',x:900,z:300}]
  } } };
  const m = BotsModule._mcaMapState();
  m.sid = 'harness'; m.data = FIXTURE; m.world = 'overworld';
  BotsModule._mcaMapSync();
  document.getElementById('mca-map-canvas').addEventListener('pointermove', (ev) => {
    const cv = ev.target, r = cv.getBoundingClientRect();
    BotsModule._mcaMapCoords({ x: ev.clientX - r.left, y: ev.clientY - r.top }, cv);
  });
  if (document.fonts && document.fonts.load) document.fonts.load('8px PSP').then(() => BotsModule._mcaMapDraw());
</script>
</body></html>
```

- [ ] **Step 2: Servir et ouvrir**

```bash
cd <scratchpad>
cp "<worktree>/frontend/js/bots_module.js" .
mkdir -p fonts && cp "<worktree>/frontend/fonts/press-start-2p-latin.woff2" fonts/
python3 -m http.server 8792 --bind 127.0.0.1 &
```

Ouvrir `http://127.0.0.1:8792/harness-mc-map.html` dans le Browser pane.

- [ ] **Step 3: Vérifier (console + screenshots)**

Checklist (spec §9) :
1. 0 erreur console.
2. Parchemin + bord déchiré + liseré ; zones hors biomes = parchemin nu.
3. Biomes en map colors (océan bleu franc, plaines vertes, désert sable, neige claire).
4. Grain visible et **stable** (deux draws successifs identiques — appeler `BotsModule._mcaMapDraw()` 2× et comparer des `getImageData` par hash, ou visuellement au screenshot).
5. Spawn = curseur blanc losange à (0,0) (coin haut-gauche de la grille fixture).
6. 11 sprites + 1 fallback pastille `?` (`type_inconnu_test`) + labels parchemin (au scale du fit, cellule ≈ 60 px ≥ 45 → labels visibles).
7. Grottes = sprite cave.
8. AUCUN losange de finds.
9. Légende : swatches biomes recolorés, mini-icônes structures + grotte, PAS de section finds ; un clic sur un chip masque le type (re-screenshot).
10. Tooltip : `computer` hover sur le village → `#mca-map-coords` contient `Village` ; hover sur une grotte → `Grotte y -12`.
11. Police pixel effective sur étiquettes/échelle (glyphes carrés, pas de monospace lisse).

- [ ] **Step 4: Corriger ce qui cloche** (retours au fichier réel du worktree, re-copier, re-vérifier), puis :

```bash
kill %1  # stoppe http.server
git add -A && git commit -m "fix(mc-map): ajustements post-vérification harness" # seulement si des fixes ont eu lieu
```

---

### Task 9: Cache-bust + parse final

**Files:**
- Modify: `frontend/index.html:15,91,106`
- Modify: `frontend/sw.js:10`

- [ ] **Step 1: Lire les valeurs d'origin/main (elles ont pu bouger)**

```bash
git fetch origin
git show origin/main:frontend/index.html | grep -o "style.css?v=[0-9]*\|lang.js?v=[0-9]*\|bots_module.js?v=[0-9]*"
git show origin/main:frontend/sw.js | grep -m1 CACHE_NAME
```

- [ ] **Step 2: Bumper AU-DESSUS des valeurs d'origin/main**

Dans `frontend/index.html` : `style.css?v=<origin+1>`, `lang.js?v=<origin+1>`, `bots_module.js?v=<origin+1>`.
Dans `frontend/sw.js` : `CACHE_NAME = 'omenserver-v<origin+1>'`.

- [ ] **Step 3: Parse final des JS modifiés**

```bash
node -e "['frontend/js/bots_module.js','frontend/js/lang.js','frontend/sw.js'].forEach(f => new Function(require('fs').readFileSync(f,'utf8'))); console.log('parse OK')"
```

Expected: `parse OK`

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/sw.js
git commit -m "chore(mc-map): cache-bust css/lang/bots_module + sw"
```

---

### Task 10: Deploy + vérification prod

- [ ] **Step 1: Vérifier qu'aucun bot/scan ne tourne** (piège #30f : un push restart uvicorn et tue les subprocess non détachés + le dict sessions self-healing)

Demander à Massii OU vérifier le badge « Bots » du dashboard prod via Chrome MCP. Si un grind MC/scan tourne → attendre.

- [ ] **Step 2: Rebase + push**

```bash
git fetch origin
git rebase origin/main
# re-vérifier que les ?v= bumpés sont TOUJOURS > origin/main après rebase (Task 9 Step 1-2 à refaire si origin a bougé)
git push origin feat/mc-map-minecraft-style:main
```

- [ ] **Step 3: Vérifier la prod (≈ 1 min d'auto-deploy + SW : 2 reloads)**

Via Chrome MCP sur la session loguée de Massii (`omenserver.org`) :
1. `index.html` sert les nouveaux `?v=` ; `sw.js` sert le nouveau `CACHE_NAME`.
2. Onglet Bots → MC Agent → groupe → onglet Mapping → « Ouvrir la carte » : rendu parchemin réel sur les données du monde du groupe (structures réelles si présentes), console sans erreur.
3. Screenshot de preuve pour Massii.

- [ ] **Step 4: Post-deploy**

- Merger la branche dans `main` local si le workflow du repo le veut (le push a déjà déployé) ; nettoyer le worktree.
- MAJ vault Obsidian (Daily note) + entrée « Historique récent » de `CLAUDE.md` si souhaité par la convention du repo (avec commit dédié docs, cache-bust non requis).
