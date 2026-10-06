"""Apply the requested release version to a build checkout, without committing it."""
import argparse
import json
import re
import tomllib
from pathlib import Path
from publish import VERSION


def set_version(root, version):
    if not VERSION.fullmatch(version):
        raise ValueError("Enter a valid release version, for example 0.1.4.")
    files = {}
    for name in ("package.json", "package-lock.json", "src-tauri/tauri.conf.json"):
        path = root / name
        data = json.loads(path.read_text(encoding="utf-8"))
        data["version"] = version
        if name == "package-lock.json":
            data["packages"][""]["version"] = version
        files[path] = json.dumps(data, indent=2, ensure_ascii=False) + "\n"

    # Limit Cargo.toml replacement to its package section, never dependencies.
    patterns = {
        "src-tauri/Cargo.toml": r'(?ms)(^\[package\]\n(?:(?!^\[).)*?^version\s*=\s*")[^"]+(")',
        "src-tauri/Cargo.lock": r'(?m)(^name = "the-signal-launcher"\nversion = ")[^"]+(")',
    }
    for name, pattern in patterns.items():
        path = root / name
        text = path.read_text(encoding="utf-8")
        updated, count = re.subn(pattern, lambda match: match[1] + version + match[2], text)
        if count != 1:
            raise ValueError(f"Expected exactly one launcher version in {name}.")
        tomllib.loads(updated)
        files[path] = updated

    # Validate every input before writing any file.
    for path, text in files.items():
        path.write_text(text, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    args = parser.parse_args()
    set_version(Path(__file__).resolve().parent.parent, args.version)
    print(f"Build checkout version set to {args.version} (no commit or push).")


if __name__ == "__main__":
    main()
