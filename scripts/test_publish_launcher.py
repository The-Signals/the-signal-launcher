import base64
import json
import tempfile
import unittest
from pathlib import Path
from publish_launcher import check_signature_key, prepare_release


def encoded_signature(key_id):
    # Synthetic fixtures test parsing/key consistency only, not cryptography.
    signature = base64.b64encode(b"ED" + key_id + bytes(64)).decode()
    global_signature = base64.b64encode(bytes(64)).decode()
    text = f"untrusted comment: fixture\n{signature}\ntrusted comment: timestamp:0\tversion:0.1.2\n{global_signature}\n"
    return base64.b64encode(text.encode()).decode()


class LauncherPublishingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.key_id = b"12345678"
        public = base64.b64encode(b"Ed" + self.key_id + bytes(32)).decode()
        self.pubkey = base64.b64encode(f"untrusted comment: fixture\n{public}\n".encode()).decode()
        self.signature = encoded_signature(self.key_id)
        self.config = {"version": "0.1.2", "plugins": {"updater": {"pubkey": self.pubkey,
                       "endpoints": ["https://github.com/owner/launcher/releases/latest/download/latest.json"]}}}
        self.installer = self.root / "The Signal Launcher_0.1.2_x64-setup.exe"
        self.installer.write_bytes(b"MZfixture")
        Path(str(self.installer) + ".sig").write_text(self.signature)

    def prepare(self):
        return prepare_release(self.installer, self.config, "owner/launcher", "Notes", self.root / "output")

    def test_prepares_separate_updater_manifest_and_three_public_assets(self):
        version, assets = self.prepare()
        self.assertEqual(version, "0.1.2")
        self.assertEqual(len(assets), 3)
        manifest = json.loads(assets[-1].read_text())
        self.assertEqual(manifest["platforms"]["windows-x86_64"]["signature"], self.signature)
        self.assertIn("owner/launcher/releases/download/v0.1.2/", manifest["platforms"]["windows-x86_64"]["url"])
        self.assertNotIn("schema_version", manifest)
        first = assets[-1].read_bytes()
        self.prepare()
        self.assertEqual(first, assets[-1].read_bytes())

    def test_rejects_signature_from_other_key(self):
        with self.assertRaises(ValueError): check_signature_key(encoded_signature(b"different"[:8]), self.pubkey)

    def test_rejects_missing_signature_and_wrong_feed(self):
        Path(str(self.installer) + ".sig").unlink()
        with self.assertRaises(ValueError): self.prepare()
        Path(str(self.installer) + ".sig").write_text(self.signature)
        self.config["plugins"]["updater"]["endpoints"] = ["https://example.com/latest.json"]
        with self.assertRaises(ValueError): self.prepare()

    def test_rejects_invalid_signature_format(self):
        with self.assertRaises(ValueError): check_signature_key("bad signature", self.pubkey)

    def test_rejects_signature_announcing_different_version(self):
        with self.assertRaises(ValueError): check_signature_key(self.signature, self.pubkey, "0.1.3")


if __name__ == "__main__":
    unittest.main()
