from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class LifecycleScriptTests(unittest.TestCase):
    def read_script(self, name):
        path = ROOT / name
        self.assertTrue(path.is_file(), f"{name} must exist")
        return path.read_text(encoding="utf-8")

    def test_start_script_is_idempotent_and_uses_0813_ports(self):
        text = self.read_script("start_0813.sh")
        self.assertIn("kill -0", text)
        self.assertIn("8083", text)
        self.assertIn("8877", text)
        self.assertIn("bundle_server.py", text)
        self.assertIn("/health", text)
        self.assertIn("flock", text)
        self.assertIn("9>&-", text)
        self.assertIn("PYTHONNOUSERSITE", text)
        self.assertNotIn('HOST="${HOST:-', text)

    def test_stop_script_validates_process_ownership(self):
        text = self.read_script("stop_0813.sh")
        self.assertIn("/proc/", text)
        self.assertIn("cmdline", text)
        self.assertIn("bundle_server.py", text)
        self.assertNotIn("pkill -f", text)

    def test_health_script_fails_on_non_200(self):
        text = self.read_script("health_0813.sh")
        self.assertIn("%{http_code}", text)
        self.assertIn('"200"', text)

    def test_runtime_files_do_not_reference_old_projects(self):
        runtime_files = [
            ROOT / "bundle_server.py",
            ROOT / "start_0813.sh",
            ROOT / "stop_0813.sh",
            ROOT / "health_0813.sh",
        ]
        combined = "\n".join(
            path.read_text(encoding="utf-8") for path in runtime_files if path.exists()
        )
        self.assertNotIn("/home/b310ai/0812", combined)
        self.assertNotIn("/home/b310ai/0812new", combined)
        self.assertNotIn("tku-tsl-text-to-gloss", combined)
        self.assertNotIn(".cache/huggingface", combined)


if __name__ == "__main__":
    unittest.main()
