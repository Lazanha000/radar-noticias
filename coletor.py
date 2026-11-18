"""Radar: coleta as fontes de fontes.json e grava, em site/:
  recentes.json  últimas 72 h (o app baixa primeiro)
  antigas.json   até 30 dias (só quando o app precisa)
  alertas.json   últimas 6 h, pequeno, para as notificações do celular
Cada notícia ganha temas, região (Brasil/mundo), países e um grupo: notícias de veículos diferentes
sobre o mesmo fato. O tamanho do grupo (quantos veículos e de quantas linhas editoriais) é a base da relevância.
Uso: python coletor.py           (coleta e grava)
     python coletor.py --testar  (só mostra quantos itens cada fonte deu)
     python coletor.py --grupos  (mostra os maiores grupos, para conferir o agrupamento)"""
import html, json, math, re, sys, time, unicodedata, urllib.error, urllib.request
from collections import Counter, defaultdict
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
ALERTA_H = 6         # janela do arquivo de notificações
JANELA_GRUPO_H = 48  # só agrupa notícias recentes
RESUMO = 150         # caracteres de resumo


# ---------- leitura das fontes ----------

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
    """RSS, RDF ou Atom -> [(titulo, link, ts, resumo, categorias, imagem)]. ValueError se não for feed."""
    try:
        raiz = ET.fromstring(xml.strip())  # Correio do Povo põe espaços antes do <?xml
    except Exception as e:  # HTML de bloqueio, ou entidade barrada pelo defusedxml
        raise ValueError("não é feed") from e
    itens = []
    for el in raiz.iter():
        if el.tag.split("}")[-1] not in ("item", "entry"):
            continue
        c, cats, img = {}, [], ""
        for f in el:
            k = f.tag.split("}")[-1]
            c.setdefault(k, f)
            if k in ("category", "subject"):
                cats.append(f.get("term") or f.text or "")
            elif k in ("content", "thumbnail", "enclosure") and not img and f.get("url") and                     (f.get("medium") == "image" or (f.get("type") or "image").startswith("image")):
                img = f.get("url")
            for g in f:  # media:group > media:content
                if not img and g.tag.split("}")[-1] in ("content", "thumbnail") and g.get("url"):
                    img = g.get("url")
        link = c.get("link")
        link = (link.get("href") or link.text or "").strip() if link is not None else ""
        txt = lambda k: (c[k].text or "") if k in c else ""
        if not img and (m := re.search(r'<img[^>]+src="(https?://[^"]+)"', txt("encoded") + txt("description"))):
            img = html.unescape(m.group(1))
        t, r = limpa(txt("title")), limpa(txt("description") or txt("summary"))
        if not t:  # UOL: a maioria dos itens vem só com a descrição
            t, r = r, ""
        ts = data_ts(txt("pubDate") or txt("published") or txt("updated") or txt("date"))
        if ts is None and (m := re.search(r"/(20\d\d)/(\d\d)/(\d\d)/", link)):  # sem data: tenta a do endereço
            ts = int(datetime(*map(int, m.groups()), 3, tzinfo=timezone.utc).timestamp())  # meia-noite de Brasília
        if t and link.startswith("http"):
            itens.append((t, link, ts, resumo(r, t), " ".join(cats), img))
    if not itens and raiz.tag.split("}")[-1] not in ("rss", "feed", "RDF"):
        raise ValueError("não é feed")
    return itens


def parse_wp(corpo):
    """API do WordPress (sites cujo feed vem quebrado)."""
    return [(limpa(p["title"]["rendered"]), p["link"], data_ts(p["date_gmt"] + "Z"),
             resumo(limpa(p["excerpt"]["rendered"]), limpa(p["title"]["rendered"])), "",
             ((p.get("yoast_head_json") or {}).get("og_image") or [{}])[0].get("url") or p.get("jetpack_featured_media_url") or "")
            for p in json.loads(corpo) if p.get("link")]


