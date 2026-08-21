from pathlib import Path
import site
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]


class RuntimeIndependenceTests(unittest.TestCase):
    def test_user_site_is_disabled(self):
        self.assertFalse(site.ENABLE_USER_SITE)
        self.assertNotIn(str(Path.home() / ".local"), "\n".join(sys.path))

    def test_inference_dependencies_load_from_0813(self):
        import accelerate
        import bitsandbytes
        import peft
        import scipy
        import sklearn
        import soxr
        import torch
        import transformers

        for module in [
            accelerate,
            bitsandbytes,
            peft,
            scipy,
            sklearn,
            soxr,
            torch,
            transformers,
        ]:
            module_path = Path(module.__file__).resolve()
            with self.subTest(module=module.__name__, path=str(module_path)):
                self.assertTrue(module_path.is_relative_to(ROOT), module_path)

    def test_model_service_validates_context_defensively(self):
        source = (ROOT / "model_service/scripts/serve_model.py").read_text(encoding="utf-8")
        self.assertIn("context must be a string", source)
        self.assertIn("1000", source)


if __name__ == "__main__":
    unittest.main()
