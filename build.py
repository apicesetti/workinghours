"""Genera las configuraciones para pegar en MyGeotab (Administración → Sistema → Configuración del sistema → Add-Ins).

Son dos add-ins separados para que onStartup/onShutdown solo apliquen a Drive:
  dist/config-mygeotab.json  Página "Horas de trabajo" (Actividad → Horas de trabajo)
  dist/config-drive.json     Add-in de Geotab Drive con onStartup (avisa al identificarse)

Uso: python build.py [URL_BASE_HOSTING]
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).parent
DIST = ROOT / "dist"
DIST.mkdir(exist_ok=True)

BASE_URL = (sys.argv[1] if len(sys.argv) > 1
            else "https://apicesetti.github.io/workinghours").rstrip("/")
VERSION = "1.0.0"
MENU = {"es": "Horas de trabajo", "en": "Working hours"}

mygeotab = {
    "name": "Horas de trabajo",
    "supportEmail": "soporte@cesetti.com.ar",
    "version": VERSION,
    "items": [
        {
            "url": BASE_URL + "/workingHours.html",
            "path": "ActivityLink/",
            "menuName": MENU,
            "svgIcon": BASE_URL + "/images/icon.svg",
        }
    ],
}

drive = {
    "name": "Horas de trabajo (Drive)",
    "supportEmail": "soporte@cesetti.com.ar",
    "version": VERSION,
    "items": [
        {
            "url": BASE_URL + "/workingHoursDrive.html",
            "path": "DriveAppLink/",
            "menuName": MENU,
            "svgIcon": BASE_URL + "/images/icon.svg",
        }
    ],
    "onStartup": True,
    "onShutdown": True,
}

for name, cfg in (("config-mygeotab.json", mygeotab), ("config-drive.json", drive)):
    out = DIST / name
    out.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    print("OK ->", out)
