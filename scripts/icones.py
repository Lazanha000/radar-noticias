"""Baixa o ícone de cada fonte (64 px) para site/ico/<id>.png. Rodar ao adicionar fontes: python scripts/icones.py"""
import json, urllib.request
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
RAIZ = Path(__file__).resolve().parent.parent
fontes = json.loads((RAIZ / "fontes.json").read_text(encoding="utf-8"))

def um(f):
    destino = RAIZ / "site" / "ico" / f"{f['id']}.png"
    if destino.exists():
        return f["id"], "já tinha"
    url = f"https://www.google.com/s2/favicons?domain={f['site']}&sz=64"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=20) as r:
            destino.write_bytes(r.read())
        return f["id"], "ok"
    except Exception as e:
        return f["id"], f"erro {e}"

with ThreadPoolExecutor(12) as ex:
    for i, s in ex.map(um, fontes):
        if s != "já tinha":
            print(i, s)
