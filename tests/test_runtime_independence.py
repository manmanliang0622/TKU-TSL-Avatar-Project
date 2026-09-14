from pathlib import Path
import site
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]

# 這組測的是「部署在學校主機上的 bundle 自成一格」：推論套件從 bundle 自己的
# .venv 載入、不吃使用者目錄的 site-packages、模型服務在旁邊。開發機的 repo
# 沒有 model_service/（模型與 checkpoint 只在學校主機），也不該為了跑測試裝
# torch —— 在那裡跑只會把「環境不同」誤報成壞掉。
IN_DEPLOYED_BUNDLE = (
    (ROOT / "model_service/scripts/serve_model.py").is_file()
    and Path(sys.prefix).resolve() == (ROOT / ".venv").resolve()
)


@unittest.skipUnless(
    IN_DEPLOYED_BUNDLE,
    "只在學校主機的 bundle 目錄、用它自己的 .venv 執行才有意義"
    "（例：cd ~/0821_bundle && .venv/bin/python3 -m unittest tests.test_runtime_independence）",
)
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
