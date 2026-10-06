import hashlib
import io
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch, Mock
from publish import package, publish, safe_path, load_package, upload_asset, UploadProgress

DRAFT = json.dumps({"draft": True, "upload_url": "https://uploads.github.com/repos/owner/repo/releases/1/assets{?name,label}", "assets": []})
SUMMARY = '{"databaseId": 1, "isDraft": true}'


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.build = self.root / "build"
        self.build.mkdir()
        (self.build / "The-Signal.exe").write_bytes(b"exe")
        (self.build / "UnityPlayer.dll").write_bytes(b"dll")
        (self.build / "The-Signal_Data").mkdir()
        (self.build / "The-Signal_Data" / "data").write_bytes(b"data")

    def package(self, **kwargs):
        args = dict(build=self.build, executable="The-Signal.exe", version="0.1.0", notes="Notes", repository="ZiiMs/the-signal", output=self.root / "output")
        args.update(kwargs)
        return package(**args)

    def test_manifest_matches_zip_and_excludes_development_files(self):
        (self.build / "steam_appid.txt").write_text("dev")
        debug = self.build / "The-Signal_BackUpThisFolder_ButDontShipItWithYourGame"
        debug.mkdir()
        (debug / "secret").write_text("debug")
        archive, manifest_path = self.package()
        manifest = json.loads(manifest_path.read_text())
        self.assertEqual(manifest["sha256"], hashlib.sha256(archive.read_bytes()).hexdigest())
        self.assertEqual(manifest["size"], archive.stat().st_size)
        with zipfile.ZipFile(archive) as zipped:
            self.assertEqual(manifest["unpacked_size"], sum(i.file_size for i in zipped.infolist()))
            self.assertEqual(len(zipped.namelist()), 3)

    def test_refuses_source_and_nested_output(self):
        with self.assertRaises(ValueError): self.package(output=self.build / "output")
        (self.build / "Assets").mkdir()
        with self.assertRaises(ValueError): self.package()

    def test_refuses_invalid_versions_and_overwrite(self):
        with self.assertRaises(ValueError): self.package(version="../oops")
        self.package()
        with self.assertRaises(ValueError): self.package()

    def test_reuses_existing_package_without_modifying_it(self):
        archive, manifest = self.package()
        before = (archive.read_bytes(), manifest.read_bytes())
        result = load_package(archive.parent, "ZiiMs/the-signal")
        self.assertEqual(result, (archive, manifest, "0.1.0", "Notes"))
        self.assertEqual(before, (archive.read_bytes(), manifest.read_bytes()))

    def test_existing_package_rejects_changed_zip_and_other_repository(self):
        archive, _manifest = self.package()
        with self.assertRaises(ValueError): load_package(archive.parent, "other/repo")
        data = archive.read_bytes()
        archive.write_bytes(bytes([data[0] ^ 1]) + data[1:])
        with self.assertRaisesRegex(ValueError, "checksum"):
            load_package(archive.parent, "ZiiMs/the-signal")

    def test_retargets_verified_manifest_without_repacking_zip(self):
        archive, manifest = self.package()
        before = archive.read_bytes()
        load_package(archive.parent, "The-Signals/the-signal-data", retarget=True)
        self.assertEqual(archive.read_bytes(), before)
        self.assertIn("The-Signals/the-signal-data/releases/download/", json.loads(manifest.read_text())["url"])

    def test_retarget_does_not_modify_manifest_when_verification_fails(self):
        archive, manifest = self.package()
        before = manifest.read_bytes()
        archive.write_bytes(b"changed")
        with self.assertRaises(ValueError): load_package(archive.parent, "new/repo", retarget=True)
        self.assertEqual(manifest.read_bytes(), before)

    def test_steam_test_is_explicit_and_preserves_only_expected_override(self):
        with self.assertRaises(ValueError): self.package(steam_test=True)
        (self.build / "steam_appid.txt").write_text("480\n")
        (self.build / "LaunchSteamTest.cmd").write_text("test")
        archive, manifest_path = self.package(steam_test=True)
        manifest = json.loads(manifest_path.read_text())
        self.assertEqual(manifest["launch_arguments"], ["--signal-steam-test"])
        with zipfile.ZipFile(archive) as zipped:
            self.assertIn("steam_appid.txt", zipped.namelist())
            self.assertNotIn("LaunchSteamTest.cmd", zipped.namelist())

    def test_steam_test_refuses_other_app_ids(self):
        (self.build / "steam_appid.txt").write_text("12345")
        with self.assertRaises(ValueError): self.package(steam_test=True)

    def test_windows_paths(self):
        for name in ["../x", "C:/x", "NUL.txt", "a/COM1", "a\\b", "a./b", "a//b"]:
            with self.assertRaises(ValueError, msg=name): safe_path(name)

    @patch("publish.gh", return_value='{"isPrivate": true}')
    def test_private_distribution_is_rejected(self, mocked):
        with self.assertRaises(ValueError): publish("owner/repo", "0.1.0", "", Path("a"), Path("b"))
        self.assertEqual(mocked.call_count, 1)

    @patch("publish.gh", return_value='{"isPrivate": false, "isEmpty": true}')
    def test_empty_distribution_requires_initialization(self, mocked):
        with self.assertRaises(ValueError): publish("owner/repo", "0.1.0", "", Path("a"), Path("b"))
        self.assertEqual(mocked.call_count, 1)

    @patch("publish.subprocess.run", return_value=Mock(returncode=1, stderr="HTTP 404"))
    @patch("publish.gh", side_effect=['{"isPrivate": false}', '', SUMMARY, DRAFT, 'secret-token', ''])
    @patch("publish.upload_asset")
    def test_uploads_as_draft_before_promoting_latest(self, upload, mocked, _run):
        url = publish("owner/repo", "0.1.0", "Notes", Path("game.zip"), Path("manifest.json"))
        create = mocked.call_args_list[1].args
        promote = mocked.call_args_list[-1].args
        self.assertIn("--draft", create)
        self.assertNotIn("game.zip", create)
        self.assertEqual([call.args[1] for call in upload.call_args_list], [Path("game.zip"), Path("manifest.json")])
        self.assertIn("--draft=false", promote)
        self.assertIn("--latest", promote)
        self.assertEqual(url, "https://github.com/owner/repo/releases/tag/v0.1.0")

    @patch("publish.subprocess.run", return_value=Mock(returncode=1, stderr="HTTP 404"))
    @patch("publish.gh", side_effect=['{"isPrivate": false}', '', SUMMARY, DRAFT, 'secret-token'])
    @patch("publish.upload_asset", side_effect=OSError("disconnected"))
    def test_failed_upload_does_not_promote_release(self, _upload, mocked, _run):
        with self.assertRaises(OSError):
            publish("owner/repo", "0.1.0", "", Path("game.zip"), Path("manifest.json"))
        self.assertFalse(any(call.args[:2] == ("release", "edit") for call in mocked.call_args_list))

    @patch("publish.subprocess.run", return_value=Mock(returncode=0, stdout=SUMMARY))
    @patch("publish.gh")
    @patch("publish.upload_asset")
    def test_resume_skips_only_verified_existing_draft_assets(self, upload, mocked, _run):
        archive, manifest = self.package()
        draft = json.loads(DRAFT)
        draft["assets"] = [{"name": archive.name, "state": "uploaded", "size": archive.stat().st_size,
                            "digest": "sha256:" + hashlib.sha256(archive.read_bytes()).hexdigest()}]
        mocked.side_effect = ['{"isPrivate": false}', json.dumps(draft), 'secret-token', '']
        publish("owner/repo", "0.1.0", "", archive, manifest)
        upload.assert_called_once_with(draft["upload_url"], manifest, "secret-token")

    @patch("publish.subprocess.run", return_value=Mock(returncode=0, stdout='{"isDraft": false}'))
    @patch("publish.gh", return_value='{"isPrivate": false}')
    @patch("publish.upload_asset")
    def test_published_releases_are_never_modified(self, upload, _gh, _run):
        with self.assertRaises(ValueError): publish("owner/repo", "0.1.0", "", Path("a"), Path("b"))
        upload.assert_not_called()

    def test_progress_does_not_claim_completion_before_server_confirmation(self):
        stream = io.StringIO()
        progress = UploadProgress("game.zip", 100, stream=stream)
        progress.update(100)
        self.assertIn("99.9%", stream.getvalue())
        self.assertNotIn("100.0%", stream.getvalue())
        progress.update(100, complete=True)
        self.assertIn("100.0%", stream.getvalue())
        self.assertIn("verified", stream.getvalue())

    @patch("publish.http.client.HTTPSConnection")
    def test_streaming_upload_uses_chunks_and_verifies_response(self, connection_class):
        asset = self.root / "game.zip"
        data = b"x" * 700_000
        asset.write_bytes(data)
        connection = connection_class.return_value
        response = connection.getresponse.return_value
        response.status = 201
        response.read.return_value = json.dumps({"state": "uploaded", "size": len(data), "digest": "sha256:" + hashlib.sha256(data).hexdigest()}).encode()
        with patch("publish.sys.stderr", new_callable=io.StringIO) as output:
            upload_asset(json.loads(DRAFT)["upload_url"], asset, "secret-token")
            self.assertIn("100.0%", output.getvalue())
            self.assertNotIn("secret-token", output.getvalue())
        connection.putheader.assert_any_call("Content-Length", str(len(data)))
        self.assertEqual(b"".join(call.args[0] for call in connection.send.call_args_list), data)
        self.assertEqual(connection.send.call_count, 3)
        connection.close.assert_called_once()

    @patch("publish.http.client.HTTPSConnection")
    def test_rejected_upload_never_reports_success(self, connection_class):
        asset = self.root / "game.zip"
        asset.write_bytes(b"zip")
        connection = connection_class.return_value
        connection.getresponse.return_value.status = 403
        connection.getresponse.return_value.read.return_value = b"{}"
        with patch("publish.sys.stderr", new_callable=io.StringIO) as output:
            with self.assertRaisesRegex(ValueError, "HTTP 403"):
                upload_asset(json.loads(DRAFT)["upload_url"], asset, "secret-token")
            self.assertNotIn("100.0%", output.getvalue())
        connection.close.assert_called_once()

    @patch("publish.http.client.HTTPSConnection")
    def test_upload_rejects_untrusted_endpoint_before_sending_token(self, connection_class):
        with self.assertRaises(ValueError): upload_asset("https://example.com/assets", Path("a"), "secret-token")
        connection_class.assert_not_called()


if __name__ == "__main__":
    unittest.main()
