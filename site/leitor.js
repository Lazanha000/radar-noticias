"use strict";
/* Leitor do Radar: abre a notícia aqui dentro, só com o texto (sem anúncios nem menus), com tema de leitura
   (claro, sépia, escuro, preto), letra, fonte, espaçamento e largura, e salva em PDF.
   O texto é extraído pelo Readability (o mesmo do modo leitura do Firefox). No app Android a página é baixada pela
   ponte RadarApp (sem bloqueio); no navegador, só funciona com sites que permitem (os outros abrem no site). */
(() => {
  const READABILITY = "https://cdn.jsdelivr.net/npm/@mozilla/readability@0.5.0/Readability.js";
  const PURIFY = "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js";
  const TEMAS = [["claro", "Claro"], ["sepia", "Sépia"], ["escuro", "Escuro"], ["preto", "Preto"]];
  const PAD = {tema: "sepia", fs: 19, fonte: "serif", entre: 1.65, larg: "normal"};
  const cache = new Map();
  let lt = Object.assign({}, PAD, le("leitor", {}));
  let aberto = null;
  const scripts = new Map();

  function carrega(src) {
    if (!scripts.has(src)) scripts.set(src, new Promise((ok, erro) => {
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => { scripts.delete(src); s.remove(); erro(new Error("sem internet para abrir o leitor")); };
      document.head.append(s);
    }));
    return scripts.get(src);
  }

  // O texto vem de sites de terceiros e entra nesta página (que tem a ponte com o app): passa pelo DOMPurify
  // (sem script, iframe, formulário, estilo, evento; só endereços http/https) e entra como nós, não como texto HTML.
  function limpar(html, base) {
    const frag = DOMPurify.sanitize(html, {
      RETURN_DOM_FRAGMENT: true, ALLOWED_URI_REGEXP: /^https?:/i,
      FORBID_TAGS: ["style", "form", "input", "button", "select", "textarea", "iframe", "object", "embed", "svg", "math", "video", "audio", "source"],
      FORBID_ATTR: ["style", "class", "id", "srcset", "sizes", "width", "height"]});
    for (const a of frag.querySelectorAll("a")) {
      let h = a.getAttribute("href") || "";
      try { h = new URL(h, base).href; } catch (e) { h = ""; }
      if (/^https?:/i.test(h)) { a.href = h; a.target = "_blank"; a.rel = "noopener noreferrer"; } else a.removeAttribute("href");
    }
    for (const img of frag.querySelectorAll("img")) {
      let src = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "";
      try { src = new URL(src, base).href; } catch (e) { src = ""; }
      if (!/^https?:/i.test(src)) { img.remove(); continue; }
      for (const at of [...img.attributes]) if (at.name.startsWith("data-")) img.removeAttribute(at.name);
      img.src = src; img.loading = "lazy"; img.referrerPolicy = "no-referrer"; img.alt = img.alt || "";
    }
    return frag;
  }

  async function extrair(url) {
    if (cache.has(url)) return cache.get(url);
    const [html] = await Promise.all([baixarTexto(url), carrega(READABILITY), carrega(PURIFY)]);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const b = doc.createElement("base"); b.href = url; doc.head.prepend(b);
    const r = new Readability(doc, {charThreshold: 300, keepClasses: false}).parse();
    if (!r || !r.content) throw new Error("não achei o texto");
    const res = {titulo: r.title, autor: r.byline, frag: limpar(r.content, url), texto: (r.textContent || "").trim(), site: r.siteName};
    cache.set(url, res);
    return res;
  }

  function aplicar() {
    const L = document.getElementById("leitor");
    if (!L) return;
    L.dataset.tema = lt.tema; L.dataset.fonte = lt.fonte; L.dataset.larg = lt.larg;
    L.style.setProperty("--lt-fs", lt.fs + "px"); L.style.setProperty("--lt-entre", lt.entre);
    guarda("leitor", lt);
    L.querySelectorAll("[data-lt-tema]").forEach(b => b.setAttribute("aria-pressed", b.dataset.ltTema === lt.tema));
    L.querySelectorAll("[data-lt-fonte]").forEach(b => b.setAttribute("aria-pressed", b.dataset.ltFonte === lt.fonte));
    L.querySelectorAll("[data-lt-entre]").forEach(b => b.setAttribute("aria-pressed", +b.dataset.ltEntre === lt.entre));
    L.querySelectorAll("[data-lt-larg]").forEach(b => b.setAttribute("aria-pressed", b.dataset.ltLarg === lt.larg));
    const t = L.querySelector(".lt-fs-v"); if (t) t.textContent = lt.fs;
  }

  function painel() {
    return `<div class="lt-painel" hidden>`
      + `<div class="lt-linha"><span>Fundo</span><div class="lt-temas">${TEMAS.map(([k, n]) => `<button data-lt-tema="${k}" class="lt-t-${k}" aria-label="${n}"><b>Aa</b><small>${n}</small></button>`).join("")}</div></div>`
      + `<div class="lt-linha"><span>Letra</span><div class="lt-seg"><button data-lt-fs="-1" aria-label="Diminuir letra">A−</button><span class="lt-fs-v"></span><button data-lt-fs="1" aria-label="Aumentar letra">A+</button></div></div>`
      + `<div class="lt-linha"><span>Fonte</span><div class="lt-seg"><button data-lt-fonte="serif" class="lt-serif">Serifa</button><button data-lt-fonte="sans" class="lt-sans">Sem serifa</button></div></div>`
      + `<div class="lt-linha"><span>Espaço</span><div class="lt-seg"><button data-lt-entre="1.45">Justo</button><button data-lt-entre="1.65">Normal</button><button data-lt-entre="1.9">Largo</button></div></div>`
      + `<div class="lt-linha"><span>Largura</span><div class="lt-seg"><button data-lt-larg="estreita">Estreita</button><button data-lt-larg="normal">Normal</button><button data-lt-larg="larga">Larga</button></div></div>`
      + `</div>`;
  }

  function fechar(deHistorico) {
    const L = document.getElementById("leitor");
    if (!L) return;
    L.remove(); document.body.classList.remove("lendo");
    aberto = null;
    if (!deHistorico && history.state?.leitor) history.back();
  }

  async function abrir(url, info = {}) {
    fechar(true);
    aberto = url;
    document.body.classList.add("lendo");
    if (!history.state?.leitor) history.pushState({leitor: 1}, "");
    const L = document.createElement("div");
    L.id = "leitor"; L.setAttribute("role", "dialog"); L.setAttribute("aria-modal", "true"); L.setAttribute("aria-label", "Leitor");
    const dataTxt = info.ts ? new Date(info.ts * 1000).toLocaleString("pt-BR", {day: "numeric", month: "long", hour: "2-digit", minute: "2-digit"}) : "";
    L.innerHTML = `<div class="lt-prog"><i></i></div>`
      + `<header class="lt-barra"><button class="lt-b" data-lt="fechar" aria-label="Voltar">${ic("voltar")}</button><span class="lt-nome">${esc(info.fonte || "")}</span>`
      + `<button class="lt-b" data-lt="aa" aria-label="Aparência da leitura" aria-expanded="false"><span class="lt-aa">Aa</span></button>`
      + `<button class="lt-b" data-lt="pdf" aria-label="Salvar em PDF"><span class="lt-pdf">PDF</span></button>`
      + `<button class="lt-b" data-lt="partilhar" aria-label="Compartilhar">${ic("partilhar")}</button>`
      + `<a class="lt-b" href="${esc(url)}" target="_blank" rel="noopener" aria-label="Abrir no site do jornal">${ic("externo")}</a></header>`
      + painel()
      + `<article class="lt-art"><div class="lt-fonte">${esc(info.fonte || "")}${dataTxt ? " · " + esc(dataTxt) : ""}</div>`
      + `<h1 class="lt-tit">${esc(info.titulo || "")}</h1><div class="lt-meta"></div>`
      + `<div class="lt-corpo"><div class="lt-carregando"><span></span>Abrindo o texto…</div></div>`
      + `<footer class="lt-pe"><a href="${esc(url)}" target="_blank" rel="noopener">Ler no site do jornal ${ic("externo")}</a>`
      + `<span>Texto extraído da página original de ${esc(info.fonte || new URL(url).hostname)}. Fotos, vídeos e gráficos podem faltar.</span></footer></article>`;
    document.body.append(L);
    aplicar();
    L.scrollTop = 0;
    L.addEventListener("scroll", () => {
      const max = L.scrollHeight - L.clientHeight;
      L.querySelector(".lt-prog i").style.width = (max > 0 ? 100 * L.scrollTop / max : 0) + "%";
    }, {passive: true});
    L.addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      const p = L.querySelector(".lt-painel");
      if (b.dataset.lt === "fechar") fechar();
      else if (b.dataset.lt === "aa") { p.hidden = !p.hidden; b.setAttribute("aria-expanded", !p.hidden); }
      else if (b.dataset.lt === "pdf") salvarPdf(info.titulo || document.title);
      else if (b.dataset.lt === "partilhar") partilhar(info.titulo || "", url);
      else if (b.dataset.ltTema) { lt.tema = b.dataset.ltTema; aplicar(); }
      else if (b.dataset.ltFs) { lt.fs = Math.min(30, Math.max(14, lt.fs + +b.dataset.ltFs)); aplicar(); }
      else if (b.dataset.ltFonte) { lt.fonte = b.dataset.ltFonte; aplicar(); }
      else if (b.dataset.ltEntre) { lt.entre = +b.dataset.ltEntre; aplicar(); }
      else if (b.dataset.ltLarg) { lt.larg = b.dataset.ltLarg; aplicar(); }
    });
    L.querySelector("[data-lt=fechar]").focus();
    const corpo = L.querySelector(".lt-corpo");
    try {
      const r = await extrair(url);
      if (aberto !== url) return;
      const palavras = r.texto.split(/\s+/).length;
      if (palavras < 80) throw new Error("curto");
      if (!info.titulo && r.titulo) L.querySelector(".lt-tit").textContent = r.titulo;
      L.querySelector(".lt-meta").textContent = [r.autor, `${Math.max(1, Math.round(palavras / 200))} min de leitura`].filter(Boolean).join(" · ");
      const frag = r.frag.cloneNode(true);
      // o título já está em cima: tira o mesmo título repetido no começo do texto
      const simples = t => norm(t || "").replace(/[^a-z0-9]+/g, " ").trim();
      const tit = simples(info.titulo || r.titulo);
      for (const h of [...frag.querySelectorAll("h1,h2,h3")].slice(0, 2))
        if (tit && (simples(h.textContent) === tit || (simples(h.textContent).length > 20 && tit.includes(simples(h.textContent))))) h.remove();
      corpo.textContent = "";
      // a foto da notícia, se o texto não tiver foto logo no começo
      const fotoNoComeco = [...frag.querySelectorAll("*")].slice(0, 12).some(e => e.tagName === "IMG");
      if (info.im && /^https:/.test(info.im) && !fotoNoComeco) {
        const capa = document.createElement("img");
        capa.className = "lt-capa"; capa.src = info.im; capa.alt = ""; capa.referrerPolicy = "no-referrer";
        corpo.append(capa);
      }
      corpo.append(frag);
      for (const img of corpo.querySelectorAll("img")) img.addEventListener("error", () => img.remove(), {once: true});
    } catch (e) {
      if (aberto !== url) return;
      corpo.innerHTML = (info.resumo ? `<p class="lt-resumo">${esc(info.resumo)}</p>` : "")
        + `<div class="lt-falha"><p><b>Não deu para trazer o texto desta notícia.</b> ${e.message === "curto" ? "O site pede assinatura ou mostra só parte do texto." : app ? "O site recusou ou está fora do ar." : "No navegador, a maioria dos sites não deixa outro site ler as páginas deles. No app do celular funciona."}</p>`
        + `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${ic("externo")}Abrir no site do jornal</a></div>`;
    }
  }

  function salvarPdf(titulo) {
    const antes = document.title;
    document.title = titulo;  // nome sugerido do arquivo
    if (app?.imprimir) app.imprimir(titulo);
    else if (app) alert("Para salvar em PDF, instale a versão nova do app (Ajustes mostra a versão).");
    else window.print();  // no navegador: escolha "Salvar como PDF"
    setTimeout(() => { document.title = antes; }, 1500);
  }

  function partilhar(titulo, url) {
    if (app?.compartilhar) return app.compartilhar(titulo, url);
    if (navigator.share) return navigator.share({title: titulo, url}).catch(() => {});
    navigator.clipboard?.writeText(url);
  }

  window.addEventListener("popstate", () => { if (aberto && !history.state?.leitor) fechar(true); });
  window.radarLeitor = {abrir, fechar, aberto: () => !!aberto};
})();