def parse_desc(xml):
    """UOL: o título é rubrica ("DESCULPA ALGUMA COISA"); a manchete está na descrição."""
    return [(r or t, u, ts, "", c, im) for t, u, ts, r, c, im in parse_feed(xml)]


def parse_embutido(corpo):
    """Correio do Povo: o RSS vem dentro de uma página HTML."""
    m = re.search(rb"<rss.*</rss>", corpo, re.S)
    if not m:
        raise ValueError("sem <rss>")
    return parse_feed(m.group(0))


def parse_news(xml):
    """Sitemap de notícias do Google (O Tempo, Correio Braziliense, O Povo): título, data e palavras-chave."""
    try:
        raiz = ET.fromstring(xml.strip())
    except Exception as e:
        raise ValueError("não é sitemap") from e
    itens = []
    for url in raiz:
        campos = {el.tag.split("}")[-1]: (el.text or "") for el in url.iter()}
        if campos.get("title") and campos.get("loc"):
            img = next((el.text for el in url.iter() if el.tag.endswith("}loc") and "image" in el.tag), "") or ""
            itens.append((limpa(campos["title"]), campos["loc"].strip(), data_ts(campos.get("publication_date")), "",
                          campos.get("keywords", ""), img.strip()))
    return sorted(itens, key=lambda i: -(i[2] or 0))[:80]


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
        sec = limpa((re.search(r'class="section-badge"[^>]*>(.*?)</div>', bloco, re.S) or [None, ""])[1])
        dm = re.search(r'class="date[^"]*"[^>]*>\s*(\d{1,2}) de (\w+)', bloco)
        ts = None
        if dm and dm.group(2).lower() in MESES:
            d = datetime(hoje.year, MESES.index(dm.group(2).lower()) + 1, int(dm.group(1)), 12, tzinfo=timezone.utc)
            if d > hoje:  # dezembro visto em janeiro
                d = d.replace(year=hoje.year - 1)
            ts = int(d.timestamp())
        if t:
            im = re.search(r'<img[^>]+src="(https?://[^"]+)"', bloco)
            itens.append((t, "https://jornalofuturo.com.br" + m.group(1), ts, resumo(r, t), sec, im.group(1) if im else ""))
    return itens


LEITORES = {"wp": parse_wp, "ofuturo": parse_ofuturo, "desc": parse_desc, "news": parse_news, "embutido": parse_embutido}


def baixar(fonte):
    erro = None
    for cab in (UA, {"User-Agent": UA["User-Agent"], "Accept": "*/*"}):  # alguns servidores recusam o Accept de feed (415)
        try:
            with urllib.request.urlopen(urllib.request.Request(fonte["feed"], headers=cab), timeout=25) as r:
                return fonte, LEITORES.get(fonte.get("tipo"), parse_feed)(r.read()), None
        except urllib.error.HTTPError as e:
            erro = f"HTTPError: {e}"
            if e.code not in (406, 415):
                break
        except Exception as e:
            erro = f"{type(e).__name__}: {e}"
            break
    return fonte, [], erro[:160]


# ---------- classificação ----------

def norm(s):
    return unicodedata.normalize("NFD", s.lower()).encode("ascii", "ignore").decode()


