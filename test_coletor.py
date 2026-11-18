"""Testes rápidos dos leitores (sem internet): python test_coletor.py"""
import json
from datetime import datetime, timezone
from coletor import parse_feed, parse_desc, parse_wp, parse_ofuturo

rss = b"""<rss><channel><item><title>A &amp; B</title><link>https://x.org/1</link>
<pubDate>Wed, 18 Nov 2026 11:38:26 -0300</pubDate><description>&lt;p&gt;Resumo&lt;/p&gt; The post A apareceu</description></item>
<item><description>So descricao</description><link>https://x.org/2026/11/17/a.htm</link></item></channel></rss>"""
a, b = parse_feed(rss)
assert a == ("A & B", "https://x.org/1", 1795012706, "Resumo"), a
assert b[0] == "So descricao" and b[2] == int(datetime(2026, 11, 17, 3, tzinfo=timezone.utc).timestamp()), b
assert parse_desc(b"<rss><channel><item><title>RUBRICA</title><description>Manchete</description><link>https://u.com/x</link></item></channel></rss>")[0][0] == "Manchete"

atom = b"""<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><link rel="alternate" href="https://y.org/t"/>
<updated>2026-11-18T10:00:00Z</updated><summary>S</summary></entry></feed>"""
assert parse_feed(atom) == [("T", "https://y.org/t", 1794996000, "S")]

try:
    parse_feed(b"<html><body>bloqueado</body></html>")
    raise AssertionError("HTML passou como feed")
except ValueError:
    pass

wp = json.dumps([{"title": {"rendered": "Oi &#8211; ola"}, "link": "https://w.com/p", "date_gmt": "2026-11-18T10:00:00",
                  "excerpt": {"rendered": "<p>Ex</p>"}}]).encode()
assert parse_wp(wp) == [("Oi – ola", "https://w.com/p", 1794996000, "Ex")]

html = '''<a href="/artigo/ab-x" class="card-article-wide" data-v><div class="date text-upper">15 de Dezembro</div>
<h4><span>Título</span></h4><section class="snippet"><p>Resumo</p></section></a>'''.encode()
(t, u, ts, r), = parse_ofuturo(html, hoje=datetime(2027, 1, 10, tzinfo=timezone.utc))
assert (t, u, r) == ("Título", "https://jornalofuturo.com.br/artigo/ab-x", "Resumo")
assert datetime.fromtimestamp(ts, timezone.utc).year == 2026  # dezembro visto em janeiro é do ano anterior
print("ok")
