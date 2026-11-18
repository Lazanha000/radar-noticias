"use strict";
/* Radar Notícias. Os dados vêm prontos do coletor (recentes.json, antigas.json, locais.json, videos.json);
   busca, filtros e relevância rodam aqui, na memória do aparelho. Sites e cidades que você adiciona
   são lidos pelo próprio aparelho (no app Android, pela ponte RadarApp; no navegador, se o site permitir). */

const ALAS = [["radical", "Esquerda radical"], ["moderada", "Esquerda moderada"], ["burguesa", "Imprensa burguesa"], ["direita", "Direita"]];
const NOME_ALA = Object.fromEntries(ALAS);
const LOTE = 30;
const H = 3600;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const agora = () => Date.now() / 1000;
const ic = (n, cls = "i") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const app = window.RadarApp;  // ponte com o app Android (não existe no navegador)

// ---------- preferências (só neste aparelho) ----------
const le = (k, pad) => { try { const v = localStorage.getItem("radar2." + k); return v === null ? pad : JSON.parse(v); } catch (e) { return pad; } };
const guarda = (k, v) => { try { localStorage.setItem("radar2." + k, JSON.stringify(v)); } catch (e) {} };
const BLOCOS = [["principais", "Principais notícias"], ["locais", "Notícias locais"], ["voce", "Para você"], ["videos", "Vídeos em alta"], ["espectro", "Pelo espectro"], ["recentes", "Mais recentes"]];
const cfg = Object.assign({tema: "sistema", fs: 16, auto: true, autoMin: 15, cidade: "Araçuaí", blocos: {}}, le("cfg", {}));
const cliques = le("cliques", {}), cliquesTema = le("cliquesTema", {});
let seguindo = new Set(le("seguindo", []));
let ocultos = new Set(le("ocultos", []));
let colecoes = le("colecoes", []);
let proprias = le("proprias", []);        // sites que você adicionou: {id, nome, ala, site, feed}
let cidades = le("cidades", null);        // null = as do coletor
const alertas = Object.assign({ativo: false, modo: "ambos", escolhidos: [], nivel: "importantes", qualquer: true,
  temas: null, silencio: true, de: 22, ate: 7, maxDia: 6, intervalo: 30}, le("alertas", {}));
const visitaAnterior = le("visita", 0);
guarda("visita", Math.floor(agora()));
const blocoLigado = b => cfg.blocos[b] !== false;

function aplicarAparencia() {
  const r = document.documentElement;
  if (cfg.tema === "sistema") delete r.dataset.tema; else r.dataset.tema = cfg.tema;
  r.style.setProperty("--fs", cfg.fs + "px");
}
aplicarAparencia();

// ---------- rede ----------
async function baixar(nome) {
  const r = await fetch(nome, {cache: "no-cache"});  // revalida pela ETag: se nada mudou, não baixa de novo
  if (!r.ok) throw new Error(nome + " " + r.status);
  return r.json();
}
// texto de qualquer site: no app Android vai pela ponte (sem bloqueio de CORS); no navegador, direto
const pedidos = new Map();
let pid = 0;
window.radarResposta = (id, ok, txt) => { const p = pedidos.get(id); if (!p) return; pedidos.delete(id); ok ? p.res(txt) : p.rej(new Error(txt)); };
function baixarTexto(url) {
  if (app?.baixar) return new Promise((res, rej) => {
    const id = ++pid; pedidos.set(id, {res, rej}); app.baixar(id, url);
    setTimeout(() => window.radarResposta(id, false, "tempo esgotado"), 30000);
  });
  return fetch(url).then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); });
}

// ---------- dados ----------
const D = {itens: [], fontes: {}, lista: [], paises: [], temas: {}, gerado: 0, antigas: false, grupos: new Map(), locais: null, videos: null};
let carregandoAntigas = null, ultimoRecentes = null;