# tema: (rótulo, trechos do endereço, começos de palavra sem acento)
TEMAS = {
    "pol": ("Política", "politica poder eleicoes", "politic eleic eleitor congresso senado senador deputad camara stf supremo ministr governo presidente "
            "lula bolsonar partido prefeit governador planalto impeachment golpe pec oposicao"),
    "eco": ("Economia", "economia mercado financas negocios dinheiro invest agro", "economi inflac juros selic pib mercado dolar bolsa ibovespa emprego "
            "desemprego salario imposto tribut fiscal banco central petrobras investiment exporta importa tarifa preco divida orcamento"),
    "tra": ("Trabalho", "trabalho sindical", "greve sindicat trabalhador operari demiss terceiriz clt reforma administrativa "
            "previdencia aposentad salario minimo precariz entregador"),
    "cie": ("Ciência", "ciencia ciencias", "cienc cientista pesquisador astronom nasa telescop fisic quimic biolog genetic genoma dna "
            "fossil paleont especie evoluc universo planeta asteroide laboratorio"),
    "tec": ("Tecnologia", "tecnologia tec games inovacao", "tecnolog inteligencia artificial chatgpt openai big tech google apple microsoft "
            "nvidia chip semicondutor algoritmo internet aplicativo software startup robo"),
    "sau": ("Saúde", "saude bemestar", "saude sus hospital doenc vacin medic dengue cancer covid epidem virus anvisa remedio obesid diabet"),
    "amb": ("Meio ambiente", "ambiente clima sustentabilidade", "ambient clima climatic desmat amazon cerrado queimad enchent "
            "seca aquecimento emiss carbono cop30 biodivers agrotox"),
    "seg": ("Polícia e Justiça", "policia seguranca justica judiciario", "policia preso prisao crime homicid assassin facc trafic investigac "
            "operacao pf condenad julgament tribunal delegad"),
    "edu": ("Educação", "educacao", "educac escola enem universidad professor ensino aluno estudant mec vestibular"),
    "cul": ("Cultura", "cultura entretenimento cinema musica arteagenda diversao celebridades", "cultur cinema filme musica livro "
            "show teatro arte festival serie novela album cantor ator atriz literatur exposic"),
    "esp": ("Esporte", "esporte esportes futebol", "futebol esporte brasileirao campeonato copa selecao gol flamengo palmeiras "
            "corinthians santos vasco gremio cruzeiro olimp tenis formula"),
}
_TEMA_RE = {k: re.compile(r"\b(" + "|".join(re.escape(p) for p in v[2].split()) + ")") for k, v in TEMAS.items()}
_TEMA_URL = {k: set(v[1].split()) for k, v in TEMAS.items()}
_URL_MUNDO = {"mundo", "internacional", "world", "international", "global"}
_URL_BRASIL = {"brasil", "nacional", "cidades"}
_BR = re.compile(r"\b(brasil|lula|bolsonar|stf|congresso|governo federal|planalto|sao paulo|rio de janeiro|minas gerais|bahia)")

PAISES = json.loads((AQUI / "paises.json").read_text(encoding="utf-8"))
_PAIS_RE = [re.compile(r"\b(" + "|".join(norm(t) for t in p["termos"]) + r")\b") for p in PAISES]


def classificar(t, r, u, cats, fonte):
    """-> (temas, região 'b' Brasil | 'm' mundo, [índices de países])."""
    titulo, corpo = norm(t + " " + cats), norm(r)
    partes = set(re.split(r"[/\-_.]", norm(u.split("//", 1)[-1].split("?")[0]))[1:])
    temas = [k for k, rx in _TEMA_RE.items()
             if 2 * len(set(rx.findall(titulo))) + len(set(rx.findall(corpo))) + (3 if partes & _TEMA_URL[k] else 0) >= 2]
    no_titulo = [i for i, rx in enumerate(_PAIS_RE) if rx.search(titulo)]
    paises = no_titulo + [i for i, rx in enumerate(_PAIS_RE) if i not in no_titulo and rx.search(corpo)]
    if partes & _URL_MUNDO:
        regiao = "m"
    elif partes & _URL_BRASIL:
        regiao = "b"
    elif fonte.get("lingua", "pt") != "pt":
        regiao = "b" if "brasil" in titulo else "m"
    else:  # país estrangeiro no título e nada do Brasil no título = mundo
        regiao = "m" if no_titulo and not _BR.search(titulo) else "b"
    return temas[:3], regiao, paises[:4]


# ---------- agrupamento (mesmo fato em veículos diferentes) ----------

