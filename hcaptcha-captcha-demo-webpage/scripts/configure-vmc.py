"""Configure the demo3 page and build the companion observer for demo2 and demo3.

This build uses only Python's standard library. It neither starts a browser nor
executes hCaptcha code. The extension is built from this repository's collector sources.
"""

from pathlib import Path
import hashlib
import json
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
sys.path.insert(0, str(REPO))
from collector.build import build_extension

EXTENSION = REPO / "dist" / "vmc-frame-observer"
CONFIG = ROOT / "vmc-config.json"
cfg = json.loads(CONFIG.read_text())
cfg["config_sha256"] = hashlib.sha256(CONFIG.read_bytes()).hexdigest()

# Keep the deployed parent collector's existing core while correcting its site identity.
page = ROOT / "public" / "vmc" / "vmc-site-collector.js"
prefix, embedded = page.read_text().rsplit("\n})(", 1)
current = json.loads(embedded.strip()[:-2])
current.update({
    "experiment_origin": cfg["experiment_origin"],
    "config_sha256": cfg["config_sha256"],
    "collector": cfg["collector"],
    "vm_observer": {"enabled": False},
})
current["site"].update({
    "experiment_name": cfg["experiment_name"],
    "experiment_url": cfg["experiment_url"],
    "comparison": cfg["comparison"],
})
current["build"]["deployment"] = {
    "config_file": "hcaptcha-captcha-demo-webpage/vmc-config.json",
    "config_sha256": cfg["config_sha256"],
    "configurator": "hcaptcha-captcha-demo-webpage/scripts/configure-vmc.py",
    "configurator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    "note": "Website deployment configuration updated; upstream parent collector core retained.",
}
page.write_text(prefix + "\n})(" + json.dumps(current, separators=(",", ":")) + ");\n")

build_extension(EXTENSION, cfg)

# Package only the extension's seven files; each tab's recordings remain in local browser storage.
archive_path = ROOT / "public" / "vmc" / "vmc-frame-observer-demo2-demo3.zip"
with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name in ["background.js", "bridge.js", "collector-capture.js", "config.js",
                 "hsw_capture_download.js", "manifest.json", "observer-main.js"]:
        info = zipfile.ZipInfo("vmc-frame-observer/" + name, (1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, (EXTENSION / name).read_bytes())
print("Configured demo3 page; built dist/vmc-frame-observer for demo2 and demo3.")
print("Download:", archive_path.relative_to(REPO))
