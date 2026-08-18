"""Translation evaluation against corpus reference glosses."""

from signavatar.evaluate import evaluate_pairs, gloss_f1


def test_gloss_f1_exact():
    p, r, f = gloss_f1(["我", "聽"], ["我", "聽"])
    assert (p, r, f) == (1.0, 1.0, 1.0)


def test_gloss_f1_partial():
    p, r, f = gloss_f1(["我", "聽", "多"], ["我", "聽", "沒辦法"])
    assert p == 2 / 3
    assert r == 2 / 3


def test_gloss_f1_empty_prediction():
    p, r, f = gloss_f1([], ["我"])
    assert (p, r, f) == (0.0, 0.0, 0.0)


def test_evaluate_pairs_reports_metrics():
    pairs = [
        {"text": "我聽不到", "glosses": ["我", "聽", "沒辦法"], "source": "moc:X"},
        {"text": "你好", "glosses": ["你", "好"], "source": "moc:X"},
    ]
    vocab = {"我", "聽", "沒辦法", "你", "好"}

    def fake_translate(text):
        return ["我", "聽", "沒辦法"] if "聽" in text else ["你"]

    report = evaluate_pairs(pairs, vocab, fake_translate)
    assert report["n"] == 2
    assert report["exact"] == 0.5  # first sentence perfect, second not
    assert 0.5 < report["f1"] < 1.0
    assert report["worst"][0]["text"] == "你好"


def test_evaluate_pairs_skips_oov_references():
    # reference gloss outside vocab → sentence excluded (can't be produced)
    pairs = [{"text": "x", "glosses": ["外星詞"], "source": "moc:X"}]
    report = evaluate_pairs(pairs, {"我"}, lambda t: [])
    assert report["n"] == 0