PARADAS = set(norm("""a o as os um uma uns umas de da do das dos em na no nas nos num numa por pelo pela pelos pelas para pra
com sem sob sobre entre ate apos ante contra desde e ou mas nem que se ja nao sim mais menos muito muita muitos muitas pouco
ser foi sao era sera estar esta estao esteve tem ter teve vai vao pode podem deve devem diz dizem afirma disse quer
seu sua seus suas ele ela eles elas isso isto esse essa este aquele aquela como quando onde qual quais quem porque
ano anos dia dias hoje ontem amanha semana mes novo nova novos novas primeiro primeira entenda veja saiba video ao vivo
the of and to in for on is with from by at as el la los las del en y con un una""").split())


def fichas(t):
    return {w for w in re.findall(r"[a-z0-9]{3,}", norm(t)) if w not in PARADAS and not w.isdigit()}


def agrupar(itens, agora):
    """Grava i['g'] em cada item (0 = sem grupo). Junta títulos que dividem palavras raras."""
    for i in itens:
        i["g"] = 0
    janela = [i for i in itens if i["ts"] >= agora - JANELA_GRUPO_H * 3600]
    if not janela:
        return
    fs = {id(i): fichas(i["t"]) for i in janela}
    df = Counter(w for s in fs.values() for w in s)
    n = len(janela)
    teto = max(8, n * 0.02)  # palavra em mais de 2% dos títulos (ex.: "lula") não serve para agrupar
    peso = {w: math.log(n / c) for w, c in df.items() if c <= teto}

    def sim(a, b):
        comuns = [w for w in a & b if w in peso]
        if len(comuns) < 2:
            return 0
        if len(comuns) == 2:  # só duas palavras em comum ("inteligência artificial") exige quase tudo igual
            return 0 if sum(peso[w] for w in comuns) / (min(sum(peso.get(w, 0) for w in a), sum(peso.get(w, 0) for w in b)) or 1) < 0.75 else 0.75
        menor = min(sum(peso.get(w, 0) for w in a), sum(peso.get(w, 0) for w in b)) or 1
        return sum(peso[w] for w in comuns) / menor

    grupos, por_palavra = [], defaultdict(set)
    for i in sorted(janela, key=lambda i: i["ts"]):
        a = fs[id(i)]
        cands = set().union(*(por_palavra[w] for w in a if w in peso))
        melhor, nota = None, 0.0
        for g in cands:
            membros = grupos[g]
            if i["ts"] - membros[-1]["ts"] > 36 * 3600:
                continue
            s = max(sim(a, fs[id(m)]) for m in membros[-6:])
            if s > nota and sim(a, fs[id(membros[0])]) >= 0.3:  # parecido também com a 1ª: evita corrente de assuntos
                melhor, nota = g, s
        if melhor is None or nota < 0.5:
            melhor = len(grupos)
            grupos.append([])
        grupos[melhor].append(i)
        for w in a:
            if w in peso:
                por_palavra[w].add(melhor)
    gid = 0
    for membros in grupos:
        if len({m["f"] for m in membros}) >= 2:
            gid += 1
            for m in membros:
                m["g"] = gid


