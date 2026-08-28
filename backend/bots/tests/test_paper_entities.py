"""Tests de la détection d'entreprises (module PUR) — 100 % hors ligne.

Aucune I/O, aucun réseau : ``detect_companies`` ne voit qu'un titre et, quand
l'appelant lui en donne, les noms des titres détenus ou suivis.
"""
from backend.bots.paper import entities


# --------------------------------------------------------------------------- #
# La table livrée
# --------------------------------------------------------------------------- #

def test_le_cas_de_reference_une_entreprise_citee_dans_un_titre_politique():
    """Le cas que l'utilisateur a décrit : la dépêche parle de politique, mais
    elle nomme un titre — et c'est ce titre qui doit ressortir."""
    assert entities.detect_companies(
        "L'administration Trump veut acheter des cartes graphiques à Nvidia"
    ) == ["NVDA"]


def test_le_nom_est_reconnu_en_mot_entier_pas_en_sous_chaine():
    """« meta » ne doit pas se déclencher sur « metadata » — c'est l'esprit du
    piège #31 : un rapprochement approximatif est pire que pas de
    rapprochement."""
    assert entities.detect_companies("A new metadata standard lands") == []
    assert entities.detect_companies("Meta announces layoffs") == ["META"]


def test_un_ticker_court_ne_se_declenche_pas_a_l_interieur_d_un_mot():
    assert entities.detect_companies("the subsidiary was sold to a rival") == []
    assert entities.detect_companies("UBS raises its target") == ["UBSG.SW"]


def test_le_nom_accentue_est_reconnu_dans_ses_deux_ecritures():
    assert entities.detect_companies("Nestlé beats estimates") == ["NESN.SW"]
    assert entities.detect_companies("Nestle beats estimates") == ["NESN.SW"]


def test_un_nom_compose_est_reconnu_entier():
    assert entities.detect_companies("General Motors recalls 400k trucks") == ["GM"]


def test_une_apostrophe_ou_un_point_ne_casse_pas_la_reconnaissance():
    assert entities.detect_companies("McDonald's raises prices") == ["MCD"]
    assert entities.detect_companies("J.P. Morgan cuts its forecast") == ["JPM"]


def test_deux_noms_pointant_le_meme_titre_ne_le_rendent_qu_une_fois():
    assert entities.detect_companies("Alphabet, la maison mère de Google") == ["GOOGL"]


def test_un_titre_sans_entreprise_connue_ne_rend_rien():
    assert entities.detect_companies("Le gouvernement relève ses prévisions") == []
    assert entities.detect_companies("") == []
    assert entities.detect_companies(None) == []


# --------------------------------------------------------------------------- #
# Ordre et plafond
# --------------------------------------------------------------------------- #

def test_l_ordre_est_celui_du_titre_pas_celui_de_la_table():
    """La première entreprise citée est celle dont le titre parle."""
    assert entities.detect_companies("Tesla and Apple both fall") == ["TSLA", "AAPL"]
    assert entities.detect_companies("Apple and Tesla both fall") == ["AAPL", "TSLA"]


def test_au_plus_trois_symboles_par_titre():
    found = entities.detect_companies(
        "Nvidia, Intel, AMD, Broadcom and Qualcomm all rally")
    assert found == ["NVDA", "INTC", "AMD"]
    assert len(found) == entities.MAX_PER_TITLE


def test_deux_appels_rendent_exactement_la_meme_liste():
    title = "General Motors, Ford and Tesla all warn"
    assert entities.detect_companies(title) == entities.detect_companies(title)


# --------------------------------------------------------------------------- #
# Les ancres de l'utilisateur — prioritaires
# --------------------------------------------------------------------------- #

def test_une_ancre_de_l_utilisateur_prime_sur_la_table_livree():
    """Quelqu'un qui suit Apple sur une AUTRE place doit voir SON symbole."""
    extra = entities.anchor_index([{"symbol": "AAPL.SW", "name": "Apple"}])
    assert entities.detect_companies("Apple beats estimates", extra) == ["AAPL.SW"]
    # Sans ancre, la table livrée reprend la main.
    assert entities.detect_companies("Apple beats estimates") == ["AAPL"]


def test_une_ancre_inconnue_de_la_table_est_reconnue_par_son_nom():
    extra = entities.anchor_index([{"symbol": "SREN.SW", "name": "Swiss Re AG"}])
    assert entities.detect_companies("Swiss Re relève son dividende", extra) \
        == ["SREN.SW"]


def test_un_extra_mal_forme_est_ignore_sans_planter():
    for bad in (None, [], "pas un dict", {"": "AAPL"}, {"ap": "AAPL"},
                {"apple": ""}):
        assert entities.detect_companies("Nvidia gagne", bad) == ["NVDA"]


# --------------------------------------------------------------------------- #
# anchor_index / strip_legal_suffix
# --------------------------------------------------------------------------- #

def test_anchor_index_ecrit_le_nom_et_le_nom_sans_forme_juridique():
    index = entities.anchor_index([{"symbol": "GOOGL", "name": "Alphabet Inc."}])
    assert index["alphabet inc."] == "GOOGL"
    assert index["alphabet"] == "GOOGL"


