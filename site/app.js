"use strict";
/* Radar Notícias. Os dados vêm prontos do coletor (recentes.json, antigas.json, locais.json);
   busca, filtros e relevância rodam aqui, na memória do aparelho. */

const ALAS = [["radical", "Esquerda radical"], ["moderada", "Esquerda moderada"], ["burguesa", "Imprensa burguesa"], ["direita", "Direita"]];
const NOME_ALA = Object.fromEntries(ALAS);
const LOTE = 30;
const H = 3600;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const agora = () => Date.now() / 1000;
const ic = (n, cls = "i") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;

// ---------- preferências (só neste aparelho) ----------
const le = (k, pad) => { try { const v = localStorage.getItem("radar2." + k); return v === null ? pad : JSON.parse(v); } catch (e) { return pad; } };
const guarda = (k, v) => { try { localStorage.setItem("radar2." + k, JSON.stringify(v)); } catch (e) {} };
const cfg = Object.assign({tema: "sistema", fs: 16, auto: true, autoMin: 15, cidade: "Araçuaí"}, le("cfg", {}));
const cliques = le("cliques", {}), cliquesTema = le("cliquesTema", {});
let seguindo = new Set(le("seguindo", []));
let colecoes = le("colecoes", []);
const alertas = Object.assign({ativo: false, modo: "ambos", escolhidos: [], nivel: "importantes", qualquer: true,
  temas: null, silencio: true, de: 22, ate: 7, maxDia: 6, intervalo: 30}, le("alertas", {}));
const visitaAnterior = le("visita", 0);
guarda("visita", Math.floor(agora()));

function aplicarAparencia() {
  const r = document.documentElement;
  if (cfg.tema === "sistema") delete r.dataset.tema; else r.dataset.tema = cfg.tema;
  r.style.setProperty("--fs", cfg.fs + "px");
}
aplicarAparencia();

// ---------- dados ----------
const D = {itens: [], fontes: {}, lista: [], paises: [], temas: {}, gerado: 0, antigas: false, grupos: new Map(), locais: null};
let carregandoAntigas = null;

async function baixar(nome) {
  const r = await fetch(nome, {cache: "no-cache"});  // revalida pela ETag: se nada mudou, não baixa de novo
  if (!r.ok) throw new Error(nome + " " + r.status);
  return r.json();
}

function juntar(d, limpar) {
  if (limpar) { D.itens = []; D.fontes = {}; }
  D.lista = d.fontes; D.paises = d.paises; D.temas = d.temas; D.gerado = Math.max(D.gerado, d.gerado);
  for (const f of d.fontes) D.fontes[f.id] = f;
  const vistos = new Set(D.itens.map(i => i.u));
  for (const [t, u, ts, fi, r, tm, p, g, im] of d.itens) {
    if (vistos.has(u) || !/^https?:\/\//.test(u)) continue;  // só links web (nada de javascript:)
    const f = d.fontes[fi], cods = tm.split(" ");
    D.itens.push({t, u, ts, f, r, tm: cods.filter(c => c.length === 3), rg: cods.find(c => c.length === 1) || "b",
      p, g, im, k: norm(t + " " + r + " " + f.nome)});
  }
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
    juntar(d, true);
    D.antigas = false; carregandoAntigas = null;
    if (silencioso && tinha && window.scrollY > 400) { $("#novidade").hidden = false; return; }
    render();
  } catch (e) {
    if (!D.itens.length) $("#vista").innerHTML = `<div class="vazio">Sem conexão. ${ic("atualizar")}<br><button class="btn" onclick="carregar()">Tentar de novo</button></div>`;
  } finally { b.classList.remove("girando"); }
}