def assuntos(itens, agora):
    """Grava i['a']: fatos diferentes sobre o mesmo assunto (ex.: "Fachin diz que STF julga dosimetria" e
    "Alcolumbre pede a Moraes julgamento da dosimetria"). O app mostra um assunto por vez, sem repetir."""
    for i in itens:
        i["a"] = 0
    janela = [i for i in itens if i["ts"] >= agora - JANELA_GRUPO_H * 3600]
    if not janela:
        return
    # história = um fato (grupo) ou uma notícia sozinha
    hist = defaultdict(list)
    for i in janela:
        hist[("g", i["g"]) if i["g"] else ("u", i["u"])].append(i)
    hist = list(hist.values())
    fs = [Counter(w for m in h for w in fichas(m["t"])) for h in hist]
    # núcleo: palavras que aparecem em pelo menos 30% dos títulos da história
    nucleo = [{w for w, c in f.items() if c >= max(1, math.ceil(0.3 * len(h)))} for f, h in zip(fs, hist)]
    df = Counter(w for n in nucleo for w in n)
    n = len(hist)
    peso = {w: math.log(n / c) for w, c in df.items() if c <= max(6, n * 0.03)}
    rara = {w for w, c in df.items() if c <= max(3, n * 0.012)}
    ordem = sorted(range(n), key=lambda k: -len({m["f"] for m in hist[k]}))
    dono, por_palavra, sementes = {}, defaultdict(list), []
    for k in ordem:
        a = nucleo[k]
        melhor, nota = None, 0.0
        for t in {t for w in a & rara for t in por_palavra[w]}:
            b_ = nucleo[sementes[t]]
            comuns = [w for w in a & b_ if w in peso]
            if not any(w in rara for w in comuns) or len(comuns) < 2:
                continue
            menor = min(sum(peso.get(w, 0) for w in a), sum(peso.get(w, 0) for w in b_)) or 1
            s_ = sum(peso[w] for w in comuns) / menor
            if s_ > nota:
                melhor, nota = t, s_
        if melhor is None or nota < 0.28:
            melhor = len(sementes)
            sementes.append(k)
            for w in a & rara:
                por_palavra[w].append(melhor)
        dono[k] = melhor
    tamanho = Counter(dono.values())
    for k, h in enumerate(hist):
        if tamanho[dono[k]] > 1:
            for m in h:
                m["a"] = dono[k] + 1


# ---------- vídeos (YouTube, pelo feed público de cada canal) ----------

def coletar_videos(agora):
    canais = json.loads((AQUI / "canais.json").read_text(encoding="utf-8"))

    def um(c):
        url = "https://www.youtube.com/feeds/videos.xml?channel_id=" + c["cid"]
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25) as r:
                raiz = ET.fromstring(r.read())
        except Exception as e:
            return c, [], f"{type(e).__name__}: {e}"[:120]
        vs = []
        for el in raiz:
            if not el.tag.endswith("entry"):
                continue
            campos = {x.tag.split("}")[-1]: x for x in el.iter()}
            vid = (campos.get("videoId").text or "") if "videoId" in campos else ""
            ts = data_ts(campos["published"].text) if "published" in campos else None
            views = int(campos["statistics"].get("views", 0)) if "statistics" in campos else 0
            link = (campos["link"].get("href") or "") if "link" in campos else ""
            if vid and ts and ts >= agora - 21 * 86400:  # canais pequenos postam pouco
                vs.append([limpa(campos["title"].text or ""), vid, min(ts, agora), views, int("/shorts/" in link)])
        return c, vs, None

    with ThreadPoolExecutor(16) as ex:
        res = list(ex.map(um, canais))
    lista = [{"id": c["id"], "nome": c["nome"], "ala": c["ala"], "cid": c["cid"], "n": len(vs), "erro": e} for c, vs, e in res]
    itens = sorted(([t, v, ts, k, vw, sh] for k, (c, vs, e) in enumerate(res) for t, v, ts, vw, sh in vs), key=lambda x: -x[2])
    (SITE / "videos.json").write_text(json.dumps({"gerado": agora, "canais": lista, "itens": itens}, ensure_ascii=False,
                                                 separators=(",", ":")), encoding="utf-8")
    return len(itens), sum(1 for c in lista if c["n"])


# ---------- coleta e gravação ----------