function novoItem(t, u, ts, f, r, tm, rg, p, g, im, a) {
  return {t, u, ts, f, r, tm, rg, p, g, im, a, k: norm(t + " " + r + " " + f.nome)};
}
function juntar(d, limpar) {
  if (limpar) { D.itens = []; D.fontes = {}; D.lista = []; }
  D.paises = d.paises; D.temas = d.temas; D.gerado = Math.max(D.gerado, d.gerado);
  for (const f of d.fontes) if (!D.fontes[f.id]) { D.fontes[f.id] = f; D.lista.push(f); }
  const vistos = new Set(D.itens.map(i => i.u));
  for (const [t, u, ts, fi, r, tm, p, g, im, a] of d.itens) {
    if (vistos.has(u) || !/^https?:\/\//.test(u)) continue;  // só links web (nada de javascript:)
    const cods = tm.split(" ");
    D.itens.push(novoItem(t, u, ts, D.fontes[d.fontes[fi].id], r, cods.filter(c => c.length === 3), cods.find(c => c.length === 1) || "b", p, g, im, a || 0));
  }
  if (limpar) misturarProprias();
  arrumar();
}
function arrumar() {
  D.itens.sort((a, b) => b.ts - a.ts);
  D.grupos = new Map();
  for (const i of D.itens) {
    if (!i.g) continue;
    let g = D.grupos.get(i.g);
    if (!g) D.grupos.set(i.g, g = {id: i.g, itens: [], fontes: new Set(), alas: new Set()});
    g.itens.push(i); g.fontes.add(i.f.id); g.alas.add(i.f.ala);
  }
}

async function carregar(silencioso) {
  const b = $("#atualizar");
  b.classList.add("girando");
  try {
    const d = await baixar("recentes.json");
    if (silencioso && d.gerado === D.gerado) return;
    const tinha = D.itens.length;
    ultimoRecentes = d;
    juntar(d, true);
    D.antigas = false; carregandoAntigas = null; D.videos = null;
    if (silencioso && tinha && window.scrollY > 400) { $("#novidade").hidden = false; return; }
    render();
    atualizarProprias();
  } catch (e) {
    if (!D.itens.length) $("#vista").innerHTML = `<div class="vazio">Sem conexão.<br><br><button class="btn" onclick="carregar()">${ic("atualizar")}Tentar de novo</button></div>`;
  } finally { b.classList.remove("girando"); }
}

// notícias com mais de 3 dias só são baixadas quando fazem falta (economiza dados)
function antigas() {
  if (D.antigas) return Promise.resolve(false);
  return carregandoAntigas = carregandoAntigas || baixar("antigas.json")
    .then(d => { juntar(d); D.antigas = true; return true; })
    .catch(() => { carregandoAntigas = null; return false; });
}

// ---------- sites próprios (lidos pelo aparelho) ----------
function textoDeHtml(s) { return new DOMParser().parseFromString(s || "", "text/html").body.textContent.replace(/\s+/g, " ").trim(); }
function lerFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) return null;
  const els = [...doc.getElementsByTagName("item"), ...doc.getElementsByTagName("entry")];
  if (!els.length && !/^(rss|feed|rdf:RDF)$/.test(doc.documentElement.nodeName)) return null;
  const filho = (el, ...nomes) => { for (const n of nomes) { const x = el.getElementsByTagName(n)[0]; if (x) return x; } return null; };
  const itens = els.map(el => {
    const l = [...el.getElementsByTagName("link")].find(x => !x.getAttribute("rel") || x.getAttribute("rel") === "alternate") || filho(el, "link");
    const u = (l?.getAttribute("href") || l?.textContent || "").trim();
    const desc = filho(el, "description", "summary", "content")?.textContent || "";
    const data = filho(el, "pubDate", "published", "updated", "dc:date")?.textContent;
    const midia = filho(el, "media:content", "media:thumbnail", "enclosure");
    const img = midia?.getAttribute("url") || (desc.match(/<img[^>]+src="(https:[^"]+)"/) || [])[1] || "";
    const ts = data ? Date.parse(data) / 1000 : NaN;
    return {t: textoDeHtml(filho(el, "title")?.textContent), u, ts: isNaN(ts) ? null : Math.min(ts, agora()), r: textoDeHtml(desc).slice(0, 150), im: img.startsWith("https://") ? img : ""};
  }).filter(i => i.t && /^https?:\/\//.test(i.u));
  return {titulo: textoDeHtml(filho(doc.documentElement, "title")?.textContent || ""), itens};
}
async function descobrirFeed(endereco) {
  let url = endereco.trim();
  if (!/^https?:\/\//.test(url)) url = "https://" + url;
  const base = new URL(url);
  const tentar = async u => { try { const t = await baixarTexto(u); const f = lerFeed(t); return f && f.itens.length ? {...f, feed: u} : {html: t}; } catch (e) { return null; } };
  let r = await tentar(url);
  if (r && r.itens) return r;
  const alt = r?.html && [...new DOMParser().parseFromString(r.html, "text/html").querySelectorAll('link[rel=alternate][type*="rss"], link[rel=alternate][type*="atom"]')].map(l => new URL(l.getAttribute("href"), base).href);
  for (const u of [...(alt || []), ...["/feed/", "/rss", "/feed", "/rss.xml", "/feed.xml", "/index.xml", "/atom.xml"].map(p => new URL(p, base).href)]) {
    r = await tentar(u);
    if (r && r.itens) return r;
  }
  return null;
}
const cacheProprias = le("propriasCache", {});
function fonteDe(p) { return {id: p.id, nome: p.nome, ala: p.ala, site: p.site, propria: true, ok: cacheProprias[p.id]?.em || 0}; }
function misturarProprias() {
  const vistos = new Set(D.itens.map(i => i.u));
  for (const p of proprias) {
    const f = D.fontes[p.id] || (D.fontes[p.id] = fonteDe(p));
    if (!D.lista.includes(f)) D.lista.push(f);
    for (const i of cacheProprias[p.id]?.itens || []) {
      if (vistos.has(i.u)) continue;
      vistos.add(i.u);
      D.itens.push(novoItem(i.t, i.u, i.ts, f, i.r, [], "b", [], 0, i.im, 0));
    }
  }
}
async function atualizarProprias(forcar) {
  const velhas = proprias.filter(p => forcar || !cacheProprias[p.id] || Date.now() / 1000 - cacheProprias[p.id].em > 20 * 60);
  if (!velhas.length) return;
  const res = await Promise.all(velhas.map(async p => {
    try { const f = lerFeed(await baixarTexto(p.feed)); if (f) return [p, f.itens]; } catch (e) {}
    return [p, null];
  }));
  let mudou = false;
  for (const [p, itens] of res) {
    if (!itens) continue;
    const antes = new Map((cacheProprias[p.id]?.itens || []).map(i => [i.u, i.ts]));
    // sem data no feed: vale a primeira vez que o item apareceu
    cacheProprias[p.id] = {em: Math.floor(agora()), itens: itens.slice(0, 40).map(i => ({...i, ts: i.ts || antes.get(i.u) || Math.floor(agora())}))};
    mudou = true;
  }
  if (!mudou) return;
  guarda("propriasCache", cacheProprias);
  if (ultimoRecentes) { juntar(ultimoRecentes, true); D.antigas = false; carregandoAntigas = null; }
  if (window.scrollY < 400) render();
}

// ---------- relevância ----------
// cobertura: quantos veículos diferentes deram o mesmo fato, e de quantas linhas editoriais;
// frescor: cai pela metade a cada 8 h; pessoal: os jornais e temas que você mais abre, e os que segue.
let afin = {f: {}, t: {}};
function calcularAfinidade() {
  const mf = Math.max(1, ...Object.values(cliques)), mt = Math.max(1, ...Object.values(cliquesTema));
  afin = {f: Object.fromEntries(Object.entries(cliques).map(([k, v]) => [k, v / mf])),
          t: Object.fromEntries(Object.entries(cliquesTema).map(([k, v]) => [k, v / mt]))};
}
const grupoDe = i => i.g ? D.grupos.get(i.g) : null;
function cobertura(i) {
  const g = grupoDe(i);
  return g ? 1 + 1.6 * Math.log(g.fontes.size) + 0.35 * (g.alas.size - 1) : 1;
}
const frescor = ts => Math.pow(0.5, Math.max(0, agora() - ts) / H / 8);
const pessoal = i => 1 + 0.6 * (afin.f[i.f.id] || 0) + 0.3 * Math.max(0, ...i.tm.map(t => afin.t[t] || 0)) + (seguindo.has(i.f.id) ? 0.4 : 0);
const visiveis = (itens = D.itens) => ocultos.size ? itens.filter(i => !ocultos.has(i.f.id)) : itens;

/** "História" = o mesmo fato em vários veículos. Ordena por relevância; cada uma mostra o item mais interessante para você. */
function historias(itens) {
  const por = new Map();
  for (const i of itens) {
    const k = i.g ? "g" + i.g : i.u;
    let h = por.get(k);
    if (!h) por.set(k, h = {k, itens: [], grupo: grupoDe(i)});
    h.itens.push(i);
  }
  const lista = [];
  for (const h of por.values()) {
    const recente = Math.max(...h.itens.map(i => i.ts));
    h.rep = h.itens.reduce((a, b) => (pessoal(b) + (b.im ? 0.3 : 0) > pessoal(a) + (a.im ? 0.3 : 0) ? b : a));
    h.a = (h.itens.find(i => i.a) || {}).a || 0;
    h.nota = cobertura(h.rep) * frescor(recente) * Math.max(...h.itens.map(pessoal));
    lista.push(h);
  }
  return lista.sort((a, b) => b.nota - a.nota);
}

/** "Assunto" = fatos diferentes sobre o mesmo tema (o coletor marca; aqui ainda junta títulos que dividem
 *  duas palavras raras). Mostra um por assunto, com os outros fatos recolhidos embaixo: menos repetição. */
const PARADAS = new Set("para sobre como mais pelo pela pelos pelas apos entre contra quando onde ainda deve pode sera foram este esta essa esse isso novo nova novos novas anos hoje veja saiba entenda video vivo diz diza afirma depois antes durante segundo".split(" "));
function assuntos(hs) {
  // palavras de todos os títulos do fato (até 8), não só da manchete escolhida
  const fichas = h => h.tok || (h.tok = new Set(h.itens.slice(0, 8).flatMap(i => norm(i.t).match(/[a-z0-9]{4,}/g) || []).filter(w => !PARADAS.has(w))));
  // palavras com maiúscula no meio do título (nomes próprios), já normalizadas
  const proprios = h => h.nomes || (h.nomes = new Set(h.itens.slice(0, 8).flatMap(i =>
    i.t.split(/\s+/).slice(1).filter(w => /^[A-ZÀ-Ý][a-zà-ÿ]{3,}/.test(w)).map(w => norm(w).replace(/[^a-z0-9]/g, "")))));
  const df = new Map();
  for (const h of hs) for (const w of fichas(h)) df.set(w, (df.get(w) || 0) + 1);
  const teto = Math.max(3, hs.length * 0.01);
  const out = [], porA = new Map();
  for (const h of hs) {
    let alvo = h.a ? porA.get(h.a) : null;
    if (!alvo) {
      // 2 palavras raras em comum, e pelo menos uma é nome próprio (Moraes, Alcolumbre, Putin...):
      // palavras comuns como "lavagem" ou "operação" juntariam casos diferentes
      const raras = [...fichas(h)].filter(w => df.get(w) <= teto && df.get(w) > 1), nomes = proprios(h);
      if (raras.length >= 2) for (const T of out.slice(0, 80)) {
        const comuns = raras.filter(w => T.tok.has(w));
        if (comuns.length >= 2 && comuns.some(w => nomes.has(w) && T.nomes.has(w))) { alvo = T; break; }
      }
    }
    if (alvo) { alvo.rel.push(h); if (h.a) porA.set(h.a, alvo); continue; }  // compara só com o fato que abriu o assunto (senão vira bola de neve)
    const T = {h, rel: [], tok: new Set(fichas(h)), nomes: proprios(h)};
    out.push(T);
    if (h.a) porA.set(h.a, T);
  }
  return out;
}
const chavesDe = T => [T.h, ...T.rel].flatMap(h => h.itens.map(i => i.u));

// ---------- filtros ----------
function termos(q) {
  const ts = [];
  q = norm(q || "").replace(/"([^"]+)"/g, (_, f) => { ts.push(f.trim()); return " "; });
  return ts.concat(q.split(/\s+/).filter(Boolean));
}
function filtrar(f) {
  const lim = f.periodo ? agora() - f.periodo * H : 0, q = termos(f.q);
  return D.itens.filter(i => i.ts >= lim
    && (f.fontes ? f.fontes.has(i.f.id) : !ocultos.has(i.f.id))
    && (!f.alas.size || f.alas.has(i.f.ala))
    && (!f.temas || !f.temas.length || f.temas.some(t => i.tm.includes(t)))
    && (!f.regiao || i.rg === f.regiao)
    && (f.pais == null || f.pais === "" || i.p.includes(+f.pais))
    && (!f.minFontes || (grupoDe(i)?.fontes.size || 1) >= f.minFontes)
    && q.every(t => i.k.includes(t)));
}
const novoFiltro = (base = {}) => Object.assign({ordem: "rel", periodo: 0, alas: new Set(), pais: "", q: "", fontes: null, temas: null, regiao: "", minFontes: 0}, base);

