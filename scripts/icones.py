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


# avatares dos canais do YouTube (canais.json) -> site/ico/<id>.jpg
import re
canais = json.loads((RAIZ / "canais.json").read_text(encoding="utf-8"))
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "pt-BR", "Cookie": "CONSENT=YES+1"}

def avatar(c):
    destino = RAIZ / "site" / "ico" / f"{c['id']}.jpg"
    if destino.exists():
        return c["id"], "já tinha"
    try:
        with urllib.request.urlopen(urllib.request.Request("https://www.youtube.com/channel/" + c["cid"], headers=UA), timeout=20) as r:
            m = re.search(r'<meta property="og:image" content="([^"]+)"', r.read().decode("utf-8", "replace"))
        url = re.sub(r"=s\d+.*$", "=s88-c-k-c0x00ffffff-no-rj", m.group(1))
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
            destino.write_bytes(r.read())
        return c["id"], "ok"
    except Exception as e:
        return c["id"], f"erro {e}"

with ThreadPoolExecutor(12) as ex:
    for i, s in ex.map(avatar, canais):
        if s != "já tinha":
            print(i, s)
