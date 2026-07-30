"""Traduction des titres étrangers — « on ne sait pas lire du chinois ».

La presse LOCALE de chaque place est un choix de conception : Tokyo est couvert
par des sources japonaises, Shanghai par des sources chinoises. Le prix à payer
est que le lecteur reçoit des titres qu'il ne peut pas lire.

Trois principes, tous testés ici :

1. **Le titre d'origine n'est JAMAIS écrasé.** Une traduction est une
   transformation : elle s'ajoute (`title_display`), elle ne remplace pas le
   fait. Le lecteur doit pouvoir vérifier.
2. **Sans traduction, on affiche l'original et on le DIT** (`needs_translation`
   reste vrai). Masquer une news parce qu'on n'a pas su la traduire ferait
   sortir une section vide qui a l'air normale.
3. **Le filtre anti-conseil tourne AUSSI sur la traduction.** `is_advice` ne
   connaît que l'italien et l'anglais : un titre chinois qui dit « 5 actions à
   acheter » passe la collecte sans encombre et ne se révèle qu'une fois
   traduit. C'est le dernier endroit où on peut l'arrêter.
"""
from pulse.translate import (apply, base_lang, build_prompt, parse_response,
                             to_translate)


def _item(title, lang, source="Fonte"):
    return {"title": title, "lang": lang, "source": source,
            "url": "https://example.test/x", "published": 1785412800}


# --------------------------------------------------------------------------
# Quelle langue, au juste
# --------------------------------------------------------------------------

def test_a_regional_variant_counts_as_its_language():
    # Les flux rendent « zh-Hant », « de-CH », « pt-BR » : comparer les chaînes
    # entières ferait traduire de l'allemand vers de l'allemand.
    assert base_lang("zh-Hant") == "zh"
    assert base_lang("de-CH") == "de"
    assert base_lang("pt-BR") == "pt"
    assert base_lang("IT") == "it"
    assert base_lang(None) == ""


def test_only_the_foreign_titles_are_sent():
    items = [_item("Piazza Affari apre in rialzo", "it"),
             _item("Nikkei rises on chip demand", "en"),
             _item("日経平均は上昇", "ja")]
    pairs = to_translate(items, "it")
    assert [i for i, _t in pairs] == [1, 2]


def test_nothing_is_sent_when_everything_is_already_in_the_target_language():
    items = [_item("Piazza Affari apre in rialzo", "it"),
             _item("Terna alza la guidance", "IT")]
    assert to_translate(items, "it") == []


def test_an_item_without_a_language_is_left_alone():
    # Sans langue déclarée, on ne sait pas : traduire au hasard serait pire.
    assert to_translate([_item("Titre sans langue", None)], "it") == []


def test_the_number_of_titles_sent_is_bounded():
    items = [_item("t%d" % n, "ja") for n in range(40)]
    assert len(to_translate(items, "it", max_items=14)) == 14


# --------------------------------------------------------------------------
# Le prompt
# --------------------------------------------------------------------------

def test_the_prompt_names_the_target_language_and_numbers_the_titles():
    prompt = build_prompt([(1, "Nikkei rises"), (2, "日経平均は上昇")], "it")
    assert "italiano" in prompt.lower()
    assert "1" in prompt and "2" in prompt
    assert "Nikkei rises" in prompt


def test_the_prompt_forbids_embellishing_the_headline():
    prompt = build_prompt([(0, "x")], "it").lower()
    # Un titre traduit doit rester un titre : ni résumé, ni commentaire.
    assert "non aggiungere" in prompt or "nessun commento" in prompt


def test_the_prompt_knows_french_and_english_too():
    assert "francese" in build_prompt([(0, "x")], "fr").lower()
    assert "inglese" in build_prompt([(0, "x")], "en").lower()


# --------------------------------------------------------------------------
# La réponse
# --------------------------------------------------------------------------

def test_the_response_is_read_whatever_the_key_type():
    assert parse_response({"traduzioni": {"1": "Il Nikkei sale"}}) == {1: "Il Nikkei sale"}
    assert parse_response({"traduzioni": {2: "Il Nikkei sale"}}) == {2: "Il Nikkei sale"}


def test_a_response_without_translations_is_an_empty_mapping_not_a_crash():
    assert parse_response({"synthesis": "..."}) == {}
    assert parse_response(None) == {}
    assert parse_response("pas un objet") == {}


def test_a_non_numeric_key_is_ignored():
    assert parse_response({"traduzioni": {"titolo": "x", "3": "ok"}}) == {3: "ok"}


def test_an_empty_translation_is_ignored():
    assert parse_response({"traduzioni": {"1": "   ", "2": "vero"}}) == {2: "vero"}


# --------------------------------------------------------------------------
# L'application
# --------------------------------------------------------------------------

def test_the_original_title_is_never_overwritten():
    items = [_item("日経平均は上昇", "ja")]
    kept, stats = apply(items, {0: "Il Nikkei sale"}, "it")
    assert kept[0]["title"] == "日経平均は上昇"
    assert kept[0]["title_display"] == "Il Nikkei sale"
    assert kept[0]["translated"] is True
    assert stats["translated"] == 1


def test_a_title_already_in_the_target_language_displays_itself():
    items = [_item("Piazza Affari apre in rialzo", "it")]
    kept, _stats = apply(items, {}, "it")
    assert kept[0]["title_display"] == "Piazza Affari apre in rialzo"
    assert kept[0]["translated"] is False
    assert kept[0]["needs_translation"] is False


def test_an_untranslated_foreign_title_is_SHOWN_and_flagged():
    """Le LLM n'a pas répondu : on garde le fait et on le dit.

    Masquer la news ferait sortir une section presque vide sans qu'on sache
    pourquoi — le défaut que ce projet a payé le plus cher.
    """
    items = [_item("日経平均は上昇", "ja")]
    kept, stats = apply(items, {}, "it")
    assert len(kept) == 1
    assert kept[0]["title_display"] == "日経平均は上昇"
    assert kept[0]["needs_translation"] is True
    assert kept[0]["translated"] is False
    assert stats["untranslated"] == 1


def test_a_translation_that_turns_out_to_be_ADVICE_is_dropped():
    """`is_advice` ne connaît que l'italien et l'anglais.

    Un titre chinois qui dit « les 5 actions à acheter » traverse la collecte
    sans encombre. La traduction est le dernier endroit où on peut l'arrêter.
    """
    items = [_item("买入五只股票", "zh"), _item("上海指数收盘", "zh")]
    kept, stats = apply(items, {0: "Le 5 azioni da comprare adesso",
                                1: "L'indice di Shanghai chiude in calo"}, "it")
    assert [i["title_display"] for i in kept] == ["L'indice di Shanghai chiude in calo"]
    assert stats["dropped_advice"] == 1


def test_a_translation_for_an_index_that_does_not_exist_is_ignored():
    items = [_item("日経平均は上昇", "ja")]
    kept, _stats = apply(items, {0: "Il Nikkei sale", 99: "fantôme"}, "it")
    assert len(kept) == 1


def test_apply_tolerates_an_empty_list():
    kept, stats = apply([], {}, "it")
    assert kept == []
    assert stats["translated"] == 0


def test_apply_never_mutates_the_caller_list():
    items = [_item("日経平均は上昇", "ja")]
    apply(items, {0: "Il Nikkei sale"}, "it")
    assert "title_display" not in items[0], "la liste d'origine a été modifiée"