// ---------- pedaços de tela ----------
function quando(ts) {
  const s = agora() - ts, d = new Date(ts * 1000);
  if (s < 3570) return `há ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `há ${Math.round(s / H)} h`;
  const ontem = new Date(); ontem.setDate(ontem.getDate() - 1);
  if (d.toDateString() === ontem.toDateString()) return "ontem, " + d.toLocaleTimeString("pt-BR", {hour: "2-digit", minute: "2-digit"});
  return d.toLocaleDateString("pt-BR", {day: "numeric", month: "short"});
}
const inicial = nome => esc((String(nome).replace(/^[^A-Za-zÀ-ú0-9]+/, "")[0] || "?").toUpperCase());
const srcIcone = f => f.propria ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(f.site)}&sz=64` : `ico/${f.id}.png`;
const icone = f => `<img src="${esc(srcIcone(f))}" alt="" loading="lazy" onerror="this.outerHTML='<span class=ico-f>${inicial(f.nome)}</span>'">`;
function espectro(g, largo) {
  const n = {}; for (const i of g.itens) n[i.f.ala] = (n[i.f.ala] || 0) + 1;
  const tot = g.itens.length;
  const desc = ALAS.filter(([a]) => n[a]).map(([a, nm]) => `${n[a]} ${nm.toLowerCase()}`).join(", ");
  return `<span class="espectro${largo ? " largo" : ""}" role="img" aria-label="${esc(desc)}">${ALAS.filter(([a]) => n[a]).map(([a]) => `<i class="r-${a}" style="width:${100 * n[a] / tot}%"></i>`).join("")}</span>`;
}
function linhaFonte(i) {
  return `<div class="fonte">${icone(i.f)}<span class="ala r-${i.f.ala}" title="${NOME_ALA[i.f.ala]}"></span><span class="nm">${esc(i.f.nome)}</span></div>`;
}
function cartaoNoticia(i, {thumb = true, resumo = false, grande = false} = {}) {
  const g = grupoDe(i);
  const cob = g && g.fontes.size > 1 ? `<a class="cob" href="#historia/${g.id}">${espectro(g)}${g.fontes.size} veículos</a>` : "";
  return `<article class="n">${linhaFonte(i)}<h3${grande ? ' class="grande"' : ""}><a href="${esc(i.u)}" target="_blank" rel="noopener" data-f="${i.f.id}" data-tm="${i.tm.join(" ")}">${esc(i.t)}</a></h3>`
    + (resumo && i.r ? `<p class="res">${esc(i.r)}</p>` : "")
    + `<div class="meta">${i.ts > visitaAnterior && visitaAnterior ? '<span class="nova" title="Nova desde sua última visita"></span>' : ""}<span>${quando(i.ts)}</span>${cob}</div>`
    + (thumb && i.im ? `<img class="thumb" src="${esc(i.im)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "")
    + `</article>`;
}
// os outros fatos do mesmo assunto, recolhidos
function relacionadas(T, mostrar = 0) {
  if (!T.rel.length) return "";
  const linha = h => `<li><a href="${esc(h.rep.u)}" target="_blank" rel="noopener" data-f="${h.rep.f.id}" data-tm="${h.rep.tm.join(" ")}">${esc(h.rep.t)}</a><span>${esc(h.rep.f.nome)} · ${quando(h.rep.ts)}</span></li>`;
  const vis = T.rel.slice(0, mostrar), resto = T.rel.slice(mostrar);
  return `<div class="relac">${vis.length ? `<ul>${vis.map(linha).join("")}</ul>` : ""}`
    + (resto.length ? `<button class="abre-relac" aria-expanded="false">${ic("seta")}${mostrar ? "Mais" : ""} ${resto.length} ${resto.length === 1 ? "notícia" : "notícias"} sobre este assunto</button><ul hidden>${resto.map(linha).join("")}</ul>` : "")
    + `</div>`;
}
const cartaoAssunto = (T, opts = {}) => cartaoNoticia(T.h.rep, opts).replace(/<\/article>$/, relacionadas(T, opts.mostrar || 0) + "</article>");

// lista com rolagem infinita
function lista(el, itens, opts = {}) {
  let n = 0;
  const desenha = opts.desenha || (x => cartaoNoticia(x.rep || x, opts));
  const mais = document.createElement("div"); mais.className = "mais";
  const poe = () => {
    const fatia = itens.slice(n, n + LOTE); n += fatia.length;
    mais.insertAdjacentHTML("beforebegin", fatia.map(desenha).join(""));
    if (n >= itens.length) { obs.disconnect(); opts.fim?.(); }
  };
  const obs = new IntersectionObserver(es => es[0].isIntersecting && poe(), {rootMargin: "900px"});
  el.textContent = ""; el.append(mais);
  if (!itens.length) { el.innerHTML = `<div class="vazio">${opts.vazio || "Nenhuma notícia com esses filtros."}</div>`; opts.fim?.(); return; }
  poe(); if (n < itens.length) obs.observe(mais);
}

// ---------- vistas ----------
let vistaAtual = "", secao = le("secao", "destaques"), filtroAtual = null;
const SECOES = () => [["destaques", "Destaques"], ["manchetes", "Manchetes"], ["b", "Brasil"], ["m", "Mundo"], ...Object.entries(D.temas)];

function render() {
  $("#novidade").hidden = true;
  calcularAfinidade();
  const [v, arg] = decodeURIComponent(location.hash.slice(1) || "inicio").split("/");
  for (const a of document.querySelectorAll("[data-v]")) { if (a.dataset.v === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
  const mudou = vistaAtual !== location.hash;
  vistaAtual = location.hash;
  if (!D.itens.length) { $("#vista").innerHTML = `<div class="vazio">Carregando notícias…</div>`; return; }
  ({inicio: vInicio, colecoes: vColecoes, colecao: vColecao, banca: vBanca, fonte: vFonte, alertas: vAlertas,
    busca: vBusca, historia: vHistoria, videos: vVideos}[v] || vInicio)(arg);
  if (mudou) window.scrollTo(0, 0);
}

// rola só a faixa horizontal (scrollIntoView também rolaria a página)
const rolaAte = b => { if (b) b.parentElement.scrollLeft = b.offsetLeft - b.parentElement.clientWidth / 2 + b.offsetWidth / 2; };
function cabecalho(titulo, sub = "", extra = "") {
  return `<div class="cab"><div><h1>${titulo}</h1>${sub ? `<div class="data">${sub}</div>` : ""}</div>${extra}</div>`;
}

// Início
function vInicio() {
  const hoje = new Date().toLocaleDateString("pt-BR", {weekday: "long", day: "numeric", month: "long"});
  $("#vista").innerHTML = cabecalho("Suas notícias", hoje, `<a class="clima" id="clima" href="#alertas" hidden></a>`)
    + `<nav class="trilho" aria-label="Seções">${SECOES().map(([k, n]) => `<button data-s="${k}" aria-pressed="${k === secao}">${esc(n)}</button>`).join("")}</nav>`
    + `<div id="corpo"></div>`;
  $(".trilho").onclick = e => { const b = e.target.closest("button"); if (!b) return; secao = b.dataset.s; guarda("secao", secao); vInicio(); };
  rolaAte($(".trilho [aria-pressed=true]"));
  clima();
  if (secao === "destaques") return destaques();
  const base = secao === "manchetes" ? {minFontes: 3, periodo: 48} : secao.length === 1 ? {regiao: secao} : {temas: [secao]};
  feed($("#corpo"), novoFiltro(base));
}

function destaques() {
  const c = $("#corpo");
  const base = visiveis();
  const dia = base.filter(i => i.ts >= agora() - 24 * H);
  const ass = assuntos(historias(dia.length > 60 ? dia : base.filter(i => i.ts >= agora() - 48 * H)));
  const princ = ass.slice(0, 6);
  const usados = new Set(princ.flatMap(chavesDe)), assUsados = new Set(princ.flatMap(T => [T.h, ...T.rel].map(h => h.a).filter(Boolean)));
  const livre = T => ![T.h, ...T.rel].some(h => (h.a && assUsados.has(h.a)) || h.itens.some(i => usados.has(i.u)));
  const marca = T => { chavesDe(T).forEach(u => usados.add(u)); [T.h, ...T.rel].forEach(h => h.a && assUsados.add(h.a)); };
  c.innerHTML = `<div class="grade"><div class="principal"></div><div class="lateral"></div></div>`;
  const P = c.querySelector(".principal"), L = c.querySelector(".lateral");

  if (blocoLigado("principais") && princ.length) {
    const lider = princ[0], hl = lider.h;
    const rep = hl.itens.find(i => i.im && i === hl.rep) || hl.itens.find(i => i.im) || hl.rep;
    const outros = [], alasVistas = new Set([rep.f.ala]);
    for (const i of hl.itens) if (i !== rep && !alasVistas.has(i.f.ala) && outros.length < 3) { outros.push(i); alasVistas.add(i.f.ala); }
    for (const i of hl.itens) if (i !== rep && !outros.includes(i) && outros.length < 3) outros.push(i);
    let html = `<div class="lider">${rep.im ? `<img class="foto" src="${esc(rep.im)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}`
      + cartaoNoticia(rep, {thumb: false, grande: true}).replace(/<\/article>$/, relacionadas(lider, 2) + "</article>")
      + `<div class="outros">${outros.map(i => cartaoNoticia(i, {thumb: false})).join("")}</div></div>`;
    html += princ.slice(1).map(T => cartaoAssunto(T)).join("");
    P.insertAdjacentHTML("beforeend", `<section class="bloco b-principais"><h2>Principais notícias <button data-ir="manchetes">Ver todas ${ic("seta")}</button></h2>${html}</section>`);
    P.querySelector("[data-ir]").onclick = () => { secao = "manchetes"; guarda("secao", secao); vInicio(); };
  }

  if (blocoLigado("locais")) {
    L.insertAdjacentHTML("beforeend", `<section class="bloco b-locais" id="locais"><h2>Notícias locais</h2><div class="vazio">Carregando…</div></section>`);
    locais();
  }

  if (blocoLigado("voce")) {
    const temGosto = Object.keys(cliques).length || seguindo.size;
    const voce = assuntos(historias(base.filter(i => i.ts >= agora() - 48 * H)))
      .filter(livre)
      .filter(T => !temGosto || T.h.itens.some(i => (afin.f[i.f.id] || 0) > 0.15 || seguindo.has(i.f.id) || i.tm.some(t => (afin.t[t] || 0) > 0.3)))
      .slice(0, 6);
    voce.forEach(marca);
    P.insertAdjacentHTML("beforeend", `<section class="bloco b-voce"><h2>Para você</h2>`
      + (temGosto ? "" : `<p class="aviso">Siga jornais na Banca ou abra algumas notícias: esta parte aprende com o que você lê.</p>`)
      + voce.map(T => cartaoAssunto(T, {resumo: true})).join("") + `</section>`);
  }

  if (blocoLigado("videos")) {
    L.insertAdjacentHTML("beforeend", `<section class="bloco b-videos" id="b-videos"><h2>Vídeos em alta <a href="#videos">Ver todos ${ic("seta")}</a></h2><div class="vazio">Carregando…</div></section>`);
    videosEmAlta();
  }

  if (blocoLigado("espectro")) {
    const linhas = ALAS.map(([a, nm]) => {
      const T = assuntos(historias(base.filter(i => i.f.ala === a && i.ts >= agora() - 24 * H))).find(livre);
      if (!T) return "";
      marca(T);
      return cartaoNoticia(T.h.itens.find(i => i.f.ala === a), {thumb: false}).replace('<div class="fonte">', `<div class="rotulo r-${a}"><span class="ala"></span>${nm}</div><div class="fonte">`);
    }).join("");
    L.insertAdjacentHTML("beforeend", `<section class="bloco b-espectro linhas"><h2>Pelo espectro</h2>${linhas}</section>`);
  }

  if (blocoLigado("recentes")) {
    P.insertAdjacentHTML("beforeend", `<section class="bloco b-recentes"><h2>Mais recentes</h2><div id="recentes"></div></section>`);
    lista($("#recentes"), base, {fim: () => antigas()});
  }
  if (!c.querySelector("section")) c.innerHTML = `<p class="aviso">Todos os blocos do Início estão desligados. Ligue em Alertas e ajustes.</p>`;
}

// cidades: as do coletor (locais.json) e as que você adicionou
const listaCidades = () => cidades || (D.locais?.locais || []).map(l => ({nome: l.nome, lat: l.lat, lon: l.lon}));
async function noticiasDaCidade(c) {
  const doColetor = D.locais?.locais.find(l => l.nome === c.nome);
  if (doColetor && !c.busca) return doColetor.itens;
  const cache = le("cidade:" + c.nome, null);
  if (cache && Date.now() - cache.em < 30 * 60 * 1000) return cache.itens;
  const q = encodeURIComponent((c.busca || `"${c.nome}"`) + " when:7d");
  const f = lerFeed(await baixarTexto(`https://news.google.com/rss/search?q=${q}&hl=pt-BR&gl=BR&ceid=BR:pt-419`));
  const itens = (f?.itens || []).map(i => {
    const m = i.t.match(/^(.*) - ([^-]+)$/);
    return [m ? m[1] : i.t, i.u, i.ts || agora(), m ? m[2] : "Google Notícias"];
  }).slice(0, 20);
  guarda("cidade:" + c.nome, {em: Date.now(), itens});
  return itens;
}
async function locais() {
  const el = $("#locais");
  try { D.locais = D.locais || await baixar("locais.json"); } catch (e) { D.locais = {locais: []}; }
  if (!document.body.contains(el)) return;
  const cs = listaCidades();
  if (!cs.length) { el.innerHTML = `<h2>Notícias locais</h2><p class="aviso">Adicione cidades em Alertas e ajustes.</p>`; return; }
  let atual = le("local", cs[0].nome), aberto = false;
  const pinta = async () => {
    const c = cs.find(x => x.nome === atual) || cs[0];
    el.innerHTML = `<h2>Notícias locais <a href="#alertas/cidades">Cidades ${ic("seta")}</a></h2><div class="chips">${cs.map(x => `<button aria-pressed="${x.nome === c.nome}" data-l="${esc(x.nome)}">${esc(x.nome)}</button>`).join("")}</div><div class="its"><div class="vazio">Carregando…</div></div>`;
    rolaAte(el.querySelector(".chips [aria-pressed=true]"));
    let its;
    try { its = await noticiasDaCidade(c); } catch (e) {
      el.querySelector(".its").innerHTML = `<div class="vazio">${app ? "Não deu para buscar agora." : "Cidades adicionadas por você são buscadas pelo app do celular."}</div>`; return;
    }
    if (atual !== c.nome && cs.some(x => x.nome === atual)) return;
    const vis = its.slice(0, aberto ? 20 : 4);
    el.querySelector(".its").innerHTML = (vis.length ? vis.map(([t, u, ts, fonte]) => `<article class="n"><div class="fonte"><span class="ico-f">${inicial(fonte)}</span><span class="nm">${esc(fonte)}</span></div>`
        + `<h3><a href="${esc(/^https?:\/\//.test(u) ? u : "#")}" target="_blank" rel="noopener">${esc(t)}</a></h3><div class="meta">${quando(ts)}</div></article>`).join("")
        : `<div class="vazio">Nada nos últimos 7 dias.</div>`)
      + (its.length > 4 ? `<button class="mostrar-mais">${aberto ? "Mostrar menos" : `Mostrar mais (${its.length})`}</button>` : "");
  };
  el.onclick = e => {
    const b = e.target.closest("[data-l]");
    if (b) { atual = b.dataset.l; guarda("local", atual); aberto = false; pinta(); }
    if (e.target.closest(".mostrar-mais")) { aberto = !aberto; pinta(); }
  };
  pinta();
}

// clima (Open-Meteo, sem cadastro), da cidade escolhida em Ajustes
async function clima() {
  const el = $("#clima");
  try {
    D.locais = D.locais || await baixar("locais.json");
    const c = listaCidades().find(l => l.nome === cfg.cidade && l.lat != null);
    if (!c || !el) return;
    let w = le("clima", null);
    if (!w || w.cidade !== c.nome || Date.now() - w.em > 30 * 60 * 1000) {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&current=temperature_2m,weather_code&timezone=America%2FSao_Paulo`);
      const j = await r.json();
      w = {cidade: c.nome, t: Math.round(j.current.temperature_2m), cod: j.current.weather_code, em: Date.now()};
      guarda("clima", w);
    }
    const [nome, simb] = w.cod >= 95 ? ["Tempestade", "raio"] : w.cod >= 51 ? ["Chuva", "chuva"] : w.cod >= 45 ? ["Neblina", "nuvem"]
      : w.cod >= 2 ? ["Nublado", "nuvem"] : w.cod === 1 ? ["Poucas nuvens", "sol"] : ["Céu limpo", "sol"];
    if (!document.body.contains(el)) return;
    el.innerHTML = `${ic(simb)}<div><b>${w.t} °C</b><span>${nome}<br>${esc(c.nome)}</span></div>`;
    el.setAttribute("aria-label", `${w.t} graus, ${nome}, em ${c.nome}. Mudar cidade`);
    el.hidden = false;
  } catch (e) { /* sem clima: segue sem o quadro */ }
}

// ---------- vídeos ----------
async function carregarVideos() {
  if (D.videos) return D.videos;
  const d = await baixar("videos.json");
  D.videos = d.itens.map(([t, id, ts, ci, v, s]) => ({t, id, ts, c: d.canais[ci], v, s, k: norm(t + " " + d.canais[ci].nome)}))
    .filter(x => /^[\w-]{11}$/.test(x.id));
  D.canais = d.canais;
  return D.videos;
}
const notaVideo = x => (x.v + 50) / Math.pow((agora() - x.ts) / H + 2, 1.4);
const visualiz = v => v >= 1e6 ? (v / 1e6).toFixed(1).replace(".", ",").replace(",0", "") + " mi" : v >= 1e3 ? Math.round(v / 1e3) + " mil" : String(v);
function cartaoVideo(x) {
  return `<a class="video" href="https://www.youtube.com/watch?v=${x.id}" target="_blank" rel="noopener">`
    + `<span class="capa"><img src="https://i.ytimg.com/vi/${x.id}/mqdefault.jpg" alt="" loading="lazy">${x.s ? '<span class="selo">Short</span>' : ""}</span>`
    + `<span class="vt">${esc(x.t)}</span>`
    + `<span class="vm"><img src="ico/${esc(x.c.id)}.jpg" alt="" loading="lazy" onerror="this.remove()"><span class="ala r-${x.c.ala}"></span>${esc(x.c.nome)}</span>`
    + `<span class="vm2">${quando(x.ts)}${x.v ? ` · ${visualiz(x.v)} visualizações` : ""}</span></a>`;
}
async function videosEmAlta() {
  const el = $("#b-videos");
  try { await carregarVideos(); } catch (e) { el?.remove(); return; }
  if (!el || !document.body.contains(el)) return;
  const top = D.videos.filter(x => !x.s && x.ts >= agora() - 48 * H).sort((a, b) => notaVideo(b) - notaVideo(a));
  const um = [], canais = new Set();
  for (const x of top) { if (!canais.has(x.c.id)) { um.push(x); canais.add(x.c.id); } if (um.length === 8) break; }  // um por canal
  el.querySelector(".vazio").outerHTML = `<div class="faixa-videos">${um.map(cartaoVideo).join("")}</div>`;
}
let filtroVideos = {alas: new Set(), ordem: "rel", shorts: le("shorts", true), canal: "", q: ""};
async function vVideos() {
  $("#vista").innerHTML = cabecalho("Vídeos", "Canais de notícias no YouTube") + `<div class="vazio">Carregando…</div>`;
  try { await carregarVideos(); } catch (e) { $("#vista .vazio").textContent = "Sem conexão."; return; }
  const f = filtroVideos;
  const pinta = () => {
    const q = termos(f.q);
    let vs = D.videos.filter(x => (!f.alas.size || f.alas.has(x.c.ala)) && (f.shorts || !x.s) && (!f.canal || x.c.id === f.canal) && q.every(t => x.k.includes(t)));
    if (f.ordem === "rel") vs = vs.sort((a, b) => notaVideo(b) - notaVideo(a));
    $("#vlista").innerHTML = vs.length ? vs.slice(0, 120).map(cartaoVideo).join("") : `<div class="vazio">Nenhum vídeo com esses filtros.</div>`;
    $("#vcont").textContent = `${vs.length} vídeos`;
  };
  $("#vista").innerHTML = cabecalho("Vídeos", `${D.canais.filter(c => c.n).length} canais de notícias no YouTube`)
    + `<label class="campo-busca">${ic("busca")}<input type="search" id="vq" placeholder="Buscar vídeos" aria-label="Buscar vídeos" value="${esc(f.q)}"></label>`
    + `<div class="chips" id="valas"><button data-a="" aria-pressed="${!f.alas.size}">Todas</button>${ALAS.map(([a, n]) => `<button data-a="${a}" aria-pressed="${f.alas.has(a)}"><span class="ala r-${a}" style="display:inline-block;margin-right:6px"></span>${n}</button>`).join("")}</div>`
    + `<div class="ferr"><div class="seg" role="group" aria-label="Ordenar"><button data-o="rel" aria-pressed="${f.ordem === "rel"}">Em alta</button><button data-o="data" aria-pressed="${f.ordem === "data"}">Mais recentes</button></div>`
    + `<select id="vcanal" class="sel" aria-label="Canal"><option value="">Todos os canais</option>${ALAS.map(([a, n]) => `<optgroup label="${n}">${D.canais.filter(c => c.ala === a && c.n).map(c => `<option value="${esc(c.id)}" ${f.canal === c.id ? "selected" : ""}>${esc(c.nome)}</option>`).join("")}</optgroup>`).join("")}</select>`
    + `<label class="mini"><input type="checkbox" id="vshorts" class="chave" ${f.shorts ? "checked" : ""}>Shorts</label><span class="cont" id="vcont"></span></div>`
    + `<div class="grade-videos" id="vlista"></div>`;
  $("#valas").onclick = e => { const b = e.target.closest("button"); if (!b) return; const a = b.dataset.a; if (!a) f.alas.clear(); else f.alas.has(a) ? f.alas.delete(a) : f.alas.add(a); vVideos(); };
  $(".ferr").onclick = e => { const b = e.target.closest("[data-o]"); if (b) { f.ordem = b.dataset.o; vVideos(); } };
  $("#vcanal").onchange = e => { f.canal = e.target.value; pinta(); };
  $("#vshorts").onchange = e => { f.shorts = e.target.checked; guarda("shorts", f.shorts); pinta(); };
  let espera;
  $("#vq").oninput = e => { clearTimeout(espera); espera = setTimeout(() => { f.q = e.target.value; pinta(); }, 140); };
  pinta();
}

// feed genérico: ordem, filtros e lista
function feed(el, f, {semFontes} = {}) {
  filtroAtual = f;
  const pinta = () => {
    const ativos = [];
    if (f.periodo) ativos.push(["periodo", {24: "Últimas 24 h", 72: "3 dias", 168: "7 dias", 720: "30 dias"}[f.periodo] || f.periodo + " h"]);
    for (const a of f.alas) ativos.push(["ala:" + a, NOME_ALA[a]]);
    if (f.pais !== "") ativos.push(["pais", D.paises[f.pais]]);
    el.innerHTML = `<div class="ferr"><div class="seg" role="group" aria-label="Ordenar">`
      + `<button data-o="rel" aria-pressed="${f.ordem === "rel"}">Relevância</button><button data-o="data" aria-pressed="${f.ordem === "data"}">Mais recentes</button></div>`
      + `<button class="btn ${ativos.length ? "sel" : ""}" data-filtros>${ic("filtro")}Filtros${ativos.length ? ` (${ativos.length})` : ""}</button><span class="cont" aria-live="polite"></span></div>`
      + (ativos.length ? `<div class="filtros-ativos">${ativos.map(([k, n]) => `<button data-tira="${k}" aria-label="Tirar filtro ${esc(n)}">${esc(n)} ${ic("fechar")}</button>`).join("")}</div>` : "")
      + `<div class="lista"></div>`;
    const its = filtrar(f);
    const rel = f.ordem === "rel";
    const itens = rel ? assuntos(historias(its)) : its;
    const n = itens.length, pal = rel ? (n === 1 ? "assunto" : "assuntos") : (n === 1 ? "notícia" : "notícias");
    el.querySelector(".cont").textContent = `${n.toLocaleString("pt-BR")} ${pal}${D.antigas ? "" : " · últimos 3 dias"}`;
    lista(el.querySelector(".lista"), itens, {resumo: true, desenha: rel ? T => cartaoAssunto(T, {resumo: true}) : null, fim: () => antigas().then(novas => novas && pinta())});
  };
  el.onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.o) { f.ordem = b.dataset.o; pinta(); }
    else if ("filtros" in b.dataset) abrirFiltros(f, pinta, semFontes);
    else if (b.dataset.tira) {
      const k = b.dataset.tira;
      if (k === "periodo") f.periodo = 0; else if (k === "pais") f.pais = ""; else f.alas.delete(k.slice(4));
      pinta();
    }
  };
  if (f.q || f.fontes || f.periodo > 72) antigas().then(novas => novas && pinta());
  pinta();
}

function abrirFiltros(f, depois, semFontes) {
  const d = $("#folha");
  const paisesComNoticia = [...new Set(D.itens.flatMap(i => i.p))].sort((a, b) => D.paises[a].localeCompare(D.paises[b]));
  d.innerHTML = `<form method="dialog"><div class="f-cab"><h2>Filtros</h2><button class="btn-i" value="x" aria-label="Fechar">${ic("fechar")}</button></div><div class="f-corpo">`
    + `<h3>Período</h3><div class="opcoes">${[[0, "Tudo"], [24, "24 h"], [72, "3 dias"], [168, "7 dias"], [720, "30 dias"]].map(([h, n]) => `<label><input type="radio" name="periodo" value="${h}" ${+f.periodo === h ? "checked" : ""}>${n}</label>`).join("")}</div>`
    + (semFontes ? "" : `<h3>Linha editorial</h3><div class="opcoes">${ALAS.map(([a, n]) => `<label><input type="checkbox" name="ala" value="${a}" ${f.alas.has(a) ? "checked" : ""}><span class="ala r-${a}"></span>${n}</label>`).join("")}</div>`)
    + `<h3>País citado</h3><select name="pais"><option value="">Todos</option>${paisesComNoticia.map(p => `<option value="${p}" ${String(f.pais) === String(p) ? "selected" : ""}>${esc(D.paises[p])}</option>`).join("")}</select>`
    + `</div><div class="f-pe"><button class="btn" value="limpar">Limpar</button><button class="btn pri" value="ok">Aplicar</button></div></form>`;
  d.onclose = () => {
    if (d.returnValue === "x" || !d.returnValue) return;
    const fd = new FormData(d.querySelector("form"));
    if (d.returnValue === "limpar") { f.periodo = 0; f.alas.clear(); f.pais = ""; }
    else { f.periodo = +fd.get("periodo"); f.alas = new Set(fd.getAll("ala")); f.pais = fd.get("pais"); }
    if (f.periodo > 72 || f.periodo === 0) antigas();
    depois();
  };
  d.returnValue = ""; d.showModal();
}

// história: todos os veículos que deram o mesmo fato
function vHistoria(id) {
  const g = D.grupos.get(+id);
  if (!g) { $("#vista").innerHTML = `<button class="voltar" onclick="history.back()">${ic("voltar")}Voltar</button><div class="vazio">Essa história saiu da lista.</div>`; return; }
  const its = [...g.itens].sort((a, b) => a.ts - b.ts);
  const n = {}; for (const i of its) n[i.f.ala] = (n[i.f.ala] || 0) + 1;
  $("#vista").innerHTML = `<button class="voltar" onclick="history.back()">${ic("voltar")}Voltar</button>`
    + cabecalho(esc(historias(its)[0].rep.t), `${g.fontes.size} veículos · primeira notícia ${quando(its[0].ts)}`)
    + `<section class="bloco"><h2>Quem cobriu ${espectro(g, true)}</h2>`
    + ALAS.filter(([a]) => n[a]).map(([a, nm]) => `<div class="rotulo r-${a}" style="padding-top:16px"><span class="ala"></span>${nm} · ${n[a]}</div>`
      + its.filter(i => i.f.ala === a).map(i => cartaoNoticia(i, {resumo: true}).replace(/<a class="cob".*?<\/a>/, "")).join("")).join("")
    + `</section>`;
}

// busca
function vBusca() {
  const f = novoFiltro({ordem: "rel", q: le("ultimaBusca", "")});
  $("#vista").innerHTML = `<label class="campo-busca">${ic("busca")}<input type="search" id="q" placeholder="Buscar em todas as notícias" aria-label="Buscar (use aspas para frase exata)" autocomplete="off" enterkeyhint="search" value="${esc(f.q)}"><button class="btn-i" id="limpaq" aria-label="Limpar busca">${ic("fechar")}</button></label><div id="corpo"></div>`;
  const q = $("#q");
  let espera;
  const roda = () => { f.q = q.value.trim(); guarda("ultimaBusca", f.q); f.q ? feed($("#corpo"), f) : ($("#corpo").innerHTML = `<p class="rodape">Busca por palavras, sem acento obrigatório. Use "aspas" para frase exata.</p>`); };
  q.oninput = () => { clearTimeout(espera); espera = setTimeout(roda, 140); };
  q.onkeydown = e => e.key === "Enter" && q.blur();
  $("#limpaq").onclick = () => { q.value = ""; roda(); q.focus(); };
  roda(); if (!f.q) q.focus();
}

// ---------- coleções ----------
const CORES = ["#0a7471", "#9e1c22", "#c25570", "#2c4f8c", "#b7791f", "#5b4a9c", "#3d7a3a", "#555f5c"];
function colecoesTodas() {
  const pre = ALAS.map(([a, n]) => ({id: "ala-" + a, nome: n, fontes: D.lista.filter(f => f.ala === a).map(f => f.id), fixa: true, ala: a}));
  const seg = seguindo.size ? [{id: "seguindo", nome: "Jornais que sigo", fontes: [...seguindo], fixa: true}] : [];
  return [...seg, ...colecoes, ...pre];
}
function mosaico(c) {
  const fs = c.fontes.map(id => D.fontes[id]).filter(Boolean).slice(0, 4);
  const cor = c.ala ? `var(--${c.ala})` : c.cor || "var(--ac)";
  return `<div class="mosaico n${fs.length}" style="--cor:${cor}" aria-hidden="true">${fs.map(icone).join("")}</div>`;
}
function vColecoes() {
  const cs = colecoesTodas();
  const cartao = c => {
    const fs = c.fontes.map(id => D.fontes[id]).filter(Boolean);
    const ult = visiveis().find(i => c.fontes.includes(i.f.id) && (!c.temas?.length || c.temas.some(t => i.tm.includes(t))));
    return `<div class="cartao">${mosaico(c)}<div class="txt"><b>${esc(c.nome)}</b><span>${fs.length} ${fs.length === 1 ? "jornal" : "jornais"}${ult ? " · " + esc(ult.t) : ""}</span></div>`
      + `<a class="cobre" href="#colecao/${c.id}" aria-label="Abrir ${esc(c.nome)}"></a></div>`;
  };
  $("#vista").innerHTML = cabecalho("Coleções", "Grupos de jornais para ler juntos", `<button class="btn pri" id="nova">${ic("mais")}Nova coleção</button>`)
    + (colecoes.length || seguindo.size ? `<h2 class="secao">Suas coleções</h2><div class="cartoes">${cs.filter(c => !c.ala).map(cartao).join("")}</div>`
      : `<p class="aviso">Monte coleções com os jornais que quiser (por exemplo, "Imprensa mineira" ou "Economia"). No celular, elas aparecem também ao segurar o ícone do app.</p>`)
    + `<h2 class="secao">Por linha editorial</h2><div class="cartoes">${cs.filter(c => c.ala).map(cartao).join("")}</div>`;
  $("#nova").onclick = () => editarColecao();
}
function vColecao(id) {
  const c = colecoesTodas().find(x => x.id === id);
  if (!c) { location.hash = "#colecoes"; return; }
  $("#vista").innerHTML = `<button class="voltar" onclick="location.hash='#colecoes'">${ic("voltar")}Coleções</button>`
    + `<div class="perfil">${mosaico(c).replace('class="mosaico', 'class="mosaico grande')}<div style="flex:1;min-width:0"><h1>${esc(c.nome)}</h1><div class="sub">${c.fontes.length} jornais${c.temas?.length ? " · " + c.temas.map(t => esc(D.temas[t])).join(", ") : ""}</div></div>`
    + (c.fixa ? "" : `<button class="btn" id="editar">${ic("editar")}Editar</button>`) + `</div><div id="corpo"></div>`;
  $("#editar")?.addEventListener("click", () => editarColecao(c));
  feed($("#corpo"), novoFiltro({fontes: new Set(c.fontes), temas: c.temas || null}), {semFontes: true});
}
function marcarFontes(sel, nome = "fonte") {
  return `<input type="text" class="filtra-f" placeholder="Procurar jornal" aria-label="Procurar jornal">`
    + `<div class="marcar">${ALAS.map(([a, n]) => `<h3 class="r-${a}"><span class="ala"></span>${n}</h3>` + D.lista.filter(f => f.ala === a).map(f => `<label data-nome="${esc(norm(f.nome))}"><input type="checkbox" name="${nome}" value="${esc(f.id)}" ${sel.includes(f.id) ? "checked" : ""}>${icone(f)}${esc(f.nome)}</label>`).join("")).join("")}</div>`;
}
function ligarFiltroFontes(raiz) {
  raiz.querySelector(".filtra-f").oninput = e => { const q = norm(e.target.value); raiz.querySelectorAll(".marcar label").forEach(l => l.hidden = !l.dataset.nome.includes(q)); };
}
function editarColecao(c) {
  const d = $("#folha"), novo = !c;
  c = c || {id: "c" + Date.now().toString(36), nome: "", fontes: [], temas: [], cor: CORES[colecoes.length % CORES.length]};
  d.innerHTML = `<form method="dialog"><div class="f-cab"><h2>${novo ? "Nova coleção" : "Editar coleção"}</h2><button class="btn-i" value="x" aria-label="Fechar" formnovalidate>${ic("fechar")}</button></div><div class="f-corpo">`
    + `<h3>Nome</h3><input type="text" name="nome" required maxlength="40" value="${esc(c.nome)}" placeholder="Ex.: Imprensa mineira">`
    + `<h3>Cor</h3><div class="cores">${CORES.map(k => `<label style="--cor:${k}"><input type="radio" name="cor" value="${k}" ${c.cor === k ? "checked" : ""}><span class="sr">${k}</span></label>`).join("")}</div>`
    + `<h3>Só estes temas (opcional)</h3><div class="opcoes">${Object.entries(D.temas).map(([k, n]) => `<label><input type="checkbox" name="tema" value="${k}" ${c.temas?.includes(k) ? "checked" : ""}>${esc(n)}</label>`).join("")}</div>`
    + `<h3>Jornais</h3>${marcarFontes(c.fontes)}`
    + `</div><div class="f-pe">${novo ? "" : `<button class="btn" value="apagar" style="margin-right:auto;color:var(--perigo)" formnovalidate>Apagar</button>`}<button class="btn" value="x" formnovalidate>Cancelar</button><button class="btn pri" value="ok">Salvar</button></div></form>`;
  ligarFiltroFontes(d);
  d.onclose = () => {
    const fd = new FormData(d.querySelector("form"));
    if (d.returnValue === "apagar") { if (confirm(`Apagar a coleção "${c.nome}"?`)) { colecoes = colecoes.filter(x => x.id !== c.id); salvarColecoes(); location.hash = "#colecoes"; render(); } return; }
    if (d.returnValue !== "ok") return;
    Object.assign(c, {nome: fd.get("nome").trim() || "Sem nome", fontes: fd.getAll("fonte"), temas: fd.getAll("tema"), cor: fd.get("cor") || c.cor});
    if (novo) colecoes.push(c);
    salvarColecoes();
    if (novo) location.hash = "#colecao/" + c.id; else render();
  };
  d.returnValue = ""; d.showModal();
}
function salvarColecoes() {
  guarda("colecoes", colecoes);
  try { app?.atalhos?.(JSON.stringify(colecoes.slice(0, 3).map(c => ({id: c.id, nome: c.nome})))); } catch (e) {}
}

// ---------- banca ----------
function vBanca() {
  const hoje = {}; for (const i of D.itens) if (i.ts >= agora() - 24 * H) hoje[i.f.id] = (hoje[i.f.id] || 0) + 1;
  const ultima = {}; for (const i of D.itens) ultima[i.f.id] = ultima[i.f.id] || i;
  const cartao = f => `<div class="cartao${ocultos.has(f.id) ? " oculto" : ""}" data-nome="${esc(norm(f.nome + " " + f.site))}"><div class="ic">${icone(f)}</div>`
    + `<div class="txt"><b>${esc(f.nome)}${ocultos.has(f.id) ? ' <small>oculto</small>' : ""}</b><span>${hoje[f.id] ? `${hoje[f.id]} hoje · ` : ""}${ultima[f.id] ? esc(ultima[f.id].t) : "sem notícias recentes"}</span></div>`
    + `<a class="cobre" href="#fonte/${esc(f.id)}" aria-label="Abrir ${esc(f.nome)}"></a>`
    + `<button class="btn-i estrela acao" data-seguir="${esc(f.id)}" aria-pressed="${seguindo.has(f.id)}" aria-label="Seguir ${esc(f.nome)}">${ic("estrela")}</button></div>`;
  const seg = D.lista.filter(f => seguindo.has(f.id));
  const meus = D.lista.filter(f => f.propria);
  $("#vista").innerHTML = cabecalho("Banca", `${D.lista.length} jornais`, `<button class="btn pri" id="addsite">${ic("mais")}Adicionar site</button>`)
    + `<input type="search" class="busca-banca" placeholder="Procurar jornal" aria-label="Procurar jornal">`
    + (seg.length ? `<h2 class="secao">Seguindo</h2><div class="cartoes">${seg.map(cartao).join("")}</div>` : "")
    + (meus.length ? `<h2 class="secao">Sites que você adicionou</h2><div class="cartoes">${meus.map(cartao).join("")}</div>` : "")
    + ALAS.map(([a, n]) => `<h2 class="secao r-${a}"><span class="ala"></span>${n}</h2><div class="cartoes">${D.lista.filter(f => f.ala === a && !f.propria).map(cartao).join("")}</div>`).join("");
  $(".busca-banca").oninput = e => {
    const q = norm(e.target.value);
    document.querySelectorAll(".cartao[data-nome]").forEach(c => c.hidden = !c.dataset.nome.includes(q));
  };
  $("#addsite").onclick = adicionarSite;
}
function adicionarSite() {
  const d = $("#folha");
  d.innerHTML = `<form method="dialog"><div class="f-cab"><h2>Adicionar site</h2><button class="btn-i" value="x" aria-label="Fechar" formnovalidate>${ic("fechar")}</button></div><div class="f-corpo">`
    + `<p class="aviso">Cole o endereço do site ou do feed (RSS). O Radar procura o feed sozinho. Os sites que você adiciona são lidos pelo seu aparelho${app ? "" : " (no navegador do PC só funciona se o site permitir; no app do celular funciona sempre)"}.</p>`
    + `<h3>Endereço</h3><input type="text" name="url" required placeholder="ex.: jornalggn.com.br" inputmode="url" autocomplete="off">`
    + `<h3>Nome (opcional)</h3><input type="text" name="nome" maxlength="40" placeholder="Igual ao do site">`
    + `<h3>Linha editorial</h3><div class="opcoes">${ALAS.map(([a, n], k) => `<label><input type="radio" name="ala" value="${a}" ${k === 1 ? "checked" : ""}><span class="ala r-${a}"></span>${n}</label>`).join("")}</div>`
    + `<p id="estado-site" class="rodape" aria-live="polite"></p>`
    + `</div><div class="f-pe"><button class="btn" value="x" formnovalidate>Cancelar</button><button class="btn pri" value="ok" id="procurar">Procurar e adicionar</button></div></form>`;
  const form = d.querySelector("form");
  form.onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(form), est = $("#estado-site"), b = $("#procurar");
    b.disabled = true; est.textContent = "Procurando o feed…";
    const r = await descobrirFeed(fd.get("url"));
    b.disabled = false;
    if (!r) { est.textContent = "Não achei um feed nesse endereço. Tente o endereço do feed (geralmente termina em /feed ou /rss)."; return; }
    const site = new URL(r.feed).hostname.replace(/^www\./, "");
    const p = {id: "p-" + site.replace(/[^a-z0-9]/g, ""), nome: fd.get("nome").trim() || r.titulo.split(/\s[:|–—-]\s|:\s/)[0].trim().slice(0, 40) || site, ala: fd.get("ala"), site, feed: r.feed};
    if (D.fontes[p.id] && !D.fontes[p.id].propria || proprias.some(x => x.id === p.id)) { est.textContent = "Esse site já está no Radar."; return; }
    proprias.push(p); guarda("proprias", proprias);
    cacheProprias[p.id] = {em: Math.floor(agora()), itens: r.itens.slice(0, 40).map(i => ({...i, ts: i.ts || Math.floor(agora())}))};
    guarda("propriasCache", cacheProprias);
    d.close();
    if (ultimoRecentes) juntar(ultimoRecentes, true);
    location.hash = "#fonte/" + p.id; render();
  };
  d.onclose = null; d.returnValue = ""; d.showModal();
}
function vFonte(id) {
  const f = D.fontes[id];
  if (!f) { location.hash = "#banca"; return; }
  const mal = !f.propria && (!f.ok || agora() - f.ok > 86400);
  const oculto = ocultos.has(id);
  $("#vista").innerHTML = `<button class="voltar" onclick="location.hash='#banca'">${ic("voltar")}Banca</button>`
    + `<div class="perfil"><div class="ic">${icone(f)}</div><div style="flex:1;min-width:0"><h1>${esc(f.nome)}</h1>`
    + `<div class="sub"><span class="rotulo r-${f.ala}" style="font-size:.66rem"><span class="ala"></span>${NOME_ALA[f.ala]}</span><a href="https://${esc(f.site)}" target="_blank" rel="noopener">${esc(f.site)}</a>${mal ? `<span style="color:var(--perigo)">coleta falhando${f.ok ? " desde " + quando(f.ok) : ""}</span>` : ""}</div></div></div>`
    + `<div class="acoes-fonte"><button class="btn estrela" data-seguir="${esc(f.id)}" aria-pressed="${seguindo.has(f.id)}">${ic("estrela")}${seguindo.has(f.id) ? "Seguindo" : "Seguir"}</button>`
    + `<button class="btn" id="ocultar">${oculto ? "Mostrar nas listas" : "Ocultar das listas"}</button>`
    + (f.propria ? `<button class="btn" id="remover" style="color:var(--perigo)">Remover site</button>` : "") + `</div>`
    + (oculto ? `<p class="aviso">Este jornal está oculto: não aparece no Início, nas coleções nem na busca.</p>` : "")
    + `<div id="corpo"></div>`;
  $("#ocultar").onclick = () => { oculto ? ocultos.delete(id) : ocultos.add(id); guarda("ocultos", [...ocultos]); vFonte(id); };
  $("#remover")?.addEventListener("click", () => {
    if (!confirm(`Remover "${f.nome}" do Radar?`)) return;
    proprias = proprias.filter(p => p.id !== id); guarda("proprias", proprias);
    delete cacheProprias[id]; guarda("propriasCache", cacheProprias);
    delete D.fontes[id];
    if (ultimoRecentes) juntar(ultimoRecentes, true);
    location.hash = "#banca";
  });
  feed($("#corpo"), novoFiltro({fontes: new Set([id])}), {semFontes: true});
}

// ---------- alertas e ajustes ----------
function fontesQueMaisLeio() {
  return Object.entries(cliques).filter(([id, n]) => n >= 2 && D.fontes[id]).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id);
}
function fontesDosAlertas() {
  const auto = new Set([...fontesQueMaisLeio(), ...seguindo]), esc_ = new Set(alertas.escolhidos);
  return [...(alertas.modo === "auto" ? auto : alertas.modo === "escolhidos" ? esc_ : new Set([...auto, ...esc_]))].filter(id => !ocultos.has(id));
}
function enviarAlertas() {
  if (!app) return;
  const nivel = {grandes: 6, importantes: 3, tudo: 1}[alertas.nivel];
  try {
    app.salvarAlertas(JSON.stringify({ativo: alertas.ativo, fontes: fontesDosAlertas(), minFontes: nivel,
      qualquer: alertas.qualquer ? {nf: 8, na: 3} : null, temas: alertas.temas, silencio: alertas.silencio ? [alertas.de, alertas.ate] : null,
      maxDia: alertas.maxDia, intervalo: alertas.intervalo}));
  } catch (e) {}
}
function vAlertas(parte) {
  const permissao = app?.permissao ? app.permissao() : "";
  const top = fontesQueMaisLeio();
  const op = (v, l, sel) => `<option value="${esc(v)}" ${String(sel) === String(v) ? "selected" : ""}>${esc(l)}</option>`;
  const horas = sel => Array.from({length: 24}, (_, h) => op(h, h + "h", sel)).join("");
  const temas = alertas.temas || Object.keys(D.temas);
  const versaoApp = app?.versao ? app.versao() : "";
  const cs = listaCidades();
  $("#vista").innerHTML = cabecalho("Alertas e ajustes") + `<form class="ajustes" id="aj" onsubmit="return false">`
    + (app ? (permissao === "negada" ? `<p class="aviso">O Android está bloqueando as notificações do Radar. <button class="btn" type="button" id="permitir">Permitir</button></p>` : "")
      : `<p class="aviso">As notificações funcionam no app do celular (Android). Aqui no navegador você pode deixar tudo configurado, mas os avisos só chegam pelo app.</p>`)
    + `<section class="grupo"><h2>Notificações</h2>`
    + `<label class="op"><span class="t"><b>Receber notificações</b><span>Avisa quando sai uma notícia relevante dos jornais escolhidos.</span></span><input type="checkbox" class="chave" name="ativo" ${alertas.ativo ? "checked" : ""}></label>`
    + `<label class="op"><span class="t"><b>Notícias muito grandes de qualquer jornal</b><span>8 ou mais veículos, de 3 linhas editoriais diferentes.</span></span><input type="checkbox" class="chave" name="qualquer" ${alertas.qualquer ? "checked" : ""}></label>`
    + `<label class="op"><span class="t"><b>Verificar a cada</b></span><select name="intervalo">${op(15, "15 min", alertas.intervalo)}${op(30, "30 min", alertas.intervalo)}${op(60, "1 hora", alertas.intervalo)}${op(120, "2 horas", alertas.intervalo)}</select></label>`
    + `<label class="op"><span class="t"><b>Máximo por dia</b></span><select name="maxDia">${[3, 6, 10, 20].map(n => op(n, n, alertas.maxDia)).join("")}${op(999, "Sem limite", alertas.maxDia)}</select></label>`
    + `<label class="op"><span class="t"><b>Horário de silêncio</b><span>Nada de notificação nesse intervalo.</span></span><input type="checkbox" class="chave" name="silencio" ${alertas.silencio ? "checked" : ""}></label>`
    + `<div class="op" ${alertas.silencio ? "" : "hidden"} id="horas"><span class="t"><b>Das</b></span><span style="display:flex;gap:8px;align-items:center"><select name="de" aria-label="Início do silêncio">${horas(alertas.de)}</select> às <select name="ate" aria-label="Fim do silêncio">${horas(alertas.ate)}</select></span></div>`
    + (app ? `<div class="op"><span class="t"><b>Testar</b><span>Manda uma notificação de exemplo agora.</span></span><button class="btn" type="button" id="testar">Enviar teste</button></div>` : "")
    + `</section>`
    + `<section class="grupo"><h2>Quando avisar</h2>`
    + [["grandes", "Só grandes notícias", "O mesmo fato em 6 ou mais veículos."], ["importantes", "Notícias importantes", "O mesmo fato em 3 ou mais veículos."], ["tudo", "Tudo dos jornais escolhidos", "Cada notícia nova deles (pode ser muita coisa)."]]
      .map(([v, b, s]) => `<label class="radio"><input type="radio" name="nivel" value="${v}" ${alertas.nivel === v ? "checked" : ""}><span><b>${b}</b><span>${s}</span></span></label>`).join("")
    + `</section>`
    + `<section class="grupo"><h2>De quais jornais</h2>`
    + [["auto", "Os que mais leio e os que sigo", "Escolhidos sozinhos pelo que você abre aqui."], ["escolhidos", "Só os que eu marcar abaixo", ""], ["ambos", "Os dois", ""]]
      .map(([v, b, s]) => `<label class="radio"><input type="radio" name="modo" value="${v}" ${alertas.modo === v ? "checked" : ""}><span><b>${b}</b>${s ? `<span>${s}</span>` : ""}</span></label>`).join("")
    + `<p style="color:var(--tx2);font-size:.82rem;margin:10px 0 4px">Os que mais leio agora:</p><div class="top-lidos">${top.length ? top.map(id => `<span>${icone(D.fontes[id])}${esc(D.fontes[id].nome)}</span>`).join("") : `<span style="background:none;padding:0;font-weight:400;color:var(--tx2)">ainda nenhum (abra algumas notícias)</span>`}</div>`
    + `<details class="sobre"><summary>Marcar jornais (${alertas.escolhidos.length})</summary>${marcarFontes(alertas.escolhidos, "escolhido")}</details>`
    + `</section>`
    + `<section class="grupo"><h2>Temas</h2><p>Só avisa sobre estes assuntos.</p><div class="opcoes" style="padding-bottom:14px">${Object.entries(D.temas).map(([k, n]) => `<label><input type="checkbox" name="tema" value="${k}" ${temas.includes(k) ? "checked" : ""}>${esc(n)}</label>`).join("")}</div></section>`
    + `<section class="grupo"><h2>Início</h2><p>Blocos que aparecem em Destaques.</p>${BLOCOS.map(([k, n]) => `<label class="op"><span class="t"><b>${n}</b></span><input type="checkbox" class="chave" name="bloco" value="${k}" ${blocoLigado(k) ? "checked" : ""}></label>`).join("")}</section>`
    + `<section class="grupo" id="cidades"><h2>Cidades</h2><p>Notícias locais e clima. ${app ? "" : "Cidades novas são buscadas pelo app do celular."}</p>`
    + `<ul class="lista-cidades">${cs.map(c => `<li><span>${esc(c.nome)}${c.uf ? ` <small>${esc(c.uf)}</small>` : ""}</span><button type="button" class="btn-i" data-tira-cidade="${esc(c.nome)}" aria-label="Tirar ${esc(c.nome)}">${ic("fechar")}</button></li>`).join("")}</ul>`
    + `<div class="add-cidade"><input type="text" id="nova-cidade" placeholder="Adicionar cidade (ex.: Diamantina)" autocomplete="off"><button type="button" class="btn" id="add-cidade">${ic("mais")}Adicionar</button></div><p id="estado-cidade" class="rodape" aria-live="polite"></p></section>`
    + `<section class="grupo"><h2>Aparência e atualização</h2>`
    + `<label class="op"><span class="t"><b>Tema</b></span><select name="tema_cor">${op("sistema", "Igual ao celular", cfg.tema)}${op("claro", "Claro", cfg.tema)}${op("escuro", "Escuro", cfg.tema)}</select></label>`
    + `<label class="op"><span class="t"><b>Tamanho da letra</b></span><select name="fs">${op(14, "Pequena", cfg.fs)}${op(16, "Normal", cfg.fs)}${op(18, "Grande", cfg.fs)}${op(20, "Maior", cfg.fs)}</select></label>`
    + `<label class="op"><span class="t"><b>Atualizar automaticamente</b><span>Busca notícias novas enquanto o app está aberto e quando você volta a ele.</span></span><input type="checkbox" class="chave" name="auto" ${cfg.auto ? "checked" : ""}></label>`
    + `<label class="op" ${cfg.auto ? "" : "hidden"} id="autoMin"><span class="t"><b>A cada</b></span><select name="autoMin">${op(5, "5 min", cfg.autoMin)}${op(15, "15 min", cfg.autoMin)}${op(30, "30 min", cfg.autoMin)}${op(60, "1 hora", cfg.autoMin)}</select></label>`
    + `<label class="op"><span class="t"><b>Cidade do clima</b></span><select name="cidade">${cs.filter(l => l.lat != null).map(l => op(l.nome, l.nome, cfg.cidade)).join("")}</select></label>`
    + `</section>`
    + `<section class="grupo"><details class="sobre"><summary>Como a relevância é medida</summary>`
    + `<p>Não dá para saber quantas pessoas leram cada notícia nos outros sites. Então o Radar mede assim:</p><ul>`
    + `<li><b>Cobertura:</b> quantos veículos diferentes deram o mesmo fato. O coletor junta títulos que falam da mesma coisa (palavras raras em comum).</li>`
    + `<li><b>Espectro:</b> se o fato aparece em várias linhas editoriais (esquerda, imprensa burguesa, direita), pesa mais.</li>`
    + `<li><b>Frescor:</b> a nota cai pela metade a cada 8 horas.</li>`
    + `<li><b>Você:</b> jornais e temas que você mais abre, e os que segue, sobem. Isso fica só neste aparelho.</li>`
    + `<li><b>Sem repetição:</b> fatos diferentes do mesmo assunto (ex.: "Fachin diz que o STF julga a dosimetria" e "Alcolumbre pede a Moraes o julgamento") aparecem juntos, num item só.</li>`
    + `<li><b>Vídeos:</b> visualizações divididas pelo tempo desde a publicação.</li></ul>`
    + `<p>Coleta de hora em hora. Última: ${new Date(D.gerado * 1000).toLocaleString("pt-BR", {dateStyle: "short", timeStyle: "short"})}.${versaoApp ? " App versão " + esc(versaoApp) + "." : ""}</p></details></section>`
    + `</form>`;
  const form = $("#aj");
  ligarFiltroFontes(form);
  form.onchange = e => {
    if (e.target.matches(".filtra-f, #nova-cidade")) return;
    const fd = new FormData(form);
    Object.assign(alertas, {ativo: fd.has("ativo"), qualquer: fd.has("qualquer"), intervalo: +fd.get("intervalo"), maxDia: +fd.get("maxDia"),
      silencio: fd.has("silencio"), de: +fd.get("de"), ate: +fd.get("ate"), nivel: fd.get("nivel"), modo: fd.get("modo"),
      escolhidos: fd.getAll("escolhido"), temas: fd.getAll("tema").length === Object.keys(D.temas).length ? null : fd.getAll("tema")});
    const ligados = new Set(fd.getAll("bloco"));
    Object.assign(cfg, {tema: fd.get("tema_cor"), fs: +fd.get("fs"), auto: fd.has("auto"), autoMin: +fd.get("autoMin"), cidade: fd.get("cidade") || cfg.cidade,
      blocos: Object.fromEntries(BLOCOS.map(([k]) => [k, ligados.has(k)]))});
    $("#horas").hidden = !alertas.silencio; $("#autoMin").hidden = !cfg.auto;
    form.querySelector("details summary").textContent = `Marcar jornais (${alertas.escolhidos.length})`;
    guarda("alertas", alertas); guarda("cfg", cfg); aplicarAparencia(); agendarAuto();
    if (e.target.name === "ativo" && alertas.ativo && app?.pedirPermissao) app.pedirPermissao();
    enviarAlertas();
  };
  form.onclick = e => {
    const t = e.target.closest("[data-tira-cidade]");
    if (t) { cidades = listaCidades().filter(c => c.nome !== t.dataset.tiraCidade); guarda("cidades", cidades); vAlertas("cidades"); }
  };
  $("#add-cidade").onclick = adicionarCidade;
  $("#nova-cidade").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); adicionarCidade(); } };
  $("#testar")?.addEventListener("click", () => app.testar());
  $("#permitir")?.addEventListener("click", () => app.pedirPermissao());
  if (parte === "cidades") $("#cidades").scrollIntoView();
}
async function adicionarCidade() {
  const nome = $("#nova-cidade").value.trim(), est = $("#estado-cidade");
  if (!nome) return;
  est.textContent = "Procurando…";
  try {
    const j = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(nome)}&count=5&language=pt&countryCode=BR`)).json();
    const r = (j.results || [])[0];
    if (!r) { est.textContent = "Não achei essa cidade no Brasil."; return; }
    const c = {nome: r.name, uf: r.admin1 || "", lat: +r.latitude.toFixed(2), lon: +r.longitude.toFixed(2), busca: `"${r.name}"`};
    cidades = listaCidades().filter(x => x.nome !== c.nome).concat(c);
    guarda("cidades", cidades); guarda("local", c.nome);
    vAlertas("cidades");
  } catch (e) { est.textContent = "Sem conexão para procurar a cidade."; }
}

// ---------- eventos globais ----------
document.addEventListener("click", e => {
  const a = e.target.closest("a[data-f]");
  if (a) {  // aprende o que você lê (só neste aparelho)
    cliques[a.dataset.f] = (cliques[a.dataset.f] || 0) + 1; guarda("cliques", cliques);
    for (const t of (a.dataset.tm || "").split(" ").filter(Boolean)) cliquesTema[t] = (cliquesTema[t] || 0) + 1;
    guarda("cliquesTema", cliquesTema);
    enviarAlertas();
  }
  const r = e.target.closest(".abre-relac");
  if (r) {
    const ul = r.nextElementSibling, aberto = r.getAttribute("aria-expanded") === "true";
    r.setAttribute("aria-expanded", !aberto); ul.hidden = aberto;
  }
  const s = e.target.closest("[data-seguir]");
  if (s) {
    const id = s.dataset.seguir;
    seguindo.has(id) ? seguindo.delete(id) : seguindo.add(id);
    guarda("seguindo", [...seguindo]);
    for (const b of document.querySelectorAll(`[data-seguir="${CSS.escape(id)}"]`)) {
      b.setAttribute("aria-pressed", seguindo.has(id));
      if (b.classList.contains("btn")) b.lastChild.textContent = seguindo.has(id) ? "Seguindo" : "Seguir";
    }
    enviarAlertas();
  }
});
$("#atualizar").onclick = () => { carregar(); atualizarProprias(true); };
$("#novidade").onclick = () => { window.scrollTo(0, 0); render(); };
window.addEventListener("hashchange", render);
// atalhos do ícone do app e widgets ("radar:busca", "radar:manchetes", "radar:colecao/ID") chegam como hash
function abrirHash(hash) {
  if (hash === "manchetes") { secao = "manchetes"; guarda("secao", secao); hash = "inicio"; }
  if (location.hash === "#" + hash) render(); else location.hash = "#" + hash;
}
window.radarAbrir = abrirHash;
if (location.hash === "#manchetes") { secao = "manchetes"; guarda("secao", secao); history.replaceState(null, "", "#inicio"); }

let relogio, saiu = 0;
function agendarAuto() {
  clearInterval(relogio);
  if (cfg.auto) relogio = setInterval(() => !document.hidden && carregar(true), cfg.autoMin * 60 * 1000);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) saiu = Date.now();
  else if (cfg.auto && saiu && Date.now() - saiu > 5 * 60 * 1000) carregar(true);
});
agendarAuto();
render();
carregar().then(() => { enviarAlertas(); salvarColecoes(); });
