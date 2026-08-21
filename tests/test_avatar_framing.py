from pathlib import Path
import re
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class AvatarFramingTests(unittest.TestCase):
    def test_desktop_camera_is_closer_without_over_zooming(self):
        bridge = (PROJECT_ROOT / "signavatar-bridge.js").read_text(encoding="utf-8-sig")
        match = re.search(r"const camera = \{ yaw: 0, pitch: 0\.03, dist: ([0-9.]+) \};", bridge)
        self.assertIsNotNone(match)
        distance = float(match.group(1))
        self.assertEqual(distance, 1.4)
        self.assertGreaterEqual(distance, 1.35)

    def test_camera_target_reduces_excess_headroom(self):
        avatar = (PROJECT_ROOT / "avatar3d.js").read_text(encoding="utf-8")
        self.assertIn("const HEAD_TARGET_BLEND = 0.58;", avatar)
        self.assertIn("TARGET.set(0, hips.y + (head.y - hips.y) * HEAD_TARGET_BLEND, 0);", avatar)

    def test_narrow_stages_pull_camera_back_for_hand_safety(self):
        avatar = (PROJECT_ROOT / "avatar3d.js").read_text(encoding="utf-8")
        self.assertIn("const SAFE_STAGE_ASPECT = 1.6;", avatar)
        self.assertIn(
            "Math.max(1, SAFE_STAGE_ASPECT / Math.max(cam.aspect, 0.01))",
            avatar,
        )

    def test_avatar_scripts_share_one_cache_version(self):
        """The three avatar scripts must carry the SAME ?v= tag.

        This used to assert a hardcoded version string, which meant the test
        failed on every cache bump and had to be hand-synced — so it reported
        a routine version change as a breakage. What actually matters is that
        the scripts agree: avatar3d, composer and signavatar-bridge are
        released together, and a mismatch means a browser can pair new code
        with a cached old counterpart. That is the real defect, and it is what
        is checked here. The tags are also compared across the pages that load
        them, for the same reason.
        """
        scripts = ("avatar3d.js", "composer.js", "signavatar-bridge.js")
        pages = ("index.html", "viewer.html", "generate.html")
        seen = {}
        for page in pages:
            path = PROJECT_ROOT / page
            if not path.exists():
                continue
            text = path.read_text(encoding="utf-8")
            for script in scripts:
                found = re.findall(
                    rf'src="{re.escape(script)}\?v=([^"]+)"', text
                )
                for version in found:
                    seen[f"{page}:{script}"] = version

        self.assertTrue(seen, "no versioned avatar script tags found")
        versions = set(seen.values())
        self.assertEqual(
            len(versions),
            1,
            f"avatar script cache tags disagree: {seen}",
        )
        self.assertTrue(
            next(iter(versions)).strip(),
            "cache tag is present but empty",
        )


if __name__ == "__main__":
    unittest.main()