def carregar_anterior():
    itens, saude = [], {}
    for nome in ("recentes.json", "antigas.json"):
        try:
            d = json.loads((SITE / nome).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        ids = [f["id"] for f in d["fontes"]]
        itens += [{"t": x[0], "u": x[1], "ts": x[2], "f": ids[x[3]], "r": x[4], "im": x[8] if len(x) > 8 else ""} for x in d["itens"]]
        saude.update({f["id"]: f for f in d["fontes"]})
    return itens, saude


def coletar():
    fontes = json.loads((AQUI / "fontes.json").read_text(encoding="utf-8"))
    por_id = {f["id"]: f for f in fontes}
    agora = int(time.time())
    anteriores, saude_ant = carregar_anterior()
    por_link = {i["u"]: i for i in anteriores}
    saude = []
    with ThreadPoolExecutor(24) as ex:
        for fonte, itens, erro in ex.map(baixar, fontes):
            ant = saude_ant.get(fonte["id"], {})
            saude.append({"id": fonte["id"], "nome": fonte["nome"], "ala": fonte["ala"], "site": fonte["site"],
                          "ok": agora if itens else ant.get("ok"), "erro": None if itens else (erro or "feed vazio"), "n": len(itens)})
            for t, u, ts, r, cats, img in itens:
                velho = por_link.get(u)
                if ts and agora + 600 < ts <= agora + 600 + 10800:  # UOL e outros: hora UTC marcada como -0300
                    ts -= 10800
                # sem data ou data no futuro: vale a primeira vez que o item apareceu
                # (na 1ª coleta da fonte, item sem data vai para ontem, senão os sem data tomam o topo)
                ts = min(ts or (agora if ant else agora - 86400), agora) if not velho else velho["ts"]
                por_link[u] = {"t": t, "u": u, "ts": ts, "f": fonte["id"], "r": r, "c": cats, "im": img if img.startswith("https://") else ""}
    limite = agora - DIAS * 86400
    itens = sorted((i for i in por_link.values() if i["ts"] >= limite and i["f"] in por_id),
                   key=lambda i: -i["ts"])[:MAX_ITENS]
    for i in itens:
        i["tm"], i["rg"], i["p"] = classificar(i["t"], i["r"], i["u"], i.get("c", ""), por_id[i["f"]])
    agrupar(itens, agora)
    assuntos(itens, agora)
    return saude, itens, agora


def gravar(saude, itens, agora):
    idx = {f["id"]: n for n, f in enumerate(saude)}
    fonte = {f["id"]: f for f in saude}
    corte = agora - RECENTE_H * 3600
    comum = {"gerado": agora, "fontes": saude, "paises": [p["nome"] for p in PAISES],
             "temas": {k: v[0] for k, v in TEMAS.items()}}
    linha = lambda i: [i["t"], i["u"], i["ts"], idx[i["f"]], i["r"], " ".join(i["tm"] + [i["rg"]]), i["p"], i["g"], i["im"], i["a"]]
    for nome, parte in (("recentes.json", [i for i in itens if i["ts"] >= corte]),
                        ("antigas.json", [i for i in itens if i["ts"] < corte])):
        (SITE / nome).write_text(json.dumps(dict(comum, itens=[linha(i) for i in parte]), ensure_ascii=False,
                                            separators=(",", ":")), encoding="utf-8")
    # alertas: o celular baixa isto a cada ~30 min; cada notícia já vem com o tamanho do grupo dela
    fontes_g, alas_g = defaultdict(set), defaultdict(set)
    for i in itens:
        if i["g"]:
            fontes_g[i["g"]].add(i["f"])
            alas_g[i["g"]].add(fonte[i["f"]]["ala"])
    alertas = [{"t": i["t"], "u": i["u"], "ts": i["ts"], "f": i["f"], "nome": fonte[i["f"]]["nome"], "g": i["g"],
                "nf": len(fontes_g[i["g"]]) if i["g"] else 1, "na": len(alas_g[i["g"]]) if i["g"] else 1,
                "tm": i["tm"] + [i["rg"]]}
               for i in itens if i["ts"] >= agora - ALERTA_H * 3600]
    def nota(i):
        cob = 1 + 1.6 * math.log(len(fontes_g[i["g"]])) + 0.35 * (len(alas_g[i["g"]]) - 1) if i["g"] else 1
        return cob * 0.5 ** (max(0, agora - i["ts"]) / 3600 / 8)
    vistos, destaque = set(), []
    for i in sorted((i for i in itens if i["ts"] >= agora - 24 * 3600), key=lambda i: (-nota(i), -bool(i["im"]))):
        chave = ("a", i["a"]) if i["a"] else ("g", i["g"]) if i["g"] else ("u", i["u"])
        if chave in vistos:
            continue
        vistos.add(chave)
        destaque.append({"t": i["t"], "u": i["u"], "ts": i["ts"], "f": fonte[i["f"]]["nome"], "ala": fonte[i["f"]]["ala"],
                         "nf": len(fontes_g[i["g"]]) if i["g"] else 1})
        if len(destaque) == 25:
            break
    (SITE / "widget.json").write_text(json.dumps({"gerado": agora, "itens": destaque}, ensure_ascii=False,
                                                 separators=(",", ":")), encoding="utf-8")
    (SITE / "alertas.json").write_text(json.dumps({"gerado": agora, "itens": alertas}, ensure_ascii=False,
                                                  separators=(",", ":")), encoding="utf-8")


def coletar_locais(agora):
    """Notícias por cidade (locais.json) pela busca do Google Notícias, como no Radar do Vale.
    Feed do Google Notícias: uso pessoal, não comercial."""
    from urllib.parse import quote
    locais = json.loads((AQUI / "locais.json").read_text(encoding="utf-8"))

    def um(local):
        url = f"https://news.google.com/rss/search?q={quote(local['busca'] + ' when:7d')}&hl=pt-BR&gl=BR&ceid=BR:pt-419"
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25) as r:
                raiz = ET.fromstring(r.read())
        except Exception:
            return local, []
        itens = []
        for el in raiz.iter("item"):
            fonte = limpa(el.findtext("source") or "")
            t = limpa(el.findtext("title") or "")
            if fonte and t.endswith(" - " + fonte):  # o Google põe " - Veículo" no fim
                t = t[: -len(fonte) - 3]
            ts = data_ts(el.findtext("pubDate"))
            if t and ts and ts >= agora - 7 * 86400:
                itens.append([t, el.findtext("link") or "", min(ts, agora), fonte])
        return local, sorted(itens, key=lambda i: -i[2])[:20]

    with ThreadPoolExecutor(8) as ex:
        res = list(ex.map(um, locais))
    saida = [{**{k: v for k, v in l.items() if k != "busca"}, "itens": its} for l, its in res]
    (SITE / "locais.json").write_text(json.dumps({"gerado": agora, "locais": saida}, ensure_ascii=False,
                                                 separators=(",", ":")), encoding="utf-8")
    return sum(len(its) for _, its in res)


