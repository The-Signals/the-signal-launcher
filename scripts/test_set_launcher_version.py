import json
import tempfile
import tomllib
import unittest
from pathlib import Path
from set_launcher_version import set_version


class VersionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root / "src-tauri").mkdir()
        fixtures = {
            "package.json": '{"version": "0.1.2"}',
            "package-lock.json": '{"version": "0.1.3", "packages": {"": {"version": "0.1.1"}, "dependency": {"version": "0.1.2"}}}',
            "src-tauri/tauri.conf.json": '{"version": "0.1.0", "plugins": {"updater": {"pubkey": "unchanged"}}}',
            "src-tauri/Cargo.toml": '[package]\nname = "the-signal-launcher"\nversion = "0.1.2"\n\n[dependencies.fixture]\nversion = "0.1.2"\n',
            "src-tauri/Cargo.lock": 'version = 4\n\n[[package]]\nname = "fixture"\nversion = "0.1.2"\n\n[[package]]\nname = "the-signal-launcher"\nversion = "0.1.3"\n',
        }
        for name, content in fixtures.items():
            (self.root / name).write_text(content, encoding="utf-8")

    def test_applies_input_to_all_versions_without_changing_dependencies_or_key(self):
        set_version(self.root, "0.1.4")
        for name in ("package.json", "package-lock.json", "src-tauri/tauri.conf.json"):
            self.assertEqual(json.loads((self.root / name).read_text())["version"], "0.1.4")
        npm = json.loads((self.root / "package-lock.json").read_text())
        self.assertEqual(npm["packages"][""]["version"], "0.1.4")
        self.assertEqual(npm["packages"]["dependency"]["version"], "0.1.2")
        cargo = tomllib.loads((self.root / "src-tauri/Cargo.toml").read_text())
        self.assertEqual(cargo["package"]["version"], "0.1.4")
        self.assertEqual(cargo["dependencies"]["fixture"]["version"], "0.1.2")
        packages = tomllib.loads((self.root / "src-tauri/Cargo.lock").read_text())["package"]
        self.assertEqual([p["version"] for p in packages], ["0.1.2", "0.1.4"])
        config = json.loads((self.root / "src-tauri/tauri.conf.json").read_text())
        self.assertEqual(config["plugins"]["updater"]["pubkey"], "unchanged")

    def test_accepts_prerelease_versions_and_repeat_application(self):
        set_version(self.root, "0.2.0-beta.1")
        set_version(self.root, "0.2.0-beta.1")
        self.assertEqual(json.loads((self.root / "package.json").read_text())["version"], "0.2.0-beta.1")

    def test_invalid_version_does_not_modify_files(self):
        path = self.root / "package.json"
        before = path.read_bytes()
        with self.assertRaises(ValueError):
            set_version(self.root, "bad-version")
        self.assertEqual(path.read_bytes(), before)

    def test_missing_cargo_version_does_not_partially_update_json(self):
        path = self.root / "package.json"
        before = path.read_bytes()
        (self.root / "src-tauri/Cargo.lock").write_text('version = 4\n')
        with self.assertRaises(ValueError):
            set_version(self.root, "0.1.4")
        self.assertEqual(path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