def test_anchor_index_ecrit_le_symbole_quand_il_est_assez_long():
    """Une POSITION ne porte pas de nom : sans la clé du symbole, un titre
    détenu ne serait reconnaissable par rien."""
    index = entities.anchor_index([{"symbol": "NESN.SW"}])
    assert index == {"nesn.sw": "NESN.SW"}


def test_anchor_index_refuse_un_ticker_trop_court():
    """« F », « GM », « KO » redeviennent des mots ordinaires en minuscules —
    les laisser entrer étiquetterait la moitié des titres."""
    assert entities.anchor_index([{"symbol": "F"}, {"symbol": "GM"}]) == {}


def test_anchor_index_ignore_un_nom_qui_recopie_le_ticker():
    index = entities.anchor_index([{"symbol": "AAPL", "name": "aapl"}])
    assert index == {"aapl": "AAPL"}


def test_anchor_index_est_tolerant_a_l_entree():
    assert entities.anchor_index(None) == {}
    assert entities.anchor_index("pas une liste") == {}
    assert entities.anchor_index([None, 42, {"name": "sans symbole"}]) == {}


def test_strip_legal_suffix_retire_les_formes_juridiques_en_fin():
    assert entities.strip_legal_suffix("Roche Holding AG") == "roche"
    assert entities.strip_legal_suffix("Coca-Cola Co") == "coca-cola"
    assert entities.strip_legal_suffix("Bank of America Corp") == "bank of america"


def test_strip_legal_suffix_ne_vide_jamais_un_nom():
    """Un nom qui ne serait fait QUE de ces mots-là ressort inchangé plutôt que
    de disparaître."""
    assert entities.strip_legal_suffix("Inc") == "inc"
    assert entities.strip_legal_suffix("") == ""


def test_first_company_rend_le_premier_ou_none():
    assert entities.first_company("Tesla and Apple both fall") == "TSLA"
    assert entities.first_company("rien de connu ici") is None


# --------------------------------------------------------------------------- #
# W2a — la presse MONDIALE : le module ne lit pas la langue, il lit les NOMS
#
# C'est ce qui rend le volet « presse financière mondiale » possible sans écrire
# une ligne de plus ici : une entreprise s'appelle pareil en allemand, en
# anglais et en italien. La TONALITÉ, elle, reste calibrée EN/FR/IT
# (``newswatch.classify``) — un titre allemand entre en « neutre » plutôt
# qu'avec une couleur inventée.
# --------------------------------------------------------------------------- #

def test_un_titre_ALLEMAND_est_symbolise_comme_les_autres():
    assert entities.detect_companies(
        "Nestlé kündigt Milliarden-Rückkauf an") == ["NESN.SW"]
    assert entities.detect_companies(
        "Handelsblatt: Siemens und SAP im Fokus, Nvidia legt zu") == ["NVDA"]


def test_un_titre_ANGLAIS_BRITANNIQUE_ou_INDIEN_passe_aussi():
    assert entities.first_company(
        "BBC: Boeing wins a defence contract") == "BA"
    assert entities.first_company(
        "Economic Times: TSMC lifts capex guidance") == "TSM"


def test_la_langue_ne_change_JAMAIS_le_symbole_rendu():
    """Le même fait, dans quatre langues, doit rendre exactement le même
    ticker — sinon la mémoire d'un titre se scinderait par langue de source."""
    faits = [
        "Nestlé beats estimates",
        "Nestlé dépasse les attentes",
        "Nestlé übertrifft die Erwartungen",
        "Nestlé supera le attese",
    ]
    assert {entities.first_company(f) for f in faits} == {"NESN.SW"}


def test_une_ancre_de_l_utilisateur_prime_meme_sur_un_titre_etranger():
    """Si quelqu'un suit « Apple » sur une autre place, c'est SON symbole qui
    doit sortir — quelle que soit la langue de la dépêche."""
    anchors = entities.anchor_index([{"symbol": "APC.DE", "name": "Apple Inc."}])
    assert entities.first_company("Apple legt in Frankfurt zu",
                                  anchors) == "APC.DE"


# --------------------------------------------------------------------------- #
# known_symbols — l'accès PUBLIC à la table (LOT 3, A3)
# --------------------------------------------------------------------------- #

def test_known_symbols_contains_the_reference_tickers():
    symbols = entities.known_symbols()
    assert "NVDA" in symbols and "NESN.SW" in symbols


def test_known_symbols_has_no_duplicate_even_though_several_names_share_a_ticker():
    # "alphabet" et "google" pointent tous deux GOOGL dans la table -- il ne
    # doit ressortir qu'UNE fois.
    symbols = entities.known_symbols()
    assert symbols.count("GOOGL") == 1
    assert len(symbols) == len(set(symbols))


def test_known_symbols_is_a_tuple_not_the_mutable_source_table():
    assert isinstance(entities.known_symbols(), tuple)