if __name__ == "__main__":
    t0 = time.time()
    saude, itens, agora = coletar()
    for f in saude:
        print(f"{f['ala'][:4]:5} {f['n']:4}  {f['nome']}" + (f"   <- {f['erro']}" if f["n"] == 0 else ""))
    falhas = sum(1 for f in saude if f["n"] == 0)
    print(f"{len(itens)} itens, {len(saude) - falhas}/{len(saude)} fontes ok, {time.time() - t0:.0f}s")
    if "--grupos" in sys.argv:
        g = defaultdict(list)
        for i in itens:
            if i["g"]:
                g[i["g"]].append(i)
        for membros in sorted(g.values(), key=lambda m: -len({x["f"] for x in m}))[:25]:
            print(f"\n== {len({x['f'] for x in membros})} veículos")
            for x in membros[:8]:
                print(f"   {x['f'][:14]:14} {x['t'][:100]}")
    if "--assuntos" in sys.argv:
        a = defaultdict(list)
        for i in itens:
            if i["a"]:
                a[i["a"]].append(i)
        for membros in sorted(a.values(), key=lambda m: -len(m))[:20]:
            print(f"\n## assunto com {len(membros)} notícias, {len({x['g'] or x['u'] for x in membros})} fatos")
            vistos = set()
            for x in membros:
                if (x["g"] or x["u"]) not in vistos:
                    vistos.add(x["g"] or x["u"])
                    print(f"   {x['t'][:110]}")
    if "--testar" not in sys.argv:
        SITE.mkdir(exist_ok=True)
        gravar(saude, itens, agora)
        print(f"{coletar_locais(agora)} notícias locais")
        print("%d vídeos de %d canais" % coletar_videos(agora))
