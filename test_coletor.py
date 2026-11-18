"""Testes rápidos dos leitores (sem internet): python test_coletor.py"""
import json
from datetime import datetime, timezone
from coletor import parse_feed, parse_desc, parse_wp, parse_ofuturo, parse_news, parse_embutido, classificar, agrupar, assuntos, principais

rss = b"""<rss><channel><item><title>A &amp; B</title><link>https://x.org/1</link>
<pubDate>Wed, 18 Nov 2026 11:38:26 -0300</pubDate><description>&lt;p&gt;Resumo&lt;/p&gt; The post A apareceu</description></item>
<item><description>So descricao</description><link>https://x.org/2026/11/17/a.htm</link></item></channel></rss>"""
a, b = parse_feed(rss)
assert a == ("A & B", "https://x.org/1", 1795012706, "Resumo", "", ""), a
assert b[0] == "So descricao" and b[2] == int(datetime(2026, 11, 17, 3, tzinfo=timezone.utc).timestamp()), b
assert parse_desc(b"<rss><channel><item><title>RUBRICA</title><description>Manchete</description><link>https://u.com/x</link></item></channel></rss>")[0][0] == "Manchete"

atom = b"""<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><link rel="alternate" href="https://y.org/t"/>
<updated>2026-11-18T10:00:00Z</updated><summary>S</summary></entry></feed>"""
assert parse_feed(atom) == [("T", "https://y.org/t", 1794996000, "S", "", "")]

try:
    parse_feed(b"<html><body>bloqueado</body></html>")
    raise AssertionError("HTML passou como feed")
except ValueError:
    pass

wp = json.dumps([{"title": {"rendered": "Oi &#8211; ola"}, "link": "https://w.com/p", "date_gmt": "2026-11-18T10:00:00",
                  "excerpt": {"rendered": "<p>Ex</p>"}}]).encode()
assert parse_wp(wp) == [("Oi – ola", "https://w.com/p", 1794996000, "Ex", "", "")]

html = '''<a href="/artigo/ab-x" class="card-article-wide" data-v><div class="date text-upper">15 de Dezembro</div>
<h4><span>Título</span></h4><section class="snippet"><p>Resumo</p></section></a>'''.encode()
(t, u, ts, r, _, _), = parse_ofuturo(html, hoje=datetime(2027, 1, 10, tzinfo=timezone.utc))
assert (t, u, r) == ("Título", "https://jornalofuturo.com.br/artigo/ab-x", "Resumo")
assert datetime.fromtimestamp(ts, timezone.utc).year == 2026  # dezembro visto em janeiro é do ano anterior
# imagem: media:content, ou <img> dentro da descrição
img = b"""<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><item><title>F</title><link>https://x.org/f</link>
<media:content url="https://x.org/f.jpg" medium="image"/></item><item><title>G</title><link>https://x.org/g</link>
<description>&lt;img src="https://x.org/g.jpg"&gt; texto</description></item></channel></rss>"""
assert [i[5] for i in parse_feed(img)] == ["https://x.org/f.jpg", "https://x.org/g.jpg"]
assert parse_embutido(b"<html> <rss><channel><item><title>E</title><link>https://e.com/1</link></item></channel></rss></html>")[0][0] == "E"

news = b"""<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
<url><loc>https://n.com/a</loc><news:news><news:publication_date>2026-11-18T10:00:00+00:00</news:publication_date>
<news:title>Manchete</news:title><news:keywords>Economia</news:keywords></news:news></url></urlset>"""
assert parse_news(news) == [("Manchete", "https://n.com/a", 1794996000, "", "Economia", "")]

fonte = {"site": "x.com.br"}
assert classificar("Nasa lança telescópio", "", "https://g1.globo.com/ciencia/x", "", fonte)[0] == ["cie"]
assert classificar("Putin e Xi se reúnem na China", "", "https://x.com/a", "", fonte)[1] == "m"
assert classificar("Lula conversa com Xi sobre a China", "", "https://x.com/a", "", fonte)[1] == "b"
assert classificar("Greve dos petroleiros", "", "https://x.com/mundo/a", "", fonte)[1] == "m"

# agrupamento: mesmo fato em veículos diferentes junta; assuntos só parecidos, não
agora = 1795000000
its = [{"t": t, "ts": agora - k * 600, "f": f} for k, (t, f) in enumerate([
    ("Fachin diz que STF pode julgar Lei da Dosimetria ainda em 2026", "a"),
    ("STF pode julgar Lei da Dosimetria neste ano, diz Fachin", "b"),
    ("Fachin sinaliza que STF pode julgar dosimetria ainda neste ano", "c"),
    ("Deezer terá recurso para ocultar músicas geradas por inteligência artificial", "d"),
    ("Um bafômetro para a inteligência artificial", "e")] + [(f"Notícia avulsa número {w}", "z") for w in
    "alfa beta gama delta epsilon zeta eta teta iota capa lambda mi ni csi omicron pi ro sigma tau ipsilon".split()])]
agrupar(its, agora)
assert its[0]["g"] and its[0]["g"] == its[1]["g"] == its[2]["g"], [i["g"] for i in its[:5]]
assert not its[3]["g"] or its[3]["g"] != its[4]["g"]

# assuntos e principais: fatos diferentes do mesmo assunto viram um item; o dia inteiro conta
alas = {"a": "radical", "b": "moderada", "c": "burguesa", "d": "direita", "e": "burguesa", "f": "burguesa", "g": "burguesa",
        "h": "burguesa", "z": "burguesa"}
fontes = [{"id": k, "ala": v} for k, v in alas.items()]
H = 3600
def it(t, f, h, r=""):
    return {"t": t, "u": f"https://{f}.com/{abs(hash(t))}", "ts": agora - int(h * H), "f": f, "r": r, "im": "", "tm": ["pol"]}
its = [it("Andrei entrega a Fachin relatório da PF sobre ministros no caso Master", f, 14 + k) for k, f in enumerate("abcd")]
its += [it("Andrei vai ao Senado explicar troca de delegados no caso Master", f, 2) for f in "bc"]
its += [it("Cantor famoso lança álbum surpresa com participação de rapper", f, 0.5) for f in "efgh"]  # 4 da mesma linha, agora
its += [it(f"Notícia avulsa número {w}", "z", 1) for w in "alfa beta gama delta epsilon zeta eta teta".split()]
its.sort(key=lambda i: -i["ts"])
agrupar(its, agora)
pr = principais(assuntos(its, agora), fontes, agora, its)
master = {i["a"] for i in its if "Master" in i["t"]}
assert len(master) == 1 or any(set(p["a"]) >= master for p in pr), master  # um assunto só
assert set(pr[0]["a"]) & master, pr[0]  # 4 linhas há 14 h > 1 linha agora
assert pr[0]["nf"] == 4 and pr[0]["na"] == 4, pr[0]
assert sum(1 for p in pr if set(p["a"]) & master) == 1  # não repete
print("ok")
