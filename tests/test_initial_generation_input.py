from html.parser import HTMLParser
from pathlib import Path
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class ElementTextParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.targets = {"textInput": {"attrs": {}, "text": []}, "originalSentence": {"attrs": {}, "text": []}}
        self.active_target = None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        element_id = attributes.get("id")
        if element_id in self.targets:
            self.active_target = element_id
            self.targets[element_id]["attrs"] = attributes

    def handle_endtag(self, tag):
        if self.active_target is not None:
            self.active_target = None

    def handle_data(self, data):
        if self.active_target is not None:
            self.targets[self.active_target]["text"].append(data)


class InitialGenerationInputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        parser = ElementTextParser()
        parser.feed((PROJECT_ROOT / "index.html").read_text(encoding="utf-8"))
        cls.elements = parser.targets

    def test_generation_input_starts_empty_with_prompt(self):
        text_input = self.elements["textInput"]
        self.assertEqual("".join(text_input["text"]).strip(), "")
        self.assertEqual(text_input["attrs"].get("placeholder"), "請輸入中文句子…")

    def test_original_sentence_starts_empty(self):
        original_sentence = self.elements["originalSentence"]
        self.assertEqual("".join(original_sentence["text"]).strip(), "")


if __name__ == "__main__":
    unittest.main()