// notícias com mais de 3 dias só são baixadas quando fazem falta (economiza dados)
function antigas() {
  if (D.antigas) return Promise.resolve(false);
  return carregandoAntigas = carregandoAntigas || baixar("antigas.json")
    .then(d => { juntar(d); D.antigas = true; return true; })
    .catch(() => { carregandoAntigas = null; return false; });
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
const nota = i => cobertura(i) * frescor(i.ts) * pessoal(i);

/** Junta os itens do mesmo fato em "histórias" e ordena por relevância. Cada história mostra o item mais interessante para você. */
function historias(itens) {
  const por = new Map();
  for (const i of itens) {
    const k = i.g ? "g" + i.g : i.u;
    let h = por.get(k);
    if (!h) por.set(k, h = {itens: [], grupo: grupoDe(i)});
    h.itens.push(i);
  }
  const lista = [];
  for (const h of por.values()) {
    const recente = Math.max(...h.itens.map(i => i.ts));
    h.rep = h.itens.reduce((a, b) => (pessoal(b) + (b.im ? 0.3 : 0) > pessoal(a) + (a.im ? 0.3 : 0) ? b : a));
    h.nota = cobertura(h.rep) * frescor(recente) * Math.max(...h.itens.map(pessoal));
    lista.push(h);
  }
  return lista.sort((a, b) => b.nota - a.nota);
}

// ---------- filtros ----------
function termos(q) {
  const ts = [];
  q = norm(q || "").replace(/"([^"]+)"/g, (_, f) => { ts.push(f.trim()); return " "; });
  return ts.concat(q.split(/\s+/).filter(Boolean));
}
function filtrar(f) {
  const lim = f.periodo ? agora() - f.periodo * H : 0, q = termos(f.q);
  return D.itens.filter(i => i.ts >= lim
    && (!f.fontes || f.fontes.has(i.f.id))
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
const inicial = nome => esc((nome.replace(/^[^A-Za-zÀ-ú0-9]+/, "")[0] || "?").toUpperCase());
const icone = f => `<img src="ico/${f.id}.png" alt="" loading="lazy" onerror="this.outerHTML='<span class=ico-f>${inicial(f.nome)}</span>'">`;
function espectro(g) {
  const n = {}; for (const i of g.itens) n[i.f.ala] = (n[i.f.ala] || 0) + 1;
  const tot = g.itens.length;
  const desc = ALAS.filter(([a]) => n[a]).map(([a, nm]) => `${n[a]} ${nm.toLowerCase()}`).join(", ");
  return `<span class="espectro" title="${esc(desc)}" aria-label="${esc(desc)}">${ALAS.filter(([a]) => n[a]).map(([a]) => `<i class="r-${a}" style="width:${100 * n[a] / tot}%"></i>`).join("")}</span>`;
}
function linhaFonte(i) {
  return `<div class="fonte">${icone(i.f)}<span class="ala r-${i.f.ala}" title="${NOME_ALA[i.f.ala]}"></span><span class="nm">${esc(i.f.nome)}</span></div>`;
}
function cartaoNoticia(i, {thumb = true, resumo = false, h} = {}) {
  const g = grupoDe(i);
  const cob = g && g.fontes.size > 1 ? `<a class="cob" href="#historia/${g.id}">${espectro(g)}${g.fontes.size} veículos</a>` : "";
  return `<article class="n">${linhaFonte(i)}<h3><a href="${esc(i.u)}" target="_blank" rel="noopener" data-f="${i.f.id}" data-tm="${i.tm.join(" ")}">${esc(i.t)}</a></h3>`
    + (resumo && i.r ? `<p class="res">${esc(i.r)}</p>` : "")
    + `<div class="meta">${i.ts > visitaAnterior && visitaAnterior ? '<span class="nova" title="Nova desde sua última visita"></span>' : ""}<span>${quando(i.ts)}</span>${cob}</div>`
    + (thumb && i.im ? `<img class="thumb" src="${esc(i.im)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "")
    + `</article>`;
}

// lista com rolagem infinita
function lista(el, itens, opts = {}) {
  let n = 0;
  const mais = document.createElement("div"); mais.className = "mais";
  const poe = () => {
    const fatia = itens.slice(n, n + LOTE); n += fatia.length;
    mais.insertAdjacentHTML("beforebegin", fatia.map(x => cartaoNoticia(x.rep || x, opts)).join(""));
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
    busca: vBusca, historia: vHistoria}[v] || vInicio)(arg);
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
  feed($("#corpo"), novoFiltro(base), {chave: "s-" + secao});
}

function destaques() {
  const c = $("#corpo");
  const dia = D.itens.filter(i => i.ts >= agora() - 24 * H);
  const hs = historias(dia.length > 60 ? dia : D.itens.filter(i => i.ts >= agora() - 48 * H));
  const princ = hs.slice(0, 6), usados = new Set(princ.flatMap(h => h.itens.map(i => i.u)));
  c.innerHTML = `<div class="grade"><div class="principal"></div><div class="lateral"></div></div>`;
  const P = c.querySelector(".principal"), L = c.querySelector(".lateral");

  // principais
  const lider = princ[0];
  let html = "";
  if (lider) {
    const rep = lider.itens.find(i => i.im && i === lider.rep) || lider.itens.find(i => i.im) || lider.rep;
    const outros = [], alasVistas = new Set([rep.f.ala]);
    for (const i of lider.itens) if (i !== rep && !alasVistas.has(i.f.ala) && outros.length < 3) { outros.push(i); alasVistas.add(i.f.ala); }
    for (const i of lider.itens) if (i !== rep && !outros.includes(i) && outros.length < 3) outros.push(i);
    html += `<div class="lider">${rep.im ? `<img class="foto" src="${esc(rep.im)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}`
      + cartaoNoticia(rep, {thumb: false}).replace("<h3>", '<h3 class="grande">')
      + `<div class="outros">${outros.map(i => cartaoNoticia(i, {thumb: false})).join("")}</div></div>`;
  }
  html += princ.slice(1).map(h => cartaoNoticia(h.rep)).join("");
  P.insertAdjacentHTML("beforeend", `<section class="bloco b-principais"><h2>Principais notícias <button data-ir="manchetes">Ver todas ${ic("seta")}</button></h2>${html}</section>`);

  // locais
  L.insertAdjacentHTML("beforeend", `<section class="bloco b-locais" id="locais"><h2>Notícias locais</h2><div class="vazio">Carregando…</div></section>`);
  locais();

  // para você
  const temGosto = Object.keys(cliques).length || seguindo.size;
  const voce = historias(D.itens.filter(i => i.ts >= agora() - 48 * H && !usados.has(i.u)))
    .filter(h => !temGosto || h.itens.some(i => (afin.f[i.f.id] || 0) > 0.15 || seguindo.has(i.f.id) || i.tm.some(t => (afin.t[t] || 0) > 0.3)))
    .slice(0, 6);
  voce.forEach(h => h.itens.forEach(i => usados.add(i.u)));
  P.insertAdjacentHTML("beforeend", `<section class="bloco b-voce"><h2>Para você</h2>`
    + (temGosto ? "" : `<p class="aviso">Siga jornais na Banca ou abra algumas notícias: esta parte aprende com o que você lê.</p>`)
    + voce.map(h => cartaoNoticia(h.rep, {resumo: true})).join("") + `</section>`);

  // pelo espectro: a notícia mais relevante de cada linha editorial
  const linhas = ALAS.map(([a, nm]) => {
    const h = historias(D.itens.filter(i => i.f.ala === a && i.ts >= agora() - 24 * H && !usados.has(i.u)))[0];
    return h ? cartaoNoticia(h.itens.find(i => i.f.ala === a), {thumb: false}).replace('<div class="fonte">', `<div class="rotulo r-${a}"><span class="ala"></span>${nm}</div><div class="fonte">`) : "";
  }).join("");
  L.insertAdjacentHTML("beforeend", `<section class="bloco b-espectro linhas"><h2>Pelo espectro</h2>${linhas}</section>`);

  // mais recentes
  P.insertAdjacentHTML("beforeend", `<section class="bloco b-recentes"><h2>Mais recentes</h2><div id="recentes"></div></section>`);
  lista($("#recentes"), D.itens, {fim: () => antigas()});
  c.querySelector("[data-ir]").onclick = () => { secao = "manchetes"; guarda("secao", secao); vInicio(); };
}

async function locais() {
  const el = $("#locais");
  try { D.locais = D.locais || await baixar("locais.json"); } catch (e) { el.remove(); return; }
  if (!document.body.contains(el)) return;
  let atual = le("local", D.locais.locais[0]?.nome), aberto = false;
  const pinta = () => {
    const l = D.locais.locais.find(x => x.nome === atual) || D.locais.locais[0];
    const its = l.itens.slice(0, aberto ? 20 : 4);
    el.innerHTML = `<h2>Notícias locais</h2><div class="chips">${D.locais.locais.map(x => `<button aria-pressed="${x.nome === l.nome}" data-l="${esc(x.nome)}">${esc(x.nome)}</button>`).join("")}</div>`
      + (its.length ? its.map(([t, u, ts, fonte]) => `<article class="n"><div class="fonte"><span class="ico-f">${inicial(fonte)}</span><span class="nm">${esc(fonte)}</span></div>`
        + `<h3><a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a></h3><div class="meta">${quando(ts)}</div></article>`).join("")
        : `<div class="vazio">Nada nos últimos 7 dias.</div>`)
      + (l.itens.length > 4 ? `<button class="mostrar-mais">${aberto ? "Mostrar menos" : `Mostrar mais (${l.itens.length})`}</button>` : "");
    rolaAte(el.querySelector(".chips [aria-pressed=true]"));
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
    const c = D.locais.locais.find(l => l.nome === cfg.cidade && l.lat != null);
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

// feed genérico: ordem, filtros e lista
function feed(el, f, {chave, semFontes} = {}) {
  filtroAtual = f;
  const pinta = () => {
    const ativos = [];
    if (f.periodo) ativos.push(["periodo", {24: "Últimas 24 h", 72: "3 dias", 168: "7 dias", 720: "30 dias"}[f.periodo] || f.periodo + " h"]);
    for (const a of f.alas) ativos.push(["ala:" + a, NOME_ALA[a]]);
    if (f.pais !== "") ativos.push(["pais", D.paises[f.pais]]);
    el.innerHTML = `<div class="ferr"><div class="seg" role="group" aria-label="Ordenar">`
      + `<button data-o="rel" aria-pressed="${f.ordem === "rel"}">Relevância</button><button data-o="data" aria-pressed="${f.ordem === "data"}">Mais recentes</button></div>`
      + `<button class="btn ${ativos.length ? "sel" : ""}" data-filtros>${ic("filtro")}Filtros${ativos.length ? ` (${ativos.length})` : ""}</button><span class="cont" aria-live="polite"></span></div>`
      + (ativos.length ? `<div class="filtros-ativos">${ativos.map(([k, n]) => `<button data-tira="${k}" aria-label="Tirar filtro ${esc(n)}">${esc(n)} ${ic("fechar", "i")}</button>`).join("")}</div>` : "")
      + `<div class="lista"></div>`;
    const its = filtrar(f);
    const itens = f.ordem === "rel" ? historias(its) : its;
    el.querySelector(".cont").textContent = `${itens.length.toLocaleString("pt-BR")} ${f.ordem === "rel" ? (itens.length === 1 ? "história" : "histórias") : (itens.length === 1 ? "notícia" : "notícias")}${D.antigas ? "" : " · últimos 3 dias"}`;
    lista(el.querySelector(".lista"), itens, {resumo: true, fim: () => antigas().then(novas => novas && pinta())});
    el.querySelectorAll(".lista svg.i").forEach(s => s.style.width = "18px");
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
    + `<section class="bloco"><h2>Quem cobriu ${espectro(g).replace('class="espectro"', 'class="espectro" style="width:120px;height:8px"')}</h2>`
    + ALAS.filter(([a]) => n[a]).map(([a, nm]) => `<div class="rotulo r-${a}" style="padding-top:16px"><span class="ala"></span>${nm} · ${n[a]}</div>`
      + its.filter(i => i.f.ala === a).map(i => cartaoNoticia(i, {resumo: true}).replace(/<a class="cob".*?<\/a>/, "")).join("")).join("")
    + `</section>`;
}

// busca
function vBusca() {
  const f = filtroAtual && vistaAtual === "#busca" && filtroAtual.q !== undefined ? filtroAtual : novoFiltro({ordem: "rel"});
  f.q = f.q || le("ultimaBusca", "");
  $("#vista").innerHTML = `<label class="campo-busca">${ic("busca")}<input type="search" id="q" placeholder="Buscar em todas as notícias" aria-label="Buscar (use aspas para frase exata)" autocomplete="off" enterkeyhint="search" value="${esc(f.q)}"><button class="btn-i" id="limpaq" aria-label="Limpar busca">${ic("fechar")}</button></label><div id="corpo"></div>`;
  const q = $("#q");
  let espera;
  const roda = () => { f.q = q.value.trim(); guarda("ultimaBusca", f.q); f.q ? feed($("#corpo"), f) : ($("#corpo").innerHTML = `<p class="rodape">Busca por palavras, sem acento obrigatório. Use "aspas" para frase exata.</p>`); };
  q.oninput = () => { clearTimeout(espera); espera = setTimeout(roda, 140); };
  q.onkeydown = e => e.key === "Enter" && q.blur();
  $("#limpaq").onclick = () => { q.value = ""; roda(); q.focus(); };
  roda(); if (!f.q) q.focus();
}

// coleções
function colecoesTodas() {
  const pre = ALAS.map(([a, n]) => ({id: "ala-" + a, nome: n, fontes: D.lista.filter(f => f.ala === a).map(f => f.id), fixa: true, ala: a}));
  const seg = seguindo.size ? [{id: "seguindo", nome: "Jornais que sigo", fontes: [...seguindo], fixa: true}] : [];
  return [...seg, ...colecoes, ...pre];
}
function vColecoes() {
  const cs = colecoesTodas();
  const cartao = c => {
    const fs = c.fontes.map(id => D.fontes[id]).filter(Boolean);
    const ult = D.itens.find(i => c.fontes.includes(i.f.id) && (!c.temas?.length || c.temas.some(t => i.tm.includes(t))));
    return `<div class="cartao"><div class="ic"><span class="pilha">${fs.slice(0, 3).map(icone).join("")}</span></div>`
      + `<div class="txt"><b>${c.ala ? `<span class="ala r-${c.ala}" style="display:inline-block;margin-right:6px"></span>` : ""}${esc(c.nome)}</b><span>${fs.length} ${fs.length === 1 ? "jornal" : "jornais"}${ult ? " · " + esc(ult.t) : ""}</span></div>`
      + `<a class="cobre" href="#colecao/${c.id}" aria-label="Abrir ${esc(c.nome)}"></a></div>`;
  };
  $("#vista").innerHTML = cabecalho("Coleções", "Grupos de jornais para ler juntos", `<button class="btn pri" id="nova">${ic("mais")}Nova coleção</button>`)
    + (colecoes.length || seguindo.size ? `<h2 class="secao">Suas coleções</h2><div class="cartoes">${cs.filter(c => !c.ala).map(cartao).join("")}</div>`
      : `<p class="aviso">Monte coleções com os jornais que quiser (por exemplo, "Imprensa mineira" ou "Economia"). Abaixo, as quatro linhas editoriais já prontas.</p>`)
    + `<h2 class="secao">Por linha editorial</h2><div class="cartoes">${cs.filter(c => c.ala).map(cartao).join("")}</div>`;
  $("#nova").onclick = () => editarColecao();
}
function vColecao(id) {
  const c = colecoesTodas().find(x => x.id === id);
  if (!c) { location.hash = "#colecoes"; return; }
  $("#vista").innerHTML = `<button class="voltar" onclick="location.hash='#colecoes'">${ic("voltar")}Coleções</button>`
    + cabecalho(esc(c.nome), `${c.fontes.length} jornais${c.temas?.length ? " · " + c.temas.map(t => D.temas[t]).join(", ") : ""}`,
      c.fixa ? "" : `<button class="btn" id="editar">${ic("editar")}Editar</button>`) + `<div id="corpo"></div>`;
  $("#editar")?.addEventListener("click", () => editarColecao(c));
  feed($("#corpo"), novoFiltro({fontes: new Set(c.fontes), temas: c.temas || null}), {semFontes: true});
}
function editarColecao(c) {
  const d = $("#folha"), novo = !c;
  c = c || {id: "c" + Date.now().toString(36), nome: "", fontes: [], temas: []};
  d.innerHTML = `<form method="dialog"><div class="f-cab"><h2>${novo ? "Nova coleção" : "Editar coleção"}</h2><button class="btn-i" value="x" aria-label="Fechar">${ic("fechar")}</button></div><div class="f-corpo">`
    + `<h3>Nome</h3><input type="text" name="nome" required maxlength="40" value="${esc(c.nome)}" placeholder="Ex.: Imprensa mineira">`
    + `<h3>Só estes temas (opcional)</h3><div class="opcoes">${Object.entries(D.temas).map(([k, n]) => `<label><input type="checkbox" name="tema" value="${k}" ${c.temas?.includes(k) ? "checked" : ""}>${esc(n)}</label>`).join("")}</div>`
    + `<h3>Jornais</h3><input type="text" id="filtra-f" placeholder="Procurar jornal" aria-label="Procurar jornal">`
    + `<div class="marcar">${ALAS.map(([a, n]) => `<h3 class="r-${a}"><span class="ala"></span>${n}</h3>` + D.lista.filter(f => f.ala === a).map(f => `<label data-nome="${esc(norm(f.nome))}"><input type="checkbox" name="fonte" value="${f.id}" ${c.fontes.includes(f.id) ? "checked" : ""}>${icone(f)}${esc(f.nome)}</label>`).join("")).join("")}</div>`
    + `</div><div class="f-pe">${novo ? "" : `<button class="btn" value="apagar" style="margin-right:auto;color:var(--perigo)" formnovalidate>Apagar</button>`}<button class="btn" value="x" formnovalidate>Cancelar</button><button class="btn pri" value="ok">Salvar</button></div></form>`;
  d.querySelector("#filtra-f").oninput = e => { const q = norm(e.target.value); d.querySelectorAll(".marcar label").forEach(l => l.hidden = !l.dataset.nome.includes(q)); };
  d.onclose = () => {
    const fd = new FormData(d.querySelector("form"));
    if (d.returnValue === "apagar") { if (confirm(`Apagar a coleção "${c.nome}"?`)) { colecoes = colecoes.filter(x => x.id !== c.id); guarda("colecoes", colecoes); location.hash = "#colecoes"; render(); } return; }
    if (d.returnValue !== "ok") return;
    Object.assign(c, {nome: fd.get("nome").trim() || "Sem nome", fontes: fd.getAll("fonte"), temas: fd.getAll("tema")});
    if (novo) colecoes.push(c);
    guarda("colecoes", colecoes);
    if (novo) location.hash = "#colecao/" + c.id; else render();
  };
  d.returnValue = ""; d.showModal();
}

// banca
function vBanca() {
  const hoje = {}; for (const i of D.itens) if (i.ts >= agora() - 24 * H) hoje[i.f.id] = (hoje[i.f.id] || 0) + 1;
  const ultima = {}; for (const i of D.itens) ultima[i.f.id] = ultima[i.f.id] || i;
  const cartao = f => `<div class="cartao" data-nome="${esc(norm(f.nome + " " + f.site))}"><div class="ic">${icone(f)}</div>`
    + `<div class="txt"><b>${esc(f.nome)}</b><span>${hoje[f.id] ? `${hoje[f.id]} hoje · ` : ""}${ultima[f.id] ? esc(ultima[f.id].t) : "sem notícias recentes"}</span></div>`
    + `<a class="cobre" href="#fonte/${f.id}" aria-label="Abrir ${esc(f.nome)}"></a>`
    + `<button class="btn-i estrela acao" data-seguir="${f.id}" aria-pressed="${seguindo.has(f.id)}" aria-label="Seguir ${esc(f.nome)}">${ic("estrela")}</button></div>`;
  const seg = D.lista.filter(f => seguindo.has(f.id));
  $("#vista").innerHTML = cabecalho("Banca", `${D.lista.length} jornais`)
    + `<input type="search" class="busca-banca" placeholder="Procurar jornal" aria-label="Procurar jornal">`
    + (seg.length ? `<h2 class="secao">Seguindo</h2><div class="cartoes">${seg.map(cartao).join("")}</div>` : "")
    + ALAS.map(([a, n]) => `<h2 class="secao r-${a}"><span class="ala"></span>${n}</h2><div class="cartoes">${D.lista.filter(f => f.ala === a).map(cartao).join("")}</div>`).join("");
  $(".busca-banca").oninput = e => {
    const q = norm(e.target.value);
    document.querySelectorAll(".cartao[data-nome]").forEach(c => c.hidden = !c.dataset.nome.includes(q));
  };
}
function vFonte(id) {
  const f = D.fontes[id];
  if (!f) { location.hash = "#banca"; return; }
  const mal = !f.ok || agora() - f.ok > 86400;
  $("#vista").innerHTML = `<button class="voltar" onclick="location.hash='#banca'">${ic("voltar")}Banca</button>`
    + `<div class="perfil"><div class="ic">${icone(f)}</div><div style="flex:1;min-width:0"><h1>${esc(f.nome)}</h1>`
    + `<div class="sub"><span class="rotulo r-${f.ala}" style="font-size:.66rem"><span class="ala"></span>${NOME_ALA[f.ala]}</span><a href="https://${esc(f.site)}" target="_blank" rel="noopener">${esc(f.site)}</a>${mal ? `<span style="color:var(--perigo)">coleta falhando${f.ok ? " desde " + quando(f.ok) : ""}</span>` : ""}</div></div>`
    + `<button class="btn estrela" data-seguir="${f.id}" aria-pressed="${seguindo.has(f.id)}">${ic("estrela")}${seguindo.has(f.id) ? "Seguindo" : "Seguir"}</button></div><div id="corpo"></div>`;
  feed($("#corpo"), novoFiltro({fontes: new Set([id])}), {semFontes: true});
}

// alertas e ajustes
const app = window.RadarApp;  // ponte com o app Android (não existe no navegador)
function fontesQueMaisLeio() {
  return Object.entries(cliques).filter(([id, n]) => n >= 2 && D.fontes[id]).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id);
}
function fontesDosAlertas() {
  const auto = new Set([...fontesQueMaisLeio(), ...seguindo]), esc_ = new Set(alertas.escolhidos);
  return [...(alertas.modo === "auto" ? auto : alertas.modo === "escolhidos" ? esc_ : new Set([...auto, ...esc_]))];
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
function vAlertas() {
  const permissao = app?.permissao ? app.permissao() : "";
  const top = fontesQueMaisLeio();
  const op = (v, l, sel) => `<option value="${v}" ${String(sel) === String(v) ? "selected" : ""}>${l}</option>`;
  const horas = sel => Array.from({length: 24}, (_, h) => op(h, h + "h", sel)).join("");
  const temas = alertas.temas || Object.keys(D.temas);
  const versaoApp = app?.versao ? app.versao() : "";
  $("#vista").innerHTML = cabecalho("Alertas e ajustes") + `<form class="ajustes" id="aj">`
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
    + `<details class="sobre"><summary>Marcar jornais (${alertas.escolhidos.length})</summary><div class="marcar">${ALAS.map(([a, n]) => `<h3 class="r-${a}"><span class="ala"></span>${n}</h3>` + D.lista.filter(f => f.ala === a).map(f => `<label><input type="checkbox" name="escolhido" value="${f.id}" ${alertas.escolhidos.includes(f.id) ? "checked" : ""}>${icone(f)}${esc(f.nome)}</label>`).join("")).join("")}</div></details>`
    + `</section>`
    + `<section class="grupo"><h2>Temas</h2><p>Só avisa sobre estes assuntos.</p><div class="opcoes" style="padding-bottom:14px">${Object.entries(D.temas).map(([k, n]) => `<label><input type="checkbox" name="tema" value="${k}" ${temas.includes(k) ? "checked" : ""}>${esc(n)}</label>`).join("")}</div></section>`
    + `<section class="grupo"><h2>Aparência e atualização</h2>`
    + `<label class="op"><span class="t"><b>Tema</b></span><select name="tema_cor">${op("sistema", "Igual ao celular", cfg.tema)}${op("claro", "Claro", cfg.tema)}${op("escuro", "Escuro", cfg.tema)}</select></label>`
    + `<label class="op"><span class="t"><b>Tamanho da letra</b></span><select name="fs">${op(14, "Pequena", cfg.fs)}${op(16, "Normal", cfg.fs)}${op(18, "Grande", cfg.fs)}${op(20, "Maior", cfg.fs)}</select></label>`
    + `<label class="op"><span class="t"><b>Atualizar automaticamente</b><span>Busca notícias novas enquanto o app está aberto e quando você volta a ele.</span></span><input type="checkbox" class="chave" name="auto" ${cfg.auto ? "checked" : ""}></label>`
    + `<label class="op" ${cfg.auto ? "" : "hidden"} id="autoMin"><span class="t"><b>A cada</b></span><select name="autoMin">${op(5, "5 min", cfg.autoMin)}${op(15, "15 min", cfg.autoMin)}${op(30, "30 min", cfg.autoMin)}${op(60, "1 hora", cfg.autoMin)}</select></label>`
    + `<label class="op"><span class="t"><b>Cidade do clima</b></span><select name="cidade">${(D.locais?.locais || [{nome: cfg.cidade, lat: 1}]).filter(l => l.lat != null).map(l => op(l.nome, l.nome, cfg.cidade)).join("")}</select></label>`
    + `</section>`
    + `<section class="grupo"><details class="sobre"><summary>Como a relevância é medida</summary>`
    + `<p>Não dá para saber quantas pessoas leram cada notícia nos outros sites. Então o Radar mede assim:</p><ul>`
    + `<li><b>Cobertura:</b> quantos veículos diferentes deram o mesmo fato. O coletor junta títulos que falam da mesma coisa (palavras raras em comum).</li>`
    + `<li><b>Espectro:</b> se o fato aparece em várias linhas editoriais (esquerda, imprensa burguesa, direita), pesa mais.</li>`
    + `<li><b>Frescor:</b> a nota cai pela metade a cada 8 horas.</li>`
    + `<li><b>Você:</b> jornais e temas que você mais abre, e os que segue, sobem. Isso fica só neste aparelho.</li></ul>`
    + `<p>Coleta de hora em hora. Última: ${new Date(D.gerado * 1000).toLocaleString("pt-BR", {dateStyle: "short", timeStyle: "short"})}.${versaoApp ? " App versão " + esc(versaoApp) + "." : ""}</p></details></section>`
    + `</form>`;
  const form = $("#aj");
  form.onchange = () => {
    const fd = new FormData(form);
    Object.assign(alertas, {ativo: fd.has("ativo"), qualquer: fd.has("qualquer"), intervalo: +fd.get("intervalo"), maxDia: +fd.get("maxDia"),
      silencio: fd.has("silencio"), de: +fd.get("de"), ate: +fd.get("ate"), nivel: fd.get("nivel"), modo: fd.get("modo"),
      escolhidos: fd.getAll("escolhido"), temas: fd.getAll("tema").length === Object.keys(D.temas).length ? null : fd.getAll("tema")});
    Object.assign(cfg, {tema: fd.get("tema_cor"), fs: +fd.get("fs"), auto: fd.has("auto"), autoMin: +fd.get("autoMin"), cidade: fd.get("cidade")});
    $("#horas").hidden = !alertas.silencio; $("#autoMin").hidden = !cfg.auto;
    form.querySelector("details summary").textContent = `Marcar jornais (${alertas.escolhidos.length})`;
    guarda("alertas", alertas); guarda("cfg", cfg); aplicarAparencia(); agendarAuto();
    if (alertas.ativo && app?.pedirPermissao) app.pedirPermissao();
    enviarAlertas();
  };
  $("#testar")?.addEventListener("click", () => app.testar());
  $("#permitir")?.addEventListener("click", () => app.pedirPermissao());
}

// ---------- eventos globais ----------
document.addEventListener("click", e => {
  const a = e.target.closest("a[data-f]");
  if (a) {  // aprende o que você lê (só neste aparelho)
    cliques[a.dataset.f] = (cliques[a.dataset.f] || 0) + 1; guarda("cliques", cliques);
    for (const t of a.dataset.tm.split(" ").filter(Boolean)) cliquesTema[t] = (cliquesTema[t] || 0) + 1;
    guarda("cliquesTema", cliquesTema);
    enviarAlertas();
  }
  const s = e.target.closest("[data-seguir]");
  if (s) {
    const id = s.dataset.seguir;
    seguindo.has(id) ? seguindo.delete(id) : seguindo.add(id);
    guarda("seguindo", [...seguindo]);
    for (const b of document.querySelectorAll(`[data-seguir="${id}"]`)) {
      b.setAttribute("aria-pressed", seguindo.has(id));
      if (b.classList.contains("btn")) b.lastChild.textContent = seguindo.has(id) ? "Seguindo" : "Seguir";
    }
    enviarAlertas();
  }
});
$("#atualizar").onclick = () => carregar();
$("#novidade").onclick = () => { window.scrollTo(0, 0); render(); };
window.addEventListener("hashchange", render);

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
carregar().then(enviarAlertas);
