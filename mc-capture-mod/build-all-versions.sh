#!/bin/bash
# OmenCapture — Builder le jar pour toutes les versions Fabric MC supportées.
#
# Usage :
#   ./build-all-versions.sh              # builde toutes les versions de la matrice
#   ./build-all-versions.sh 1.21.1       # builde une seule version
#   ./build-all-versions.sh 1.20.1 1.21  # builde plusieurs versions ciblées
#
# Sortie : un jar par version dans dist/, nommé mc-capture-<modver>-mc<mcver>.jar
#
# Prérequis :
# - JDK 17 (pour 1.20.1-1.20.4)
# - JDK 21 (pour 1.20.6, 1.21+)
#   → soit `java -version` retourne 21 et SDK 17 est utilisé via Loom auto-toolchain
#   → soit on lance avec `JAVA_HOME=/path/jdk17 ./build-all-versions.sh 1.20.1`
#
# Si une version échoue (ex : yarn build a bougé), le script CONTINUE avec
# les versions restantes et liste les échecs à la fin.

set -uo pipefail

cd "$(dirname "$0")"

# === Matrice des versions ===
# ⚠️ TOOLCHAIN (2026-06-04) : MC 1.21.6+ embarque des mappings yarn en unpick v3 → fabric-loom
#    1.10.5 / Gradle 8.12 échouait ("Unsupported unpick version"). La toolchain est désormais
#    loom 1.16.3 (build.gradle) + Gradle 9.4.1 (gradle-wrapper.properties) — compatible 1.20.1
#    → 1.21.11. De plus 1.21.6+ a cassé des API (KeyBinding.Category record, GameProfile.name())
#    → CaptureMod.java cible MC 1.21.6+ en référence DIRECTE (KeyBinding.Category.MISC). PAS de
#    réflexion par nom yarn : loom ne remappe pas les String → Class.forName(<yarn>) crashe au
#    RUNTIME sur client remappé. Les jars ≤1.21.5 sont FIGÉS (committés) ; rebuild d'une version
#    ≤1.21.5 = checkout du code d'avant 2026-06-04 (sinon échec de compil KeyBinding.Category).
# Format : <mc_version>|<java_release>|<yarn_mappings>|<loader_version>|<fabric_api_version>
# Valeurs basées sur https://fabricmc.net/develop (juin 2026). Si un build échoue
# avec "Could not resolve dependency", chercher la dernière yarn/fabric-api pour
# cette version MC sur fabricmc.net et corriger ici.
# Valeurs vérifiées via les maven-metadata.xml RÉELS (curl + grep, juin 2026) :
#   - yarn      : https://maven.fabricmc.net/net/fabricmc/yarn/maven-metadata.xml
#   - fabric-api: https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml
# Re-vérifier avec :
#   curl -s <metadata-url> | grep -oE "X+build\.[0-9]+|[0-9]+\.[0-9]+\.[0-9]+\+X" | sort -V | tail -1
read -r -d '' VERSION_MATRIX <<'EOF' || true
1.20.1|17|1.20.1+build.10|0.16.10|0.92.9+1.20.1
1.20.4|17|1.20.4+build.3|0.16.10|0.97.3+1.20.4
1.20.6|21|1.20.6+build.3|0.16.10|0.100.8+1.20.6
1.21|21|1.21+build.9|0.16.10|0.102.0+1.21
1.21.1|21|1.21.1+build.3|0.16.10|0.116.12+1.21.1
1.21.4|21|1.21.4+build.8|0.16.10|0.119.4+1.21.4
1.21.5|21|1.21.5+build.1|0.16.10|0.128.2+1.21.5
1.21.11|21|1.21.11+build.6|0.16.10|0.141.4+1.21.11
EOF

# === Args : filtrer les versions à builder ===
TARGETS=("$@")
should_build() {
    local mc=$1
    [ ${#TARGETS[@]} -eq 0 ] && return 0
    for t in "${TARGETS[@]}"; do
        [ "$t" = "$mc" ] && return 0
    done
    return 1
}

# === Backup gradle.properties original ===
BACKUP=$(mktemp -t mc-capture-build-XXXXXX.properties)
cp gradle.properties "$BACKUP"
trap 'cp "$BACKUP" gradle.properties; rm -f "$BACKUP"; echo "(gradle.properties restauré)"' EXIT

MOD_VERSION=$(grep '^mod_version=' gradle.properties | cut -d= -f2)
DIST=dist
mkdir -p "$DIST"

PASSED=()
FAILED=()
SKIPPED=()

while IFS='|' read -r MC JAVA YARN LOADER FABRIC; do
    [ -z "$MC" ] && continue

    if ! should_build "$MC"; then
        SKIPPED+=("$MC")
        continue
    fi

    OUT="$DIST/mc-capture-${MOD_VERSION}-mc${MC}.jar"
    if [ -f "$OUT" ]; then
        # Skip si déjà buildé (utile pour reprises après un build partiel échoué)
        echo "[$MC] déjà présent dans $DIST/ → skip (supprimer le jar pour rebuild)"
        PASSED+=("$MC")
        continue
    fi

    echo ""
    echo "=========================================="
    echo "  Build MC $MC (Java $JAVA)"
    echo "=========================================="
    cat > gradle.properties <<EOF
org.gradle.jvmargs=-Xmx2G
minecraft_version=$MC
yarn_mappings=$YARN
loader_version=$LOADER
fabric_version=$FABRIC
mod_version=$MOD_VERSION
maven_group=org.omen.capture
archives_base_name=mc-capture
EOF

    # Clean build/libs pour éviter de copier un jar d'une autre version
    rm -rf build/libs

    if ./gradlew build -Pjava_version="$JAVA" --no-daemon --warning-mode none 2>&1 | tail -25; then
        BUILT_JAR=$(ls build/libs/mc-capture-${MOD_VERSION}.jar 2>/dev/null | head -1)
        if [ -n "$BUILT_JAR" ] && [ -f "$BUILT_JAR" ]; then
            cp "$BUILT_JAR" "$OUT"
            echo "[$MC] ✓ produit → $OUT"
            PASSED+=("$MC")
        else
            echo "[$MC] ✗ build OK mais jar introuvable dans build/libs/"
            FAILED+=("$MC (jar manquant)")
        fi
    else
        echo "[$MC] ✗ gradlew build échoué"
        FAILED+=("$MC (gradlew)")
    fi

done <<< "$VERSION_MATRIX"

echo ""
echo "=========================================="
echo "  RÉSUMÉ"
echo "=========================================="
echo "Réussis    (${#PASSED[@]}) : ${PASSED[*]:-—}"
echo "Échoués    (${#FAILED[@]}) : ${FAILED[*]:-—}"
echo "Non ciblés (${#SKIPPED[@]}) : ${SKIPPED[*]:-—}"
echo ""
echo "Jars dispos :"
ls -lh "$DIST"/*.jar 2>/dev/null | awk '{print "  " $9 "  " $5}'

[ ${#FAILED[@]} -eq 0 ]
