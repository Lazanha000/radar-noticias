"""Radar: coleta os feeds de fontes.json e grava site/recentes.json + site/antigas.json.
O app baixa um arquivo pronto e busca na memória (rápido), em vez de ler site por site.
Uso: python coletor.py           (coleta e grava)
     python coletor.py --testar  (só mostra quantos itens cada fonte deu)"""
import html, json, re, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from defusedxml import ElementTree as ET  # feeds são de terceiros

AQUI = Path(__file__).parent
SITE = AQUI / "site"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept": "application/rss+xml, application/xml, text/xml, */*"}
DIAS = 30            # histórico guardado
MAX_ITENS = 20000    # teto para o arquivo não pesar no celular
RECENTE_H = 72       # o que vai no arquivo carregado primeiro
RESUMO = 150         # caracteres de resumo


def data_ts(s):
    if not s:
        return None
    s = s.strip()
    try:
        d = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return int(d.timestamp())


def limpa(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def resumo(r, t):
    r = re.sub(r"\s*(The post|O post|Leia mais|Continue lendo|\[…\]|\[\.\.\.\]).*$", "", r)
    if r.startswith(t[:40]):
        return ""
    return r if len(r) <= RESUMO else r[:RESUMO].rsplit(" ", 1)[0] + "…"


def parse_feed(xml):
    """RSS, RDF ou Atom -> [(titulo, link, ts, resumo)]. ValueError se não for feed."""
    try:
        raiz = ET.fromstring(xml)
    except Exception as e:  # HTML de bloqueio, ou entidade barrada pelo defusedxml
        raise ValueError("não é feed") from e
    itens = []
    for el in raiz.iter():
        if el.tag.split("}")[-1] not in ("item", "entry"):
            continue
        c = {}
        for f in el:
            c.setdefault(f.tag.split("}")[-1], f)
        link = c.get("link")
        link = (link.get("href") or link.text or "").strip() if link is not None else ""
        txt = lambda k: (c[k].text or "") if k in c else ""
        t, r = limpa(txt("title")), limpa(txt("description") or txt("summary"))
        if not t:  # UOL: a maioria dos itens vem só com a descrição
            t, r = r, ""
        ts = data_ts(txt("pubDate") or txt("published") or txt("updated") or txt("date"))
        if ts is None and (m := re.search(r"/(20\d\d)/(\d\d)/(\d\d)/", link)):  # sem data: tenta a do endereço
            ts = int(datetime(*map(int, m.groups()), 3, tzinfo=timezone.utc).timestamp())  # meia-noite de Brasília
        if t and link.startswith("http"):
            itens.append((t, link, ts, resumo(r, t)))
    if not itens and raiz.tag.split("}")[-1] not in ("rss", "feed", "RDF"):
        raise ValueError("não é feed")
    return itens


def parse_wp(corpo):
    """API do WordPress (sites cujo feed vem quebrado)."""
    return [(limpa(p["title"]["rendered"]), p["link"], data_ts(p["date_gmt"] + "Z"),
             resumo(limpa(p["excerpt"]["rendered"]), limpa(p["title"]["rendered"])))
            for p in json.loads(corpo) if p.get("link")]


MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto",
         "setembro", "outubro", "novembro", "dezembro"]


def parse_ofuturo(corpo, hoje=None):
    """Jornal O Futuro não tem feed: lê os cartões da página pública /artigo ("15 de Novembro", sem ano)."""
    hoje = hoje or datetime.now(timezone.utc)
    itens = []
    for m in re.finditer(r'<a href="(/artigo/[^"]+)" class="card-article[^"]*"[^>]*>(.*?)</a>', corpo.decode("utf-8", "replace"), re.S):
        bloco = m.group(2)
        t = limpa((re.search(r"<h\d[^>]*>(.*?)</h\d>", bloco, re.S) or [None, ""])[1])
        r = limpa((re.search(r'class="snippet"[^>]*>(.*?)</section>', bloco, re.S) or [None, ""])[1])
        dm = re.search(r'class="date[^"]*"[^>]*>\s*(\d{1,2}) de (\w+)', bloco)
        ts = None
        if dm and dm.group(2).lower() in MESES:
            d = datetime(hoje.year, MESES.index(dm.group(2).lower()) + 1, int(dm.group(1)), 12, tzinfo=timezone.utc)
            if d > hoje:  # dezembro visto em janeiro
                d = d.replace(year=hoje.year - 1)
            ts = int(d.timestamp())
        if t:
            itens.append((t, "https://jornalofuturo.com.br" + m.group(1), ts, resumo(r, t)))
    return itens


def parse_desc(xml):
    """UOL: o título é rubrica ("DESCULPA ALGUMA COISA"); a manchete está na descrição."""
    return [(r or t, u, ts, "") for t, u, ts, r in parse_feed(xml)]


LEITORES = {"wp": parse_wp, "ofuturo": parse_ofuturo, "desc": parse_desc}


def baixar(fonte):
    try:
        with urllib.request.urlopen(urllib.request.Request(fonte["feed"], headers=UA), timeout=25) as r:
            return fonte, LEITORES.get(fonte.get("tipo"), parse_feed)(r.read()), None
    except Exception as e:
        return fonte, [], f"{type(e).__name__}: {e}"[:160]


def carregar_anterior():
    itens, saude = [], {}
    for nome in ("recentes.json", "antigas.json"):
        try:
            d = json.loads((SITE / nome).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        ids = [f["id"] for f in d["fontes"]]
        itens += [(t, u, ts, ids[fi], r) for t, u, ts, fi, r in d["itens"]]
        saude.update({f["id"]: f for f in d["fontes"]})
    return itens, saude


def coletar():
    fontes = json.loads((AQUI / "fontes.json").read_text(encoding="utf-8"))
    agora = int(time.time())
    anteriores, saude_ant = carregar_anterior()
    por_link = {u: (t, u, ts, fid, r) for t, u, ts, fid, r in anteriores}
    saude = []
    with ThreadPoolExecutor(24) as ex:
        for fonte, itens, erro in ex.map(baixar, fontes):
            ant = saude_ant.get(fonte["id"], {})
            if itens:
                ultimo_ok, ultimo_erro = agora, None
            else:
                ultimo_ok, ultimo_erro = ant.get("ok"), erro or "feed vazio"
            saude.append({"id": fonte["id"], "nome": fonte["nome"], "ala": fonte["ala"], "site": fonte["site"],
                          "ok": ultimo_ok, "erro": ultimo_erro, "n": len(itens)})
            for t, u, ts, r in itens:
                velho = por_link.get(u)
                if ts and agora + 600 < ts <= agora + 600 + 10800:  # UOL e outros: hora UTC marcada como -0300
                    ts -= 10800
                # sem data ou data no futuro: vale a primeira vez que o item apareceu
                # (na 1ª coleta da fonte, item sem data vai para ontem, senão os sem data tomam o topo)
                ts = min(ts or (agora if ant else agora - 86400), agora) if not velho else velho[2]
                por_link[u] = (t, u, ts, fonte["id"], r)
    ids_validos = {f["id"] for f in fontes}
    limite = agora - DIAS * 86400
    itens = sorted((i for i in por_link.values() if i[2] >= limite and i[3] in ids_validos),
                   key=lambda i: -i[2])[:MAX_ITENS]
    return saude, itens, agora


def gravar(saude, itens, agora):
    idx = {f["id"]: n for n, f in enumerate(saude)}
    corte = agora - RECENTE_H * 3600
    for nome, parte in (("recentes.json", [i for i in itens if i[2] >= corte]),
                        ("antigas.json", [i for i in itens if i[2] < corte])):
        dados = {"gerado": agora, "fontes": saude, "itens": [[t, u, ts, idx[fid], r] for t, u, ts, fid, r in parte]}
        (SITE / nome).write_text(json.dumps(dados, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    t0 = time.time()
    saude, itens, agora = coletar()
    for f in saude:
        print(f"{f['ala'][:4]:5} {f['n']:4}  {f['nome']}" + (f"   <- {f['erro']}" if f["n"] == 0 else ""))
    falhas = sum(1 for f in saude if f["n"] == 0)
    print(f"{len(itens)} itens, {len(saude) - falhas}/{len(saude)} fontes ok, {time.time() - t0:.0f}s")
    if "--testar" not in sys.argv:
        SITE.mkdir(exist_ok=True)
        gravar(saude, itens, agora)
