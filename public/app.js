// Interface do nucleo operacional. Um modulo so: as telas antigas vinham de
// app2.js mais tres arquivos de "enhancements" empilhados, o que tornava
// impossivel saber qual deles definia um comportamento.

// As chaves deste navegador mudaram de prefixo (agora nucleo_): o que estava
// guardado com o prefixo antigo passa para o novo, e ninguem precisa entrar de novo.
for (const nome of ["token", "user", "view", "empresa", "colunas_excel"]) {
  try {
    const antigo = localStorage.getItem("j" + "360_" + nome);
    if (antigo !== null && localStorage.getItem("nucleo_" + nome) === null) localStorage.setItem("nucleo_" + nome, antigo);
    if (antigo !== null) localStorage.removeItem("j" + "360_" + nome);
  } catch { /* sem armazenamento: so entra de novo */ }
}

const state = {
  token: localStorage.getItem("nucleo_token"),
  user: JSON.parse(localStorage.getItem("nucleo_user") || "null"),
  view: localStorage.getItem("nucleo_view") || "carteira",
  empresaId: localStorage.getItem("nucleo_empresa") || null,
  filtrosAcervo: {},
  query: ""
};

const app = document.querySelector("#app");

// --------------------------------------------------------------- utilitarios

function esc(valor) {
  return String(valor ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

async function api(caminho, opcoes = {}) {
  const resposta = await fetch(caminho, {
    ...opcoes,
    headers: {
      "content-type": "application/json",
      ...(state.token ? { authorization: "Bearer " + state.token } : {}),
      ...(opcoes.headers || {})
    }
  });
  if (resposta.status === 401 && state.token) {
    sair(true);
    throw new Error("Sessao expirada");
  }
  // O servidor bloqueia tudo ate a senha ser trocada: a tela acompanha.
  if (resposta.status === 403) {
    const copia = await resposta.clone().json().catch(() => ({}));
    if (copia.code === "TROCAR_SENHA") {
      telaTrocarSenha();
      throw new Error("Troca de senha obrigatoria");
    }
  }
  const tipo = resposta.headers.get("content-type") || "";
  const dados = tipo.includes("json") ? await resposta.json().catch(() => ({})) : {};
  if (!resposta.ok) {
    const erro = new Error(dados.error || "Erro na API (" + resposta.status + ")");
    erro.status = resposta.status;
    erro.dados = dados;
    throw erro;
  }
  return dados;
}

function can(permissao) {
  return Boolean(state.user?.permissions?.includes(permissao));
}

function dinheiro(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function percentual(valor, casas = 4) {
  return Number(valor || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: casas, maximumFractionDigits: casas
  }) + "%";
}

function dataHora(valor) {
  if (!valor) return "-";
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return esc(valor);
  return data.toLocaleString("pt-BR");
}

function dataCurta(valor) {
  if (!valor) return "-";
  const partes = String(valor).slice(0, 10).split("-");
  return partes.length === 3 ? partes[2] + "/" + partes[1] + "/" + partes[0] : esc(valor);
}

const CLASSES_BADGE = {
  Valido: "ok", Conforme: "ok", Finalizado: "ok", Ativo: "ok", Ativa: "ok",
  Saudavel: "ok", Resolvido: "ok", Conectado: "ok", Pronto: "ok", Armazenado: "ok",
  Vencendo: "warn", Atencao: "warn", Aberto: "warn", Pendente: "warn",
  "Falta configurar": "warn", atencao: "warn",
  Processando: "info", informativo: "info", "No prazo": "info", "Ciência enviada": "info", "Só resumo": "warn",
  Critico: "danger", Vencido: "danger", Erro: "danger", Irregular: "danger", critico: "danger",
  Ignorado: "off", "Nao contratado": "off", "Sem Movimento": "off",
  concluida: "ok", gravado: "ok", ja_existia: "ok", resolvida: "ok", emitida: "info", recebida: "warn",
  pendente: "warn", executando: "info", aberta: "danger", confirmada: "off", erro: "danger",
  cancelada: "off", conflito: "danger", "sem pasta": "off", Inativo: "off", Cancelada: "danger",
  Autorizada: "ok", proprio: "info", procuracao: "warn", ativa: "ok", inativa: "off",
  "Nao implementado": "off", "Nao conferido": "off",
  enviado: "ok", processado: "ok", aguardando: "warn", parcial: "warn", Liberada: "ok", Recebido: "info", "Substituído": "off"
};

function badge(valor) {
  const texto = String(valor ?? "");
  return '<span class="badge ' + (CLASSES_BADGE[texto] || "info") + '">' + esc(texto) + "</span>";
}

function aviso(mensagem, tipo = "info") {
  let item = document.querySelector(".toast");
  if (!item) {
    item = document.createElement("div");
    item.className = "toast";
    document.body.appendChild(item);
  }
  item.textContent = mensagem;
  item.dataset.type = tipo;
  item.classList.add("show");
  clearTimeout(item.dataset.timer);
  item.dataset.timer = setTimeout(() => item.classList.remove("show"), 4000);
}

function tabela(colunas, linhas, vazio = "Nenhum registro encontrado") {
  if (!linhas.length) return '<div class="empty">' + esc(vazio) + "</div>";
  return '<div class="table-wrap"><table><thead><tr>' +
    colunas.map((coluna) => "<th>" + coluna + "</th>").join("") +
    "</tr></thead><tbody>" +
    linhas.map((linha) => "<tr>" + linha.map((celula) => '<td><div class="cel">' + (celula ?? "-") + "</div></td>").join("") + "</tr>").join("") +
    "</tbody></table></div>";
}

/** Cada linha da tabela cabe numa linha so: o texto cortado aparece inteiro ao passar o mouse. */
function dicasDeCorte(raiz) {
  // Com espaco sobrando a tabela mostra tudo. Quando nao cabe, procura o maior
  // limite de largura por celula que ainda faz caber, e corta so o necessario.
  for (const caixa of raiz.querySelectorAll(".table-wrap")) {
    caixa.style.removeProperty("--corte");
    if (caixa.scrollWidth <= caixa.clientWidth) continue;
    let [cabe, naoCabe] = [96, 640];
    while (naoCabe - cabe > 8) {
      const meio = Math.floor((cabe + naoCabe) / 2);
      caixa.style.setProperty("--corte", meio + "px");
      if (caixa.scrollWidth > caixa.clientWidth) naoCabe = meio; else cabe = meio;
    }
    caixa.style.setProperty("--corte", cabe + "px");
  }
  for (const item of raiz.querySelectorAll(".cel, .cel code")) {
    if (!item.title && item.scrollWidth > item.clientWidth) item.title = item.textContent.trim();
  }
}

let esperaLargura;
window.addEventListener("resize", () => {
  clearTimeout(esperaLargura);
  esperaLargura = setTimeout(() => dicasDeCorte(document), 150);
});

function campo(rotulo, controle, largo = false) {
  return '<label class="form-field' + (largo ? " full" : "") + '"><span>' + rotulo + "</span>" + controle + "</label>";
}

function opcoes(atual, pares) {
  return pares.map(([valor, rotulo]) =>
    '<option value="' + esc(valor) + '"' + (String(atual ?? "") === String(valor) ? " selected" : "") + ">" + esc(rotulo) + "</option>").join("");
}

/** Competencias MM/AAAA, da mais nova para a mais velha: o mes atual e os anteriores. */
function mesesRecentes(quantos = 24) {
  const hoje = new Date();
  return Array.from({ length: quantos }, (_, i) => {
    const data = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    return String(data.getMonth() + 1).padStart(2, "0") + "/" + data.getFullYear();
  });
}

/** Opcoes de competencia com valor AAAA-MM e rotulo MM/AAAA (o formato da regra de busca). */
function opcoesCompetenciaIso(quantos = 36) {
  return mesesRecentes(quantos).map((mes) => [mes.slice(3) + "-" + mes.slice(0, 2), mes]);
}

const ROTULO_DOC_PONTE = { nfe: "NF-e", nfse: "NFS-e", cte: "CT-e" };

/** Competencia escolhida num seletor, em vez de digitada. */
function seletorCompetencia(nome, atual = "", vazio = null) {
  const lista = mesesRecentes();
  if (atual && !lista.includes(atual)) lista.unshift(atual);
  return '<select name="' + nome + '">' + (vazio === null ? "" : '<option value="">' + esc(vazio) + "</option>") +
    opcoes(atual, lista.map((mes) => [mes, mes])) + "</select>";
}

function valores(formulario) {
  return Object.fromEntries(new FormData(formulario).entries());
}

function combina(item) {
  return !state.query || JSON.stringify(item).toLowerCase().includes(state.query.toLowerCase());
}

function modal(titulo, html, largura) {
  fecharModal();
  const fundo = document.createElement("div");
  fundo.className = "modal-backdrop";
  fundo.innerHTML = '<div class="modal"' + (largura ? ' style="width:min(' + largura + 'px,100%)"' : "") + '>' +
    '<div class="modal-head"><h2>' + titulo + '</h2><button data-fechar>Fechar</button></div>' +
    '<div class="modal-body">' + html + "</div></div>";
  document.body.appendChild(fundo);
  dicasDeCorte(fundo);
  fundo.addEventListener("click", (evento) => {
    if (evento.target === fundo || evento.target.hasAttribute("data-fechar")) fecharModal();
  });
  document.addEventListener("keydown", escapeFecha);
  return fundo;
}

function escapeFecha(evento) {
  if (evento.key === "Escape") fecharModal();
}

/** Pergunta antes de uma acao que nao tem volta facil. Resolve true ao confirmar. */
function confirmarAcao(titulo, texto, rotulo) {
  return new Promise((resolve) => {
    let respondeu = false;
    const fundo = modal(titulo,
      '<div class="message warn">' + texto + "</div>" +
      '<div class="form-actions"><button type="button" data-fechar>Cancelar</button>' +
      '<button class="primary" id="confirmar-acao">' + esc(rotulo) + "</button></div>");
    fundo.querySelector("#confirmar-acao").addEventListener("click", () => {
      respondeu = true;
      fecharModal();
      resolve(true);
    });
    fundo.addEventListener("click", (evento) => {
      if (!respondeu && (evento.target === fundo || evento.target.hasAttribute("data-fechar"))) resolve(false);
    });
  });
}

function fecharModal() {
  document.querySelector(".modal-backdrop")?.remove();
  document.removeEventListener("keydown", escapeFecha);
}

function barraBusca(dica) {
  return '<div class="toolbar"><label class="search"><span>Buscar</span>' +
    '<input id="busca" placeholder="' + esc(dica) + '" value="' + esc(state.query) + '"></label></div>';
}

function ligarBusca(redesenhar) {
  const entrada = document.querySelector("#busca");
  if (!entrada) return;
  entrada.addEventListener("input", () => {
    state.query = entrada.value;
    redesenhar();
    const novo = document.querySelector("#busca");
    if (novo) { novo.focus(); novo.setSelectionRange(novo.value.length, novo.value.length); }
  });
}

// A sessao pode cair no meio do carregamento de uma tela: nesse caso o layout
// ja foi trocado pela tela de login, e nao existe mais onde escrever.
function titulo(texto, subtitulo) {
  const cabecalho = document.querySelector("#titulo");
  if (!cabecalho) return;
  cabecalho.textContent = texto;
  document.querySelector("#subtitulo").textContent = subtitulo;
}

function conteudo(html) {
  const alvo = document.querySelector("#content");
  if (!alvo) return;
  alvo.innerHTML = html;
  dicasDeCorte(alvo);
}

function carregando() {
  conteudo('<div class="card"><div class="loading">Carregando...</div></div>');
}

function ir(view) {
  state.view = view;
  state.query = "";
  localStorage.setItem("nucleo_view", view);
  render();
}

// ------------------------------------------------------------------- login

// ------------------------------------------------------- marca do escritorio

const MARCA_PADRAO = { nome: "NÚCLEO FISCAL", subtitulo: "Operação fiscal do escritório", tituloNavegador: "NÚCLEO FISCAL",
  mensagemLogin: "Operação fiscal do escritório", rodape: "", credito: "", logo: null, logoEscuro: null, favicon: null,
  cores: {}, tema: "claro", suporte: {}, telas: {} };
const marca = () => state.marca || MARCA_PADRAO;

async function carregarMarca() {
  try {
    const resposta = await fetch("/api/marca");
    if (resposta.ok) state.marca = { ...MARCA_PADRAO, ...(await resposta.json()) };
  } catch { /* fica a marca padrao */ }
  const m = marca();
  const raiz = document.documentElement;
  document.title = m.tituloNavegador || m.nome;
  const cores = { "--primary": m.cores?.primaria, "--ring": m.cores?.primaria, "--secondary": m.cores?.secundaria, "--accent": m.cores?.destaque };
  for (const [variavel, valor] of Object.entries(cores)) if (valor) raiz.style.setProperty(variavel, valor);
  if (m.favicon) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
    link.href = m.favicon;
  }
}

/** Logo do escritorio, ou a inicial do nome num quadrado da cor primaria. */
function logoDaMarca() {
  const m = marca();
  const logo = m.logo;
  return logo ? '<img class="brand-logo" src="' + esc(logo) + '" alt="' + esc(m.nome) + '">'
    : '<div class="brand-mark">' + esc(String(m.nome || "N").trim().charAt(0).toUpperCase()) + "</div>";
}

/** Contato de suporte, rodape e credito, quando a marca traz algum. */
function rodapeDaMarca() {
  const m = marca();
  const s = m.suporte || {};
  const contatos = [
    s.email ? '<a href="mailto:' + esc(s.email) + '">' + esc(s.email) + "</a>" : "",
    s.whatsapp ? '<a href="https://wa.me/' + esc(s.whatsapp.replace(/\D/g, "")) + '" target="_blank" rel="noopener">WhatsApp ' +
      esc(s.whatsapp) + "</a>" : "",
    s.telefone ? esc(s.telefone) : "",
    s.site ? '<a href="' + esc(s.site) + '" target="_blank" rel="noopener">' + esc(s.site.replace(/^https?:\/\//, "")) + "</a>" : ""
  ].filter(Boolean);
  if (!contatos.length && !m.rodape && !m.credito) return "";
  return '<footer class="rodape">' + (contatos.length ? "<p>Suporte: " + contatos.join(" · ") + "</p>" : "") +
    (m.rodape ? "<p>" + esc(m.rodape) + "</p>" : "") + (m.credito ? '<p class="muted">' + esc(m.credito) + "</p>" : "") + "</footer>";
}

function telaLogin(mensagem = "") {
  // Usuarios de demonstracao so existem com NUCLEO_DEMO=1: em producao, nada
  // preenchido e nenhuma dica (o servidor diz o modo em /api/health).
  const demo = state.modoDemo === true;
  app.innerHTML = '<div class="login"><form class="login-card" id="form-login">' +
    logoDaMarca() +
    "<h1>" + esc(marca().nome) + "</h1>" +
    "<p>" + esc(marca().mensagemLogin || marca().subtitulo) + "</p>" +
    (mensagem ? '<div class="message danger-text">' + esc(mensagem) + "</div>" : "") +
    campo("E-mail", '<input name="email" type="email" required autocomplete="username"' + (demo ? ' value="admin@demo.local"' : "") + ">", true) +
    campo("Senha", '<input name="password" type="password" required autocomplete="current-password"' + (demo ? ' value="123456"' : "") + ">", true) +
    '<button class="primary" type="submit">Entrar</button>' +
    (demo ? '<p class="muted">Demonstração: admin@demo.local ou fiscal@demo.local, senha 123456</p>' : "") +
    "</form>" + rodapeDaMarca() + "</div>";

  if (state.modoDemo === undefined) {
    fetch("/api/health").then((resposta) => resposta.json()).then((saude) => {
      state.modoDemo = saude.modoDemo === true;
      if (state.modoDemo && document.querySelector("#form-login")) telaLogin(mensagem);
    }).catch(() => { state.modoDemo = false; });
  }

  document.querySelector("#form-login").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const botao = evento.target.querySelector("button");
    botao.disabled = true;
    try {
      const dados = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(valores(evento.target))
      });
      state.token = dados.token;
      state.user = dados.user;
      localStorage.setItem("nucleo_token", dados.token);
      localStorage.setItem("nucleo_user", JSON.stringify(dados.user));
      if (dados.mustChangePassword) telaTrocarSenha();
      else render();
    } catch (erro) {
      botao.disabled = false;
      telaLogin(erro.message);
    }
  });
}

/**
 * Troca obrigatoria. Enquanto a senha nao muda, o servidor devolve 403 em
 * tudo: nao adianta deixar o usuario navegar.
 */
function telaTrocarSenha(mensagem = "") {
  app.innerHTML = '<div class="login"><form class="login-card" id="form-senha">' +
    '<div class="brand-mark">N</div>' +
    "<h1>Trocar senha</h1>" +
    "<p>Obrigatório antes de usar o sistema</p>" +
    (mensagem ? '<div class="message danger-text">' + esc(mensagem) + "</div>" : "") +
    '<div class="message info">Mínimo de 10 caracteres. Não pode ser só números, ' +
    "nem uma das senhas mais comuns." +
    "</div>" +
    campo("Senha atual", '<input name="senhaAtual" type="password" required autocomplete="current-password">', true) +
    campo("Senha nova", '<input name="senhaNova" type="password" required minlength="10" autocomplete="new-password">', true) +
    campo("Repita a senha nova", '<input name="repetir" type="password" required minlength="10" autocomplete="new-password">', true) +
    '<button class="primary" type="submit">Trocar e entrar</button>' +
    '<button type="button" id="cancelar-troca">Sair</button>' +
    "</form></div>";

  document.querySelector("#cancelar-troca").addEventListener("click", () => sair());
  document.querySelector("#form-senha").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const dados = valores(evento.target);
    if (dados.senhaNova !== dados.repetir) return telaTrocarSenha("As duas senhas novas nao conferem");
    try {
      await api("/api/auth/trocar-senha", {
        method: "POST",
        body: JSON.stringify({ senhaAtual: dados.senhaAtual, senhaNova: dados.senhaNova })
      });
      if (state.user) {
        state.user.mustChangePassword = false;
        localStorage.setItem("nucleo_user", JSON.stringify(state.user));
      }
      aviso("Senha trocada", "success");
      render();
    } catch (erro) {
      telaTrocarSenha(erro.message);
    }
  });
}

async function sair(expirou = false) {
  if (!expirou) await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  state.token = null;
  state.user = null;
  localStorage.removeItem("nucleo_token");
  localStorage.removeItem("nucleo_user");
  telaLogin(expirou ? "Sua sessao expirou. Entre novamente." : "");
}

// ------------------------------------------------------------------- layout

const MENU = [
  ["Captura", [
    ["carteira", "Carteira", "Visão geral da captura"],
    ["empresas", "Empresas", "Configurar a captura de cada empresa"],
    ["acervo", "Notas", "XML e PDF capturados"],
    ["resumos", "Resumos", "NF-e só em resumo, uma por uma"],
    ["pendencias", "Pendências", "O que falta completar"],
    ["fila", "Fila", "Execuções de captura"],
    ["agendamentos", "Agendamentos", "Captura automática"],
    ["certificadosA1", "Certificados A1", "Cofre de certificados"],
    ["agente", "Pastas", "XML e PDF na pasta de cada empresa"]
  ]],
  ["Central", [
    ["dashboard", "Painel", "Indicadores"],
    ["alerts", "Alertas", "Vigilância"],
    ["conferencias", "Conferências", "Divergências"],
    ["history", "Ocorrências", "Histórico"],
    ["certificates", "Certificados", "A1 e A3"]
  ]],
  ["Módulos", [
    ["clients", "Clientes", "Cadastro central"],
    ["services", "Serviços", "NFS-e"],
    ["federal", "Federal", "NF-e e NFC-e"],
    ["simples", "Simples Nacional", "Apuração do DAS"],
    ["lucro", "Presumido e Real", "IRPJ, CSLL, PIS e COFINS"],
    ["prevention", "Prevenção", "Monitoramento"]
  ]],
  ["Sistema", [
    ["processes", "Processamentos", "Rotinas"],
    ["imports", "Importações", "Entrada de documentos"],
    ["uploads", "Arquivos", "XML e ZIP"],
    ["rules", "Regras", "Parâmetros"],
    ["reports", "Relatórios", "CSV"],
    ["integrations", "Integrações", "Conectores"],
    ["users", "Usuários", "Perfis"],
    ["settings", "Configurações", "Limites"],
    ["audit", "Auditoria", "Trilha"]
  ]]
];

// Telas de detalhe que nao estao no menu acendem a aba de onde se chega nelas.
const ABA_DA_TELA = { empresa: "empresas" };

/** O menu com as telas que a marca do escritorio deixa ligadas. */
function menuLigado() {
  const telas = marca().telas || {};
  // A equipe e do dono: quem nao gere a equipe nao ve a tela.
  const permitida = (view) => view !== "users" || can("equipe");
  return MENU.map(([grupo, itens]) => [grupo, itens.filter(([view]) => telas[view] !== false && permitida(view))])
    .filter(([, itens]) => itens.length);
}

const ROTULO_PERFIL = { admin: "Dono", operador: "Operador", operador_fiscal: "Operador fiscal", leitura: "Leitura" };

function grupoDaTela(view) {
  const alvo = ABA_DA_TELA[view] || view;
  const menu = menuLigado();
  return menu.find(([, itens]) => itens.some(([item]) => item === alvo)) || menu[0];
}

// Navegacao sempre no topo, sem barra lateral: marca, grupos e usuario na
// primeira faixa; as telas do grupo num trilho de abas logo abaixo (o TabsList
// do shadcn). Faixa que nao cabe rola na horizontal, sem quebrar linha. A caixa
// alta dos rotulos vem do CSS: o texto fica com acento.
function desenharLayout() {
  const iniciais = (state.user.name || "?").split(" ").map((parte) => parte[0]).slice(0, 2).join("");
  const [grupoAtual, itensAtuais] = grupoDaTela(state.view);
  const ativa = ABA_DA_TELA[state.view] || state.view;
  app.innerHTML = '<div class="layout"><header class="topo">' +
    '<div class="faixa-identidade">' +
      '<div class="brand">' + logoDaMarca() +
      '<div class="brand-texto"><strong>' + esc(marca().nome) + "</strong><span>" + esc(marca().subtitulo) + "</span></div></div>" +
      '<nav class="faixa-grupos">' + menuLigado().map(([grupo, itens]) =>
        '<button class="grupo' + (grupo === grupoAtual ? " active" : "") + '" data-view="' + itens[0][0] + '">' +
        esc(grupo) + "</button>").join("") + "</nav>" +
      '<div class="user"><div class="quem"><strong>' + esc(state.user.name) + "</strong>" +
      '<p class="muted">' + esc(ROTULO_PERFIL[state.user.role] || state.user.role) + "</p></div>" +
      '<div class="avatar">' + esc(iniciais.toUpperCase()) + "</div>" +
      '<button id="sair">Sair</button></div>' +
    "</div>" +
    '<div class="subnav"><nav class="faixa-telas"><div class="trilho">' + itensAtuais.map(([view, rotulo, dica]) =>
      '<button class="nav' + (ativa === view ? " active" : "") + '" data-view="' + view + '" title="' + esc(dica) + '">' +
      esc(rotulo) + "</button>").join("") + "</div></nav></div>" +
    "</header><main class=\"main\">" +
    '<div class="top"><div><h1 id="titulo">...</h1><p id="subtitulo"></p></div></div>' +
    '<div class="content" id="content"></div>' + rodapeDaMarca() + "</main></div>";

  for (const botao of document.querySelectorAll(".nav, .grupo")) {
    botao.addEventListener("click", () => ir(botao.dataset.view));
  }
  document.querySelector("#sair").addEventListener("click", () => sair());
  // Em tela estreita o grupo e a aba ativos podem estar fora da faixa: traz para a vista.
  for (const ativo of document.querySelectorAll(".faixa-grupos .active, .faixa-telas .active")) {
    ativo.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

const TELAS = {
  carteira, empresas, empresa, acervo, resumos, pendencias, fila, agendamentos, certificadosA1, agente,
  dashboard, alerts, conferencias, history, certificates, clients, services, federal,
  simples, lucro: telaLucro, prevention, processes, imports, uploads, rules, reports, integrations, users,
  settings, audit
};

async function render() {
  if (!state.token || !state.user) return telaLogin();
  if (state.user.mustChangePassword) return telaTrocarSenha();
  desenharLayout();
  carregando();
  const tela = TELAS[state.view] || dashboard;
  try {
    await tela();
  } catch (erro) {
    // Sessao expirada ja levou o usuario para o login: nao sobrepor com erro.
    if (!state.token) return;
    titulo("Erro", "Não foi possível carregar a tela");
    conteudo('<div class="card"><div class="body"><div class="message danger-text">' +
      esc(erro.message) + "</div></div></div>");
  }
}

// ---------------------------------------------------------------- dashboard

async function dashboard() {
  titulo("Painel", "Indicadores do acervo capturado");
  const dados = await api("/api/dashboard");
  const m = dados.metrics;

  conteudo(
    '<div class="grid metrics">' +
      cartao("Empresas", dados.monitoredCompanies, "monitoradas") +
      cartao("Módulos ativos", dados.activeModules, "contratados") +
      cartao("Alertas pendentes", dados.pendingAlerts, "na vigilância") +
      cartao("Documentos", m.documentsCaptured, "no acervo") +
      cartao("Conferidos", m.documentsChecked, "de " + m.documentsCaptured + " documentos") +
      cartao("Conformidade", m.conformityRate === null ? "-" : m.conformityRate + "%", "das notas conferidas") +
    "</div>" +
    '<div class="grid metrics">' +
      cartao("Críticas", m.criticalCompanies, "empresas com alerta crítico") +
      cartao("Afetadas", m.affectedCompanies, "empresas com algum alerta") +
      cartao("Certificados", m.certificatesExpiring, "perto de vencer") +
      cartao("Sem emissão", m.companiesWithoutIssuance, "empresas sem nota no período") +
      cartao("Capturas", m.failedCaptures, "com a última em erro") +
      cartao("DAS pendentes", m.pendingDas, "apurações sem DAS") +
    "</div>" +
    '<div class="grid split">' +
      '<div class="card"><div class="head"><div><h2>Atenção necessária</h2>' +
        "<p>Agrupado por fonte e tipo de alerta</p></div></div>" +
        tabela(["Fonte", "Ocorrência", "Severidade", "Qtd"],
          dados.attention.map((item) => [esc(item.source), esc(item.label), badge(item.severity), item.count]),
          "Nenhum alerta pendente") +
      "</div>" +
      '<div class="card"><div class="head"><div><h2>Saúde operacional</h2>' +
        "<p>Por modulo</p></div></div><div class=\"body\">" +
        dados.moduleHealth.map((modulo) =>
          '<div class="health-row"><strong>' + esc(modulo.name) + "</strong>" +
          "<div>" + badge(modulo.status) + "</div>" +
          "<span>" + modulo.healthy + " saudavel, " + modulo.warning + " atencao, " +
          modulo.critical + " critico</span></div>").join("") +
      "</div></div>" +
    "</div>" +
    (m.documentsCaptured === 0
      ? '<div class="card"><div class="body"><div class="message info">' +
        "Nenhum documento no acervo ainda. Va em <strong>Importacoes</strong> e envie um XML ou ZIP " +
        "de NF-e / NFS-e: a conferencia, a apuracao e os alertas passam a sair desses dados." +
        "</div></div></div>"
      : "")
  );
}

// ------------------------------------------------------------------ alertas

async function alerts() {
  titulo("Alertas", "Gerados pela vigilância a cada execução");
  const dados = await api("/api/alerts");

  const desenhar = () => {
    const filtrados = dados.filter(combina);
    conteudo('<div class="card"><div class="head"><div><h2>Fila de alertas</h2>' +
      "<p>" + filtrados.length + " alerta(s); " +
      filtrados.filter((item) => item.status === "Pendente").length + " pendente(s)</p></div>" +
      '<div class="actions">' +
      (can("import") ? '<button class="primary" id="vigiar">Executar vigilância</button>' : "") +
      "</div></div>" +
      barraBusca("codigo, empresa ou titulo") +
      tabela(["Fonte", "Alerta", "Empresa", "Severidade", "Status", "Vence", "Ações"],
        filtrados.map((item) => [
          esc(item.source),
          "<strong>" + esc(item.title) + "</strong><br><span class=\"muted\">" + esc(item.detail || "") + "</span>",
          esc(item.clientName),
          badge(item.severity),
          badge(item.status) + (item.reason ? '<br><span class="muted">' + esc(item.reason) + "</span>" : ""),
          item.dueAt ? dataCurta(item.dueAt) : "-",
          item.status === "Pendente" && can("write")
            ? '<div class="actions"><button data-resolver="' + item.id + '">Resolver</button>' +
              '<button data-ignorar="' + item.id + '">Ignorar</button></div>'
            : "-"
        ]), "Nenhum alerta. Execute a vigilancia para recalcular."));

    ligarBusca(desenhar);
    document.querySelector("#vigiar")?.addEventListener("click", async (evento) => {
      evento.target.disabled = true;
      try {
        const resumo = await api("/api/alerts/executar", { method: "POST" });
        aviso(resumo.novos + " novo(s), " + resumo.pendentes + " pendente(s), " +
          resumo.encerrados + " encerrado(s)", "success");
        render();
      } catch (erro) { aviso(erro.message, "error"); evento.target.disabled = false; }
    });

    for (const botao of document.querySelectorAll("[data-resolver]")) {
      botao.addEventListener("click", () => tratarAlerta(botao.dataset.resolver, "resolve"));
    }
    for (const botao of document.querySelectorAll("[data-ignorar]")) {
      botao.addEventListener("click", () => tratarAlerta(botao.dataset.ignorar, "ignore"));
    }
  };

  desenhar();
}

function tratarAlerta(id, acao) {
  const exigeMotivo = acao === "ignore";
  const fundo = modal(exigeMotivo ? "Ignorar alerta" : "Resolver alerta",
    '<form id="form-alerta" class="form-grid">' +
    '<div class="full message info">' +
    (exigeMotivo
      ? "Ignorar um alerta exige justificativa: ela fica na trilha de auditoria com seu usuario."
      : "A resolucao e registrada na trilha de auditoria. O alerta nao reabre enquanto o fato persistir.") +
    "</div>" +
    campo("Justificativa" + (exigeMotivo ? " (obrigatoria)" : " (opcional)"),
      '<textarea name="reason" rows="3"' + (exigeMotivo ? " required" : "") + "></textarea>", true) +
    '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
    '<button class="primary" type="submit">Confirmar</button></div></form>');

  fundo.querySelector("#form-alerta").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    try {
      await api("/api/alerts/" + id + "/" + acao, {
        method: "PATCH",
        body: JSON.stringify(valores(evento.target))
      });
      fecharModal();
      aviso("Alerta atualizado", "success");
      render();
    } catch (erro) { aviso(erro.message, "error"); }
  });
}

// -------------------------------------------------------------- conferencias

async function conferencias() {
  titulo("Conferências", "Recálculo por tributo, com memória de cálculo");
  const dados = await api("/api/conferencias");
  const c = dados.consolidado;

  const desenhar = () => {
    const filtrados = dados.documentos.filter(combina);
    conteudo(
      '<div class="grid metrics">' +
        '<div class="card metric"><span>Documentos</span><strong>' + c.documentos + "</strong></div>" +
        '<div class="card metric"><span>Conformes</span><strong>' + c.conformes + "</strong></div>" +
        '<div class="card metric"><span>Atencao</span><strong>' + c.atencao + "</strong></div>" +
        '<div class="card metric"><span>Irregulares</span><strong>' + c.irregulares + "</strong></div>" +
        '<div class="card metric"><span>Achados</span><strong>' + c.achados + "</strong></div>" +
        '<div class="card metric"><span>Justificados</span><strong>' + c.tratados + "</strong></div>" +
      "</div>" +
      '<div class="card"><div class="head"><div><h2>Divergencias por tipo</h2>' +
        "<p>O que mais aparece no acervo</p></div></div>" +
        tabela(["Código", "Achado", "Severidade", "Ocorrências", "Justificados"],
          c.porCodigo.map((item) => [
            "<code>" + esc(item.code) + "</code>", esc(item.title),
            badge(item.severity), item.count, item.tratados
          ]), "Nenhuma divergencia encontrada") +
      "</div>" +
      '<div class="card"><div class="head"><div><h2>Documentos conferidos</h2>' +
        "<p>Clique em Detalhar para ver a conta de cada achado</p></div></div>" +
        barraBusca("chave, numero ou empresa") +
        tabela(["Tipo", "Número", "Emissão", "Empresa", "Status", "Achados", "Abertos", "Ações"],
          filtrados.map((item) => [
            esc(item.kind), esc(item.number), dataCurta(item.issuedAt), esc(item.clientName),
            badge(item.summary.status),
            item.summary.total,
            item.abertos ? '<span class="error-count">' + item.abertos + "</span>" : "0",
            '<button data-detalhar="' + esc(item.documentKey) + '">Detalhar</button>'
          ]), "Nenhum documento conferido ainda") +
      "</div>");

    ligarBusca(desenhar);
    for (const botao of document.querySelectorAll("[data-detalhar]")) {
      botao.addEventListener("click", () => detalharDocumento(botao.dataset.detalhar));
    }
  };

  desenhar();
}

async function detalharDocumento(chave) {
  const conferencia = await api("/api/conferencias/" + encodeURIComponent(chave));
  const detalhe = await api("/api/documents/" + encodeURIComponent(chave)).catch(() => null);
  const documento = detalhe?.documento;

  const achados = conferencia.findings.map((achado) =>
    '<div class="card" style="margin-bottom:10px"><div class="head"><div>' +
      "<h2>" + badge(achado.severity) + " " + esc(achado.title) + "</h2>" +
      "<p><code>" + esc(achado.code) + "</code>" +
      (achado.item ? " &middot; item " + achado.item : "") + "</p></div>" +
      (can("write") && !achado.justification
        ? '<button data-justificar="' + esc(achado.code) + '" data-item="' + (achado.item ?? "") + '">Justificar</button>'
        : "") +
    '</div><div class="body">' +
      (achado.expected !== null && achado.expected !== undefined
        ? "<p><strong>Esperado:</strong> " + esc(achado.expected) +
          " &nbsp; <strong>Encontrado:</strong> " + esc(achado.found) +
          (achado.difference !== null && achado.difference !== undefined
            ? ' &nbsp; <strong>Diferenca:</strong> <span class="error-count">' + esc(achado.difference) + "</span>"
            : "") + "</p>"
        : "") +
      '<p class="muted"><strong>Conta:</strong> ' + esc(achado.basis) + "</p>" +
      '<p class="muted"><strong>Base normativa:</strong> ' + esc(achado.rule) + "</p>" +
      (achado.justification
        ? '<div class="message ok"><strong>Justificado</strong> por ' + esc(achado.justifiedBy) +
          " em " + dataHora(achado.justifiedAt) + ":<br>" + esc(achado.justification) + "</div>"
        : "") +
    "</div></div>").join("");

  const itens = documento?.items?.length
    ? '<div class="card"><div class="head"><div><h2>Itens do documento</h2>' +
      "<p>Valores lidos do XML</p></div></div>" +
      tabela(["#", "Descrição", "NCM", "CFOP", "CST/CSOSN", "Valor", "ICMS", "PIS", "COFINS"],
        documento.items.map((item) => [
          item.n, esc(item.description), esc(item.ncm), esc(item.cfop),
          esc(item.icms.cst || item.icms.csosn || "-"),
          dinheiro(item.total), dinheiro(item.icms.value),
          dinheiro(item.pis.value), dinheiro(item.cofins.value)
        ])) + "</div>"
    : "";

  const servico = documento?.service
    ? '<div class="card"><div class="head"><div><h2>Serviço</h2></div></div>' +
      tabela(["Item LC 116", "Base", "Alíquota", "ISS", "Retido", "Líquido"],
        [[esc(documento.service.code), dinheiro(documento.service.base),
          percentual(documento.service.rate, 2), dinheiro(documento.service.iss),
          documento.service.issWithheld ? badge("Pendente") : "Nao",
          dinheiro(documento.service.net)]]) + "</div>"
    : "";

  const fundo = modal("Documento " + esc(conferencia.kind) + " " + esc(conferencia.number),
    '<p class="muted">Chave: <code>' + esc(conferencia.documentKey) + "</code><br>" +
    "Empresa: " + esc(conferencia.clientName) + " &middot; Emissao: " + dataCurta(conferencia.issuedAt) +
    " &middot; Conferido em " + dataHora(conferencia.checkedAt) + "</p>" +
    '<div class="head" style="border:0;padding:10px 0"><div><h2>' + badge(conferencia.summary.status) +
    " " + conferencia.summary.total + " achado(s)</h2>" +
    "<p>" + conferencia.summary.critico + " critico(s), " + conferencia.summary.atencao + " atencao</p></div>" +
    (can("import") ? '<button id="reconferir">Reconferir</button>' : "") + "</div>" +
    (achados || '<div class="message ok">Nenhuma divergencia neste documento.</div>') +
    itens + servico, 900);

  fundo.querySelector("#reconferir")?.addEventListener("click", async () => {
    try {
      await api("/api/conferencias/" + encodeURIComponent(chave) + "/reconferir", { method: "POST" });
      aviso("Documento reconferido", "success");
      fecharModal();
      render();
    } catch (erro) { aviso(erro.message, "error"); }
  });

  for (const botao of fundo.querySelectorAll("[data-justificar]")) {
    botao.addEventListener("click", () => {
      const code = botao.dataset.justificar;
      const item = botao.dataset.item === "" ? null : Number(botao.dataset.item);
      const interno = modal("Justificar " + esc(code),
        '<form id="form-justificar" class="form-grid">' +
        '<div class="full message info">A justificativa entra na trilha de auditoria com seu usuario ' +
        "e sobrevive a reconferencias do mesmo achado.</div>" +
        campo("Justificativa (mínimo 10 caracteres)", '<textarea name="justification" rows="4" required></textarea>', true) +
        '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
        '<button class="primary" type="submit">Justificar</button></div></form>');

      interno.querySelector("#form-justificar").addEventListener("submit", async (evento) => {
        evento.preventDefault();
        try {
          await api("/api/conferencias/" + encodeURIComponent(chave) + "/justificar", {
            method: "POST",
            body: JSON.stringify({ code, item, ...valores(evento.target) })
          });
          fecharModal();
          aviso("Divergencia justificada", "success");
          detalharDocumento(chave);
        } catch (erro) { aviso(erro.message, "error"); }
      });
    });
  }
}

// -------------------------------------------------------------- ocorrencias

async function history() {
  titulo("Ocorrências", "Histórico de eventos");
  const dados = await api("/api/occurrences");
  const desenhar = () => {
    const filtrados = dados.filter(combina);
    conteudo('<div class="card"><div class="head"><div><h2>Histórico</h2>' +
      "<p>" + filtrados.length + " evento(s)</p></div></div>" +
      barraBusca("titulo, fonte ou empresa") +
      tabela(["Quando", "Ocorrência", "Fonte", "Empresa", "Severidade"],
        filtrados.map((item) => [
          dataHora(item.time), esc(item.title), esc(item.source),
          esc(item.clientName), badge(item.severity)
        ]), "Nenhuma ocorrencia registrada"));
    ligarBusca(desenhar);
  };
  desenhar();
}

// ------------------------------------------------------------- certificados

async function certificates() {
  titulo("Certificados", "Validade dos certificados digitais");
  const dados = await api("/api/certificates");
  const clientes = await api("/api/clients");

  const desenhar = () => {
    const filtrados = dados.filter(combina);
    conteudo('<div class="card"><div class="head"><div><h2>Certificados digitais</h2>' +
      "<p>" + filtrados.length + " certificado(s)</p></div>" +
      (can("write") ? '<button class="primary" id="novo-cert">Cadastrar certificado</button>' : "") +
      "</div>" + barraBusca("empresa ou tipo") +
      tabela(["Empresa", "Tipo", "Vencimento", "Dias", "Status", "Origem da data", "Uso"],
        filtrados.map((item) => [
          esc(item.clientName), esc(item.type), dataCurta(item.expiresAt),
          item.daysToExpiry === null ? "-" : item.daysToExpiry,
          badge(item.status),
          item.readFromFile ? badge("Valido") + " do arquivo" : '<span class="muted">digitada</span>',
          esc(item.usage || "-")
        ]), "Nenhum certificado cadastrado"));

    ligarBusca(desenhar);
    document.querySelector("#novo-cert")?.addEventListener("click", () => formCertificado(clientes));
  };
  desenhar();
}

function formCertificado(clientes) {
  const fundo = modal("Cadastrar certificado",
    '<form id="form-cert" class="form-grid">' +
    '<div class="full message info">Envie um arquivo <strong>.cer</strong>, <strong>.crt</strong> ou ' +
    "<strong>.pem</strong> e a validade e lida do proprio certificado. " +
    "Certificado A1 <strong>.pfx/.p12</strong> usado na captura vai em <strong>Captura de notas &gt; Certificados A1</strong>, " +
    "que abre o arquivo com a senha e le a validade sozinho." +
    "</div>" +
    campo("Empresa", '<select name="clientId" required>' +
      clientes.map((cliente) => '<option value="' + cliente.id + '">' + esc(cliente.name) + "</option>").join("") +
      "</select>") +
    campo("Tipo", '<select name="type"><option>A1</option><option>A3</option></select>') +
    campo("Arquivo do certificado (.cer/.crt/.pem)", '<input type="file" name="arquivo" accept=".cer,.crt,.pem">') +
    campo("Validade (se não enviar arquivo)", '<input type="date" name="expiresAt">') +
    grupoChecks("Uso", ["Federal", "Estadual", "Municipal", "Serviços"].map((uso) =>
      '<label><input type="checkbox" name="usage" value="' + uso + '"> ' + uso + "</label>").join(""), false) +
    '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
    '<button class="primary" type="submit">Cadastrar</button></div></form>');

  fundo.querySelector("#form-cert").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const dados = valores(evento.target);
    const arquivo = evento.target.arquivo.files[0];
    const corpo = {
      clientId: dados.clientId, type: dados.type,
      usage: new FormData(evento.target).getAll("usage").join(", "), expiresAt: dados.expiresAt || undefined
    };
    if (arquivo) corpo.contentBase64 = await lerBase64(arquivo);
    try {
      const criado = await api("/api/certificates", { method: "POST", body: JSON.stringify(corpo) });
      fecharModal();
      aviso(criado.readFromFile
        ? "Certificado lido do arquivo, valido ate " + criado.expiresAt
        : "Certificado cadastrado", "success");
      render();
    } catch (erro) {
      aviso(erro.message + (erro.dados?.hint ? " " + erro.dados.hint : ""), "error");
    }
  });
}

function lerBase64(arquivo) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(String(leitor.result).split(",")[1]);
    leitor.onerror = () => reject(new Error("Nao foi possivel ler o arquivo"));
    leitor.readAsDataURL(arquivo);
  });
}

// ----------------------------------------------------------------- clientes

const MODULOS = ["Federal", "Servicos", "Simples Nacional", "Prevencao"];

async function clients() {
  titulo("Clientes", "Cadastro central das empresas");
  const dados = await api("/api/clients");

  const desenhar = () => {
    const filtrados = dados.filter(combina);
    conteudo('<div class="card"><div class="head"><div><h2>Clientes</h2>' +
      "<p>" + filtrados.length + " empresa(s)</p></div>" +
      (can("write") ? '<button class="primary" id="novo-cliente">Novo cliente</button>'
                    : badge("Somente leitura")) + "</div>" +
      barraBusca("CNPJ, razao social ou cidade") +
      tabela(["CNPJ", "Razão social", "Regime", "Anexo", "RBT12", "Certificado", "Docs", "Status", "Ações"],
        filtrados.map((item) => [
          esc(item.cnpj), esc(item.name), esc(item.taxRegime), esc(item.anexo || "-"),
          item.rbt12 ? dinheiro(item.rbt12) : '<span class="muted">nao informado</span>',
          badge(item.certificate), item.documents, badge(item.status),
          can("write") ? '<button data-editar="' + item.id + '">Editar</button>' : "-"
        ]), "Nenhum cliente cadastrado"));

    ligarBusca(desenhar);
    document.querySelector("#novo-cliente")?.addEventListener("click", () => formCliente({}));
    for (const botao of document.querySelectorAll("[data-editar]")) {
      botao.addEventListener("click", () =>
        formCliente(dados.find((item) => item.id === botao.dataset.editar)));
    }
  };
  desenhar();
}

function formCliente(item) {
  const editando = Boolean(item.id);
  const fundo = modal(editando ? "Editar cliente" : "Novo cliente",
    '<form id="form-cliente" class="form-grid">' +
    campo("CNPJ", '<input name="cnpj" placeholder="00.000.000/0000-00" required value="' +
      esc(item.cnpj || "") + '">') +
    campo("Razão social", '<input name="name" required value="' + esc(item.name || "") + '">') +
    campo("Cidade", '<input name="city" value="' + esc(item.city || "") + '">') +
    campo("Regime tributario", '<select name="taxRegime">' +
      ["Simples Nacional", "Lucro Presumido", "Lucro Real"].map((regime) =>
        "<option" + (item.taxRegime === regime ? " selected" : "") + ">" + regime + "</option>").join("") +
      "</select>") +
    campo("Anexo do Simples", '<select name="anexo">' +
      ['<option value="">nao se aplica</option>'].concat(["I", "II", "III", "IV", "V"].map((anexo) =>
        '<option value="' + anexo + '"' + (item.anexo === anexo ? " selected" : "") + ">Anexo " + anexo + "</option>")).join("") +
      "</select>") +
    campo("RBT12 (receita dos 12 meses anteriores)",
      '<input name="rbt12" type="number" step="0.01" min="0" value="' + (item.rbt12 ?? "") + '">') +
    campo("Folha 12 meses (ativa o Fator R)",
      '<input name="folha12" type="number" step="0.01" min="0" value="' + (item.folha12 ?? "") + '">') +
    '<fieldset class="form-field full"><legend>Módulos vinculados</legend><div class="checks">' +
      MODULOS.map((modulo) => "<label><input type=\"checkbox\" name=\"modules\" value=\"" + modulo + "\"" +
        ((item.modules || []).includes(modulo) ? " checked" : "") + "> " + modulo + "</label>").join("") +
    "</div></fieldset>" +
    '<div class="full message info">O RBT12 e a folha nao sao deduzidos dos documentos: a receita ' +
    "dos 12 meses anteriores e a folha de salarios vem da contabilidade. Sem RBT12 nao existe " +
    "aliquota efetiva, e a apuracao e recusada." +
    "</div>" +
    '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
    '<button class="primary" type="submit">Salvar</button></div></form>');

  fundo.querySelector("#form-cliente").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const dados = valores(evento.target);
    const corpo = {
      ...dados,
      anexo: dados.anexo || null,
      rbt12: dados.rbt12 === "" ? null : Number(dados.rbt12),
      folha12: dados.folha12 === "" ? null : Number(dados.folha12),
      modules: [...evento.target.querySelectorAll('[name="modules"]:checked')].map((caixa) => caixa.value)
    };
    try {
      const resposta = await api(editando ? "/api/clients/" + item.id : "/api/clients", {
        method: editando ? "PATCH" : "POST",
        body: JSON.stringify(corpo)
      });
      fecharModal();
      aviso(resposta.linkedDocuments
        ? "Cliente criado e " + resposta.linkedDocuments + " documento(s) vinculado(s)"
        : "Cliente salvo", "success");
      render();
    } catch (erro) { aviso(erro.message, "error"); }
  });
}

// ------------------------------------------------------- visoes documentais

async function services() {
  titulo("Serviços", "NFS-e capturadas e conferidas");
  const dados = await api("/api/services/nfse");
  const desenhar = () => {
    const filtrados = dados.filter(combina);
    conteudo('<div class="card"><div class="head"><div><h2>NFS-e</h2>' +
      "<p>" + filtrados.length + " nota(s) no acervo</p></div>" +
      (can("import") ? '<button id="ir-importar">Importar XML</button>' : "") + "</div>" +
      barraBusca("numero ou empresa") +
      tabela(["Número", "Empresa", "Emissão", "Valor", "Alíquota", "ISS", "Retido", "Status", "Achados"],
        filtrados.map((item) => [
          esc(item.number), esc(item.clientName), dataCurta(item.date),
          dinheiro(item.amount), percentual(item.rate, 2), dinheiro(item.iss),
          item.retention ? dinheiro(item.retention) : "-",
          badge(item.status),
          item.findings
            ? '<button data-detalhar="' + esc(item.id) + '">' + item.findings + " achado(s)</button>"
            : badge("Conforme")
        ]), "Nenhuma NFS-e capturada. Importe um XML em Importacoes."));
    ligarBusca(desenhar);
    document.querySelector("#ir-importar")?.addEventListener("click", () => ir("imports"));
    for (const botao of document.querySelectorAll("[data-detalhar]")) {
      botao.addEventListener("click", () => detalharDocumento(botao.dataset.detalhar));
    }
  };
  desenhar();
}

async function federal() {
  titulo("Federal", "NF-e e NFC-e capturadas e conferidas");
  const dados = await api("/api/federal/docs");
  const desenhar = () => {
    const filtrados = dados.filter(combina);
    conteudo('<div class="card"><div class="head"><div><h2>Documentos federais</h2>' +
      "<p>" + filtrados.length + " documento(s) no acervo</p></div>" +
      (can("import") ? '<button class="primary" id="ir-importar">Nova importação</button>' : "") + "</div>" +
      barraBusca("chave, empresa ou tipo") +
      tabela(["Tipo", "Chave", "Empresa", "Emissão", "Operação", "Valor", "Status", "Achados"],
        filtrados.map((item) => [
          esc(item.type),
          '<code title="' + esc(item.key) + '">' + esc(String(item.key).slice(0, 12)) + "..." +
            esc(String(item.key).slice(-6)) + "</code>",
          esc(item.clientName), dataCurta(item.date), esc(item.operation),
          dinheiro(item.amount), badge(item.status),
          item.findings
            ? '<button data-detalhar="' + esc(item.key) + '">' + item.findings + " achado(s)</button>"
            : badge("Conforme")
        ]), "Nenhum documento federal capturado. Importe um XML ou ZIP em Importacoes."));
    ligarBusca(desenhar);
    document.querySelector("#ir-importar")?.addEventListener("click", () => ir("imports"));
    for (const botao of document.querySelectorAll("[data-detalhar]")) {
      botao.addEventListener("click", () => detalharDocumento(botao.dataset.detalhar));
    }
  };
  desenhar();
}

// ------------------------------------------------- lucro presumido e real

const REGIMES_LUCRO = [["presumido", "Lucro Presumido (trimestre)"], ["real-trimestral", "Lucro Real trimestral"],
  ["real-estimativa", "Lucro Real por estimativa (mês)"]];
const ROTULO_REGIME_LUCRO = { presumido: "Lucro Presumido", "real-trimestral": "Lucro Real trimestral", "real-estimativa": "Lucro Real estimativa" };
const TIPOS_RECEITA = ["NF-e", "NFC-e", "NFS-e", "CT-e"];

/** Trimestres AAAA-Tn, do atual para tras, com rotulo "3º trimestre de 2026". */
function trimestresRecentes(quantos = 8) {
  const hoje = new Date();
  let ano = hoje.getFullYear();
  let t = Math.floor(hoje.getMonth() / 3) + 1;
  const lista = [];
  for (let i = 0; i < quantos; i += 1) {
    lista.push([ano + "-T" + t, t + "º trimestre de " + ano]);
    t -= 1;
    if (!t) { t = 4; ano -= 1; }
  }
  return lista;
}

function periodoLucroBr(periodo) {
  const t = /^(\d{4})-T([1-4])$/.exec(periodo || "");
  return t ? t[2] + "º tri/" + t[1] : competenciaBr(periodo);
}

async function telaLucro() {
  titulo("Lucro Presumido e Real", "IRPJ, CSLL, PIS e COFINS a partir das notas, com memória de cálculo");
  const [apuracoes, clientes, ref] = await Promise.all([
    api("/api/lucro/apuracoes"), api("/api/clients"), api("/api/lucro/atividades")
  ]);

  const desenhar = () => {
    const filtrados = apuracoes.filter(combina);
    conteudo(
      '<div class="card"><div class="head"><div><h2>Apurações</h2>' +
        "<p>" + filtrados.length + " apuração(ões) gravada(s)</p></div>" +
        '<div class="actions"><button class="primary" id="apurar-lucro">Apurar</button></div></div>' +
        barraBusca("empresa, regime ou período") +
        tabela(["Empresa", "Regime", "Período", "IRPJ", "CSLL", "PIS", "COFINS", "Total", "Gravada em", ""],
          filtrados.map((item) => {
            const t = item.resultado.tributos || {};
            return [esc(item.clientName), esc(ROTULO_REGIME_LUCRO[item.regime] || item.regime), periodoLucroBr(item.periodo),
              dinheiro(t.irpj), dinheiro(t.csll), dinheiro(t.pis), dinheiro(t.cofins),
              "<strong>" + dinheiro(item.total) + "</strong>", quandoCurto(item.apuradoEm),
              '<button data-memoria-lucro="' + item.id + '">Memória</button>'];
          }), "Nenhuma apuração gravada. Clique em Apurar.") +
      "</div>" +
      '<div class="card"><div class="head"><div><h2>Regras em uso</h2>' +
        "<p>Receita das notas emitidas, sem as canceladas</p></div></div>" +
        '<div class="body">' + listaDados([
          ["Presunção", "Comércio e indústria 8% IRPJ e 12% CSLL; serviços 32% e 32%; transporte de cargas 8% e 12%. " +
            "A atividade de cada tipo de nota pode ser trocada na apuração."],
          ["IRPJ e CSLL", "15% + adicional de 10% sobre o que passa de R$ 60.000 no trimestre (R$ 20.000 no mês); CSLL 9%."],
          ["Acréscimo da LC 224", "No Presumido, +10% na presunção sobre a receita que passa de R$ 1,25 milhão no trimestre: " +
            "IRPJ desde janeiro de 2026, CSLL desde abril de 2026."],
          ["PIS e COFINS", "Presumido 0,65% e 3% (cumulativos); Real 1,65% e 7,6% com crédito sobre as compras."],
          ["Retenções", "IR e CSLL retidos nas NFS-e de prefeitura entram sozinhos; os demais são informados."],
          ["Fora das notas", "Receitas financeiras, ganhos e devoluções entram como ajuste informado."]
        ]) + "</div></div>");

    ligarBusca(desenhar);
    document.querySelector("#apurar-lucro").addEventListener("click", () => formLucro(clientes, ref));
    for (const botao of document.querySelectorAll("[data-memoria-lucro]")) {
      botao.addEventListener("click", () => {
        const item = apuracoes.find((a) => a.id === botao.dataset.memoriaLucro);
        modal("Memória · " + esc(item.clientName) + " · " + periodoLucroBr(item.periodo), htmlLucro(item.resultado), 960);
      });
    }
  };
  desenhar();
}

function formLucro(clientes, ref) {
  // Quem esta no Presumido ou no Real vem primeiro na lista.
  const peso = (c) => (c.taxRegime === "Lucro Presumido" || c.taxRegime === "Lucro Real" ? 0 : 1);
  const empresas = [...clientes].sort((a, b) => peso(a) - peso(b) || a.name.localeCompare(b.name));
  if (!empresas.length) return modal("Apurar", '<div class="message warn">Nenhuma empresa cadastrada.</div>');
  const regimeDe = (c) => (c?.taxRegime === "Lucro Real" ? "real-trimestral" : "presumido");
  const atividades = Object.entries(ref.atividades).map(([valor, item]) => [valor, item.rotulo]);
  const so = (regimes, html) => html.replace('<label class="form-field', '<label data-so="' + regimes + '" class="form-field');
  const valor = (nome, dica) => '<input name="' + nome + '" type="number" step="0.01" placeholder="' + esc(dica) + '">';

  const fundo = modal("Apurar Lucro Presumido ou Real",
    '<form id="form-lucro" class="form-grid">' +
    campo("Empresa", '<select name="clienteId">' + opcoes(empresas[0].id,
      empresas.map((c) => [c.id, c.name + (c.taxRegime ? " · " + c.taxRegime : "")])) + "</select>") +
    campo("Regime", '<select name="regime">' + opcoes(regimeDe(empresas[0]), REGIMES_LUCRO) + "</select>") +
    campo("Período", '<select name="periodo"></select>') +
    TIPOS_RECEITA.map((tipo) => campo("Atividade da " + tipo,
      '<select name="atividade-' + tipo + '">' + opcoes(ref.padrao[tipo], atividades) + "</select>")).join("") +
    so("real-trimestral", campo("Lucro contábil do trimestre", valor("lucroContabil", "antes do IRPJ e da CSLL"))) +
    so("real-trimestral", campo("Adições", valor("adicoes", "0,00"))) +
    so("real-trimestral", campo("Exclusões", valor("exclusoes", "0,00"))) +
    so("real-trimestral", campo("Prejuízo fiscal a compensar", valor("prejuizoACompensar", "0,00"))) +
    so("real-trimestral", campo("Base negativa da CSLL", valor("baseNegativaCsll", "0,00"))) +
    so("presumido real-estimativa", campo("Receitas financeiras e ganhos", valor("outrasReceitas", "0,00"))) +
    so("presumido real-estimativa", campo("Ajuste da receita", valor("ajusteReceita", "devolução com sinal -"))) +
    so("real-estimativa", campo("Compras com crédito", valor("compras", "das notas recebidas"))) +
    campo("IRPJ retido", valor("retIrpj", "das notas")) +
    campo("CSLL retida", valor("retCsll", "das notas")) +
    campo("PIS retido", valor("retPis", "0,00")) +
    campo("COFINS retida", valor("retCofins", "0,00")) +
    '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
    (can("import") ? '<button type="button" id="gravar-lucro">Gravar</button>' : "") +
    '<button class="primary" type="submit">Calcular</button></div>' +
    '</form><div id="resultado-lucro"></div>', 960);

  const form = fundo.querySelector("#form-lucro");
  const ajustarRegime = () => {
    const regime = form.regime.value;
    const lista = regime === "real-estimativa" ? opcoesCompetenciaIso(24) : trimestresRecentes(8);
    // O padrao e o periodo fechado mais recente: o mes ou o trimestre anterior.
    form.periodo.innerHTML = opcoes(lista[1][0], lista);
    for (const item of form.querySelectorAll("[data-so]")) item.hidden = !item.dataset.so.split(" ").includes(regime);
    fundo.querySelector("#resultado-lucro").innerHTML = "";
  };
  form.clienteId.addEventListener("change", () => {
    form.regime.value = regimeDe(empresas.find((c) => c.id === form.clienteId.value));
    ajustarRegime();
  });
  form.regime.addEventListener("change", ajustarRegime);
  ajustarRegime();

  const montar = () => {
    const d = valores(form);
    const num = (v) => (v === "" || v === undefined ? undefined : Number(v));
    const corpo = {
      clienteId: d.clienteId, regime: d.regime, periodo: d.periodo,
      atividades: Object.fromEntries(TIPOS_RECEITA.map((tipo) => [tipo, d["atividade-" + tipo]])),
      retencoes: { irpj: num(d.retIrpj), csll: num(d.retCsll), pis: num(d.retPis), cofins: num(d.retCofins) }
    };
    if (d.regime === "real-trimestral") {
      Object.assign(corpo, { lucroContabil: num(d.lucroContabil), adicoes: num(d.adicoes), exclusoes: num(d.exclusoes),
        prejuizoACompensar: num(d.prejuizoACompensar), baseNegativaCsll: num(d.baseNegativaCsll) });
    } else {
      corpo.ajustes = { receita: num(d.ajusteReceita), outrasReceitas: num(d.outrasReceitas) };
    }
    if (d.regime === "real-estimativa") corpo.compras = num(d.compras);
    return corpo;
  };

  form.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    try {
      const r = await api("/api/lucro/calcular", { method: "POST", body: JSON.stringify(montar()) });
      fundo.querySelector("#resultado-lucro").innerHTML = htmlLucro(r.resultado, r.notas);
      dicasDeCorte(fundo);
    } catch (erro) { aviso(erro.message, "error"); }
  });
  fundo.querySelector("#gravar-lucro")?.addEventListener("click", async () => {
    try {
      const r = await api("/api/lucro/apuracoes", { method: "POST", body: JSON.stringify(montar()) });
      fecharModal();
      aviso("Apuração gravada: total " + dinheiro(r.resultado.total), "success");
      render();
    } catch (erro) { aviso(erro.message, "error"); }
  });
}

/** Resultado da apuracao: indicadores, vencimentos, memoria de calculo e as notas usadas. */
function htmlLucro(r, notas = null) {
  const t = r.tributos || {};
  const receita = r.receita ?? (r.mensal || []).reduce((s, m) => s + (m.receita || 0), 0);
  const sobra = r.creditoQueSobra && (r.creditoQueSobra.pis || r.creditoQueSobra.cofins)
    ? dinheiro(r.creditoQueSobra.pis) + " de PIS e " + dinheiro(r.creditoQueSobra.cofins) + " de COFINS" : "";
  const meses = Object.entries(notas || {});
  return '<div class="grid metrics" style="margin:14px 0">' +
    cartao("Receita", dinheiro(receita), r.regime === "real-trimestral"
      ? "lucro ajustado " + dinheiro(r.lucroAjustado) : esc(ROTULO_REGIME_LUCRO[r.regime] || "")) +
    cartao("IRPJ", dinheiro(t.irpj), t.adicionalIrpj ? "com adicional de " + dinheiro(t.adicionalIrpj) : "sem adicional") +
    cartao("CSLL", dinheiro(t.csll), "base " + dinheiro(r.bases?.csll)) +
    cartao("PIS", dinheiro(t.pis), r.regime === "presumido" ? "0,65% cumulativo" : "1,65% menos créditos") +
    cartao("COFINS", dinheiro(t.cofins), r.regime === "presumido" ? "3% cumulativo" : "7,6% menos créditos") +
    cartao("Total", dinheiro(r.total), periodoLucroBr(r.periodo)) +
  "</div>" +
  listaDados([
    ["Vencimento do IRPJ e da CSLL", esc(r.vencimentos?.irpjCsll || "")],
    ["Vencimento do PIS e da COFINS", esc(r.vencimentos?.pisCofins || "")],
    ["Crédito que sobra para o mês seguinte", sobra]
  ]) +
  '<div class="card" style="margin-top:12px"><div class="head"><div><h2>Memória de cálculo</h2><p>Linha a linha</p></div></div>' +
    tabela(["Descrição", "Base", "Alíquota", "Valor"], (r.memoria || []).map((linha) => linha.map((c) => esc(c || "")))) +
  "</div>" +
  (meses.length
    ? '<div class="card" style="margin-top:12px"><div class="head"><div><h2>Notas usadas</h2>' +
        "<p>Emitidas e recebidas, sem as canceladas</p></div></div>" +
        tabela(["Competência", ...TIPOS_RECEITA, "Compras", "IR retido", "CSLL retida"],
          meses.map(([mes, d]) => [competenciaBr(mes), ...TIPOS_RECEITA.map((tipo) => dinheiro(d.receitas[tipo])),
            dinheiro(d.compras), dinheiro(d.retencoes.irpj), dinheiro(d.retencoes.csll)])) +
      "</div>"
    : "");
}

// ----------------------------------------------------------- simples nacional

async function simples() {
  titulo("Simples Nacional", "Apuração da LC 123 com memória de cálculo");
  const [apuracoes, clientes, tabelas] = await Promise.all([
    api("/api/simples/assessments"),
    api("/api/clients"),
    api("/api/simples/tabelas")
  ]);
  const optantes = clientes.filter((item) => item.taxRegime === "Simples Nacional");

  const desenhar = () => {
    const filtrados = apuracoes.filter(combina);
    conteudo(
      '<div class="card"><div class="head"><div><h2>Apurações</h2>' +
        "<p>" + filtrados.length + " apuracao(oes)</p></div>" +
        '<div class="actions"><button id="simular">Simulador</button>' +
        (can("import") ? '<button class="primary" id="apurar">Apurar competência</button>' : "") +
        "</div></div>" +
        barraBusca("empresa ou competencia") +
        tabela(["Empresa", "Competência", "Anexo", "Faixa", "RBT12", "Receita", "Alíq. efetiva", "DAS", "Status", ""],
          filtrados.map((item) => [
            esc(item.clientName), esc(item.period), esc(item.anexo || "-"), item.faixa ?? "-",
            item.rbt12 ? dinheiro(item.rbt12) : "-",
            dinheiro(item.receitaMes), aliquotasDaApuracao(item),
            "<strong>" + dinheiro(item.amount) + "</strong>", badge(item.status),
            '<button data-memoria="' + item.id + '">Memória</button>'
          ]), "Nenhuma apuracao. Capture documentos e clique em Apurar competencia.") +
      "</div>" +
      '<div class="card"><div class="head"><div><h2>Tabelas em uso</h2>' +
        "<p>" + esc(tabelas.vigencia.norma) + "</p></div></div>" +
        '<div class="body"><div class="message warn">' +
        "<strong>Conferir antes de usar em producao.</strong> " + esc(tabelas.vigencia.observacao) +
        " Vigencia declarada a partir de " + esc(tabelas.vigencia.inicio) + "." +
        "</div></div>" +
      "</div>");

    ligarBusca(desenhar);
    document.querySelector("#apurar")?.addEventListener("click", () => formApurar(optantes));
    document.querySelector("#simular")?.addEventListener("click", () => formSimular());
    for (const botao of document.querySelectorAll("[data-memoria]")) {
      botao.addEventListener("click", () =>
        verMemoria(apuracoes.find((item) => item.id === botao.dataset.memoria)));
    }
  };
  desenhar();
}

function formApurar(optantes) {
  if (!optantes.length) {
    return modal("Apurar competência",
      '<div class="message warn">Nenhum cliente optante do Simples Nacional cadastrado.</div>');
  }
  const fundo = modal("Apurar competência",
    '<form id="form-apurar" class="form-grid">' +
    '<div class="full message info">A receita do mês sai dos documentos já capturados, pelo CFOP: ' +
    "revenda no Anexo I, produção própria no Anexo II e serviços (NFS-e, pela competência da nota) no anexo " +
    "de serviço do cadastro, com o Fator R quando houver folha. Remessa, transferência, retorno e nota de " +
    "entrada ficam de fora; devolução de venda abate. Todas as parcelas usam o mesmo RBT12, e o DAS é a soma " +
    "delas. O RBT12, a folha e o anexo vêm do cadastro do cliente, e podem ser sobrescritos aqui." +
    "</div>" +
    campo("Empresa", '<select name="clientId" required>' +
      optantes.map((cliente) => '<option value="' + cliente.id + '" data-rbt="' + (cliente.rbt12 ?? "") +
        '" data-folha="' + (cliente.folha12 ?? "") + '" data-anexo="' + (cliente.anexo || "") + '">' +
        esc(cliente.name) + "</option>").join("") + "</select>") +
    campo("Competência", seletorCompetencia("period", mesesRecentes(2)[1])) +
    campo("Anexo", '<select name="anexo">' +
      ['<option value="">usar o do cadastro</option>'].concat(["I", "II", "III", "IV", "V"].map((anexo) =>
        '<option value="' + anexo + '">Anexo ' + anexo + "</option>")).join("") + "</select>") +
    campo("RBT12", '<input name="rbt12" type="number" step="0.01" min="0" placeholder="do cadastro">') +
    campo("Folha 12 meses", '<input name="folha12" type="number" step="0.01" min="0" placeholder="do cadastro">', true) +
    '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
    '<button class="primary" type="submit">Apurar</button></div></form>');

  fundo.querySelector("#form-apurar").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const dados = valores(evento.target);
    const corpo = { clientId: dados.clientId, period: dados.period };
    if (dados.anexo) corpo.anexo = dados.anexo;
    if (dados.rbt12) corpo.rbt12 = Number(dados.rbt12);
    if (dados.folha12) corpo.folha12 = Number(dados.folha12);
    await enviarApuracao(corpo);
  });
}

async function enviarApuracao(corpo) {
  try {
    const resultado = await api("/api/simples/apurar", { method: "POST", body: JSON.stringify(corpo) });
    fecharModal();
    aviso("Apuracao " + resultado.period + ": DAS " + dinheiro(resultado.amount), "success");
    verMemoria(resultado);
  } catch (erro) {
    const d = erro.dados || {};
    // Competencia fora da vigencia nao e erro de digitacao: e risco de numero
    // errado. A tela explica e exige confirmacao em vez de so recusar.
    if (d.vigencia && d.motivo) {
      const fundo = modal("Competência fora da vigencia das tabelas",
        '<div class="message danger-text">' + esc(d.motivo) + "</div>" +
        "<p>As tabelas em uso foram conferidas para <strong>" + esc(d.vigencia.inicio) +
        "</strong> a <strong>" + esc(d.vigencia.fim) + "</strong>, em " +
        esc(d.vigencia.conferidoEm) + ".</p>" +
        '<p class="muted">' + esc(d.comoResolver || "") + "</p>" +
        '<div class="message warn">Se continuar, o DAS sera calculado com tabelas que ' +
        "nao valem para essa competencia, e o numero provavelmente estara errado. " +
        "A confirmacao fica registrada na auditoria com o seu usuario." +
        "</div>" +
        '<div class="form-actions"><button type="button" data-fechar>Cancelar</button>' +
        '<button class="primary" id="confirmar-vigencia">Apurar assim mesmo</button></div>');
      fundo.querySelector("#confirmar-vigencia").addEventListener("click", () =>
        enviarApuracao({ ...corpo, confirmarForaDeVigencia: true }));
      return;
    }
    aviso(erro.message + (d.hint ? " " + d.hint : ""), "error");
  }
}

function formSimular() {
  const fundo = modal("Simulador do Simples Nacional",
    '<form id="form-simular" class="form-grid">' +
    campo("Receita do mês", '<input name="receitaMes" type="number" step="0.01" min="0" required value="50000">') +
    campo("RBT12", '<input name="rbt12" type="number" step="0.01" min="1" required value="500000">') +
    campo("Anexo", '<select name="anexo">' + ["I", "II", "III", "IV", "V"].map((anexo) =>
      '<option value="' + anexo + '">Anexo ' + anexo + "</option>").join("") + "</select>") +
    campo("Folha 12 meses (opcional, ativa o Fator R)",
      '<input name="folha12" type="number" step="0.01" min="0" placeholder="deixe vazio para ignorar">') +
    '<div class="form-actions full"><button class="primary" type="submit">Calcular</button></div>' +
    "</form><div id=\"resultado-simulacao\"></div>");

  fundo.querySelector("#form-simular").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const dados = valores(evento.target);
    const corpo = {
      receitaMes: Number(dados.receitaMes),
      rbt12: Number(dados.rbt12),
      anexo: dados.anexo
    };
    if (dados.folha12) corpo.folha12 = Number(dados.folha12);
    try {
      const resultado = await api("/api/simples/simular", { method: "POST", body: JSON.stringify(corpo) });
      fundo.querySelector("#resultado-simulacao").innerHTML = htmlMemoria(resultado);
    } catch (erro) { aviso(erro.message, "error"); }
  });
}

// Aliquota efetiva na lista de apuracoes: com a receita em mais de um anexo,
// a de cada parcela (nao existe uma efetiva so).
function aliquotasDaApuracao(item) {
  const parcelas = item.segmentos || [];
  if (parcelas.length > 1) {
    return parcelas.map((parcela) => "Anexo " + esc(parcela.anexo) + " " + percentual(parcela.aliquotaEfetiva)).join("<br>");
  }
  return item.aliquotaEfetiva ? percentual(item.aliquotaEfetiva) : "-";
}

const ROTULO_PARCELA = {
  comercio: "Comércio (revenda)", industria: "Indústria (produção própria)",
  servicos: "Serviços", transporte: "Transporte e comunicação"
};

function tabelaReparticao(tributos) {
  return tabela(["Tributo", "% da reparticao", "Alíquota", "Valor", "Conta"],
    Object.entries(tributos || {}).map(([nome, item]) => [
      "<strong>" + esc(nome) + "</strong>", item.percentualReparticao + "%",
      percentual(item.aliquota), dinheiro(item.valor),
      '<span class="muted">' + esc(item.memoria || "") + "</span>"
    ]), "Nenhum tributo apurado");
}

// Cada parcela da receita no seu anexo, com o mesmo RBT12; o DAS e a soma.
function htmlParcelas(apuracao) {
  const parcelas = apuracao.segmentos || [];
  if (!parcelas.length) return "";
  const segregada = parcelas.length > 1;
  const linhas = parcelas.map((parcela) => [
    "<strong>" + esc(ROTULO_PARCELA[parcela.segmento] || parcela.rotulo || parcela.segmento) + "</strong>",
    "Anexo " + esc(parcela.anexo), dinheiro(parcela.receita), parcela.faixa ?? "-",
    percentual(parcela.aliquotaNominal, 2), dinheiro(parcela.deducao), percentual(parcela.aliquotaEfetiva),
    dinheiro(parcela.das)
  ]);
  if (segregada) {
    linhas.push(["<strong>Total</strong>", '<span class="muted">soma das parcelas</span>',
      "<strong>" + dinheiro(apuracao.receitaMes) + "</strong>", apuracao.faixa ?? "-", "", "", "",
      "<strong>" + dinheiro(apuracao.das ?? apuracao.amount) + "</strong>"]);
  }
  return '<div class="card" style="margin-top:12px"><div class="head"><div><h2>Parcelas por anexo</h2>' +
      "<p>" + (segregada
        ? "Cada atividade no seu anexo, todas com o mesmo RBT12 de " + dinheiro(apuracao.rbt12) + "; o DAS é a soma das parcelas"
        : "Toda a receita do mês numa atividade") + "</p></div></div>" +
      tabela(["Parcela", "Anexo", "Receita", "Faixa", "Nominal", "Dedução", "Efetiva", "DAS"], linhas) +
    "</div>";
}

function htmlMemoria(apuracao) {
  const fora = Object.entries(apuracao.foraDoDas || {});
  const parcelas = apuracao.segmentos || [];
  const segregada = parcelas.length > 1;
  return '<div class="grid metrics" style="margin:14px 0">' +
    '<div class="card metric"><span>Anexo</span><strong>' + esc(apuracao.anexo || "-") + "</strong></div>" +
    '<div class="card metric"><span>Faixa</span><strong>' + (apuracao.faixa ?? "-") + "</strong></div>" +
    (segregada
      ? '<div class="card metric"><span>Parcelas</span><strong>' + parcelas.length + "</strong></div>" +
        '<div class="card metric"><span>RBT12</span><strong style="font-size:18px">' + dinheiro(apuracao.rbt12) + "</strong></div>"
      : '<div class="card metric"><span>Nominal</span><strong>' + (apuracao.aliquotaNominal ?? 0) + "%</strong></div>" +
        '<div class="card metric"><span>Efetiva</span><strong>' +
          Number(apuracao.aliquotaEfetiva || 0).toFixed(4) + "%</strong></div>") +
    '<div class="card metric"><span>Receita</span><strong style="font-size:18px">' +
      dinheiro(apuracao.receitaMes) + "</strong></div>" +
    '<div class="card metric"><span>DAS</span><strong style="font-size:18px">' +
      dinheiro(apuracao.das ?? apuracao.amount) + "</strong></div>" +
  "</div>" +
  (apuracao.fatorR
    ? '<div class="message info">Fator R: ' + esc(apuracao.fatorR.motivo) + "</div>"
    : "") +
  (apuracao.avisos?.length
    ? apuracao.avisos.map((item) =>
        '<div class="message ' + (item.severity === "critico" ? "danger-text" : "warn") + '">' +
        esc(item.message) + "</div>").join("")
    : "") +
  htmlParcelas(apuracao) +
  (segregada
    ? parcelas.map((parcela) =>
        '<div class="card" style="margin-top:12px"><div class="head"><div><h2>Reparticao do Anexo ' + esc(parcela.anexo) +
          "</h2><p>" + esc(ROTULO_PARCELA[parcela.segmento] || parcela.segmento) + ": receita " + dinheiro(parcela.receita) +
          ", DAS " + dinheiro(parcela.das) + "</p></div></div>" +
          tabelaReparticao(parcela.tributos) +
        "</div>").join("")
    : '<div class="card" style="margin-top:12px"><div class="head"><div><h2>Reparticao por tributo</h2>' +
        "<p>Dentro do DAS</p></div></div>" +
        tabelaReparticao(apuracao.tributos) +
      "</div>") +
  (fora.length
    ? '<div class="card" style="margin-top:12px"><div class="head"><div><h2>Fora do DAS</h2>' +
      "<p>Recolhido pela legislacao do ente</p></div></div>" +
      tabela(["Tributo", "Valor", "Observação"],
        fora.map(([nome, item]) => [
          "<strong>" + esc(nome) + "</strong>",
          item.valor === null ? '<span class="muted">nao calculado</span>' : dinheiro(item.valor),
          '<span class="muted">' + esc(item.observacao || "") + "</span>"
        ])) + "</div>"
    : "") +
  '<div class="card" style="margin-top:12px"><div class="head"><div><h2>Memória de cálculo</h2>' +
    "<p>Cada passo, na ordem</p></div></div><div class=\"body\"><ol>" +
    (apuracao.memoria || []).map((linha) => "<li>" + esc(linha) + "</li>").join("") +
    "</ol></div></div>" +
  (apuracao.origem ? htmlOrigemReceita(apuracao.origem) : "");
}

// De onde veio a receita: o que entrou, o que abateu e o que ficou de fora pelo CFOP.
function htmlOrigemReceita(origem) {
  const fora = origem.foraDaReceita;
  const partes = ["Serviços: " + dinheiro(origem.receitaServicos),
    "Mercadorias: " + dinheiro(origem.receitaMercadorias) +
      (origem.receitaComercio !== undefined
        ? " (revenda " + dinheiro(origem.receitaComercio) + ", produção própria " + dinheiro(origem.receitaIndustria) +
          (origem.receitaSemCfop ? ", sem CFOP " + dinheiro(origem.receitaSemCfop) : "") + ")"
        : "")];
  if (origem.receitaTransporte) partes.push("Transporte: " + dinheiro(origem.receitaTransporte));
  if (origem.devolucoes) partes.push("Devoluções de venda: −" + dinheiro(origem.devolucoes));
  return '<div class="card" style="margin-top:12px"><div class="head"><div><h2>Origem da receita</h2>' +
      "<p>" + origem.documentos + " documento(s): " + origem.notasServico + " de servico, " +
      origem.notasMercadoria + " de mercadoria" +
      (origem.notasTransporte ? ", " + origem.notasTransporte + " de transporte" : "") +
      (origem.notasDevolucao ? ", " + origem.notasDevolucao + " de devolucao" : "") + "</p></div></div>" +
      '<div class="body"><p>' + partes.join(" &middot; ") + "</p>" +
      (fora?.itens
        ? '<p class="muted">Fora da receita pelo CFOP (remessa, retorno, transferência, bonificação, ativo, entrada): ' +
          fora.itens + " item(ns), " + dinheiro(fora.valor) + " — " +
          (fora.porCfop || []).map((item) => "CFOP " + esc(item.cfop) + " " + dinheiro(item.valor)).join(", ") + "</p>"
        : "") +
      (origem.notasEntradaPropria
        ? '<p class="muted">' + origem.notasEntradaPropria + " nota(s) de entrada emitida(s) pela empresa: não são receita.</p>"
        : "") +
      (origem.semCfop?.length
        ? '<p class="muted">Sem CFOP, pelo total: ' + origem.semCfop.map(esc).join("<br>") + "</p>"
        : "") +
      '<p class="muted">Chaves: ' + (origem.chaves || []).map(esc).join("<br>") + "</p></div></div>";
}

function verMemoria(apuracao) {
  if (!apuracao) return;
  modal("Apuração " + esc(apuracao.period || "") + " - " + esc(apuracao.clientName || ""),
    '<p class="muted">Apurado em ' + dataHora(apuracao.apuradoEm) + " por " +
    esc(apuracao.apuradoPor || "-") + "</p>" + htmlMemoria(apuracao), 900);
}

// ---------------------------------------------------------------- prevencao

const ROTULO_PRAZO = { a1: "Certificado A1", resumo: "NF-e em resumo", fechamento: "Fechamento do mês" };

async function prevention() {
  titulo("Prevenção", "Prazos que vencem por empresa");
  const dados = await api("/api/prevencao");
  const itens = dados.itens;
  const vencidos = itens.filter((item) => item.vencido).length;
  const em15 = itens.filter((item) => !item.vencido && item.dias <= 15).length;
  const prazo = (item) => dataCurta(item.data) + ' <span class="muted">' +
    (item.vencido ? "há " + Math.abs(item.dias) + " dia(s)" : item.dias === 0 ? "hoje" : "em " + item.dias + " dia(s)") + "</span>";

  conteudo(
    '<div class="grid metrics">' +
      cartao("Vencidos", vencidos, "precisam de ação agora") +
      cartao("Próximos 15 dias", em15, "ainda dá tempo") +
      cartao("Em " + dados.janelaDias + " dias", itens.length - vencidos, "no horizonte") +
    "</div>" +
    '<div class="card"><div class="head"><div><h2>Prazos</h2><p>Os Alertas mostram o que já está errado; aqui fica o que ' +
      "vai vencer, com data, enquanto ainda dá para evitar</p></div></div>" +
      tabela(["Prazo", "Situação", "Empresa", "O que vence", "Se passar", ""],
        itens.map((item) => [
          prazo(item),
          badge(item.vencido ? "Vencido" : item.dias <= 15 ? "Vencendo" : "No prazo"),
          "<strong>" + esc(item.empresa) + "</strong>",
          esc(item.titulo) + ' <span class="muted">' + esc(ROTULO_PRAZO[item.tipo] || item.tipo) + "</span>",
          '<span title="' + esc(item.acao) + '">' + esc(item.seVencer) + "</span>",
          item.clientId ? '<button data-abrir="' + esc(item.clientId) + '" title="' + esc(item.acao) + '">Abrir</button>' : "-"
        ]), "Nada vencendo nos próximos " + dados.janelaDias + " dias") +
    "</div>" +
    '<div class="card"><div class="body"><div class="message info"><strong>Como cada prazo é calculado.</strong> ' +
      "<strong>A1:</strong> a validade do certificado no cofre do NÚCLEO e no da PONTE. " +
      "<strong>NF-e em resumo:</strong> a distribuição da SEFAZ entrega o XML por cerca de 90 dias depois da emissão; " +
      "o prazo conta do começo do mês de emissão gravado na chave, para não prometer dias que não existem. " +
      "<strong>Fechamento:</strong> a captura do mês anterior precisa rodar depois que ele acabou; referência dia 10." +
    "</div></div></div>"
  );
  for (const botao of document.querySelectorAll("[data-abrir]")) botao.addEventListener("click", () => abrirEmpresa(botao.dataset.abrir));
}

// ----------------------------------------------------------- processamentos

async function processes() {
  titulo("Processamentos", "Rotinas do sistema");
  const dados = await api("/api/processes");
  const desenhar = () => {
    const filtrados = dados.filter(combina);
    conteudo('<div class="card"><div class="head"><div><h2>Rotinas</h2>' +
      "<p>" + filtrados.length + " execucao(oes)</p></div>" +
      (can("import") ? '<button class="primary" id="nova-rotina">Executar rotina</button>' : "") + "</div>" +
      barraBusca("tipo ou alvo") +
      tabela(["Quando", "Tipo", "Alvo", "Status", "Duracao", "Resultado"],
        filtrados.map((item) => [
          dataHora(item.date), esc(item.type), esc(item.target), badge(item.status),
          item.durationMs !== undefined ? item.durationMs + " ms" : "-",
          esc(item.details || "-")
        ]), "Nenhuma rotina executada"));
    ligarBusca(desenhar);
    document.querySelector("#nova-rotina")?.addEventListener("click", () => {
      const fundo = modal("Executar rotina",
        '<form id="form-rotina" class="form-grid">' +
        '<div class="full message info"><strong>Vigilancia</strong> recalcula todos os alertas. ' +
        "<strong>Reconferencia</strong> passa o motor de conferencia em todo o acervo de novo, " +
        "util depois de mudar uma regra. Ambas rodam na hora e devolvem o resultado." +
        "</div>" +
        campo("Tipo", '<select name="type"><option>Vigilancia</option><option>Reconferencia</option></select>') +
        campo("Alvo", '<select name="target"><option value="Todos">Toda a carteira</option></select>') +
        '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
        '<button class="primary" type="submit">Executar</button></div></form>');
      fundo.querySelector("#form-rotina").addEventListener("submit", async (evento) => {
        evento.preventDefault();
        const botao = evento.target.querySelector(".primary");
        botao.disabled = true;
        botao.textContent = "Executando...";
        try {
          const job = await api("/api/processes", { method: "POST", body: JSON.stringify(valores(evento.target)) });
          fecharModal();
          aviso(job.type + ": " + job.details, "success");
          render();
        } catch (erro) { aviso(erro.message, "error"); botao.disabled = false; botao.textContent = "Executar"; }
      });
    });
  };
  desenhar();
}

// --------------------------------------------------------------- importacoes

async function imports() {
  titulo("Importações", "XML, ZIP ou chave de acesso");
  const [dados, empresasCaptura] = await Promise.all([
    api("/api/imports"), api("/api/captura/empresas").catch(() => [])
  ]);
  // Baixar por chave usa o A1 da empresa destinataria na SEFAZ.
  const destinatarias = empresasCaptura.filter((item) => item.configurada && item.ativa && (item.fontes || []).includes("NFE"));
  const desenhar = () => {
    const filtrados = dados.filter(combina);
    conteudo(
      (can("import")
        ? '<div class="card"><div class="head"><div><h2>Nova importação</h2>' +
          "<p>XML ou ZIP de NF-e, NFC-e e NFS-e</p></div></div>" +
          '<div class="body"><form id="form-importar" class="form-grid">' +
          campo("Arquivos (.xml ou .zip, varios de uma vez)",
            '<input type="file" name="arquivos" accept=".xml,.zip" multiple required>', true) +
          campo("Módulo", '<select name="module"><option>Federal</option><option>Servicos</option></select>') +
          '<div class="form-actions"><button class="primary" type="submit">Importar</button></div>' +
          '<div class="full message info">Documentos repetidos sao recusados pela chave de acesso. ' +
          "Cada documento aceito e conferido na hora, e a vigilancia roda em seguida." +
          "</div></form>" +
          '<form id="form-chave" class="form-grid" style="margin-top:16px;border-top:1px solid var(--line);padding-top:16px">' +
          campo("Chaves de acesso de NF-e (uma por linha, até 20)",
            '<textarea name="keys" rows="3" placeholder="44 digitos"></textarea>', true) +
          campo("Empresa destinataria", destinatarias.length
            ? '<select name="clientId">' + destinatarias.map((item) =>
                '<option value="' + item.clientId + '">' + esc(item.name) + " (" + esc(item.cnpj) + ")</option>").join("") + "</select>"
            : '<select name="clientId" disabled><option>nenhuma empresa com NF-e ligada</option></select>', true) +
          '<div class="form-actions full"><button type="submit">Baixar pela chave</button></div>' +
          '<div class="full message info">Confere o digito de cada chave e baixa a NF-e na SEFAZ com o A1 da empresa ' +
          "destinataria: XML e DANFE vao para o acervo e para a pasta dela. A SEFAZ so entrega a nota a quem e " +
          "destinatario, e so dos ultimos meses. Nota so em resumo depende da Ciencia da Operacao." +
          (destinatarias.length ? "" : " Para usar, ligue NF-e em Captura de notas > Empresas > Configurar.") +
          "</div></form></div></div>"
        : "") +
      '<div class="card"><div class="head"><div><h2>Histórico de importações</h2>' +
        "<p>" + filtrados.length + " lote(s)</p></div></div>" +
        barraBusca("modulo ou metodo") +
        tabela(["Quando", "Módulo", "Metodo", "Status", "Docs", "Duplicados", "Falhas", "Detalhe"],
          filtrados.map((item) => [
            dataHora(item.date), esc(item.module), esc(item.method), badge(item.status),
            item.documents, item.duplicates ?? 0,
            item.errors?.length ? '<span class="error-count">' + item.errors.length + "</span>" : "0",
            esc(item.details || "-") +
            (item.errors?.length
              ? '<br><span class="muted">' + item.errors.map(esc).join("; ") + "</span>"
              : "") +
            (item.unlinked?.length
              ? '<br><span class="muted">Sem cliente: ' +
                item.unlinked.map((orfao) => esc(orfao.cnpj)).join(", ") + "</span>"
              : "")
          ]), "Nenhuma importacao registrada") +
      "</div>");

    ligarBusca(desenhar);

    document.querySelector("#form-importar")?.addEventListener("submit", async (evento) => {
      evento.preventDefault();
      const botao = evento.target.querySelector(".primary");
      const arquivos = [...evento.target.arquivos.files];
      if (!arquivos.length) return aviso("Selecione ao menos um arquivo", "error");
      botao.disabled = true;
      botao.textContent = "Importando...";
      try {
        const corpo = {
          module: evento.target.module.value,
          files: await Promise.all(arquivos.map(async (arquivo) => ({
            name: arquivo.name,
            contentBase64: await lerBase64(arquivo)
          })))
        };
        const resultado = await api("/api/federal/imports", { method: "POST", body: JSON.stringify(corpo) });
        aviso(resultado.importacao.documents + " documento(s) capturado(s), " +
          resultado.irregulares + " irregular(es)", "success");
        render();
      } catch (erro) {
        aviso(erro.message + (erro.dados?.importacao?.errors?.length
          ? " " + erro.dados.importacao.errors.join("; ") : ""), "error");
        botao.disabled = false;
        botao.textContent = "Importar";
      }
    });

    document.querySelector("#form-chave")?.addEventListener("submit", async (evento) => {
      evento.preventDefault();
      const botao = evento.target.querySelector('button[type="submit"]');
      botao.disabled = true;
      botao.textContent = "Consultando a SEFAZ...";
      try {
        const r = await api("/api/federal/imports", {
          method: "POST",
          body: JSON.stringify({ method: "Chave de acesso", keys: evento.target.keys.value,
            clientId: evento.target.clientId?.value || null })
        });
        const NOMES = { baixada: "Baixada", ja_no_acervo: "Ja estava", resumo: "So resumo", nao_encontrada: "Nao encontrada",
          fora_do_alcance: "Fora do alcance", recusada: "Recusada", adiada: "Adiada" };
        modal("Download por chave - " + esc(r.empresa),
          '<div class="message ' + (r.naoBaixadas ? "warn" : "info") + '"><strong>' + r.baixadas + " baixada(s)</strong>" +
          (r.jaNoAcervo ? ", " + r.jaNoAcervo + " ja no acervo" : "") +
          (r.resumos ? ", " + r.resumos + " so em resumo (veja Pendencias)" : "") +
          (r.naoBaixadas - r.resumos > 0 ? ", " + (r.naoBaixadas - r.resumos) + " nao baixada(s)" : "") + ".</div>" +
          tabela(["Chave", "Situação", "Detalhe"], r.resultados.map((item) => [
            '<code title="' + esc(item.chave) + '">' + esc(item.chave.slice(0, 22)) + "...</code>",
            badge(NOMES[item.situacao] || item.situacao), esc(item.motivo || "")
          ]), ""), 820);
        if (r.baixadas) evento.target.keys.value = "";
      } catch (erro) {
        aviso(erro.message + (erro.dados?.detalhes?.length ? " " + erro.dados.detalhes.join("; ") : "") +
          (erro.dados?.comoResolver ? " " + erro.dados.comoResolver : ""), "error");
      }
      botao.disabled = false;
      botao.textContent = "Baixar pela chave";
    });
  };
  desenhar();
}

// ------------------------------------------------------------------ arquivos

async function uploads() {
  titulo("Arquivos", "Arquivos enviados ao sistema");
  const dados = await api("/api/uploads");
  const desenhar = () => {
    const filtrados = dados.filter(combina);
    conteudo('<div class="card"><div class="head"><div><h2>Arquivos</h2>' +
      "<p>" + filtrados.length + " arquivo(s)</p></div>" +
      (can("import") ? '<button class="primary" id="enviar">Enviar arquivo</button>' : "") + "</div>" +
      barraBusca("nome ou finalidade") +
      tabela(["Arquivo", "Finalidade", "Tamanho", "SHA-256", "Quando", "Por", "Ações"],
        filtrados.map((item) => [
          esc(item.filename), esc(item.kind),
          (item.size / 1024).toFixed(1) + " KB",
          '<code title="' + esc(item.sha256 || "") + '">' + esc(String(item.sha256 || "").slice(0, 10)) + "</code>",
          dataHora(item.date), esc(item.uploadedBy),
          can("export")
            ? '<div class="actions"><button data-baixar="' + item.id + '">Baixar</button>' +
              (can("import") ? '<button data-importar="' + item.id + '">Importar</button>' : "") + "</div>"
            : "-"
        ]), "Nenhum arquivo armazenado"));

    ligarBusca(desenhar);
    document.querySelector("#enviar")?.addEventListener("click", () => {
      const fundo = modal("Enviar arquivo",
        '<form id="form-upload" class="form-grid">' +
        campo("Arquivo", '<input type="file" name="arquivo" required>', true) +
        campo("Finalidade", '<select name="kind">' + opcoes("geral", [["geral", "Geral"], ["contrato", "Contrato"],
          ["guia", "Guia de pagamento"], ["comprovante", "Comprovante"], ["planilha", "Planilha"], ["documento", "Documento da empresa"]]) +
          "</select>", true) +
        '<div class="full message info">Limite de 100 MB. Arquivo com conteudo identico a um ja ' +
        "enviado e reaproveitado, nao duplicado." +
        "</div>" +
        '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
        '<button class="primary" type="submit">Enviar</button></div></form>');
      fundo.querySelector("#form-upload").addEventListener("submit", async (evento) => {
        evento.preventDefault();
        const arquivo = evento.target.arquivo.files[0];
        const botao = evento.target.querySelector(".primary");
        botao.disabled = true;
        try {
          const resultado = await api("/api/uploads", {
            method: "POST",
            body: JSON.stringify({
              filename: arquivo.name,
              kind: evento.target.kind.value,
              contentBase64: await lerBase64(arquivo)
            })
          });
          fecharModal();
          aviso(resultado.reused ? "Arquivo identico ja existia, reaproveitado" : "Arquivo armazenado", "success");
          render();
        } catch (erro) {
          aviso(erro.message + (erro.dados?.errors?.length ? " " + erro.dados.errors.join("; ") : ""), "error");
          botao.disabled = false;
        }
      });
    });

    for (const botao of document.querySelectorAll("[data-baixar]")) {
      botao.addEventListener("click", () => baixar("/api/uploads/" + botao.dataset.baixar + "/download"));
    }
    for (const botao of document.querySelectorAll("[data-importar]")) {
      botao.addEventListener("click", async () => {
        botao.disabled = true;
        try {
          const resultado = await api("/api/federal/imports", {
            method: "POST",
            body: JSON.stringify({ uploadId: botao.dataset.importar, module: "Federal" })
          });
          aviso(resultado.importacao.documents + " documento(s) capturado(s)", "success");
          render();
        } catch (erro) { aviso(erro.message, "error"); botao.disabled = false; }
      });
    }
  };
  desenhar();
}

async function baixar(caminho) {
  try {
    const resposta = await fetch(caminho, { headers: { authorization: "Bearer " + state.token } });
    if (!resposta.ok) throw new Error("Download recusado (" + resposta.status + ")");
    const blob = await resposta.blob();
    const nome = (resposta.headers.get("content-disposition") || "").match(/filename="?([^";]+)"?/)?.[1] || "arquivo";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = nome;
    // Fora do documento, ou com o endereco liberado na hora, alguns navegadores
    // cancelam o download em silencio.
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (erro) { aviso(erro.message, "error"); }
}

// -------------------------------------------------------------------- regras

async function rules() {
  titulo("Regras", "Parâmetros da conferência");
  const dados = await api("/api/rules");
  const desenhar = () => {
    const filtrados = dados.filter(combina);
    conteudo('<div class="card"><div class="head"><div><h2>Regras fiscais</h2>' +
      "<p>" + filtrados.length + " regra(s)</p></div>" +
      (can("config") ? '<button class="primary" id="nova-regra">Nova regra</button>' : "") + "</div>" +
      barraBusca("modulo, tipo ou chave") +
      tabela(["Módulo", "Tipo", "Chave", "Alíquota esperada", "Status", "Descrição", "Ações"],
        filtrados.map((item) => [
          esc(item.module), esc(item.type), "<code>" + esc(item.key) + "</code>",
          item.expectedRate === null || item.expectedRate === undefined
            ? '<span class="muted">nao verifica aliquota</span>'
            : percentual(item.expectedRate, 2),
          badge(item.status), esc(item.description),
          can("config")
            ? '<div class="actions"><button data-editar-regra="' + item.id + '">Editar</button>' +
              '<button data-alternar="' + item.id + '">' +
              (item.status === "Ativa" ? "Desativar" : "Ativar") + "</button></div>"
            : "-"
        ]), "Nenhuma regra cadastrada"));

    ligarBusca(desenhar);
    document.querySelector("#nova-regra")?.addEventListener("click", () => formRegra({}));
    for (const botao of document.querySelectorAll("[data-editar-regra]")) {
      botao.addEventListener("click", () =>
        formRegra(dados.find((item) => item.id === botao.dataset.editarRegra)));
    }
    for (const botao of document.querySelectorAll("[data-alternar]")) {
      botao.addEventListener("click", async () => {
        const regra = dados.find((item) => item.id === botao.dataset.alternar);
        try {
          await api("/api/rules/" + regra.id, {
            method: "PATCH",
            body: JSON.stringify({ status: regra.status === "Ativa" ? "Inativa" : "Ativa" })
          });
          aviso("Regra atualizada. Rode a Reconferencia para aplicar ao acervo.", "success");
          render();
        } catch (erro) { aviso(erro.message, "error"); }
      });
    }
  };
  desenhar();
}

function formRegra(item) {
  const editando = Boolean(item.id);
  const fundo = modal(editando ? "Editar regra" : "Nova regra",
    '<form id="form-regra" class="form-grid">' +
    campo("Módulo", '<select name="module">' +
      ["Federal", "Servicos", "Simples Nacional"].map((modulo) =>
        "<option" + (item.module === modulo ? " selected" : "") + ">" + modulo + "</option>").join("") + "</select>") +
    campo("Tipo", '<select name="type">' +
      ["PIS/COFINS", "ICMS", "ISS", "IPI", "Outro"].map((tipo) =>
        "<option" + (item.type === tipo ? " selected" : "") + ">" + tipo + "</option>").join("") + "</select>") +
    campo("Chave (NCM de 8 digitos, ou item da LC 116)",
      '<input name="key" required value="' + esc(item.key || "") + '">') +
    campo("Alíquota esperada (%)",
      '<input name="expectedRate" type="number" step="0.0001" min="0" value="' + (item.expectedRate ?? "") + '">') +
    campo("Status", '<select name="status">' +
      ["Ativa", "Inativa"].map((status) =>
        "<option" + (item.status === status ? " selected" : "") + ">" + status + "</option>").join("") + "</select>") +
    campo("Descrição", '<input name="description" required value="' + esc(item.description || "") + '">', true) +
    '<div class="full message info">Uma regra com aliquota esperada compara o percentual do XML ' +
    "com o seu, por NCM, e gera o achado <code>REGRA_CADASTRADA</code>. Sem aliquota, a regra " +
    "fica apenas documentada." +
    "</div>" +
    '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
    '<button class="primary" type="submit">Salvar</button></div></form>');

  fundo.querySelector("#form-regra").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const dados = valores(evento.target);
    try {
      await api(editando ? "/api/rules/" + item.id : "/api/rules", {
        method: editando ? "PATCH" : "POST",
        body: JSON.stringify({
          ...dados,
          expectedRate: dados.expectedRate === "" ? null : Number(dados.expectedRate)
        })
      });
      fecharModal();
      aviso("Regra salva. Rode a Reconferencia para aplicar ao acervo.", "success");
      render();
    } catch (erro) { aviso(erro.message, "error"); }
  });
}

// ---------------------------------------------------------------- relatorios

const TIPOS_RELATORIO = [
  ["conferencia", "Conferencia", "Um achado por linha, com a conta e a base normativa"],
  ["documentos", "Documentos", "Acervo capturado, com chave, valor e situacao"],
  ["apuracao", "Apuracao", "DAS por competencia, tributo por tributo, com memoria"],
  ["alertas", "Alertas", "Fila de vigilancia, com tratamento e justificativa"],
  ["auditoria", "Auditoria", "Trilha completa com os hashes da cadeia"]
];

async function reports() {
  titulo("Relatórios", "Exportação em CSV");
  const [dados, clientes] = await Promise.all([api("/api/reports"), api("/api/clients")]);

  const desenhar = () => {
    const filtrados = dados.filter(combina);
    conteudo(
      (can("export")
        ? '<div class="card"><div class="head"><div><h2>Gerar relatório</h2>' +
          "<p>O arquivo sai com os dados que existem agora</p></div></div>" +
          '<div class="body"><form id="form-relatorio" class="form-grid">' +
          campo("Tipo", '<select name="type">' + TIPOS_RELATORIO.map(([valor, rotulo, dica]) =>
            '<option value="' + valor + '">' + rotulo + " - " + dica + "</option>").join("") + "</select>", true) +
          campo("Nome", '<input name="name" placeholder="opcional">') +
          campo("Competência", seletorCompetencia("period", "", "Todas")) +
          campo("Empresa", '<select name="clientId"><option value="">todas</option>' +
            clientes.map((cliente) => '<option value="' + cliente.id + '">' + esc(cliente.name) + "</option>").join("") +
            "</select>", true) +
          '<div class="form-actions full"><button class="primary" type="submit">Gerar</button></div>' +
          "</form></div></div>"
        : "") +
      '<div class="card"><div class="head"><div><h2>Relatórios gerados</h2>' +
        "<p>" + filtrados.length + " relatorio(s)</p></div></div>" +
        barraBusca("nome ou tipo") +
        tabela(["Nome", "Tipo", "Competência", "Linhas", "Status", "Quando", "Ações"],
          filtrados.map((item) => [
            esc(item.name), esc(item.type), esc(item.period), item.rows,
            badge(item.status), dataHora(item.requestedAt),
            '<div class="actions"><button data-baixar-rel="' + item.id + '" data-formato="pdf">PDF</button>' +
            '<button data-baixar-rel="' + item.id + '" data-formato="xlsx">Excel</button>' +
            '<button data-baixar-rel="' + item.id + '" data-formato="csv">CSV</button></div>'
          ]), "Nenhum relatorio gerado") +
      "</div>");

    ligarBusca(desenhar);
    document.querySelector("#form-relatorio")?.addEventListener("submit", async (evento) => {
      evento.preventDefault();
      const dadosForm = valores(evento.target);
      try {
        const criado = await api("/api/reports", {
          method: "POST",
          body: JSON.stringify({ ...dadosForm, clientId: dadosForm.clientId || null })
        });
        aviso("Relatorio com " + criado.rows + " linha(s) gerado", "success");
        baixar(criado.file);
        render();
      } catch (erro) { aviso(erro.message, "error"); }
    });
    for (const botao of document.querySelectorAll("[data-baixar-rel]")) {
      botao.addEventListener("click", () => baixar("/api/reports/" + botao.dataset.baixarRel + "/download?formato=" +
        (botao.dataset.formato || "csv")));
    }
  };
  desenhar();
}

// --------------------------------------------------------------- integracoes

async function integrations() {
  titulo("Integrações", "Conectores e situação de cada um");
  const [dados, cofre, envios] = await Promise.all([
    api("/api/integrations"),
    can("config") ? api("/api/cofre").catch(() => null) : Promise.resolve(null),
    api("/api/integracoes/envios").catch(() => [])
  ]);
  const aguardando = envios.filter((item) => item.destino === "DOMINIO" && item.situacao === "aguardando").length;

  const painelCofre = cofre
    ? '<div class="card"><div class="head"><div><h2>Cofre de segredos</h2>' +
      "<p>Onde ficam as credenciais dos conectores</p></div>" +
      badge(cofre.disponivel ? "Valido" : "Pendente") + "</div><div class=\"body\">" +
      (cofre.disponivel
        ? '<div class="message ok">Cofre ativo (' + esc(cofre.algoritmo) + "), chave vinda de " +
          esc(cofre.origem) + ". As credenciais sao cifradas antes de ir para o banco, e a " +
          "auditoria registra apenas quais chaves mudaram, nunca os valores.</div>"
        : '<div class="message danger-text"><strong>Cofre nao configurado.</strong> ' +
          esc(cofre.motivo || "") + " Enquanto isso, salvar credencial e <strong>recusado</strong>: " +
          "o sistema nao grava segredo em texto plano." +
          "</div>" +
          '<p class="muted">' + esc(cofre.comoResolver || "") + "</p>" +
          (cofre.exemploChaveCofre
            ? "<p>Chave gerada para voce copiar (nao foi gravada em lugar nenhum):</p>" +
              '<pre style="background:#f9fafc;border:1px solid var(--line);border-radius:6px;' +
              'padding:12px;overflow:auto">$env:NUCLEO_CHAVE_SEGREDOS = "' +
              esc(cofre.exemploChaveCofre) + '"</pre>'
            : "")) +
      (cofre.auditoriaAssinada
        ? '<div class="message ok">Trilha de auditoria assinada: reescrever um evento exige a ' +
          "chave, que nao esta no banco.</div>"
        : '<div class="message warn">Trilha sem assinatura. A cadeia de hash detecta alteracao ' +
          "casual, mas quem tem acesso de escrita ao arquivo do banco pode reescrever tudo e " +
          "recalcular os hashes." +
          (cofre.exemploChaveAuditoria
            ? '<pre style="background:#fff;border:1px solid var(--line);border-radius:6px;' +
              'padding:12px;margin-top:8px;overflow:auto">$env:NUCLEO_CHAVE_AUDITORIA = "' +
              esc(cofre.exemploChaveAuditoria) + '"</pre>'
            : "") +
          "</div>") +
      "</div></div>"
    : "";

  conteudo(painelCofre + '<div class="card"><div class="head"><div><h2>Conectores</h2>' +
    "<p>" + dados.filter((item) => item.implemented).length + " de " + dados.length +
    " implementado(s) neste repositorio</p></div></div>" +
    '<div class="body"><div class="message info">' +
    "<strong>Funcionando:</strong> arquivo, pasta monitorada, NFS-e pelo ADN, NF-e e CT-e pela SEFAZ, NFS-e de " +
    "prefeitura por importação, PONTE SEFAZ, SIEG (baixar e enviar XML), Domínio (XML pela Onvio API) e Acessórias " +
    "(obrigações, cadastro e guias). SIEG e Domínio pedem credenciais de parceiro que só o fornecedor entrega: " +
    "Configurar diz onde obter cada uma." +
    "</div></div>" +
    tabela(["Conector", "Status", "Descrição", "Exige", "Falta", "Ações"],
      dados.map((item) => [
        "<strong>" + esc(item.name) + "</strong>",
        badge(item.status),
        esc(item.description),
        (item.requirements || []).map((requisito) => "<code>" + esc(requisito) + "</code>").join(" ") || "-",
        item.missing?.length
          ? '<span class="error-count">' + item.missing.map(esc).join(", ") + "</span>"
          : badge("Pronto"),
        can("config")
          ? '<div class="actions">' +
            (item.implemented
              ? '<button data-testar="' + item.id + '">Testar</button>' +
                (item.requirements?.length ? '<button data-config="' + item.id + '">Configurar</button>' : "") +
                (item.id === "pasta" && !item.missing?.length && can("import")
                  ? '<button class="primary" data-executar-pasta>Importar agora</button>' : "") +
                (item.id === "ponte" && !item.missing?.length
                  ? '<button class="primary" data-ponte-carteira>Trazer a carteira</button>' : "") +
                (item.id === "acessorias" && !item.missing?.length
                  ? '<button data-acessorias-obrigacoes>Obrigações</button><button data-acessorias-trazer>Trazer empresas</button>' +
                    (can("import") ? '<button data-acessorias-guias>Enviar guias</button>' : "") : "")
              : '<button data-falta="' + item.id + '">O que falta</button>') + "</div>"
          : "-"
      ])) + "</div>" +
    (envios.length
      ? '<div class="card"><div class="head"><div><h2>Envios</h2><p>XML ao SIEG, lotes ao Domínio e guias à Acessórias</p></div>' +
        (aguardando && can("import") ? '<button id="conferir-lotes">Conferir lotes do Domínio (' + aguardando + ")</button>" : "") +
        "</div>" + tabelaEnvios(envios.slice(0, 50), true) + "</div>"
      : ""));

  document.querySelector("#conferir-lotes")?.addEventListener("click", async (evento) => {
    evento.target.disabled = true;
    try {
      const r = await api("/api/integracoes/dominio/lotes/conferir", { method: "POST" });
      aviso(r.conferidos + " lote(s) conferido(s): " + r.lotes.filter((item) => item.situacao === "processado").length + " armazenado(s)", "success");
      render();
    } catch (erro) { aviso(erro.message, "error"); evento.target.disabled = false; }
  });
  document.querySelector("[data-acessorias-obrigacoes]")?.addEventListener("click", () => obrigacoesDaAcessorias());
  document.querySelector("[data-acessorias-guias]")?.addEventListener("click", () => enviarGuiasAcessorias());
  document.querySelector("[data-acessorias-trazer]")?.addEventListener("click", async (evento) => {
    const ok = await confirmarAcao("Trazer empresas da Acessórias",
      "Cada empresa ativa da Acessórias (com CNPJ) que ainda não está no NÚCLEO é cadastrada, com o regime de lá. " +
      "Quem já existe fica como está. O limite do plano vale.", "Trazer");
    if (!ok) return;
    evento.target.disabled = true;
    try {
      const r = await api("/api/integracoes/acessorias/empresas/trazer", { method: "POST" });
      modal("Empresas da Acessórias",
        listaDados([
          ["Na Acessórias", String(r.naAcessorias)],
          ["Cadastradas agora", r.criadas.length ? r.criadas.map((item) => esc(item.nome)).join(", ") : "nenhuma"],
          ["Já estavam aqui", String(r.jaExistiam.length)],
          ["Ficaram de fora", r.ignoradas.length ? r.ignoradas.map((item) => esc(item.identificador + " (" + item.motivo + ")")).join(", ") : "nenhuma"]
        ]));
    } catch (erro) { aviso(erro.message, "error"); }
    evento.target.disabled = false;
  });

  for (const botao of document.querySelectorAll("[data-falta]")) {
    botao.addEventListener("click", () => {
      const item = dados.find((linha) => linha.id === botao.dataset.falta);
      modal(esc(item.name) + ": nao disponivel",
        '<div class="message warn">Este conector depende de algo que so o fornecedor entrega. Sem isso nao ha o que ' +
        "testar: o sistema nao finge conexao.</div>" +
        "<p><strong>Precisa de:</strong></p><ul>" +
        (item.requirements || []).map((requisito) => "<li><code>" + esc(requisito) + "</code></li>").join("") + "</ul>" +
        (item.howTo ? '<p class="muted">' + esc(item.howTo) + "</p>" : ""));
    });
  }

  document.querySelector("[data-ponte-carteira]")?.addEventListener("click", async (evento) => {
    const ok = await confirmarAcao("Trazer a carteira da PONTE",
      "Cada cliente da carteira do escritorio na PONTE passa a ser capturado por ela aqui. Quem ainda nao existe no " +
      "NUCLEO e cadastrado. Quem ja existe mantem a NFS-e pelo ADN; NF-e e CT-e diretos saem, porque com a PONTE " +
      "consultando a SEFAZ pelo mesmo CNPJ eles causariam o bloqueio de uma hora.", "Trazer");
    if (!ok) return;
    evento.target.disabled = true;
    try {
      const r = await api("/api/integrations/ponte/carteira", { method: "POST", body: JSON.stringify({ criarClientes: true }) });
      const nomes = (lista) => lista.length ? lista.map((item) => esc(item.nome)).join(", ") : "nenhuma";
      modal("Carteira da PONTE trazida",
        '<div class="message info"><strong>' + r.carteira + " cliente(s) na carteira da PONTE.</strong></div>" +
        "<p><strong>Cadastradas agora:</strong> " + nomes(r.criadas) + "</p>" +
        "<p><strong>Captura pela PONTE ligada:</strong> " + nomes(r.ligadas) + "</p>" +
        "<p><strong>Ja estavam ligadas:</strong> " + nomes(r.jaLigadas) + "</p>" +
        (r.semCertificadoNaPonte.length
          ? '<div class="message warn">Sem A1 na PONTE (ela nao consegue varrer por elas): ' + nomes(r.semCertificadoNaPonte) +
            ". Envie o certificado na carteira do escritorio, la.</div>" : "") +
        '<p class="muted">A primeira captura roda no proximo agendamento, ou em Captura de notas > Carteira > Capturar todas agora.</p>');
    } catch (erro) { aviso(erro.message, "error"); }
    evento.target.disabled = false;
  });

  document.querySelector("[data-executar-pasta]")?.addEventListener("click", async (evento) => {
    evento.target.disabled = true;
    try {
      const r = await api("/api/captura/pasta", { method: "POST" });
      aviso(r.novos
        ? r.novos + " arquivo(s) novo(s): " + (r.documentos || 0) + " documento(s) importado(s), " + (r.duplicados || 0) + " ja existiam"
        : "Nada novo na pasta (" + r.arquivos + " arquivo(s) ja lidos)", "success");
    } catch (erro) { aviso(erro.message, "error"); }
    evento.target.disabled = false;
  });

  for (const botao of document.querySelectorAll("[data-testar]")) {
    botao.addEventListener("click", async () => {
      botao.disabled = true;
      const id = botao.dataset.testar;
      const linhas = (texto) => esc(texto || "").split("\n").join("<br>");
      try {
        const resultado = await api("/api/integrations/" + id + "/test", { method: "POST" });
        modal("Teste de " + esc(id) + ": " + esc(resultado.status),
          '<div class="message ' + (resultado.ok ? "info" : "warn") + '">' + linhas(resultado.mensagem || resultado.status) + "</div>");
      } catch (erro) {
        const d = erro.dados || {};
        modal("Teste de " + esc(id),
          '<div class="message ' + (erro.status === 501 || erro.status === 422 ? "warn" : "danger-text") + '">' +
          linhas(d.mensagem || d.aviso || d.erro || erro.message) + "</div>" +
          (d.faltando?.length
            ? "<p><strong>Falta:</strong></p><ul>" +
              d.faltando.map((item) => "<li><code>" + esc(item) + "</code></li>").join("") + "</ul>"
            : "") +
          (d.comoResolver ? '<p class="muted">' + esc(d.comoResolver) + "</p>" : ""));
      }
      botao.disabled = false;
    });
  }

  for (const botao of document.querySelectorAll("[data-config]")) {
    botao.addEventListener("click", () => {
      const item = dados.find((linha) => linha.id === botao.dataset.config);
      const fundo = modal("Configurar " + esc(item.name),
        '<form id="form-integracao" class="form-grid">' +
        '<div class="full message info">Os valores ficam cifrados no banco (cofre de segredos). ' +
        "A trilha de auditoria registra apenas quais chaves mudaram, nunca os valores." +
        (item.id === "pasta" ? " Informe uma pasta deste servidor; ela e lida a cada minuto e o arquivo fica onde esta." : "") +
        "</div>" +
        (item.howTo && ["sieg", "dominio", "acessorias"].includes(item.id) ? '<div class="full message warn">' + esc(item.howTo) + "</div>" : "") +
        (item.requirements || []).map((requisito) => {
          const segredo = /chave|key|token|senha|secret/i.test(requisito);
          const preenchido = !(item.missing || []).includes(requisito);
          const exemplo = requisito === "url" && item.id === "ponte" ? ' placeholder="https://ponte-sefaz.vercel.app"'
            : preenchido ? ' placeholder="já preenchido; vazio mantém"' : "";
          // Campo de segredo com "new-password": o Chrome ignora autocomplete="off"
          // em type=password e enchia a chave da PONTE com a senha de login salva.
          return campo(ROTULO_REQUISITO[requisito] || requisito, '<input name="' + esc(requisito) + '"' +
            (segredo ? ' type="password" autocomplete="new-password"' : ' autocomplete="off"') + exemplo + ">", true);
        }).join("") +
        (item.id === "ponte"
          ? '<div class="full message info">A chave e a do cadastro do <strong>escritorio</strong> na PONTE (modulo de ' +
            "contabilidade ligado). Cada cliente precisa estar na carteira dele la, com o A1. Depois ligue " +
            "<strong>PONTE SEFAZ</strong> em cada empresa, em Captura de notas.</div>"
          : "") +
        '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
        '<button class="primary" type="submit">Salvar</button></div></form>');
      fundo.querySelector("#form-integracao").addEventListener("submit", async (evento) => {
        evento.preventDefault();
        try {
          // Campo vazio mantem o que ja esta no cofre: trocar uma chave nao apaga as outras.
          const config = Object.fromEntries(Object.entries(valores(evento.target)).filter(([, valor]) => String(valor).trim() !== ""));
          if (!Object.keys(config).length) return aviso("Nada para salvar", "error");
          await api("/api/integrations/" + item.id, {
            method: "PATCH",
            body: JSON.stringify({ config })
          });
          fecharModal();
          aviso("Configuracao salva", "success");
          render();
        } catch (erro) { aviso(erro.message, "error"); }
      });
    });
  }
}

const ROTULO_REQUISITO = {
  clientId: "ClientId", secretKey: "SecretKey", apiKey: "API Key do escritório", clientSecret: "Client secret",
  token: "API Token", url: "Endereço", chave: "Chave do escritório", caminho: "Pasta"
};

async function obrigacoesDaAcessorias() {
  const fundo = modal("Obrigações na Acessórias", '<div class="empty">Consultando a Acessórias...</div>', 1100);
  try {
    const r = await api("/api/integracoes/acessorias/obrigacoes");
    const atrasadas = r.empresas.reduce((s, item) => s + item.atrasadas, 0);
    fundo.querySelector(".modal-body").innerHTML =
      '<div class="grid metrics">' +
        cartao("Empresas", r.empresas.length, "na Acessórias") +
        cartao("Atrasadas", atrasadas, r.empresas.filter((item) => item.atrasadas).length + " empresa(s)") +
        cartao("Próximos 30 dias", r.empresas.reduce((s, item) => s + item.proximos30, 0), "a vencer") +
        cartao("Consultado", quandoCurto(r.consultadoEm), "renova a cada 10 min") +
      "</div>" +
      tabela(["Empresa", "No NÚCLEO", "Atrasadas", "Próx. 30 dias", "Entregues", "O que pede atenção"],
        r.empresas.map((item) => [
          "<strong>" + esc(item.razao) + '</strong> <span class="muted">' + esc(item.cnpj) + "</span>",
          item.clientName ? "sim" : '<span class="muted">não</span>',
          item.atrasadas ? '<span class="error-count">' + item.atrasadas + "</span>" : "0",
          item.proximos30, item.entregues,
          esc(item.obrigacoes.map((o) => o.nome + (o.atrasadas ? " (" + o.atrasadas + " atrasada)" : "")).join(", ") || "-")
        ]), "Nenhuma empresa na Acessórias");
    dicasDeCorte(fundo);
  } catch (erro) {
    fundo.querySelector(".modal-body").innerHTML = '<div class="message danger-text">' + esc(erro.message) + "</div>";
  }
}

function enviarGuiasAcessorias() {
  const fundo = modal("Enviar guias à Acessórias",
    '<form id="form-guias" class="form-grid">' +
    '<div class="full message info">O robô e-Contínuo da Acessórias lê cada PDF, acha a empresa, a obrigação e a ' +
    "competência, e dá baixa na entrega. Guia que ele não reconhece volta com o motivo. Até 50 PDFs por vez.</div>" +
    campo("Guias em PDF", '<input type="file" name="guias" multiple accept=".pdf,application/pdf" required>', true) +
    '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
    '<button class="primary" type="submit">Enviar</button></div></form><div id="resultado-guias"></div>', 960);
  fundo.querySelector("#form-guias").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const botao = evento.target.querySelector('[type="submit"]');
    botao.disabled = true;
    try {
      const arquivos = [];
      for (const arquivo of evento.target.guias.files) arquivos.push({ nome: arquivo.name, conteudoBase64: await lerComoBase64(arquivo) });
      const r = await api("/api/integracoes/acessorias/guias", { method: "POST", body: JSON.stringify({ arquivos }) });
      fundo.querySelector("#resultado-guias").innerHTML = '<div class="card" style="margin-top:12px">' +
        tabela(["Arquivo", "Resultado", "Mensagem da Acessórias"], r.resultados.map((item) => [
          esc(item.arquivo), badge(item.ok ? "Resolvido" : "Erro"), esc(item.mensagem)
        ])) + "</div>";
      dicasDeCorte(fundo);
      aviso(r.envio.aceitos + " de " + r.envio.arquivos + " guia(s) com baixa", r.envio.aceitos ? "success" : "error");
    } catch (erro) { aviso(erro.message, "error"); }
    botao.disabled = false;
  });
}

// ------------------------------------------------------------------ usuarios

async function users() {
  titulo("Usuários", "Perfis e permissões");
  const dados = await api("/api/users");

  conteudo('<div class="card"><div class="head"><div><h2>Usuários</h2>' +
    "<p>" + dados.length + " usuario(s) ativo(s)</p></div>" +
    (can("equipe") ? '<button class="primary" id="novo-usuario">Novo usuário</button>' : "") +
    "</div>" +
    tabela(["Nome", "E-mail", "Perfil", "Senha", "Permissões", "Ações"],
      dados.map((item) => [
        esc(item.name), esc(item.email), badge(ROTULO_PERFIL[item.role] || item.role),
        item.mustChangePassword ? badge("Pendente") + " troca obrigatoria" : badge("Valido"),
        (item.permissions || []).map((permissao) => "<code>" + esc(permissao) + "</code>").join(" "),
        can("equipe") && item.id !== state.user.id
          ? '<button data-desativar="' + item.id + '">Desativar</button>'
          : '<span class="muted">' + (item.id === state.user.id ? "voce" : "-") + "</span>"
      ])) +
    '<div class="body"><div class="message info">' +
    "As permissoes sao verificadas em cada rota do servidor, nao apenas escondendo botao. " +
    "Um usuario novo recebe senha provisoria aleatoria, mostrada uma unica vez, e so " +
    "consegue usar o sistema depois de trocar." +
    "</div>" +
    '<div class="message warn">Nao existe recuperacao de senha por e-mail: um administrador ' +
    "desativa o usuario e cria outro. Com um unico administrador, perder a senha dele " +
    "significa perder o acesso administrativo." +
    "</div></div></div>");

  document.querySelector("#novo-usuario")?.addEventListener("click", () => {
    const fundo = modal("Novo usuário",
      '<form id="form-usuario" class="form-grid">' +
      campo("Nome", '<input name="name" required>') +
      campo("E-mail", '<input name="email" type="email" required>') +
      campo("Perfil", '<select name="role">' + opcoes("operador_fiscal", [
        ["operador_fiscal", "Operador fiscal: captura, importa e exporta"],
        ["operador", "Operador: também carteira, certificados e integrações"],
        ["leitura", "Leitura: só consulta"],
        ["admin", "Dono: tudo, inclusive a equipe"]
      ]) + "</select>", true) +
      '<div class="full message info">A senha provisoria e gerada pelo sistema e aparece ' +
      "uma unica vez na proxima tela. Anote antes de fechar." +
      "</div>" +
      '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
      '<button class="primary" type="submit">Criar</button></div></form>');

    fundo.querySelector("#form-usuario").addEventListener("submit", async (evento) => {
      evento.preventDefault();
      try {
        const criado = await api("/api/users", {
          method: "POST",
          body: JSON.stringify(valores(evento.target))
        });
        modal("Usuário criado",
          '<div class="message warn"><strong>Anote a senha provisoria agora.</strong> ' +
          "Ela nao sera mostrada de novo.</div>" +
          "<p>Usuario: <strong>" + esc(criado.email) + "</strong></p>" +
          '<p>Senha provisoria:</p><pre style="background:#f9fafc;border:1px solid var(--line);' +
          'border-radius:6px;padding:14px;font-size:15px">' + esc(criado.senhaProvisoria) + "</pre>" +
          '<p class="muted">Na primeira entrada o sistema exige a troca.</p>');
        render();
      } catch (erro) { aviso(erro.message, "error"); }
    });
  });

  for (const botao of document.querySelectorAll("[data-desativar]")) {
    botao.addEventListener("click", async () => {
      const alvo = dados.find((item) => item.id === botao.dataset.desativar);
      const fundo = modal("Desativar usuário",
        '<div class="message warn">Desativar <strong>' + esc(alvo.email) + "</strong> encerra " +
        "as sessoes dele e impede novo login. A trilha de auditoria guarda o que ele fez.</div>" +
        '<div class="form-actions"><button type="button" data-fechar>Cancelar</button>' +
        '<button class="primary" id="confirmar-desativar">Desativar</button></div>');
      fundo.querySelector("#confirmar-desativar").addEventListener("click", async () => {
        try {
          await api("/api/users/" + alvo.id, { method: "DELETE" });
          fecharModal();
          aviso("Usuario desativado", "success");
          render();
        } catch (erro) { aviso(erro.message, "error"); }
      });
    });
  }
}

// ------------------------------------------------------------ configuracoes

async function settings() {
  titulo("Configurações", "Escritório e limites da vigilância");
  const dados = await api("/api/settings");
  const limites = dados.limites || {};

  const campoLimite = (nome, rotulo, dica) =>
    campo(rotulo, '<input name="' + nome + '" type="number" min="0" step="1" value="' +
      (limites[nome] ?? "") + '"><span class="muted">' + dica + "</span>");

  conteudo('<div class="card"><div class="head"><div><h2>Escritório</h2></div></div>' +
    '<div class="body"><form id="form-settings" class="form-grid">' +
    campo("Nome do escritório", '<input name="officeName" value="' + esc(dados.officeName) + '">') +
    campo("Competência padrão", seletorCompetencia("defaultPeriod", dados.defaultPeriod || "")) +
    '<fieldset class="form-field full"><legend>Módulos contratados</legend><div class="checks">' +
      Object.entries(dados.modules || {}).map(([nome, ativo]) =>
        '<label><input type="checkbox" name="mod:' + esc(nome) + '"' + (ativo ? " checked" : "") +
        "> " + esc(nome) + "</label>").join("") +
    "</div></fieldset>" +
    '<div class="full"><h3 style="margin:10px 0 0;font-size:14px">Limites da vigilancia</h3>' +
    '<p class="muted">Mudar um limite recalcula os alertas na hora.</p></div>' +
    campoLimite("certificadoAvisoDias", "Avisar certificado (dias)", "antes do vencimento") +
    campoLimite("semEmissaoDias", "Sem emissao (dias)", "sem nota de saida") +
    campoLimite("dasVencimentoDia", "Vencimento do DAS (dia)", "dia do mes") +
    campoLimite("quedaFaturamentoPercentual", "Queda de faturamento (%)", "frente a media") +
    campoLimite("simplesAvisoPercentual", "Aviso de limite do Simples (%)", "do teto de 4,8 mi") +
    campoLimite("limiteSimples", "Limite do Simples (R$)", "teto legal") +
    '<div class="form-actions full"><button class="primary" type="submit">Salvar</button></div>' +
    "</form></div></div>");

  document.querySelector("#form-settings").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const dadosForm = valores(evento.target);
    const modulos = {};
    for (const caixa of evento.target.querySelectorAll('[name^="mod:"]')) {
      modulos[caixa.name.slice(4)] = caixa.checked;
    }
    const novosLimites = {};
    for (const nome of Object.keys(limites)) {
      if (dadosForm[nome] !== undefined && dadosForm[nome] !== "") novosLimites[nome] = Number(dadosForm[nome]);
    }
    try {
      await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          officeName: dadosForm.officeName,
          defaultPeriod: dadosForm.defaultPeriod,
          modules: modulos,
          limites: novosLimites
        })
      });
      aviso("Configuracoes salvas e vigilancia recalculada", "success");
      render();
    } catch (erro) { aviso(erro.message, "error"); }
  });
}

// ----------------------------------------------------------------- auditoria

async function audit() {
  titulo("Auditoria", "Trilha de eventos encadeada por hash");
  const dados = await api("/api/audit-log");
  const integridade = dados.integridade;

  const desenhar = () => {
    const filtrados = dados.eventos.filter(combina);
    conteudo(
      '<div class="card"><div class="head"><div><h2>Integridade da cadeia</h2>' +
        "<p>" + integridade.length + " evento(s) registrado(s)</p></div>" +
        badge(integridade.valid ? "Valido" : "Erro") + "</div>" +
        '<div class="body"><div class="message ' + (integridade.valid ? "ok" : "danger-text") + '">' +
        (integridade.valid
          ? "<strong>Cadeia integra.</strong> Cada evento carrega o hash do anterior; " +
            "nenhum evento foi alterado ou removido desde o registro."
          : "<strong>Cadeia rompida no evento " + integridade.brokenAt + ".</strong> " +
            esc(integridade.reason)) +
        "</div>" +
        '<div class="message info"><strong>Limite honesto:</strong> a cadeia <em>detecta</em> ' +
        "adulteracao, nao a impede. Quem tem escrita no arquivo pode reescrever a trilha inteira " +
        "e recalcular todos os hashes. Para impedir, e preciso armazenamento append-only fora da " +
        "aplicacao ou assinatura com chave que ela nao guarda." +
        "</div>" +
        '<div class="actions"><button id="verificar">Verificar agora</button></div>' +
      "</div></div>" +
      '<div class="card"><div class="head"><div><h2>Eventos</h2>' +
        "<p>" + filtrados.length + " evento(s); mais recentes primeiro</p></div></div>" +
        barraBusca("usuario, acao ou alvo") +
        tabela(["Seq", "Quando", "Usuário", "Ação", "Alvo", "Dados", "Hash"],
          filtrados.map((item) => [
            item.seq, dataHora(item.at), esc(item.user), "<strong>" + esc(item.action) + "</strong>",
            "<code>" + esc(String(item.target).slice(0, 14)) + "</code>",
            item.data
              ? '<button data-dados="' + item.seq + '">ver</button>'
              : '<span class="muted">-</span>',
            '<code title="' + esc(item.hash) + '">' + esc(item.hash.slice(0, 10)) + "</code>"
          ]), "Nenhum evento registrado") +
      "</div>");

    ligarBusca(desenhar);
    document.querySelector("#verificar").addEventListener("click", async () => {
      const resultado = await api("/api/audit-log/verificar");
      aviso(resultado.valid
        ? "Cadeia integra: " + resultado.length + " evento(s)"
        : "Cadeia rompida no evento " + resultado.brokenAt + ": " + resultado.reason,
        resultado.valid ? "success" : "error");
    });
    for (const botao of document.querySelectorAll("[data-dados]")) {
      botao.addEventListener("click", () => {
        const evento = dados.eventos.find((item) => item.seq === Number(botao.dataset.dados));
        modal("Evento " + evento.seq + " - " + esc(evento.action),
          '<p class="muted">' + dataHora(evento.at) + " por " + esc(evento.user) +
          "<br>Alvo: <code>" + esc(evento.target) + "</code>" +
          "<br>Hash: <code>" + esc(evento.hash) + "</code>" +
          "<br>Anterior: <code>" + esc(evento.prevHash) + "</code></p>" +
          "<pre style=\"background:#f9fafc;border:1px solid var(--line);border-radius:6px;padding:12px;overflow:auto\">" +
          esc(JSON.stringify(evento.data, null, 2)) + "</pre>");
      });
    }
  };
  desenhar();
}

// ===================================================== CAPTURA DE NOTAS

const ROTULO_PENDENCIA = {
  resumo_sem_xml: "Nota informada sem XML",
  xml_invalido: "XML corrompido",
  xml_divergente: "XML diferente para a mesma chave",
  nota_referenciada_ausente: "Evento de nota não capturada",
  pdf_nao_gerado: "PDF não gerado",
  conflito_pasta: "Conflito na pasta",
  gravacao_pasta: "Falha ao gravar na pasta",
  lacuna_nsu: "NSU pulado pelo portal"
};

const ROTULO_MODO = { proprio: "A1 da própria empresa", procuracao: "Procuração (cnpjConsulta)" };
const ROTULO_MODO_CURTO = { proprio: "A1 próprio", procuracao: "Procuração" };
const ROTULO_TIPOS = { ambas: "Emitidas e recebidas", emitidas: "Só emitidas", recebidas: "Só recebidas" };
const ROTULO_FONTE = { ADN: "NFS-e", NFE: "NF-e", CTE: "CT-e", PONTE: "PONTE" };
const DESCRICAO_FONTE = {
  ADN: "NFS-e pelo Ambiente Nacional (emitidas e recebidas; aceita procuração)",
  NFE: "NF-e pela SEFAZ (recebidas pela empresa; exige o A1 da própria empresa)",
  CTE: "CT-e pela SEFAZ (em que a empresa é tomadora, remetente ou destinatária; exige o A1 da própria empresa)",
  PONTE: "NF-e, NFS-e e CT-e pela PONTE SEFAZ (cliente da carteira do escritório lá; o A1 fica na PONTE e não precisa " +
    "estar aqui; no lugar de NF-e e CT-e diretos)"
};
const UFS = ["AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB", "PE", "PI", "PR",
  "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO"];

/** Caixas de marcar fora de <label>: label dentro de label quebra o clique. */
function grupoChecks(rotulo, caixas, coluna = true) {
  return '<div class="form-field full"><span>' + rotulo + '</span><div class="checks' + (coluna ? " coluna" : "") + '">' +
    caixas + "</div></div>";
}

function rotuloFontes(fontes) {
  return (fontes?.length ? fontes : ["ADN"]).map((fonte) => ROTULO_FONTE[fonte] || fonte).join(", ");
}

function abrirEmpresa(id) {
  state.empresaId = id;
  localStorage.setItem("nucleo_empresa", id);
  ir("empresa");
}

function verNotas(filtros) {
  state.filtrosAcervo = filtros;
  ir("acervo");
}

function competenciaBr(valor) {
  if (!valor || !/^\d{4}-\d{2}$/.test(valor)) return esc(valor || "-");
  return valor.slice(5) + "/" + valor.slice(0, 4);
}

/**
 * Indicador: rotulo, valor e uma linha de detalhe. O tamanho do valor segue o
 * comprimento (numero grande, data e texto menores), sempre numa linha so; o
 * detalhe sempre ocupa a linha dele, para a fileira ficar da mesma altura.
 */
/** Lista de rotulo e valor, uma linha por item (itens vazios ficam de fora). */
function listaDados(pares) {
  return '<dl class="dados">' + pares.filter(([, valor]) => valor !== null && valor !== undefined && valor !== "")
    .map(([rotulo, valor]) => "<dt>" + rotulo + "</dt><dd>" + valor + "</dd>").join("") + "</dl>";
}

function cartao(rotulo, valor, detalhe = "") {
  const texto = String(valor ?? "-");
  const puro = texto.replace(/<[^>]*>/g, "");
  const tamanho = puro.length <= 7 ? "grande" : puro.length <= 13 ? "medio" : "pequeno";
  return '<div class="card metric"><span>' + rotulo + '</span><strong class="' + tamanho + '" title="' + esc(puro) + '">' +
    texto + '</strong><p class="muted" title="' + esc(String(detalhe || "").replace(/<[^>]*>/g, "")) + '">' +
    (detalhe || "&nbsp;") + "</p></div>";
}

/** "10/10 14:30": data e hora curtas, para caber num cartao. */
function quandoCurto(iso) {
  if (!iso) return "-";
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return "-";
  const dois = (n) => String(n).padStart(2, "0");
  return dois(data.getDate()) + "/" + dois(data.getMonth() + 1) + " " + dois(data.getHours()) + ":" + dois(data.getMinutes());
}

/** "há 3 h", "há 2 dias": quanto tempo faz. */
function haQuanto(iso) {
  if (!iso) return "";
  const minutos = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutos)) return "";
  if (minutos < 1) return "agora";
  if (minutos < 60) return "há " + minutos + " min";
  if (minutos < 48 * 60) return "há " + Math.round(minutos / 60) + " h";
  return "há " + Math.round(minutos / 1440) + " dias";
}

async function executarCaptura(clienteId, botao) {
  if (botao) botao.disabled = true;
  try {
    const tarefa = await api("/api/captura/empresas/" + clienteId + "/executar", { method: "POST" });
    aviso(tarefa.jaNaFila ? "Ja havia uma captura na fila para esta empresa" : "Captura enfileirada", "success");
    // Uma tarefa por documento ligado (NFS-e, NF-e, CT-e): acompanha todas.
    acompanharTarefas((tarefa.tarefas || [tarefa]).map((item) => item.id));
  } catch (erro) {
    aviso(erro.message, "error");
    if (botao) botao.disabled = false;
  }
}

/** Acompanha uma tarefa e recarrega a tela quando ela termina. */
const ROTULO_FONTE_CURTO = { ADN: "NFS-e", NFE: "NF-e", CTE: "CT-e", PONTE: "PONTE" };

/** Espera todas as tarefas de uma captura e resume o resultado de cada documento. */
function acompanharTarefas(ids) {
  if (ids.length === 1) return acompanharTarefa(ids[0]);
  const telaDeOrigem = state.view;
  const verificar = async () => {
    try {
      const lista = await Promise.all(ids.map((id) => api("/api/tarefas/" + id)));
      const andando = lista.some((item) => item.situacao === "executando" || (item.situacao === "pendente" && !item.erro));
      if (andando) { setTimeout(verificar, 1500); return; }
      const partes = lista.map((item) => {
        const rotulo = ROTULO_FONTE_CURTO[item.fonte] || item.fonte;
        if (item.situacao === "concluida") return rotulo + " " + (item.resumo?.novos || 0) + " nova(s)";
        if (item.situacao === "erro") return rotulo + " com erro (" + item.erro + ")";
        return rotulo + " aguardando (" + (item.erro || item.situacao) + ")";
      });
      const comErro = lista.some((item) => item.situacao === "erro");
      aviso((lista[0].clientName || "Empresa") + ": " + partes.join("; "), comErro ? "error" : "success");
      if (state.view === telaDeOrigem) render();
    } catch { /* sessao caiu: o login assume */ }
  };
  setTimeout(verificar, 1200);
}

function acompanharTarefa(id) {
  const telaDeOrigem = state.view;
  const verificar = async () => {
    try {
      const tarefa = await api("/api/tarefas/" + id);
      if (tarefa.situacao === "concluida") {
        const r = tarefa.resumo || {};
        aviso((tarefa.clientName || "Empresa") + ": " + (r.novos || 0) + " nota(s) nova(s)" +
          (r.resumos || r.falhas ? ", " + ((r.resumos || 0) + (r.falhas || 0)) + " pendencia(s)" : ""), "success");
      } else if (tarefa.situacao === "erro") {
        aviso((tarefa.clientName || "Empresa") + ": " + tarefa.erro, "error");
      } else if (tarefa.situacao === "pendente" && tarefa.erro) {
        aviso("Falha temporaria, nova tentativa agendada: " + tarefa.erro, "error");
      } else {
        setTimeout(verificar, 1500);
        return;
      }
      if (state.view === telaDeOrigem) render();
    } catch { /* sessao caiu: o login assume */ }
  };
  setTimeout(verificar, 1200);
}

// ------------------------------------------------------------- carteira

async function carteira() {
  titulo("Carteira", "Visão geral da captura de notas");
  const dados = await api("/api/carteira");
  const c = dados.certificados;
  const f = dados.fila;
  const e = dados.espelho;

  conteudo(
    '<div class="grid metrics">' +
      cartao("Empresas ativas", dados.empresas.ativas + " / " + dados.empresas.total,
        dados.empresas.configuradas + " configurada(s)") +
      cartao("Notas capturadas", dados.documentos.total || 0,
        (dados.documentos.emitidas || 0) + " emitidas, " + (dados.documentos.recebidas || 0) + " recebidas") +
      cartao("Pendências", dados.pendencias.abertas, "em aberto") +
      cartao("Certificados A1", c.validos, (c.vencendo ? c.vencendo + " vencendo, " : "") + (c.vencidos ? c.vencidos + " vencido(s)" : "nenhum vencido")) +
      cartao("Fila", f.executando || 0, "rodando · " + (f.pendente || 0) + " na fila · " + (f.erro || 0) + " com erro") +
      cartao("Pasta dos clientes", (e.gravado || 0) + (e.ja_existia || 0), (e.pendente || 0) + " pendente(s), " + (e.conflito || 0) + " conflito(s)") +
      (dados.plano ? cartao("Plano " + dados.plano.nome, dados.plano.emUso + " / " + (dados.plano.limiteEmpresas || "sem limite"),
        "empresas do plano") : "") +
    "</div>" +
    (dados.empresas.comErro
      ? '<div class="card"><div class="body"><div class="message danger-text"><strong>' + dados.empresas.comErro +
        " empresa(s) com a ultima captura em erro.</strong> Veja a coluna Situacao abaixo; erro de certificado " +
        "ou de procuracao nao e repetido automaticamente.</div></div></div>"
      : "") +
    '<div class="card"><div class="head"><div><h2>Empresas da carteira</h2>' +
      "<p>" + dados.agendamentos + " agendamento(s) ativo(s)</p></div>" +
      '<div class="actions">' +
      (can("import") ? '<button class="primary" id="executar-todas">Capturar todas agora</button>' : "") +
      "</div></div>" +
      tabela(["Empresa", "Autenticação", "Certificado", "Última captura", "NSU", "Notas", "Pendências", "Situação", ""],
        dados.lista.filter((item) => item.configurada).map((item) => [
          "<strong>" + esc(item.name) + "</strong><br><span class=\"muted\">" + esc(item.cnpj) + "</span>",
          badge(item.modo) + (item.ativa ? "" : " " + badge("inativa")),
          item.certificado
            ? esc(item.certificado.titular) + "<br>" + badge(item.certificado.diasParaVencer < 0 ? "Vencido"
              : item.certificado.diasParaVencer <= 30 ? "Vencendo" : "Valido") +
              ' <span class="muted">' + dataCurta(item.certificado.validoAte) + "</span>"
            : badge("Pendente"),
          item.ultimoSucesso ? dataHora(item.ultimoSucesso) : '<span class="muted">nunca</span>',
          item.ultimoNsu,
          item.capturados,
          item.pendencias ? '<span class="error-count">' + item.pendencias + "</span>" : "0",
          item.ultimaTarefa ? badge(item.ultimaTarefa) + (item.ultimoErro ? '<br><span class="muted">' + esc(item.ultimoErro) + "</span>" : "") : "-",
          '<div class="actions"><button data-abrir="' + item.clientId + '">Abrir</button>' +
            (can("import") && item.ativa ? '<button data-executar="' + item.clientId + '">Capturar</button>' : "") + "</div>"
        ]), "Nenhuma empresa configurada. Va em Empresas para ligar a captura.") +
    "</div>"
  );

  document.querySelector("#executar-todas")?.addEventListener("click", async (evento) => {
    evento.target.disabled = true;
    try {
      const r = await api("/api/captura/empresas/executar-todas", { method: "POST" });
      aviso(r.criadas + " captura(s) enfileirada(s)", "success");
      setTimeout(() => state.view === "carteira" && render(), 2500);
    } catch (erro) { aviso(erro.message, "error"); evento.target.disabled = false; }
  });
  for (const botao of document.querySelectorAll("[data-abrir]")) botao.addEventListener("click", () => abrirEmpresa(botao.dataset.abrir));
  for (const botao of document.querySelectorAll("[data-executar]")) botao.addEventListener("click", () => executarCaptura(botao.dataset.executar, botao));
}

// ------------------------------------------------------------- empresas

async function empresas() {
  titulo("Empresas", "Captura, certificado e pasta de cada empresa");
  const [lista, certs] = await Promise.all([api("/api/captura/empresas"), api("/api/certificados-digitais").catch(() => null)]);

  const desenhar = () => {
    const filtrados = lista.filter(combina);
    conteudo('<div class="card"><div class="head"><div><h2>Empresas</h2>' +
      "<p>" + lista.filter((item) => item.ativa).length + " com captura ativa de " + lista.length + "</p></div>" +
      (can("config") ? '<div class="actions"><button class="primary" id="nova-pelo-certificado">Nova empresa pelo certificado</button></div>' : "") +
      "</div>" +
      barraBusca("nome ou CNPJ") +
      tabela(["Empresa", "Captura", "Documentos", "Autenticação", "Pasta do cliente", "Notas", ""],
        filtrados.map((item) => [
          "<strong>" + esc(item.name) + "</strong><br><span class=\"muted\">" + esc(item.cnpj) + "</span>",
          item.configurada ? badge(item.ativa ? "ativa" : "inativa") : '<span class="muted">não configurada</span>',
          item.configurada ? esc(rotuloFontes(item.fontes)) + (item.uf ? ' <span class="muted">' + esc(item.uf) + "</span>" : "") : "-",
          item.configurada ? esc(ROTULO_MODO_CURTO[item.modo] || item.modo) +
            (item.certificado ? '<br><span class="muted">' + esc(item.certificado.titular) + "</span>" : "") : "-",
          item.pastaDestino ? rotuloPasta(item.pastaDestino) : '<span class="muted">só no acervo</span>',
          item.capturados,
          '<div class="actions">' + (can("config") ? '<button data-configurar="' + item.clientId + '">Configurar</button>' : "") +
            (item.configurada ? '<button data-abrir="' + item.clientId + '">Painel</button>' : "") +
            (item.configurada && (item.certificado || (item.fontes || []).includes("PONTE")) && can("import")
              ? '<button data-revisar="' + item.clientId + '" title="Pergunta a Sefin Nacional, pela chave, se alguma NFS-e ' +
                'dos últimos 3 meses foi cancelada depois">Cancelamentos</button>' : "") + "</div>"
        ]), "Nenhuma empresa cadastrada"));
    ligarBusca(desenhar);
    document.querySelector("#nova-pelo-certificado")?.addEventListener("click", novaEmpresaPeloCertificado);
    for (const botao of document.querySelectorAll("[data-configurar]")) {
      botao.addEventListener("click", () => configurarEmpresa(lista.find((item) => item.clientId === botao.dataset.configurar), certs));
    }
    for (const botao of document.querySelectorAll("[data-abrir]")) botao.addEventListener("click", () => abrirEmpresa(botao.dataset.abrir));
    for (const botao of document.querySelectorAll("[data-revisar]")) {
      botao.addEventListener("click", () => revisarCancelamentos(lista.find((item) => item.clientId === botao.dataset.revisar), botao));
    }
  };
  desenhar();
}

/**
 * Nova empresa pelo certificado: o A1 diz a razao social e o CNPJ; a empresa
 * entra na carteira da PONTE, o A1 vai para o cofre dela e a captura ja nasce
 * com a regra de busca. Nada para digitar alem da senha e de quem autorizou.
 */
function novaEmpresaPeloCertificado() {
  const meses = opcoesCompetenciaIso(36);
  const fundo = modal("Nova empresa pelo certificado",
    '<form id="form-nova-empresa" class="form-grid">' +
    '<div class="full message info">O certificado A1 do cliente já traz a razão social e o CNPJ. O A1 fica guardado, ' +
    "cifrado, no cofre deste NÚCLEO, e é ele que busca as notas: NFS-e no Ambiente Nacional, NF-e e CT-e na SEFAZ. " +
    "Nasce o termo de guarda para o cliente assinar (é aviso: a busca não espera por ele). " +
    "Filial com o A1 da matriz: informe o CNPJ da filial.</div>" +
    campo("Certificado A1 (.pfx)", '<input type="file" name="arquivo" accept=".pfx,.p12" required>') +
    campo("Senha do certificado", '<input type="password" name="senha" autocomplete="new-password" required>') +
    campo("Autorizado por", '<input name="autorizadoPor" required placeholder="Quem do cliente autorizou a guarda">') +
    campo("CNPJ da filial (opcional)", '<input name="cnpjEmpresa" inputmode="numeric" placeholder="só se for filial">') +
    campo("UF da empresa", '<select name="uf"><option value="">Escolha</option>' + opcoes("", UFS.map((uf) => [uf, uf])) + "</select>") +
    campo("Buscar notas desde", '<select name="desde">' + opcoes(mesesRecentes(13)[12].slice(3) + "-" + mesesRecentes(13)[12].slice(0, 2),
      meses) + "</select>") +
    grupoChecks("O que buscar", Object.entries(ROTULO_DOC_PONTE).map(([valor, rotulo]) =>
      '<label><input type="checkbox" name="documentos" value="' + valor + '" checked> ' + rotulo + "</label>").join(""), false) +
    grupoChecks("Depois de cadastrar", '<label><input type="checkbox" name="baixarAgora" checked> Começar a busca agora</label>', false) +
    '<div class="form-actions"><button type="button" data-fechar>Cancelar</button>' +
    '<button class="primary" type="submit">Cadastrar</button></div></form>', 720);
  fundo.querySelector("#form-nova-empresa").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const d = valores(evento.target);
    const arquivo = evento.target.arquivo.files[0];
    const documentos = new FormData(evento.target).getAll("documentos");
    if (!documentos.length) return aviso("Escolha ao menos um documento para buscar", "warn");
    if (!d.uf && documentos.some((doc) => doc === "nfe" || doc === "cte")) return aviso("Escolha a UF da empresa", "warn");
    const botao = evento.target.querySelector('button[type="submit"]');
    botao.disabled = true;
    botao.textContent = "Cadastrando...";
    try {
      const r = await api("/api/captura/empresas/nova", { method: "POST", body: JSON.stringify({
        pfxBase64: await lerComoBase64(arquivo), senha: d.senha, autorizadoPor: d.autorizadoPor,
        cnpjEmpresa: d.cnpjEmpresa || undefined, desde: d.desde, documentos, uf: d.uf || undefined,
        baixarAgora: Boolean(evento.target.querySelector('input[name="baixarAgora"]').checked) }) });
      fecharModal();
      aviso(r.cliente.nome + (r.criado ? " cadastrada" : " atualizada") + ". A1 guardado no NÚCLEO até " + dataCurta(r.vencimento) +
        (r.captura ? ". Busca começou (acompanhe no painel)." : ".") +
        (r.avisos?.length ? " " + r.avisos.join(" ") : ""), r.avisos?.length ? "warn" : "success");
      abrirEmpresa(r.cliente.id);
    } catch (erro) {
      aviso(erro.message, "error");
      botao.disabled = false;
      botao.textContent = "Cadastrar";
    }
  });
}

/** Revisao de cancelamentos da NFS-e: dispara e acompanha ate terminar. */
async function revisarCancelamentos(empresa, botao) {
  botao.disabled = true;
  botao.textContent = "Revisando...";
  try {
    const rota = "/api/captura/empresas/" + empresa.clientId + "/revisar-cancelamentos";
    let estado = await api(rota, { method: "POST" });
    while (estado.situacao === "executando") {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      estado = await api(rota);
    }
    if (estado.situacao === "falhou") throw new Error(estado.erro);
    const r = estado.resumo;
    if (r.pelaPonte) {
      aviso(empresa.name + ": a PONTE conferiu " + r.conferidas + " NFS-e pela chave, " + r.canceladas.length +
        " cancelada(s) depois" + (r.pendentes ? ", " + r.pendentes + " para a próxima (limite do ambiente nacional)" : "") +
        (r.avisos?.length ? ". " + r.avisos.join(" ") : "."), r.canceladas.length || r.pendentes ? "warn" : "success");
    } else if (r.semCertificado) {
      aviso(r.semCertificado, "warn");
    } else {
      aviso(empresa.name + ": " + r.conferidas + " NFS-e conferida(s) na Sefin Nacional, " +
        r.canceladas.length + " cancelada(s) depois" +
        (r.naoConferidas.length ? ", " + r.naoConferidas.length + " sem resposta (entram na proxima)" : "") +
        (r.puladas ? ", " + r.puladas + " ja conferida(s) hoje" : "") + ".",
        r.canceladas.length || r.naoConferidas.length ? "warn" : "success");
    }
  } catch (erro) {
    aviso(erro.message, "error");
  } finally {
    botao.disabled = false;
    botao.textContent = "Cancelamentos";
  }
}

function configurarEmpresa(empresaAtual, certs) {
  // Sem certificado no cofre a empresa ainda pode capturar pela PONTE SEFAZ,
  // que guarda o A1 do lado de la: o formulario abre do mesmo jeito.
  const lista = (certs?.certificados || []).filter((item) => item.ativo);
  const fundo = modal("Captura de " + esc(empresaAtual.name),
    '<form id="form-captura" class="form-grid">' +
    campo("Autenticação", '<select name="modo">' + Object.entries(ROTULO_MODO).map(([valor, rotulo]) =>
      '<option value="' + valor + '"' + ((empresaAtual.modo || "proprio") === valor ? " selected" : "") + ">" + rotulo + "</option>").join("") + "</select>") +
    campo("Certificado A1", '<select name="certificadoId"><option value="">nenhum (so pela PONTE SEFAZ)</option>' +
      lista.map((item) =>
      '<option value="' + item.id + '"' + (empresaAtual.certificadoId === item.id ? " selected" : "") + ">" +
      esc(item.titular) + " (" + esc(item.titularCnpj || "") + ") ate " + dataCurta(item.validoAte) + "</option>").join("") + "</select>" +
      (lista.length ? "" : '<span class="muted">Nenhum A1 no cofre: envie em Certificados A1, ou use so a PONTE SEFAZ.</span>')) +
    campo("Notas a guardar na pasta", '<select name="tipos">' + Object.entries(ROTULO_TIPOS).map(([valor, rotulo]) =>
      '<option value="' + valor + '"' + ((empresaAtual.tipos || "ambas") === valor ? " selected" : "") + ">" + rotulo + "</option>").join("") + "</select>") +
    campo("Captura", '<select name="ativa"><option value="true"' + (empresaAtual.ativa !== false ? " selected" : "") + '>Ativa</option>' +
      '<option value="false"' + (empresaAtual.ativa === false && empresaAtual.configurada ? " selected" : "") + ">Pausada</option></select>") +
    grupoChecks("Documentos a buscar", Object.entries(DESCRICAO_FONTE).map(([fonte, descricao]) =>
      '<label><input type="checkbox" name="fonte" value="' + fonte + '"' +
      ((empresaAtual.fontes?.length ? empresaAtual.fontes : ["ADN"]).includes(fonte) ? " checked" : "") + "> " +
      esc(descricao) + "</label>").join("")) +
    campo("UF da empresa (obrigatória para NF-e e CT-e)", '<select name="uf"><option value="">-</option>' +
      UFS.map((uf) => '<option value="' + uf + '"' + (empresaAtual.uf === uf ? " selected" : "") + ">" + uf + "</option>").join("") +
      "</select>") +
    grupoChecks("Pela PONTE, o que buscar", Object.entries(ROTULO_DOC_PONTE).map(([valor, rotulo]) =>
      '<label><input type="checkbox" name="docPonte" value="' + valor + '"' +
      ((empresaAtual.documentosPonte?.length ? empresaAtual.documentosPonte : Object.keys(ROTULO_DOC_PONTE)).includes(valor)
        ? " checked" : "") + "> " + rotulo + "</label>").join(""), false) +
    campo("Período começa em", '<select name="periodoDesde">' + opcoes(empresaAtual.periodoDesde || "",
      [["", "Sem início fixo"], ...opcoesCompetenciaIso(60)]) + "</select>") +
    campo("A rotina olha para trás", '<select name="periodoMeses">' + opcoes(empresaAtual.periodoMeses || "",
      [["", "Padrão (4 meses)"], ...[1, 2, 3, 4, 6, 12].map((n) => [String(n), n + (n === 1 ? " mês" : " meses")])]) + "</select>") +
    grupoChecks("Ciência da Operação automática (NF-e)", '<label><input type="checkbox" name="manifestarCiencia"' +
      (empresaAtual.manifestarCiencia ? " checked" : "") + "> Manifestar ciencia sozinho para cada NF-e recebida em resumo</label>") +
    campo("Pasta do cliente neste computador (opcional)",
      '<input name="pastaDestino" placeholder="C:\\Clientes\\Empresa X" value="' + esc(empresaAtual.pastaDestino || "") + '">', true) +
    '<div class="full message info">' +
    "<strong>A1 da propria empresa:</strong> o certificado e do mesmo CNPJ (ou do mesmo CNPJ raiz, matriz e filial).<br>" +
    "<strong>Procuracao:</strong> o certificado e do escritorio; o cliente precisa ter outorgado procuracao eletronica " +
    "ao titular. Sem ela o portal recusa e a captura para com o motivo.<br>" +
    "<strong>Pasta:</strong> e a pasta DESTA empresa; dentro dela o sistema cria ANO / MES / tipo de nota (NF-e, NFS-e, CT-e) / " +
    "EMITIDAS ou RECEBIDAS / XML ou PDF. Para escolher sem digitar, rode no computador do escritorio " +
    "<code>agente\\escolher-pastas.ps1</code>: ele abre o seletor de pastas do Windows para cada empresa. " +
    "Se o servidor nao enxerga essa pasta (servidor na nuvem), o agente local grava quando o computador ligar. " +
    "Nenhum arquivo diferente ja existente e sobrescrito.<br>" +
    "<strong>NF-e e CT-e:</strong> a SEFAZ entrega as notas em que a empresa e destinataria ou tomadora. As NF-e que a " +
    "propria empresa emitiu nao vem por aqui (a SEFAZ nao devolve ao emitente): elas entram pela importacao do emissor." +
    "</div>" +
    '<div class="full message warn"><strong>Ciencia da Operacao:</strong> a SEFAZ so entrega o XML completo de uma NF-e ' +
    "recebida depois que o destinatario manifesta ciencia. A ciencia e registrada em nome do cliente, com o certificado " +
    "dele: diz que ele tomou conhecimento da nota, sem confirmar nem negar a operacao. A manifestacao conclusiva " +
    "(confirmacao, desconhecimento ou operacao nao realizada), quando obrigatoria, continua com o cliente. " +
    "Ligue a opcao automatica so com a autorizacao dele; sem ela, cada nota pode ser manifestada a mao na pendencia." +
    "</div>" +
    '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
    '<button class="primary" type="submit">Salvar</button></div></form>', 760);

  fundo.querySelector("#form-captura").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const dados = valores(evento.target);
    const fontes = [...evento.target.querySelectorAll('input[name="fonte"]:checked')].map((item) => item.value);
    if (!fontes.length) return aviso("Escolha ao menos um tipo de documento", "error");
    if (!dados.certificadoId && fontes.some((fonte) => fonte !== "PONTE")) {
      return aviso("NFS-e, NF-e e CT-e diretos usam o A1 daqui: escolha o certificado, ou marque so a PONTE SEFAZ", "error");
    }
    delete dados.fonte;
    delete dados.docPonte;
    const documentosPonte = new FormData(evento.target).getAll("docPonte");
    if (fontes.includes("PONTE") && !documentosPonte.length) return aviso("Escolha ao menos um documento para buscar pela PONTE", "error");
    try {
      const salvo = await api("/api/captura/empresas/" + empresaAtual.clientId, {
        method: "PUT",
        body: JSON.stringify({ ...dados, ativa: dados.ativa === "true", fontes,
          manifestarCiencia: Boolean(evento.target.querySelector('input[name="manifestarCiencia"]').checked),
          documentosPonte: documentosPonte.length === 3 ? null : documentosPonte,
          periodoDesde: dados.periodoDesde || null, periodoMeses: dados.periodoMeses ? Number(dados.periodoMeses) : null })
      });
      fecharModal();
      aviso("Captura configurada" + (salvo.cobertura ? " (" + salvo.cobertura.motivo + ")" : ""), "success");
      render();
    } catch (erro) {
      aviso(erro.message + (erro.dados?.comoResolver ? " " + erro.dados.comoResolver : ""), "error");
    }
  });
}

// ---------------------------------------------------- painel da empresa

async function empresa() {
  if (!state.empresaId) return ir("empresas");
  const [dados, externos] = await Promise.all([
    api("/api/captura/empresas/" + state.empresaId),
    api("/api/integracoes/empresas/" + state.empresaId).catch(() => null)
  ]);
  const e = dados.empresa;
  titulo(e.name, e.cnpj + " - painel de captura");

  const abertas = dados.pendencias.filter((item) => item.situacao === "aberta");
  const total = dados.historico.reduce((acc, item) => acc + item.emitidas + item.recebidas + item.outras, 0);
  const pelaPonte = (e.fontes || []).includes("PONTE");
  const resumosNfe = abertas.filter((item) => item.tipo === "resumo_sem_xml" &&
    String(item.chave || item.referencia || "").slice(20, 22) === "55").length;
  const periodo = dados.periodo || { meses: [], desde: null };
  const ponte = dados.ponte;

  const somaHistorico = (campo) => dados.historico.reduce((acc, item) => acc + (item[campo] || 0), 0);
  const cursoresDiretos = (dados.cursores || []).filter((item) => item.fonte !== "PONTE");
  const diasA1 = (data) => data ? Math.floor((new Date(String(data).slice(0, 10) + "T23:59:59") - Date.now()) / 86_400_000) : null;
  const a1Ponte = !e.certificado && ponte?.temCertificado ? diasA1(ponte.certificadoVencimento) : null;
  const pastaGravados = (dados.espelho.gravado || 0) + (dados.espelho.ja_existia || 0);

  conteudo(
    '<div class="grid metrics">' +
      cartao("Notas no acervo", total, somaHistorico("emitidas") + " emitidas · " + somaHistorico("recebidas") + " recebidas") +
      cartao("Última captura", e.ultimoSucesso ? quandoCurto(e.ultimoSucesso) : "Nunca",
        e.ultimoSucesso ? haQuanto(e.ultimoSucesso) : "use Capturar agora") +
      (pelaPonte
        ? cartao("Busca", "PONTE", e.periodoDesde ? "desde " + competenciaBr(e.periodoDesde) : "últimos " + (e.periodoMeses || 4) + " meses")
        : cartao("NSU atual", cursoresDiretos.length ? cursoresDiretos.map((item) => item.ultimoNsu).join(" / ") : dados.cursor.ultimoNsu,
          cursoresDiretos.filter((item) => item.bloqueadoAte).length
            ? cursoresDiretos.filter((item) => item.bloqueadoAte)
              .map((item) => (ROTULO_FONTE[item.fonte] || item.fonte) + " liberada às " + quandoCurto(item.bloqueadoAte)).join(" · ")
            : cursoresDiretos.map((item) => ROTULO_FONTE[item.fonte] || item.fonte).join(" / "))) +
      cartao("Pendências", abertas.length, resumosNfe ? resumosNfe + " NF-e em resumo" : abertas.length ? "em aberto" : "nada em aberto") +
      (e.certificado
        ? cartao("Certificado A1", dataCurta(e.certificado.validoAte),
          (e.certificado.diasParaVencer < 0 ? "vencido" : e.certificado.diasParaVencer + " dias") + " · no NÚCLEO")
        : a1Ponte !== null
          ? cartao("Certificado A1", dataCurta(ponte.certificadoVencimento), (a1Ponte < 0 ? "vencido" : a1Ponte + " dias") + " · na PONTE")
          : cartao("Certificado A1", "Sem A1", pelaPonte ? "envie o A1 para a PONTE" : "envie em Certificados A1")) +
      (e.pastaDestino
        ? cartao("Pasta", pastaGravados, (dados.espelho.pendente || 0) + " pendente(s)" +
          (dados.espelho.conflito ? " · " + dados.espelho.conflito + " conflito(s)" : ""))
        : cartao("Pasta", "Sem pasta", "só no acervo")) +
    "</div>" +
    '<div class="card"><div class="head"><div><h2>Configuração</h2>' +
      "<p>" + esc(!e.certificadoId && (e.fontes || []).join() === "PONTE" ? "A1 guardado na PONTE SEFAZ"
        : ROTULO_MODO[e.modo] || "não configurada") + " &middot; " + esc(ROTULO_TIPOS[e.tipos] || "") +
      " &middot; " + esc(rotuloFontes(e.fontes)) + (e.uf ? " &middot; " + esc(e.uf) : "") +
      (e.manifestarCiencia ? " &middot; ciencia automatica" : "") + "</p></div>" +
      '<div class="actions">' +
        (can("import") && e.ativa ? '<button class="primary" id="capturar">Capturar agora</button>' : "") +
        (can("import") ? '<button id="importar">Importar XML</button>' : "") +
        // Faixa de NSU so existe no ADN: na SEFAZ e na PONTE o botao nao teria o que fazer.
        (can("import") && (e.fontes || ["ADN"]).includes("ADN") ? '<button id="faixa">Rebuscar faixa de NSU</button>' : "") +
        '<button id="notas">Ver notas</button>' +
        (can("export") ? '<button id="exportar">Exportar ZIP</button>' : "") +
        (can("config") ? '<button id="configurar">Configurar</button>' : "") +
        (can("config") ? '<button id="agendar-empresa" title="Cria um agendamento só desta empresa">Agendar</button>' : "") +
      "</div></div>" +
      listaDados([
        ["Certificado", e.certificado ? esc(e.certificado.titular) + ' <span class="muted">' + esc(e.certificado.cnpj || "") + "</span>"
          : pelaPonte ? "Nenhum aqui; o A1 fica na PONTE" : "Nenhum"],
        ["Pasta", e.pastaDestino ? rotuloPasta(e.pastaDestino) : '<span class="muted">Nenhuma; só o acervo central</span>'],
        ...(pelaPonte && dados.regra ? [
          ["O que busca", esc(dados.regra.documentos.map((doc) => ROTULO_DOC_PONTE[doc] || doc).join(", "))],
          ["Período", (e.periodoDesde ? "Desde " + competenciaBr(e.periodoDesde) : "Sem início fixo") +
            ' <span class="muted">· a rotina olha ' + (e.periodoMeses || 4) + " meses para trás</span>"],
          ["Próxima busca pede", esc(dados.regra.proximaRotina.map(competenciaBr).join(", ") || "nada")]
        ] : []),
        ["Agendamentos", dados.agendamentos.length
          ? dados.agendamentos.map((item) => esc(item.descricao) + (item.clientId ? "" : ' <span class="muted">· toda a carteira</span>'))
            .join("<br>")
          : '<span class="muted">Nenhum. A captura só roda quando alguém pede.</span>']
      ]) +
      "</div>" +
    cartaoPonte(e, ponte) +
    cartaoTermo(e, dados.termo, dados.termos || []) +
    cartaoExternos(e, externos) +
    '<div class="card"><div class="head"><div><h2>Período</h2><p>Mês a mês: o que está no acervo' +
      (pelaPonte ? " e quando cada competência foi trazida da PONTE" + (periodo.desde ? ", cliente na carteira desde " +
        dataCurta(periodo.desde) : "") : "") + "</p></div>" +
      '<div class="actions">' +
        (can("import") && pelaPonte ? '<button class="primary" id="baixar-periodo">Baixar período</button>' : "") +
        (can("write") && resumosNfe ? '<button id="ciencia-lote">Ciência em lote (' + resumosNfe + ")</button>" : "") +
        (can("import") && (e.certificadoId || pelaPonte) ? '<button id="cancelamentos" title="Pergunta ao ambiente nacional, ' +
          'pela chave, se alguma NFS-e dos últimos 3 meses foi cancelada depois">Cancelamentos</button>' : "") +
      "</div></div>" +
      tabela(["Competência", "Emitidas", "Valor emitido", "Recebidas", "Valor recebido", "Canceladas",
        ...(pelaPonte ? ["Trazida da PONTE", "Arquivos", "Só resumo"] : []), ""],
        periodo.meses.map((item) => [
          "<strong>" + competenciaBr(item.competencia) + "</strong>",
          item.emitidas, dinheiro(item.valorEmitidas), item.recebidas, dinheiro(item.valorRecebidas),
          item.canceladas || "0",
          ...(pelaPonte ? [
            item.trazidoEm ? dataHora(item.trazidoEm) : '<span class="muted">não trazida</span>',
            item.arquivos ?? "-",
            item.semXml ? '<span class="error-count">' + item.semXml + "</span>" : item.semXml === null ? "-" : "0"
          ] : []),
          '<button data-competencia="' + esc(item.competencia) + '">Ver notas</button>'
        ]), pelaPonte ? "Nenhum mês trazido ainda. Use Baixar período." : "Nenhuma nota capturada ainda") +
    "</div>" +
    '<div class="card"><div class="head"><div><h2>Pendências</h2><p>' + abertas.length + " em aberto</p></div>" +
      '<button id="todas-pendencias">Abrir painel de pendências</button></div>' +
      tabelaPendencias(dados.pendencias.slice(0, 15), false) +
    "</div>" +
    '<div class="card"><div class="head"><div><h2>Últimas execuções</h2></div></div>' +
      tabela(["Quando", "Documento", "Origem", "Competência", "Situação", "Resultado"],
        dados.tarefas.map((item) => [
          dataHora(item.criadaEm), esc(ROTULO_FONTE[item.fonte] || item.fonte), esc(item.origem),
          competenciaBr(item.competencia), badge(item.situacao),
          item.resumo ? resumoTarefa(item.resumo) : esc(item.erro || "-")
        ]), "Nenhuma execucao ainda") +
    "</div>" +
    ((dados.manifestacoes || []).length
      ? '<div class="card"><div class="head"><div><h2>Ciência da Operação enviada</h2>' +
        "<p>Manifestacoes registradas na SEFAZ em nome desta empresa</p></div></div>" +
        tabela(["Quando", "Chave", "Situação", "Protocolo", "Origem", "Por"],
          dados.manifestacoes.map((item) => [
            dataHora(item.enviadaEm), '<code title="' + esc(item.chave) + '">' + esc(item.chave.slice(0, 20)) + "...</code>",
            badge(item.situacao) + (item.situacao !== "aceita" ? '<br><span class="muted">' + esc(item.motivo || "") + "</span>" : ""),
            esc(item.protocolo || "-"), esc(item.origem), esc(item.enviadaPor || "automatica")
          ]), "Nenhuma") +
        "</div>"
      : "")
  );

  document.querySelector("#capturar")?.addEventListener("click", (evento) => executarCaptura(e.clientId, evento.target));
  document.querySelector("#notas").addEventListener("click", () => verNotas({ clienteId: e.clientId }));
  document.querySelector("#todas-pendencias").addEventListener("click", () => { state.filtroPendencias = { clienteId: e.clientId }; ir("pendencias"); });
  document.querySelector("#exportar")?.addEventListener("click", () => baixar("/api/acervo/exportar?clienteId=" + e.clientId));
  document.querySelector("#configurar")?.addEventListener("click", async () => configurarEmpresa(e, await api("/api/certificados-digitais")));
  document.querySelector("#faixa")?.addEventListener("click", () => rebuscarFaixa(e));
  document.querySelector("#importar")?.addEventListener("click", () => importarXml(e, dados.entrada));
  document.querySelector("#baixar-periodo")?.addEventListener("click", () => baixarPeriodo(e, periodo));
  document.querySelector("#agendar-empresa")?.addEventListener("click", () => { state.novoAgendamentoPara = e.clientId; ir("agendamentos"); });
  document.querySelector("#ciencia-lote")?.addEventListener("click", () => cienciaEmLote(e, resumosNfe));
  document.querySelector("#cancelamentos")?.addEventListener("click", (evento) =>
    revisarCancelamentos({ clientId: e.clientId, name: e.name }, evento.target));
  ligarPonte(e, ponte);
  ligarTermo(e, dados.termo);
  ligarExternos(e, externos);
  for (const botao of document.querySelectorAll("[data-competencia]")) {
    botao.addEventListener("click", () => verNotas({ clienteId: e.clientId, competencia: botao.dataset.competencia }));
  }
  ligarPendencias();
}

// ------------------------------------------- termo de guarda do A1

const ROTULO_TERMO = { pendente: "Pendente", assinado: "Recebido", substituido: "Substituído", reenviado: "Reenviado" };
const COR_DA_CONFERENCIA = { "icp-brasil": "ok", "gov-br": "ok", integra: "info", "nao-confere": "danger", manual: "warn" };

/** O que a maquina provou sobre a assinatura: o rotulo, quem assinou e o aviso, sem afirmar mais do que isso. */
function conferenciaDoTermo(c) {
  if (!c) return '<span class="muted">sem conferência</span>';
  return '<span class="badge ' + (COR_DA_CONFERENCIA[c.nivel] || "info") + '" title="' + esc(c.motivo || "") + '">' + esc(c.rotulo) + "</span>" +
    (c.assinante ? '<br><span class="muted">' + esc(c.assinante) + (c.cpf ? " · CPF " + esc(c.cpf) : "") +
      (c.cnpj ? " · CNPJ " + esc(c.cnpj) : "") + "</span>" : "") +
    (c.aviso ? '<br><span class="danger-text">' + esc(c.aviso) + "</span>" : "");
}

/** Termo de guarda do A1 do cliente guardado aqui. Aviso, nao trava: a busca usa o A1 sem ele. */
function cartaoTermo(e, termo, historico) {
  if (!termo && !historico.length) return "";
  const pendente = termo?.situacao === "pendente";
  return '<div class="card"><div class="head"><div><h2>Termo de guarda do A1</h2>' +
      "<p>O cliente autoriza o escritório a guardar e usar o certificado</p></div>" +
      '<div class="actions">' +
        (termo && can("config") ? '<button id="termo-baixar">' + (pendente ? "Baixar para assinar" : "Baixar o modelo") + "</button>" : "") +
        (termo && can("config") ? '<button class="' + (pendente ? "primary" : "") + '" id="termo-enviar">Enviar o assinado</button>' : "") +
      "</div></div>" +
    (pendente
      ? '<div class="body"><div class="message warn">Termo ainda não assinado. A busca das notas continua; isto é só um aviso ' +
        "para o arquivo do escritório ficar completo.</div></div>"
      : termo?.situacao === "assinado" && !["icp-brasil", "gov-br"].includes(termo.conferencia?.nivel)
        ? '<div class="body"><div class="message warn">Termo recebido, mas a assinatura não foi provada pela máquina: ' +
          esc(termo.conferencia?.motivo || "confira o papel.") + " A busca continua; é só um aviso.</div></div>"
        : "") +
    tabela(["Situação", "Assinatura", "Autorizado por", "Criado", "Recebido", ""],
      historico.map((item) => [
        badge(ROTULO_TERMO[item.situacao] || item.situacao),
        item.situacao === "pendente" ? '<span class="muted">-</span>' : conferenciaDoTermo(item.conferencia),
        esc(item.autorizadoPor || "-"), quandoCurto(item.criadoEm),
        item.assinadoEm ? quandoCurto(item.assinadoEm) + '<br><span class="muted">' + esc(item.assinadoPor || "") + "</span>" : "-",
        item.arquivoAssinado && can("export") ? '<button data-termo-assinado="' + item.id + '">PDF assinado</button>' : ""
      ]), "Nenhum termo") +
  "</div>";
}

function ligarTermo(e, termo) {
  document.querySelector("#termo-baixar")?.addEventListener("click", () => baixar("/api/captura/empresas/" + e.clientId + "/termo/pdf"));
  document.querySelector("#termo-enviar")?.addEventListener("click", () => {
    const fundo = modal("Enviar o termo assinado",
      '<form id="form-termo" class="form-grid">' +
      '<div class="full message info">O PDF assinado pelo cliente (à mão e digitalizado, ou com assinatura digital). ' +
      "Ele fica guardado com o histórico; certificado novo pede termo novo.</div>" +
      campo("Termo assinado (PDF)", '<input type="file" name="arquivo" accept=".pdf,application/pdf" required>', true) +
      '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
      '<button class="primary" type="submit">Enviar</button></div></form>');
    fundo.querySelector("#form-termo").addEventListener("submit", async (evento) => {
      evento.preventDefault();
      const arquivo = evento.target.arquivo.files[0];
      try {
        await api("/api/captura/empresas/" + e.clientId + "/termo/assinado", { method: "POST",
          body: JSON.stringify({ nome: arquivo.name, conteudoBase64: await lerComoBase64(arquivo) }) });
        fecharModal();
        aviso("Termo assinado guardado", "success");
        render();
      } catch (erro) { aviso(erro.message, "error"); }
    });
  });
  for (const botao of document.querySelectorAll("[data-termo-assinado]")) {
    botao.addEventListener("click", () => baixar("/api/captura/empresas/" + e.clientId + "/termo/" + botao.dataset.termoAssinado + "/assinado"));
  }
}

// ------------------------------------- SIEG, Dominio e Acessorias na empresa

const ROTULO_DESTINO = { SIEG: "SIEG", DOMINIO: "Domínio", ACESSORIAS: "Acessórias" };
const TIPOS_SIEG = ["NF-e", "NFC-e", "CT-e", "NFS-e"];

function tabelaEnvios(lista, comEmpresa = false) {
  return tabela(["Quando", "Destino", ...(comEmpresa ? ["Empresa"] : []), "Competência", "Arquivos", "Aceitos", "Recusados", "Situação"],
    lista.map((item) => [
      quandoCurto(item.criadoEm), esc(ROTULO_DESTINO[item.destino] || item.destino), ...(comEmpresa ? [esc(item.clientName || "-")] : []),
      item.competencia ? competenciaBr(item.competencia) : "-", item.arquivos, item.aceitos || "-",
      item.recusados ? '<span class="error-count">' + item.recusados + "</span>" : "0",
      badge(item.situacao) + (item.lote ? ' <span class="muted">lote ' + esc(item.lote) + "</span>" : "")
    ]), "Nenhum envio ainda");
}

/** Cartao das integracoes no painel da empresa: so aparece com alguma configurada. */
function cartaoExternos(e, x) {
  if (!x || !(x.sieg.configurado || x.dominio.configurado || x.acessorias.configurado)) return "";
  const baixa = x.sieg.baixa;
  const andamentoSieg = !baixa ? "Nenhuma baixa feita nesta sessão do servidor"
    : baixa.situacao === "executando" ? "Baixando " + competenciaBr(baixa.de) + " a " + competenciaBr(baixa.ate) + ": " + baixa.feitos +
      " de " + (baixa.total || "?") + " consulta(s)"
    : baixa.situacao === "concluida" ? baixa.resumo.novos + " nota(s) nova(s), " + baixa.resumo.duplicados + " já existiam (" +
      competenciaBr(baixa.de) + " a " + competenciaBr(baixa.ate) + ")"
    : '<span class="danger-text">' + esc(baixa.erro || "falhou") + "</span>";
  return '<div class="card"><div class="head"><div><h2>SIEG, Domínio e Acessórias</h2>' +
    "<p>O que vem e o que vai desta empresa</p></div>" +
    '<div class="actions">' +
      (x.sieg.configurado && can("import") ? '<button id="sieg-baixar"' + (baixa?.situacao === "executando" ? " disabled" : "") +
        '>Baixar do SIEG</button><button id="sieg-enviar">Enviar ao SIEG</button>' : "") +
      (x.dominio.configurado && x.dominio.ativada && can("import") ? '<button id="dominio-enviar">Enviar ao Domínio</button>' : "") +
      (x.dominio.configurado && !x.dominio.ativada && can("config") ? '<button id="dominio-ativar">Ativar no Domínio</button>' : "") +
      (x.dominio.configurado && x.dominio.ativada && can("config") ? '<button id="dominio-desativar">Desligar do Domínio</button>' : "") +
      (x.acessorias.configurado ? '<button id="acessorias-entregas">Entregas na Acessórias</button>' : "") +
    "</div></div>" +
    listaDados([
      ["SIEG", x.sieg.configurado ? andamentoSieg : ""],
      ["Domínio", x.dominio.configurado ? (x.dominio.ativada ? "Ativada com a chave do contador"
        : '<span class="muted">Não ativada: falta a chave que o contador gera no Onvio para este CNPJ</span>') : ""],
      ["Acessórias", x.acessorias.configurado ? "Ligada pelo API Token do escritório" : ""]
    ]) +
    (x.envios.length ? tabelaEnvios(x.envios.slice(0, 10)) : "") +
  "</div>";
}

function ligarExternos(e, x) {
  if (!x) return;
  document.querySelector("#sieg-baixar")?.addEventListener("click", () => baixarDoSieg(e));
  document.querySelector("#sieg-enviar")?.addEventListener("click", () => enviarCompetencia(e, "sieg"));
  document.querySelector("#dominio-enviar")?.addEventListener("click", () => enviarCompetencia(e, "dominio"));
  document.querySelector("#dominio-ativar")?.addEventListener("click", () => ativarNoDominio(e));
  document.querySelector("#dominio-desativar")?.addEventListener("click", async () => {
    const ok = await confirmarAcao("Desligar do Domínio", "A integrationKey de " + e.name + " sai do cofre. Para enviar de novo, " +
      "será preciso a chave do contador outra vez. O que já foi enviado continua no Domínio.", "Desligar");
    if (!ok) return;
    try {
      await api("/api/integracoes/dominio/empresas/" + e.clientId + "/desativar", { method: "POST" });
      aviso("Empresa desligada do Domínio", "success");
      render();
    } catch (erro) { aviso(erro.message, "error"); }
  });
  document.querySelector("#acessorias-entregas")?.addEventListener("click", () => entregasNaAcessorias(e));
  if (x.sieg.baixa?.situacao === "executando") acompanharSieg(e);
}

/** Enquanto a baixa do SIEG roda, a tela da empresa se atualiza sozinha. */
function acompanharSieg(e) {
  const tela = state.empresaId;
  setTimeout(async () => {
    if (state.view !== "empresa" || state.empresaId !== tela || document.querySelector(".modal-backdrop")) return;
    try {
      const baixa = await api("/api/integracoes/sieg/empresas/" + e.clientId + "/baixar");
      if (baixa.situacao === "concluida") aviso("SIEG: " + baixa.resumo.novos + " nota(s) nova(s)", "success");
      if (baixa.situacao === "falhou") aviso("SIEG: " + baixa.erro, "error");
      render();
    } catch { /* a proxima abertura da tela mostra */ }
  }, 5000);
}

function baixarDoSieg(e) {
  const meses = opcoesCompetenciaIso(24);
  const fundo = modal("Baixar do SIEG",
    '<form id="form-sieg" class="form-grid">' +
    '<div class="full message info">Traz do cofre do SIEG as notas em que ' + esc(e.name) + " aparece como emitente, " +
    "destinatário, tomador ou remetente. O SIEG aceita 2 consultas por minuto: cada mês e tipo leva de 30 segundos a 2 minutos, " +
    "em segundo plano. Nota que já está aqui não duplica.</div>" +
    campo("De", '<select name="de">' + opcoes(meses[1][0], meses) + "</select>") +
    campo("Até", '<select name="ate">' + opcoes(meses[1][0], meses) + "</select>") +
    '<fieldset class="form-field full"><legend>Documentos</legend><div class="checks">' +
      TIPOS_SIEG.map((tipo) => '<label><input type="checkbox" name="tipo:' + tipo + '" checked> ' + tipo + "</label>").join("") +
    "</div></fieldset>" +
    '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
    '<button class="primary" type="submit">Baixar</button></div></form>');
  fundo.querySelector("#form-sieg").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const d = valores(evento.target);
    const tipos = TIPOS_SIEG.filter((tipo) => evento.target.querySelector('[name="tipo:' + tipo + '"]').checked);
    if (!tipos.length) return aviso("Marque ao menos um documento", "error");
    try {
      await api("/api/integracoes/sieg/empresas/" + e.clientId + "/baixar", { method: "POST",
        body: JSON.stringify({ de: d.de <= d.ate ? d.de : d.ate, ate: d.de <= d.ate ? d.ate : d.de, tipos }) });
      fecharModal();
      aviso("Baixa do SIEG começou; a tela se atualiza sozinha", "success");
      render();
    } catch (erro) { aviso(erro.message, "error"); }
  });
}

function enviarCompetencia(e, destino) {
  const meses = opcoesCompetenciaIso(24);
  const nome = destino === "sieg" ? "SIEG" : "Domínio";
  const fundo = modal("Enviar ao " + nome,
    '<form id="form-envio" class="form-grid">' +
    '<div class="full message info">' + (destino === "sieg"
      ? "Manda ao cofre do SIEG o XML de cada nota desta competência que está no acervo."
      : "Manda à Escrita Fiscal do Domínio o XML de NF-e, NFC-e e CT-e desta competência, em lotes de 50. " +
        "A NFS-e tem leiaute próprio no Domínio e não vai por aqui. Depois, Integrações > Conferir lotes diz se cada lote foi armazenado.") +
    "</div>" +
    campo("Competência", '<select name="competencia">' + opcoes(meses[1][0], meses) + "</select>") +
    '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
    '<button class="primary" type="submit">Enviar</button></div></form>');
  fundo.querySelector("#form-envio").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const botao = evento.target.querySelector('[type="submit"]');
    botao.disabled = true;
    try {
      const r = await api("/api/integracoes/" + destino + "/empresas/" + e.clientId + "/enviar", { method: "POST",
        body: JSON.stringify({ competencia: valores(evento.target).competencia }) });
      fecharModal();
      aviso(destino === "sieg"
        ? r.aceitos + " de " + r.arquivos + " XML aceito(s) pelo SIEG"
        : r.lotes.length + " lote(s) enviado(s) ao Domínio, " + r.lotes.reduce((s, l) => s + l.arquivos, 0) + " XML", "success");
      render();
    } catch (erro) { aviso(erro.message, "error"); botao.disabled = false; }
  });
}

function ativarNoDominio(e) {
  const fundo = modal("Ativar no Domínio",
    '<form id="form-dominio" class="form-grid">' +
    '<div class="full message info">O contador gera a chave desta empresa no Onvio: Onvio Gestão &gt; API &gt; Chave &gt; ' +
    "Nova habilitação, uma por CNPJ, sem vencimento. O NÚCLEO confere no Domínio de quem é a chave antes de ativar e guarda " +
    "só a chave de integração, cifrada.</div>" +
    campo("Chave do contador", '<input name="chaveContador" type="password" autocomplete="new-password" required>', true) +
    '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
    '<button class="primary" type="submit">Ativar</button></div></form>');
  fundo.querySelector("#form-dominio").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    try {
      await api("/api/integracoes/dominio/empresas/" + e.clientId + "/ativar", { method: "POST",
        body: JSON.stringify({ chaveContador: valores(evento.target).chaveContador }) });
      fecharModal();
      aviso("Empresa ativada no Domínio", "success");
      render();
    } catch (erro) { aviso(erro.message, "error"); }
  });
}

async function entregasNaAcessorias(e) {
  const meses = opcoesCompetenciaIso(24);
  const mesAtual = meses[0][0];
  const fundo = modal("Entregas na Acessórias · " + esc(e.name),
    '<div class="filtros">' + campo("Mês do prazo", '<select id="mes-entregas">' +
      opcoes(mesAtual, [...proximosMeses(2), ...meses]) + "</select>") +
    '</div><div id="lista-entregas"><div class="empty">Carregando...</div></div>', 960);
  const carregar = async () => {
    const mes = fundo.querySelector("#mes-entregas").value;
    const [ano, m] = mes.split("-").map(Number);
    const fim = mes + "-" + String(new Date(ano, m, 0).getDate()).padStart(2, "0");
    const alvo = fundo.querySelector("#lista-entregas");
    try {
      const r = await api("/api/integracoes/acessorias/empresas/" + e.clientId + "/entregas?de=" + mes + "-01&ate=" + fim);
      alvo.innerHTML = tabela(["Obrigação", "Prazo", "Entregue em", "Situação", "Departamento", "Responsável"],
        r.entregas.map((item) => [
          "<strong>" + esc(item.nome) + "</strong>", dataCurta(item.prazo), item.entrega ? dataCurta(item.entrega) : "-",
          badge(item.status) + (item.multa && !item.entrega ? ' <span class="muted">com multa</span>' : ""),
          esc(item.departamento || "-"), esc(item.responsavel || "-")
        ]), "Nenhuma entrega com prazo neste mês");
      dicasDeCorte(alvo);
    } catch (erro) { alvo.innerHTML = '<div class="message danger-text">' + esc(erro.message) + "</div>"; }
  };
  fundo.querySelector("#mes-entregas").addEventListener("change", carregar);
  carregar();
}

/** Os proximos meses (AAAA-MM, MM/AAAA), para prazos que ainda vao vencer. */
function proximosMeses(quantos) {
  const hoje = new Date();
  return Array.from({ length: quantos }, (_, i) => {
    const data = new Date(hoje.getFullYear(), hoje.getMonth() + quantos - i, 1);
    const mm = String(data.getMonth() + 1).padStart(2, "0");
    return [data.getFullYear() + "-" + mm, mm + "/" + data.getFullYear()];
  });
}

// --------------------------------------------- PONTE dentro do NUCLEO

/** Cartao da PONTE no painel da empresa: o vinculo na carteira e o A1 la. */
function cartaoPonte(e, ponte) {
  const pelaPonte = (e.fontes || []).includes("PONTE");
  if (!pelaPonte && !can("config")) return "";
  const naCarteira = ponte?.naCarteira === true;
  const a1 = ponte?.temCertificado
    ? esc(ponte.certificadoTitular || "A1") + " até " + dataCurta(ponte.certificadoVencimento)
    : naCarteira ? '<span class="error-count">sem A1 na PONTE</span>' : "-";
  return '<div class="card"><div class="head"><div><h2>PONTE SEFAZ</h2><p>' +
    (naCarteira ? "Na carteira do escritório" + (ponte.desde ? " desde " + dataCurta(ponte.desde) : "") +
      (ponte.ultimaVarredura ? " · última varredura " + dataHora(ponte.ultimaVarredura) : "")
      : ponte ? "Fora da carteira da PONTE" : "Ainda não está na PONTE") + "</p></div>" +
    '<div class="actions">' +
      (can("config") && !naCarteira ? '<button class="primary" id="ponte-incluir">Incluir na PONTE</button>' : "") +
      (can("config") && naCarteira ? '<button id="ponte-editar">Editar</button>' : "") +
      (can("config") && naCarteira ? '<button id="ponte-a1">Enviar A1</button>' : "") +
      (can("config") && naCarteira ? '<button id="ponte-termo">Termo do A1</button>' : "") +
      (can("config") && naCarteira && ponte.temCertificado ? '<button id="ponte-remover-a1">Remover A1</button>' : "") +
      (can("config") && naCarteira ? '<button class="danger" id="ponte-encerrar">Encerrar</button>' : "") +
    "</div></div>" +
    listaDados([
      ["A1 na PONTE", a1],
      ["Busca automática dela", naCarteira ? (ponte.radar === false ? "Desligada" : "Ligada") : null]
    ]) +
    (naCarteira && !ponte.temCertificado
      ? '<div class="body"><div class="message warn">Sem o A1 do cliente a PONTE não varre a SEFAZ nem o ambiente nacional. ' +
        "Envie o A1 (o da matriz serve para as filiais).</div></div>" : "") +
    (naCarteira ? '<div class="body" id="ponte-nfa" hidden></div>' : "") +
    "</div>";
}

function ligarPonte(e, ponte) {
  document.querySelector("#ponte-incluir")?.addEventListener("click", () => incluirNaPonte(e));
  document.querySelector("#ponte-editar")?.addEventListener("click", () => editarNaPonte(e, ponte));
  document.querySelector("#ponte-remover-a1")?.addEventListener("click", async () => {
    const ok = await confirmarAcao("Remover o A1 da PONTE",
      "O certificado de " + e.name + " sai do cofre da PONTE e a busca desta empresa para até outro A1 ser enviado. " +
      "Nada do que já foi capturado é apagado.", "Remover");
    if (!ok) return;
    try {
      const r = await api("/api/ponte/empresas/" + e.clientId + "/certificado/remover", { method: "POST" });
      aviso(r.aviso, "success");
      render();
    } catch (erro) { aviso(erro.message, "error"); }
  });
  // NFA do produtor rural: vem da PONTE na hora, sem segurar o painel.
  const caixaNfa = document.querySelector("#ponte-nfa");
  if (caixaNfa) {
    api("/api/ponte/empresas/" + e.clientId + "/nfa").then((r) => {
      if (!r.nfa.length || !document.body.contains(caixaNfa)) return;
      caixaNfa.hidden = false;
      caixaNfa.innerHTML = '<p><strong>NFA do produtor rural (' + r.nfa.length + "):</strong> o arquivo fica no SIARE; use o " +
        "número e o protocolo para baixar.</p>" +
        tabela(["Número", "Protocolo", "Produtor (IE)", "Emitida"], r.nfa.map((item) => [
          "<strong>" + esc(item.numero || "-") + "</strong>", esc(item.protocolo || "-"), esc(item.produtorIe || "-"),
          item.emitidaEm ? dataHora(item.emitidaEm) : "-"
        ]));
      dicasDeCorte(caixaNfa);
    }).catch(() => {});
  }
  document.querySelector("#ponte-a1")?.addEventListener("click", () => enviarA1Ponte(e));
  document.querySelector("#ponte-termo")?.addEventListener("click", () => termoPonte(e));
  document.querySelector("#ponte-encerrar")?.addEventListener("click", () => encerrarPonte(e));
}

async function incluirNaPonte(e) {
  const fundo = modal("Incluir " + esc(e.name) + " na PONTE",
    '<form id="form-incluir" class="form-grid">' +
    '<div class="full message info">A empresa entra na carteira do escritório na PONTE SEFAZ e a captura dela passa a ' +
    "ser feita por lá. Depois, envie o A1 do cliente para a PONTE. O plano do escritório limita quantas empresas cabem.</div>" +
    campo("Período começa em", seletorCompetencia("desde", mesesRecentes(13)[12], "Hoje"), true) +
    '<div class="form-actions"><button type="button" data-fechar>Cancelar</button>' +
    '<button class="primary" type="submit">Incluir</button></div></form>');
  fundo.querySelector("#form-incluir").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const mes = valores(evento.target).desde;
    const desde = /^\d{2}\/\d{4}$/.test(mes || "") ? mes.slice(3) + "-" + mes.slice(0, 2) + "-01" : undefined;
    try {
      await api("/api/ponte/empresas/" + e.clientId + "/incluir", { method: "POST", body: JSON.stringify({ desde }) });
      fecharModal();
      aviso(e.name + " incluída na PONTE. Envie o A1 dela.", "success");
      render();
    } catch (erro) { aviso(erro.message, "error"); }
  });
}

async function editarNaPonte(e, ponte) {
  const fundo = modal("Editar " + esc(e.name) + " na PONTE",
    '<form id="form-editar-ponte" class="form-grid">' +
    '<div class="full message info">Só muda o que você preencher. O código contábil é o código desta empresa no sistema ' +
    "de contabilidade do escritório.</div>" +
    campo("Apelido", '<input name="apelido" placeholder="' + esc(e.name) + '">') +
    campo("Código contábil", '<input name="codigoContabil" placeholder="ex.: 0153">') +
    campo("Busca automática da PONTE", '<select name="radar">' + opcoes("", [["", "Manter como está"], ["true", "Ligada"],
      ["false", "Desligada"]]) + "</select>", true) +
    '<div class="form-actions"><button type="button" data-fechar>Cancelar</button>' +
    '<button class="primary" type="submit">Salvar</button></div></form>');
  fundo.querySelector("#form-editar-ponte").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    try {
      const r = await api("/api/ponte/empresas/" + e.clientId + "/alterar", { method: "POST", body: JSON.stringify(valores(evento.target)) });
      fecharModal();
      aviso("Salvo na PONTE: " + r.alterados.join(", "), "success");
      render();
    } catch (erro) { aviso(erro.message, "error"); }
  });
}

async function enviarA1Ponte(e) {
  const temNoCofre = Boolean(e.certificadoId);
  const fundo = modal("Enviar o A1 de " + esc(e.name) + " para a PONTE",
    '<form id="form-a1-ponte" class="form-grid">' +
    '<div class="full message info">O A1 fica guardado no cofre da PONTE, que usa ele para varrer a SEFAZ e o ambiente ' +
    "nacional. O arquivo é aberto aqui antes de sair: senha errada ou certificado de outro CNPJ param aqui. " +
    "Para filial, o A1 da matriz serve.</div>" +
    (temNoCofre ? campo("Origem", '<select name="origem"><option value="cofre">O A1 que já está no cofre do NÚCLEO</option>' +
      '<option value="arquivo">Outro arquivo .pfx</option></select>', true) : "") +
    '<div class="full form-grid" id="a1-arquivo"' + (temNoCofre ? ' hidden' : "") + ">" +
      campo("Arquivo .pfx", '<input type="file" name="arquivo" accept=".pfx,.p12">') +
      campo("Senha do certificado", '<input type="password" name="senha" autocomplete="new-password">') +
    "</div>" +
    campo("Autorizado por", '<input name="autorizadoPor" required placeholder="Quem do cliente autorizou a guarda">') +
    campo("Referência", '<input name="referencia" placeholder="Termo assinado em ...">') +
    '<div class="form-actions"><button type="button" data-fechar>Cancelar</button>' +
    '<button class="primary" type="submit">Enviar</button></div></form>');
  const origem = fundo.querySelector('select[name="origem"]');
  origem?.addEventListener("change", () => { fundo.querySelector("#a1-arquivo").hidden = origem.value === "cofre"; });
  fundo.querySelector("#form-a1-ponte").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const d = valores(evento.target);
    const doCofre = temNoCofre && d.origem !== "arquivo";
    const arquivo = evento.target.arquivo.files[0];
    if (!doCofre && (!arquivo || !d.senha)) return aviso("Escolha o arquivo .pfx e informe a senha", "warn");
    const botao = evento.target.querySelector('button[type="submit"]');
    botao.disabled = true;
    try {
      const r = await api("/api/ponte/empresas/" + e.clientId + "/certificado", { method: "POST", body: JSON.stringify({
        usarDoCofre: doCofre, pfxBase64: doCofre ? undefined : await lerComoBase64(arquivo), senha: doCofre ? undefined : d.senha,
        autorizadoPor: d.autorizadoPor, referencia: d.referencia || undefined }) });
      fecharModal();
      aviso("A1 de " + r.titular + " guardado na PONTE, válido até " + dataCurta(r.vencimento) + ".", "success");
      render();
    } catch (erro) { aviso(erro.message, "error"); botao.disabled = false; }
  });
}

async function termoPonte(e) {
  const fundo = modal("Termo de guarda do A1 de " + esc(e.name),
    '<div class="message info">O termo registra que o cliente autorizou o escritório a guardar o certificado dele na PONTE. ' +
    "Não é obrigatório, mas protege o escritório. Gere, colha a assinatura do cliente e guarde o assinado.</div>" +
    '<form id="form-termo" class="form-grid">' +
      campo("Responsável pelo cliente", '<input name="responsavelNome" required>') +
      campo("CPF do responsável", '<input name="responsavelCpf" inputmode="numeric" placeholder="só números">') +
      '<div class="form-actions"><button class="primary" type="submit">Gerar o termo (PDF)</button></div>' +
    "</form>" +
    '<form id="form-termo-assinado" class="form-grid">' +
      campo("Termo assinado", '<input type="file" name="arquivo" accept=".pdf,.png,.jpg,.jpeg" required>') +
      campo("Assinado por", '<input name="assinadoPor" required>') +
      '<div class="form-actions"><button type="button" id="baixar-assinado">Baixar o assinado</button>' +
      '<button class="primary" type="submit">Guardar o assinado</button></div>' +
    "</form>");
  fundo.querySelector("#form-termo").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    try {
      await baixarPost("/api/ponte/empresas/" + e.clientId + "/termo", valores(evento.target));
    } catch (erro) { aviso(erro.message, "error"); }
  });
  fundo.querySelector("#form-termo-assinado").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const arquivo = evento.target.arquivo.files[0];
    try {
      await api("/api/ponte/empresas/" + e.clientId + "/termo/assinado", { method: "POST", body: JSON.stringify({
        arquivoBase64: await lerComoBase64(arquivo), nome: arquivo.name, tipoMime: arquivo.type || "application/pdf",
        assinadoPor: valores(evento.target).assinadoPor }) });
      aviso("Termo assinado guardado na PONTE", "success");
      fecharModal();
    } catch (erro) { aviso(erro.message, "error"); }
  });
  fundo.querySelector("#baixar-assinado").addEventListener("click", () => baixar("/api/ponte/empresas/" + e.clientId + "/termo/assinado"));
}

async function encerrarPonte(e) {
  const ok = await confirmarAcao("Encerrar na PONTE",
    "A PONTE para de varrer " + e.name + ". Nada é apagado: as notas já capturadas continuam aqui e lá. " +
    "A captura desta empresa pela PONTE passa a avisar que ela saiu da carteira.", "Encerrar");
  if (!ok) return;
  try {
    const r = await api("/api/ponte/empresas/" + e.clientId + "/encerrar", { method: "POST" });
    aviso(r.aviso, "success");
    render();
  } catch (erro) { aviso(erro.message, "error"); }
}

/** POST que devolve um arquivo (o termo em PDF, por exemplo). */
async function baixarPost(caminho, corpo) {
  const resposta = await fetch(caminho, { method: "POST", body: JSON.stringify(corpo),
    headers: { authorization: "Bearer " + state.token, "content-type": "application/json" } });
  if (!resposta.ok) throw new Error((await resposta.json().catch(() => ({}))).error || "Pedido recusado (" + resposta.status + ")");
  const blob = await resposta.blob();
  const nome = (resposta.headers.get("content-disposition") || "").match(/filename="?([^";]+)"?/)?.[1] || "arquivo";
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = nome;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Baixar periodo: escolhe de e ate (competencias) e acompanha ate terminar. */
function baixarPeriodo(e, periodo) {
  const meses = mesesRecentes(60);
  const desde = periodo?.desde ? periodo.desde.slice(5, 7) + "/" + periodo.desde.slice(0, 4) : null;
  const inicio = desde && meses.includes(desde) ? desde : meses[11];
  const seletor = (nome, atual) => '<select name="' + nome + '">' + opcoes(atual, meses.map((mes) => [mes, mes])) + "</select>";
  const fundo = modal("Baixar período de " + esc(e.name),
    '<form id="form-periodo" class="form-grid">' +
    '<div class="full message info">Traz da PONTE cada competência do período: NF-e, NFS-e e CT-e, emitidas e recebidas, ' +
    "com XML, PDF e a pasta do cliente. Nota já guardada não duplica." + (desde ? " O cliente está na carteira desde " +
      desde + "." : "") + "</div>" +
    campo("De", seletor("de", inicio)) + campo("Até", seletor("ate", meses[0])) +
    '<div class="form-actions"><button type="button" data-fechar>Cancelar</button>' +
    '<button class="primary" type="submit">Baixar</button></div></form>');
  fundo.querySelector("#form-periodo").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const d = valores(evento.target);
    const paraIso = (mes) => mes.slice(3) + "-" + mes.slice(0, 2);
    const botao = evento.target.querySelector('button[type="submit"]');
    botao.disabled = true;
    botao.textContent = "Baixando...";
    try {
      const rota = "/api/captura/empresas/" + e.clientId + "/periodo";
      let estado = await api(rota, { method: "POST", body: JSON.stringify({ de: paraIso(d.de), ate: paraIso(d.ate) }) });
      while (estado.situacao === "executando") {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        estado = (await api(rota)).baixa;
      }
      if (estado.situacao === "falhou") throw new Error(estado.erro);
      const r = estado.resumo;
      fecharModal();
      aviso(e.name + ": " + r.competencias.length + " mes(es) trazido(s), " + r.novos + " nota(s) nova(s), " + r.duplicados +
        " já guardada(s)" + (r.resumos ? ", " + r.resumos + " só em resumo" : "") + (r.falhas ? ", " + r.falhas + " pacote(s) com falha" : "") +
        ".", r.falhas ? "warn" : "success");
      render();
    } catch (erro) {
      aviso(erro.message, "error");
      botao.disabled = false;
      botao.textContent = "Baixar";
    }
  });
}

/** Ciencia da Operacao em todas as NF-e da empresa que estao so em resumo. */
async function cienciaEmLote(e, quantas) {
  const ok = await confirmarAcao("Ciência em lote",
    "Manifesta a Ciência da Operação nas " + quantas + " NF-e de " + e.name + " que estão só em resumo. É um ato em nome " +
    "do cliente, registrado na SEFAZ: diz que ele tomou conhecimento das notas, sem confirmar nem negar a operação, e " +
    "libera o XML completo. Fica na trilha de auditoria com o seu usuário.", "Manifestar");
  if (!ok) return;
  try {
    const r = await api("/api/captura/empresas/" + e.clientId + "/ciencia-em-lote", { method: "POST" });
    aviso(r.aceitas.length + " ciência(s) registrada(s)" + (r.recusadas.length ? ", " + r.recusadas.length + " recusada(s)" : "") +
      ". " + (r.proximoPasso || "O XML completo chega na próxima captura."), r.recusadas.length ? "warn" : "success");
    render();
  } catch (erro) { aviso(erro.message, "error"); }
}

function resumoTarefa(r) {
  return (r.novos || 0) + " nova(s): " + (r.emitidas || 0) + " emitida(s), " + (r.recebidas || 0) + " recebida(s)" +
    (r.outras ? ", " + r.outras + " de terceiros" : "") +
    (r.ciencias?.enviadas ? ", " + r.ciencias.aceitas.length + " ciencia(s) registrada(s)" +
      (r.ciencias.recusadas.length ? ' <span class="error-count">' + r.ciencias.recusadas.length + " recusada(s)</span>" : "") : "") +
    (r.eventos ? ", " + r.eventos + " evento(s)" : "") +
    (r.resumos ? ', <span class="error-count">' + r.resumos + " sem XML</span>" : "") +
    (r.falhas ? ', <span class="error-count">' + r.falhas + " corrompida(s)</span>" : "") +
    '<br><span class="muted">' + (r.fonte === "PONTE"
      ? "meses " + esc((r.competencias || []).slice().reverse().join(", "))
      : "NSU " + r.nsuInicial + " a " + r.nsuFinal) + ", " + r.chamadas + " chamada(s)" +
    (r.viaProcuracao ? ", via procuracao" : "") +
    (r.liberaEm ? ", proxima consulta a SEFAZ apos " + dataHora(r.liberaEm) : "") +
    (r.fonte === "PONTE" ? ", varredura da PONTE: " + esc(r.varredura?.resultado || "-") +
      (r.avisos?.length ? '<br><span class="error-count">' + r.avisos.map(esc).join(" ") + "</span>" : "") : "") + "</span>";
}

function lerComoBase64(arquivo) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(String(leitor.result).split(",").pop());
    leitor.onerror = () => reject(new Error("Nao foi possivel ler " + arquivo.name));
    leitor.readAsDataURL(arquivo);
  });
}

function importarXml(e, entrada) {
  const separador = String(e.pastaDestino || "").includes("\\") ? "\\" : "/";
  // Pasta do navegador nao tem leitura automatica de entrada: so o botao de importar.
  const caminhoEntrada = entrada && e.pastaDestino && !e.pastaDestino.startsWith("navegador:")
    ? e.pastaDestino.replace(/[\/]+$/, "") + separador + entrada.split("/").join(separador) : "";
  const fundo = modal("Importar XML de " + esc(e.name),
    '<form id="form-importar" class="form-grid">' +
    '<div class="full message info">Para as notas que nao passam pelos portais: <strong>NFS-e de prefeitura com ' +
    "sistema proprio</strong> (exporte os XML no site da prefeitura), <strong>NF-e emitidas pela propria empresa" +
    "</strong> (exporte do emissor) e notas recebidas por e-mail. Aceita XML, ZIP e o PDF com o mesmo nome do XML, " +
    "que e guardado junto. Arquivo que nao menciona o CNPJ da empresa e recusado.<br>" +
    (caminhoEntrada
      ? "<strong>Automatico:</strong> solte os arquivos em <code>" + esc(caminhoEntrada) + "</code>. O servidor (ou o " +
        "agente local) importa sozinho e move cada arquivo para IMPORTADOS ou COM_ERRO, com o motivo."
      : "Configure a pasta do cliente para ganhar uma pasta de entrada lida automaticamente.") +
    "</div>" +
    campo("Arquivos", '<input type="file" name="arquivos" multiple accept=".xml,.zip,.pdf" required>', true) +
    '<div id="resultado-importacao" class="full"></div>' +
    '<div class="form-actions full"><button type="button" data-fechar>Fechar</button>' +
    '<button class="primary" type="submit">Importar</button></div></form>', 760);

  // Ao fechar depois de importar, o painel volta com os numeros novos.
  let importou = false;
  fundo.addEventListener("click", (evento) => {
    if (importou && (evento.target === fundo || evento.target.hasAttribute("data-fechar"))) render();
  });
  fundo.querySelector("#form-importar").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const botao = evento.target.querySelector(".primary");
    const escolhidos = [...evento.target.querySelector('input[type="file"]').files];
    if (!escolhidos.length) return;
    botao.disabled = true;
    botao.textContent = "Importando...";
    try {
      const arquivos = [];
      for (const arquivo of escolhidos) arquivos.push({ nome: arquivo.name, conteudoBase64: await lerComoBase64(arquivo) });
      const r = await api("/api/captura/empresas/" + e.clientId + "/importar", { method: "POST", body: JSON.stringify({ arquivos }) });
      const fora = r.arquivos.filter((item) => item.situacao === "recusado" || item.situacao === "ignorado");
      fundo.querySelector("#resultado-importacao").innerHTML =
        '<div class="message ' + (r.recusados ? "warn" : "info") + '"><strong>' + r.novos + " nota(s) nova(s)</strong>: " +
        r.emitidas + " emitida(s), " + r.recebidas + " recebida(s)" + (r.outras ? ", " + r.outras + " de terceiros" : "") +
        (r.eventos ? "; " + r.eventos + " evento(s)" : "") + (r.duplicados ? "; " + r.duplicados + " ja estavam no acervo" : "") +
        "; PDF: " + r.pdfsAnexados + " guardado(s) junto, " + r.pdfsGerados + " gerado(s)" +
        (r.semPdf ? ", " + r.semPdf + " sem PDF (envie o PDF da prefeitura com o mesmo nome do XML)" : "") + ".</div>" +
        (fora.length ? tabela(["Arquivo", "Situação", "Motivo"],
          fora.map((item) => [esc(item.nome), badge(item.situacao), esc(item.motivo || "")]), "") : "");
      importou = true;
      aviso(r.novos + " nota(s) importada(s)", r.recusados ? "info" : "success");
      botao.textContent = "Importar mais";
      botao.disabled = false;
      evento.target.querySelector('input[type="file"]').value = "";
    } catch (erro) {
      aviso(erro.message, "error");
      botao.disabled = false;
      botao.textContent = "Importar";
    }
  });
}

function rebuscarFaixa(e) {
  const fundo = modal("Rebuscar faixa de NSU",
    '<form id="form-faixa" class="form-grid">' +
    '<div class="full message info">Pede ao portal de novo os NSU informados, sem mexer no cursor. Serve para ' +
    "notas que vieram sem XML ou corrompidas: se o portal ja tiver o arquivo, a pendencia fecha sozinha. " +
    "Maximo de 500 NSU por vez.</div>" +
    campo("De (NSU)", '<input name="de" type="number" min="1" required>') +
    campo("Até (NSU)", '<input name="ate" type="number" min="1">') +
    '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
    '<button class="primary" type="submit">Buscar</button></div></form>');
  fundo.querySelector("#form-faixa").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const dados = valores(evento.target);
    const botao = evento.target.querySelector(".primary");
    botao.disabled = true;
    botao.textContent = "Buscando...";
    try {
      const r = await api("/api/captura/empresas/" + e.clientId + "/faixa", {
        method: "POST", body: JSON.stringify({ de: Number(dados.de), ate: Number(dados.ate || dados.de) })
      });
      fecharModal();
      aviso("Faixa rebuscada: " + r.novos + " nota(s) nova(s)", "success");
      render();
    } catch (erro) { aviso(erro.message, "error"); botao.disabled = false; botao.textContent = "Buscar"; }
  });
}

// ------------------------------------------------------- notas capturadas

// Colunas da relacao em Excel (as mesmas chaves do servidor). A escolha fica neste navegador.
const COLUNAS_EXCEL = [
  ["empresa", "Empresa"], ["cnpjEmpresa", "CNPJ da empresa"], ["documento", "Documento"], ["papel", "Papel"],
  ["numero", "Número"], ["serie", "Série"], ["emissao", "Emissão"], ["competencia", "Competência"], ["emitente", "Emitente"],
  ["cnpjEmitente", "CNPJ do emitente"], ["destinatario", "Destinatário ou tomador"], ["cnpjDestinatario", "CNPJ do destinatário"],
  ["valor", "Valor"], ["situacao", "Situação"], ["conferencia", "Conferência"], ["xml", "XML"], ["pdf", "PDF"], ["chave", "Chave"]
];

function escolherColunasExcel(filtros) {
  let salvas = null;
  try { salvas = JSON.parse(localStorage.getItem("nucleo_colunas_excel") || "null"); } catch { salvas = null; }
  const marcadas = new Set(Array.isArray(salvas) && salvas.length ? salvas : COLUNAS_EXCEL.map(([chave]) => chave));
  const fundo = modal("Relação em Excel",
    '<form id="form-colunas" class="form-grid">' +
    '<div class="full message info">Uma linha por nota, com os filtros da tela, e uma aba de resumo por empresa e mês. ' +
    "Escolha as colunas; a escolha fica guardada neste navegador.</div>" +
    grupoChecks("Colunas", COLUNAS_EXCEL.map(([chave, rotulo]) =>
      '<label><input type="checkbox" name="coluna" value="' + chave + '"' + (marcadas.has(chave) ? " checked" : "") + "> " +
      rotulo + "</label>").join(""), false) +
    '<div class="form-actions"><button type="button" id="todas-colunas">Marcar todas</button>' +
    '<button class="primary" type="submit">Baixar Excel</button></div></form>', 720);
  fundo.querySelector("#todas-colunas").addEventListener("click", () => {
    for (const caixa of fundo.querySelectorAll('input[name="coluna"]')) caixa.checked = true;
  });
  fundo.querySelector("#form-colunas").addEventListener("submit", (evento) => {
    evento.preventDefault();
    const escolhidas = new FormData(evento.target).getAll("coluna");
    if (!escolhidas.length) return aviso("Escolha ao menos uma coluna", "warn");
    try { localStorage.setItem("nucleo_colunas_excel", JSON.stringify(escolhidas)); } catch { /* sem armazenamento: so nao lembra */ }
    fecharModal();
    baixar("/api/acervo/relacao?" + new URLSearchParams({ ...filtros, colunas: escolhidas.join(",") }).toString());
  });
}

/** Periodo de emissao escolhido num seletor: vira as datas de e ate. */
function datasDoPeriodo(periodo) {
  const dia = (data) => data.getFullYear() + "-" + String(data.getMonth() + 1).padStart(2, "0") + "-" +
    String(data.getDate()).padStart(2, "0");
  const hoje = new Date();
  const [ano, mes, hojeDia] = [hoje.getFullYear(), hoje.getMonth(), hoje.getDate()];
  if (periodo === "hoje") return { de: dia(hoje), ate: dia(hoje) };
  if (periodo === "7") return { de: dia(new Date(ano, mes, hojeDia - 6)), ate: dia(hoje) };
  if (periodo === "30") return { de: dia(new Date(ano, mes, hojeDia - 29)), ate: dia(hoje) };
  if (periodo === "mes") return { de: dia(new Date(ano, mes, 1)), ate: dia(hoje) };
  if (periodo === "mes-passado") return { de: dia(new Date(ano, mes - 1, 1)), ate: dia(new Date(ano, mes, 0)) };
  return {};
}

/** Filtros da tela em parametros da busca: o periodo escolhido vira as datas. */
function consultaDasNotas(f) {
  const { periodo, de, ate, ...resto } = f;
  const datas = periodo === "outro" ? { de, ate } : datasDoPeriodo(periodo);
  return Object.fromEntries(Object.entries({ ...resto, ...datas }).filter(([, v]) => v !== undefined && v !== ""));
}

async function acervo() {
  const f = state.filtrosAcervo || {};
  titulo("Notas", "XML e PDF de todas as empresas");
  const lista = await api("/api/captura/empresas");
  const dados = await api("/api/acervo/documentos?" + new URLSearchParams(consultaDasNotas(f)).toString());

  const competencias = dados.competencias || [];
  if (f.competencia && !competencias.includes(f.competencia)) competencias.unshift(f.competencia);
  // Barra de filtros numa linha: sem filtro, o seletor mostra o nome do campo, apagado.
  const seletor = (nome, dica, pares) => '<select name="' + nome + '" title="' + dica + '" aria-label="' + dica + '"' +
    (f[nome] ? ' class="ativo"' : "") + ">" + opcoes(f[nome], pares) + "</select>";
  const algumFiltro = Object.entries(f).some(([nome, valor]) => nome !== "pagina" && valor);

  conteudo(
    '<div class="card"><div class="head"><div><h2>' + dados.total + " nota(s)</h2>" +
      "<p>Página " + dados.pagina + " de " + Math.max(1, Math.ceil(dados.total / dados.porPagina)) + "</p></div>" +
      '<div class="actions">' +
        (algumFiltro ? '<button class="ghost" id="limpar">Limpar filtros</button>' : "") +
        (can("export") ? '<button id="exportar-excel" title="Relação das notas destes filtros, com resumo por mês">Excel</button>' +
          '<button id="exportar-filtro" title="ZIP com as notas destes filtros">Exportar ZIP</button>' : "") +
        (dados.pagina > 1 ? '<button id="anterior">Anterior</button>' : "") +
        (dados.pagina * dados.porPagina < dados.total ? '<button id="proxima">Próxima</button>' : "") +
      "</div></div>" +
    '<form id="form-filtros" class="filtros">' +
      seletor("clienteId", "Empresa", [["", "Empresa"],
        ...lista.filter((item) => item.configurada).map((item) => [item.clientId, item.name])]) +
      seletor("competencia", "Competência", [["", "Competência"],
        ...competencias.map((competencia) => [competencia, competenciaBr(competencia)])]) +
      seletor("tipo", "Documento", [["", "Tipo"], ["NFS-e", "NFS-e"], ["NF-e", "NF-e"], ["CT-e", "CT-e"]]) +
      seletor("papel", "Papel", [["", "Papel"], ["emitida", "Só emitidas"], ["recebida", "Só recebidas"],
        ["outro", "De terceiros"]]) +
      seletor("situacao", "Situação", [["", "Situação"], ["autorizada", "Autorizadas"], ["cancelada", "Canceladas"]]) +
      seletor("periodo", "Emissão", [["", "Emissão"], ["hoje", "Emitidas hoje"], ["7", "Últimos 7 dias"],
        ["30", "Últimos 30 dias"], ["mes", "Este mês"], ["mes-passado", "Mês passado"], ["outro", "Entre datas"]]) +
      (f.periodo === "outro"
        ? '<input name="de" type="date" title="Emissão de" aria-label="Emissão de" value="' + esc(f.de || "") + '">' +
          '<input name="ate" type="date" title="Emissão até" aria-label="Emissão até" value="' + esc(f.ate || "") + '">'
        : "") +
      seletor("pdf", "PDF", [["", "PDF"], ["sim", "Com PDF"], ["nao", "Sem PDF"]]) +
      '<input name="busca" type="search" class="busca' + (f.busca ? " ativo" : "") + '" placeholder="Número, chave, CNPJ ou valor" ' +
        'title="Número da nota; trecho da chave; CNPJ do emitente, destinatário ou tomador (12.345.678/0001-90); ' +
        'ou valor exato (1.234,56)" value="' + esc(f.busca || "") + '">' +
      '<input name="produto" type="search" class="busca' + (f.produto ? " ativo" : "") + '" placeholder="Produto, NCM ou CFOP" ' +
        'title="Código busca CFOP, NCM ou código do serviço; texto busca a descrição do produto ou do serviço" value="' +
        esc(f.produto || "") + '">' +
    "</form>" +
      tabela(["Emissão", "Comp.", "Empresa", "Tipo", "Número", "Contraparte", "Valor", "Situação", "Conferência", "Pasta", "Arquivos"],
        dados.documentos.map((item) => {
          const contraparte = item.papel === "emitida" ? item.destinatario : item.emitente;
          return [
            dataCurta(item.emissao), competenciaBr(item.competencia), esc(item.clientName),
            esc(item.tipo || "") + "<br>" + badge(item.papel),
            '<strong title="Chave ' + esc(item.chave) + (item.fonte === "IMPORTACAO" ? " (importada)" : item.nsu ? ", NSU " + esc(item.nsu) : "") +
              '">' + esc(item.numero) + "</strong>",
            '<span title="' + esc(contraparte?.nome || "") + (contraparte?.cnpj ? ", CNPJ " + esc(contraparte.cnpj) : "") + '">' +
              esc(contraparte?.nome || "-") + "</span>",
            dinheiro(item.valor),
            badge(item.cancelada ? "Cancelada" : "Autorizada"),
            badge(item.conferencia),
            badge(item.pasta),
            '<div class="actions">' +
              (item.xml && can("export") ? '<button data-baixar-doc="' + item.id + '/xml">XML</button>' : "") +
              (item.pdf && can("export") ? '<button data-baixar-doc="' + item.id + '/pdf">PDF</button>' : "") +
            "</div>"
          ];
        }), "Nenhuma nota com estes filtros") +
    "</div>"
  );

  const aplicar = (novos) => { state.filtrosAcervo = novos; render(); };
  // Escolheu, filtrou: sem botao de filtrar. A busca por numero ou chave vai no Enter.
  const formulario = document.querySelector("#form-filtros");
  const doFormulario = () => Object.fromEntries(Object.entries(valores(formulario)).filter(([, v]) => v));
  formulario.addEventListener("change", () => aplicar(doFormulario()));
  formulario.addEventListener("submit", (evento) => { evento.preventDefault(); aplicar(doFormulario()); });
  document.querySelector("#limpar")?.addEventListener("click", () => aplicar({}));
  document.querySelector("#exportar-filtro")?.addEventListener("click", () => {
    const { pagina, ...atuais } = consultaDasNotas(f);
    baixar("/api/acervo/exportar?" + new URLSearchParams(atuais).toString());
  });
  document.querySelector("#exportar-excel")?.addEventListener("click", () => {
    const { pagina, ...atuais } = consultaDasNotas(f);
    escolherColunasExcel(atuais);
  });
  document.querySelector("#anterior")?.addEventListener("click", () => aplicar({ ...f, pagina: (dados.pagina || 1) - 1 }));
  document.querySelector("#proxima")?.addEventListener("click", () => aplicar({ ...f, pagina: (dados.pagina || 1) + 1 }));
  for (const botao of document.querySelectorAll("[data-baixar-doc]")) {
    botao.addEventListener("click", () => baixar("/api/acervo/documentos/" + botao.dataset.baixarDoc));
  }
}

// ------------------------------------------------------------- resumos

/**
 * NF-e que so vieram em resumo, uma por uma. Nada e liberado sozinho: a pessoa
 * libera o XML (Ciencia da Operacao) de uma nota, das marcadas, ou deixa para depois.
 */
async function resumos() {
  titulo("Resumos", "NF-e só em resumo, uma por uma");
  const filtro = state.filtroResumos || {};
  const [dados, lista] = await Promise.all([
    api("/api/captura/resumos" + (filtro.clienteId ? "?clienteId=" + encodeURIComponent(filtro.clienteId) : "")),
    api("/api/captura/empresas")
  ]);
  const todos = dados.resumos;
  const visiveis = todos.filter((item) => !filtro.situacao ||
    (filtro.situacao === "liberada" ? item.ciencia?.situacao === "aceita" : item.ciencia?.situacao !== "aceita"));
  const hoje = new Date().toISOString().slice(0, 10);
  const prazoXml = (item) => {
    if (!item.prazoXml) return "-";
    const dias = Math.round((new Date(item.prazoXml) - new Date(hoje)) / 86_400_000);
    return dataCurta(item.prazoXml) + " " + badge(dias < 0 ? "Vencido" : dias <= 15 ? "Vencendo" : "No prazo");
  };
  const valorTotal = visiveis.reduce((soma, item) => soma + (item.valor || 0), 0);

  conteudo(
    '<div class="card"><div class="head"><div><h2>' + visiveis.length + " NF-e em resumo</h2>" +
      "<p>" + dinheiro(valorTotal) + " ao todo. O XML completo só vem depois da Ciência da Operação; nada é liberado sem você " +
      "mandar.</p></div>" +
      '<div class="actions">' +
        (can("write") ? '<button id="selecionar-faltam">Selecionar todas que faltam (' +
          visiveis.filter((item) => item.ciencia?.situacao !== "aceita").length + ")</button>" +
          '<button class="ghost" id="limpar-selecao">Limpar seleção</button>' +
          '<button class="primary" id="liberar-marcadas" disabled>Liberar marcadas</button>' : "") +
      "</div></div>" +
      '<form id="form-resumos" class="filtros">' +
        '<select name="clienteId" title="Empresa" aria-label="Empresa"' + (filtro.clienteId ? ' class="ativo"' : "") + ">" +
          opcoes(filtro.clienteId, [["", "Empresa"], ...lista.filter((item) => item.configurada).map((item) => [item.clientId, item.name])]) +
        "</select>" +
        '<select name="situacao" title="Situação" aria-label="Situação"' + (filtro.situacao ? ' class="ativo"' : "") + ">" +
          opcoes(filtro.situacao, [["", "Situação"], ["esperando", "Esperando liberação"], ["liberada", "Ciência enviada"]]) +
        "</select>" +
      "</form>" +
      tabela([
        can("write") ? '<input type="checkbox" id="marcar-todas" aria-label="Marcar todas" title="Marcar todas">' : "",
        "Empresa", "Emitente", "Emissão", "Valor", "Prazo do XML", "Situação", ""
      ], visiveis.map((item) => [
        can("write") && item.ciencia?.situacao !== "aceita"
          ? '<input type="checkbox" name="resumo" value="' + esc(item.chave) + '" data-cliente="' + esc(item.clientId) + '" ' +
            'aria-label="Marcar a nota de ' + esc(item.emitente || item.emitenteCnpj) + '">' : "",
        esc(item.clientName),
        '<span title="CNPJ ' + esc(item.emitenteCnpj || "") + " · chave " + esc(item.chave) + '">' +
          esc(item.emitente || "CNPJ " + item.emitenteCnpj) + "</span>",
        item.emissao ? dataCurta(item.emissao) : "-",
        item.valor !== null ? dinheiro(item.valor) : "-",
        prazoXml(item),
        item.ciencia?.situacao === "aceita"
          ? badge("Ciência enviada") + ' <span class="muted">' + dataCurta(item.ciencia.enviadaEm) + "</span>"
          : badge("Só resumo"),
        can("write") && item.ciencia?.situacao !== "aceita"
          ? '<button data-liberar="' + esc(item.id) + '" title="Manifesta a Ciência da Operação desta nota">Liberar XML</button>' : "-"
      ]), "Nenhuma NF-e em resumo" + (filtro.clienteId ? " nesta empresa" : "")) +
    "</div>" +
    '<div class="card"><div class="body"><div class="message info"><strong>Liberar o XML</strong> é manifestar a Ciência da ' +
      "Operação na SEFAZ em nome do cliente: diz que ele tomou conhecimento da nota, sem confirmar nem negar a operação. " +
      "O XML completo chega na captura seguinte. <strong>Prazo do XML:</strong> a distribuição da SEFAZ entrega a nota por " +
      "cerca de 90 dias depois da emissão.</div></div></div>"
  );

  document.querySelector("#form-resumos").addEventListener("change", (evento) => {
    state.filtroResumos = Object.fromEntries(Object.entries(valores(evento.currentTarget)).filter(([, v]) => v));
    render();
  });
  const caixas = () => [...document.querySelectorAll('input[name="resumo"]')];
  const botaoMarcadas = document.querySelector("#liberar-marcadas");
  const atualizar = () => {
    const marcadas = caixas().filter((caixa) => caixa.checked).length;
    if (botaoMarcadas) {
      botaoMarcadas.disabled = !marcadas;
      botaoMarcadas.textContent = marcadas ? "Liberar marcadas (" + marcadas + ")" : "Liberar marcadas";
    }
  };
  for (const caixa of caixas()) caixa.addEventListener("change", atualizar);
  const marcarTodas = (marcar) => {
    for (const caixa of caixas()) caixa.checked = marcar;
    const geral = document.querySelector("#marcar-todas");
    if (geral) geral.checked = marcar;
    atualizar();
  };
  document.querySelector("#marcar-todas")?.addEventListener("change", (evento) => marcarTodas(evento.target.checked));
  document.querySelector("#selecionar-faltam")?.addEventListener("click", () => marcarTodas(true));
  document.querySelector("#limpar-selecao")?.addEventListener("click", () => marcarTodas(false));
  botaoMarcadas?.addEventListener("click", async () => {
    const marcadas = caixas().filter((caixa) => caixa.checked);
    const porEmpresa = new Map();
    for (const caixa of marcadas) porEmpresa.set(caixa.dataset.cliente, [...(porEmpresa.get(caixa.dataset.cliente) || []), caixa.value]);
    const ok = await confirmarAcao("Liberar " + marcadas.length + " NF-e",
      "Manifesta a Ciência da Operação nas " + marcadas.length + " NF-e marcadas, em nome de cada cliente, na SEFAZ. " +
      "O XML completo chega na captura seguinte. Fica na trilha de auditoria com o seu usuário.", "Liberar");
    if (!ok) return;
    botaoMarcadas.disabled = true;
    let aceitas = 0;
    let recusadas = 0;
    try {
      for (const [clienteId, chaves] of porEmpresa) {
        const r = await api("/api/captura/empresas/" + clienteId + "/ciencia-em-lote", { method: "POST", body: JSON.stringify({ chaves }) });
        aceitas += r.aceitas.length;
        recusadas += r.recusadas.length;
      }
      aviso(aceitas + " liberada(s)" + (recusadas ? ", " + recusadas + " recusada(s) pela SEFAZ" : "") +
        ". O XML completo chega na próxima captura.", recusadas ? "warn" : "success");
    } catch (erro) { aviso(erro.message, "error"); }
    render();
  });
  for (const botao of document.querySelectorAll("[data-liberar]")) {
    botao.addEventListener("click", async () => {
      const ok = await confirmarAcao("Liberar o XML desta NF-e",
        "Manifesta a Ciência da Operação desta nota, em nome do cliente, na SEFAZ. O XML completo chega na captura seguinte.",
        "Liberar");
      if (!ok) return;
      botao.disabled = true;
      try {
        const r = await api("/api/pendencias/" + botao.dataset.liberar + "/ciencia", { method: "POST" });
        aviso(r.aceita ? "Ciência registrada. O XML chega na próxima captura." : "A SEFAZ não registrou: " + (r.motivo || ""),
          r.aceita ? "success" : "warn");
      } catch (erro) { aviso(erro.message, "error"); }
      render();
    });
  }
}

// ------------------------------------------------------------ pendencias

function tabelaPendencias(lista, comEmpresa = true) {
  const colunas = [...(comEmpresa ? ["Empresa"] : []), "Tipo", "Referencia", "Detalhe", "Desde", "Situacao", ""];
  return tabela(colunas, lista.map((item) => [
    ...(comEmpresa ? [esc(item.clientName)] : []),
    "<strong>" + esc(ROTULO_PENDENCIA[item.tipo] || item.tipo) + "</strong>" +
      (ROTULO_FONTE[item.fonte] ? '<br><span class="muted">' + ROTULO_FONTE[item.fonte] + "</span>" : ""),
    esc(item.referencia) + (item.chave && item.chave !== item.referencia ? '<br><code title="' + esc(item.chave) + '">' + esc(item.chave.slice(0, 14)) + "...</code>" : ""),
    '<span class="muted">' + esc(item.detalhe || "") + "</span>" + (item.tentativas > 1 ? '<br><span class="muted">' + item.tentativas + " ocorrencia(s)</span>" : ""),
    dataHora(item.criadaEm),
    badge(item.situacao) + (item.resolvidaPor ? '<br><span class="muted">' + esc(item.resolvidaPor) + "</span>" : ""),
    item.situacao === "aberta"
      ? '<div class="actions">' +
        (can("write") && ["NFE", "PONTE"].includes(item.fonte) && item.tipo === "resumo_sem_xml" &&
          String(item.chave || "").slice(20, 22) === "55"
          ? '<button class="primary" data-ciencia="' + item.id + '">Manifestar ciência</button>' : "") +
        (can("import") && !["nota_referenciada_ausente", "lacuna_nsu", "xml_divergente"].includes(item.tipo) &&
          !["NFE", "CTE", "PONTE"].includes(item.fonte)
          ? '<button data-reprocessar="' + item.id + '">Tentar de novo</button>' : "") +
        (can("write") ? '<button data-resolver="' + item.id + '">Resolver</button>' : "") + "</div>"
      : "-"
  ]), "Nenhuma pendencia");
}

function ligarPendencias() {
  for (const botao of document.querySelectorAll("[data-ciencia]")) {
    botao.addEventListener("click", () => {
      const fundo = modal("Manifestar Ciência da Operação",
        '<div class="message warn">A ciencia e registrada na SEFAZ em nome da empresa, com o certificado dela. ' +
        "Ela diz que a empresa tomou conhecimento desta NF-e, sem confirmar nem negar a operacao, e libera o XML " +
        "completo para download. Fica registrada na trilha de auditoria com o seu usuario.</div>" +
        '<div class="form-actions"><button type="button" data-fechar>Cancelar</button>' +
        '<button class="primary" id="confirmar-ciencia">Manifestar e baixar o XML</button></div>');
      fundo.querySelector("#confirmar-ciencia").addEventListener("click", async (evento) => {
        evento.target.disabled = true;
        evento.target.textContent = "Enviando...";
        try {
          const r = await api("/api/pendencias/" + botao.dataset.ciencia + "/ciencia", { method: "POST" });
          fecharModal();
          aviso(r.baixado?.novos ? "Ciencia registrada e XML baixado" :
            "Ciencia registrada" + (r.protocolo ? " (protocolo " + r.protocolo + ")" : "") +
            ". O XML chega na proxima consulta a SEFAZ.", "success");
          render();
        } catch (erro) {
          aviso(erro.message, "error");
          evento.target.disabled = false;
          evento.target.textContent = "Manifestar e baixar o XML";
        }
      });
    });
  }
  for (const botao of document.querySelectorAll("[data-reprocessar]")) {
    botao.addEventListener("click", async () => {
      botao.disabled = true;
      try {
        const r = await api("/api/pendencias/" + botao.dataset.reprocessar + "/reprocessar", { method: "POST" });
        aviso(r.pendencia?.situacao === "resolvida" ? "Resolvida" : "Reprocessado; a pendencia continua aberta", r.pendencia?.situacao === "resolvida" ? "success" : "info");
        render();
      } catch (erro) {
        aviso(erro.message + (erro.dados?.comoResolver ? " " + erro.dados.comoResolver : ""), "error");
        botao.disabled = false;
      }
    });
  }
  for (const botao of document.querySelectorAll("[data-resolver]")) {
    botao.addEventListener("click", () => {
      const fundo = modal("Resolver pendência",
        '<form id="form-resolver" class="form-grid">' +
        '<div class="full message info">Use quando a falta foi tratada fora do sistema (XML obtido com o emitente, ' +
        "arquivo conferido na pasta). A justificativa vai para a trilha de auditoria.</div>" +
        campo("Justificativa (mínimo 10 caracteres)", '<textarea name="justificativa" rows="3" required></textarea>', true) +
        '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
        '<button class="primary" type="submit">Resolver</button></div></form>');
      fundo.querySelector("#form-resolver").addEventListener("submit", async (evento) => {
        evento.preventDefault();
        try {
          await api("/api/pendencias/" + botao.dataset.resolver, {
            method: "PATCH", body: JSON.stringify({ situacao: "resolvida", ...valores(evento.target) })
          });
          fecharModal();
          aviso("Pendencia resolvida", "success");
          render();
        } catch (erro) { aviso(erro.message, "error"); }
      });
    });
  }
}

async function pendencias() {
  titulo("Pendências", "O que ainda falta completar");
  const filtro = state.filtroPendencias || { situacao: "aberta" };
  const consulta = new URLSearchParams(Object.entries(filtro).filter(([, v]) => v)).toString();
  const [dados, lista] = await Promise.all([api("/api/pendencias?" + consulta), api("/api/captura/empresas")]);

  const contagem = {};
  for (const item of dados.pendencias) contagem[item.tipo] = (contagem[item.tipo] || 0) + 1;
  const empresaFiltrada = filtro.clienteId ? lista.find((item) => item.clientId === filtro.clienteId) : null;
  const resumosNfe = dados.pendencias.filter((item) => item.situacao === "aberta" && item.tipo === "resumo_sem_xml" &&
    String(item.chave || item.referencia || "").slice(20, 22) === "55").length;

  conteudo(
    '<div class="card"><div class="body">' +
      '<div class="message info"><strong>O que o sistema consegue provar:</strong> so o que o portal informa. ' +
      "Nota informada sem XML, evento de nota que nao veio e XML corrompido tem chave ou NSU, e voce consegue ir atras. " +
      "NSU pulado e o portal dizendo que ali nao ha documento: aparece como <strong>confirmada</strong>, nao como falta. " +
      "Nota emitida fora do sistema nacional (prefeitura com sistema proprio) nao deixa rastro e nao aparece aqui." +
      "</div>" +
      "</div></div>" +
    '<div class="card"><div class="head"><div><h2>' + dados.pendencias.length + " pendência(s)</h2>" +
      "<p>" + (Object.entries(contagem).map(([tipo, n]) => n + " " + esc((ROTULO_PENDENCIA[tipo] || tipo).toLowerCase())).join(", ") ||
        "nada em aberto") + "</p></div>" +
      '<div class="actions">' +
        (can("write") && empresaFiltrada && resumosNfe
          ? '<button class="primary" id="ciencia-lote">Ciência em lote (' + resumosNfe + ")</button>" : "") +
      "</div></div>" +
      '<form id="form-pend" class="filtros">' +
        '<select name="clienteId" title="Empresa" aria-label="Empresa"' + (filtro.clienteId ? ' class="ativo"' : "") + ">" +
          opcoes(filtro.clienteId, [["", "Empresa"], ...lista.filter((item) => item.configurada).map((item) => [item.clientId, item.name])]) +
        "</select>" +
        '<select name="situacao" title="Situação" aria-label="Situação"' + (filtro.situacao ? ' class="ativo"' : "") + ">" +
          opcoes(filtro.situacao || "", [["aberta", "Abertas"], ["confirmada", "Confirmadas pelo portal"], ["resolvida", "Resolvidas"],
            ["", "Todas as situações"]]) +
        "</select>" +
        '<select name="tipo" title="Tipo" aria-label="Tipo"' + (filtro.tipo ? ' class="ativo"' : "") + ">" +
          opcoes(filtro.tipo, [["", "Tipo"], ...Object.entries(ROTULO_PENDENCIA)]) +
        "</select>" +
      "</form>" +
      tabelaPendencias(dados.pendencias) +
    "</div>"
  );

  // Escolheu, filtrou: sem botao de filtrar.
  document.querySelector("#form-pend").addEventListener("change", (evento) => {
    state.filtroPendencias = valores(evento.currentTarget);
    render();
  });
  document.querySelector("#ciencia-lote")?.addEventListener("click", () =>
    cienciaEmLote({ clientId: empresaFiltrada.clientId, name: empresaFiltrada.name }, resumosNfe));
  ligarPendencias();
}

// ------------------------------------------------------------------ fila

let relogioFila = null;

async function fila() {
  titulo("Fila", "Execuções de captura");
  clearTimeout(relogioFila);
  const dados = await api("/api/tarefas?limite=150");
  const c = dados.contagem;

  conteudo(
    '<div class="grid metrics">' +
      cartao("Rodando", c.executando || 0, "agora") + cartao("Na fila", c.pendente || 0, "esperando a vez") +
      cartao("Concluídas", c.concluida || 0, "nas últimas 150") +
      cartao("Com erro", c.erro || 0, c.erro ? "veja o motivo abaixo" : "nenhuma") + cartao("Canceladas", c.cancelada || 0, "por alguém") +
      cartao("Atualização", (c.executando || c.pendente) ? "Sozinha" : "Parada",
        (c.executando || c.pendente) ? "a cada 3 s" : "nada rodando agora") +
    "</div>" +
    '<div class="card"><div class="head"><div><h2>Execuções</h2><p>Mesma empresa nunca roda duas vezes ao mesmo tempo</p></div></div>' +
      tabela(["Criada", "Empresa", "Origem", "Comp.", "Situação", "Tentativas", "Resultado", ""],
        dados.tarefas.map((item) => [
          dataHora(item.criadaEm), esc(item.clientName), esc(item.origem), competenciaBr(item.competencia),
          badge(item.situacao) + (item.situacao === "pendente" && item.erro ? '<br><span class="muted">nova tentativa ' + dataHora(item.proximaTentativa) + "</span>" : ""),
          item.tentativas + "/" + item.maxTentativas,
          item.resumo && item.situacao === "concluida" ? resumoTarefa(item.resumo) : '<span class="muted">' + esc(item.erro || "-") + "</span>",
          can("import") ? '<div class="actions">' +
            (item.situacao === "pendente" ? '<button data-tarefa="' + item.id + '/antecipar">Agora</button><button data-tarefa="' + item.id + '/cancelar">Cancelar</button>' : "") +
            (item.situacao === "erro" || item.situacao === "cancelada" ? '<button data-tarefa="' + item.id + '/reprocessar">Repetir</button>' : "") + "</div>" : "-"
        ]), "Nenhuma execucao ainda") +
    "</div>"
  );

  for (const botao of document.querySelectorAll("[data-tarefa]")) {
    botao.addEventListener("click", async () => {
      try { await api("/api/tarefas/" + botao.dataset.tarefa, { method: "POST" }); render(); }
      catch (erro) { aviso(erro.message, "error"); }
    });
  }
  if (c.executando || c.pendente) relogioFila = setTimeout(() => state.view === "fila" && render(), 3000);
}

// ---------------------------------------------------------- agendamentos

async function agendamentos() {
  titulo("Agendamentos", "Captura automática");
  // A agenda da PONTE so aparece com a PONTE configurada.
  const [lista, empresasLista, daPonte] = await Promise.all([api("/api/agendamentos"), api("/api/captura/empresas"),
    api("/api/ponte/agenda").catch(() => null)]);
  const horaDe = (item) => String(item.hora).padStart(2, "0") + ":" + String(item.minuto || 0).padStart(2, "0");

  conteudo(
    '<div class="card"><div class="head"><div><h2>Regras ativas</h2>' +
      "<p>Horario de Brasilia. Executar no dia 1 busca o mes anterior, sem ninguem mexer.</p></div>" +
      '<div class="actions">' +
        (can("config") ? '<button id="rodar">Rodar agendador agora</button><button class="primary" id="novo">Novo agendamento</button>' : "") +
      "</div></div>" +
      tabela(["Nome", "Empresas", "Regra", "Situação", ""],
        lista.map((item) => [
          "<strong>" + esc(item.nome) + "</strong>",
          item.clientName ? esc(item.clientName) : "toda a carteira ativa",
          esc(item.descricao),
          badge(item.ativo ? "ativa" : "inativa"),
          can("config") ? '<div class="actions"><button data-alternar="' + item.id + '">' + (item.ativo ? "Pausar" : "Ativar") + "</button>" +
            '<button data-remover="' + item.id + '">Remover</button></div>' : "-"
        ]), "Nenhum agendamento. Sem agendamento, a captura so roda quando alguem pede.") +
    "</div>" +
    (daPonte
      ? '<div class="card"><div class="head"><div><h2>Agenda da PONTE</h2><p>A PONTE busca na SEFAZ e no ambiente nacional ' +
        "nestes horários e guarda lá; o agendamento do NÚCLEO marcado \"só copiar\" traz para cá sem pedir nova busca. " +
        "Até " + (daPonte.maximo || 6) + " horários.</p></div>" +
        '<div class="actions">' + (can("config") ? '<button class="primary" id="nova-agenda-ponte">Novo horário na PONTE</button>' : "") +
        "</div></div>" +
        (daPonte.relogio && !daPonte.relogio.ligado
          ? '<div class="body"><div class="message warn"><strong>O relógio da PONTE está desligado:</strong> os horários ' +
            "abaixo ainda não rodam sozinhos. " + esc(daPonte.relogio.aviso || "Quem cuida da PONTE precisa ligar o relógio dela.") +
            "</div></div>" : "") +
        tabela(["Quando", "Empresas", "Documentos", "Próxima", ""], daPonte.agendas.map((item) => [
          "<strong>" + esc(item.descricao) + "</strong>",
          esc(item.empresa),
          esc((item.documentos || ["nfe", "nfse", "cte"]).map((doc) => ({ nfe: "NF-e", nfse: "NFS-e", cte: "CT-e" })[doc] || doc).join(", ")),
          item.proxima ? dataHora(item.proxima) : "-",
          can("config") ? '<button data-desligar-agenda="' + esc(item.id) + '">Desligar</button>' : "-"
        ]), "Nenhum horário na agenda da PONTE") +
        "</div>"
      : "") +
    '<div class="card"><div class="body"><div class="message info">' +
      "<strong>Revarreduras:</strong> o portal pode publicar uma nota dias depois da emissao. O agendamento mensal " +
      "repete a busca da mesma competencia nos dias que voce escolher (padrao: 5 e 15 dias depois). Como a busca e " +
      "incremental, cada revarredura so traz o que chegou depois.<br><strong>Servidor desligado no horario:</strong> " +
      "a tarefa e criada quando ele voltar, dentro do mesmo mes." +
    "</div></div></div>"
  );

  document.querySelector("#novo")?.addEventListener("click", () => {
    const fundo = modal("Novo agendamento",
      '<form id="form-ag" class="form-grid">' +
      campo("Nome", '<input name="nome" placeholder="Fechamento mensal">') +
      campo("Empresas", '<select name="clientId"><option value="">Toda a carteira ativa</option>' +
        empresasLista.filter((item) => item.ativa).map((item) => '<option value="' + item.clientId + '">' + esc(item.name) + "</option>").join("") + "</select>") +
      campo("Frequência", '<select name="frequencia"><option value="mensal">Mensal (competência anterior)</option>' +
        '<option value="semanal">Semanal (o que houver de novo)</option><option value="diaria">Diária (o que houver de novo)</option></select>') +
      campo("Dia do mês", '<select name="diaMes">' +
        opcoes("1", Array.from({ length: 28 }, (_, i) => [String(i + 1), "Dia " + (i + 1)])) + "</select>") +
      campo("Dia da semana", '<select name="diaSemana">' + ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"].map((d, i) =>
        '<option value="' + i + '"' + (i === 1 ? " selected" : "") + ">" + d + "</option>").join("") + "</select>") +
      campo("Hora (Brasília)", '<select name="hora">' + opcoes("06:00", Array.from({ length: 48 }, (_, i) => {
        const hora = String(Math.floor(i / 2)).padStart(2, "0") + ":" + (i % 2 ? "30" : "00");
        return [hora, hora];
      })) + "</select>") +
      grupoChecks("Revarreduras (dias depois)", [1, 2, 3, 5, 7, 10, 15, 20, 25].map((dias) =>
        '<label><input type="checkbox" name="revarreduras" value="' + dias + '"' + ([5, 15].includes(dias) ? " checked" : "") +
        "> D+" + dias + "</label>").join(""), false) +
      campo("Empresas pela PONTE", '<select name="soCopiar">' + opcoes(daPonte?.agendas?.length ? "true" : "false", [
        ["false", "Pedir nova busca à PONTE"], ["true", "Só copiar o que a agenda da PONTE já buscou"]]) + "</select>", true) +
      '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
      '<button class="primary" type="submit">Criar</button></div></form>');
    fundo.querySelector("#form-ag").addEventListener("submit", async (evento) => {
      evento.preventDefault();
      const d = valores(evento.target);
      const [hora, minuto] = String(d.hora || "06:00").split(":").map(Number);
      try {
        await api("/api/agendamentos", {
          method: "POST",
          body: JSON.stringify({
            nome: d.nome || undefined, clientId: d.clientId || null, frequencia: d.frequencia,
            diaMes: Number(d.diaMes), diaSemana: Number(d.diaSemana), hora, minuto,
            revarreduras: new FormData(evento.target).getAll("revarreduras").map(Number), soCopiar: d.soCopiar === "true"
          })
        });
        fecharModal();
        aviso("Agendamento criado", "success");
        render();
      } catch (erro) { aviso(erro.message, "error"); }
    });
  });
  // Veio do painel da empresa ("Agendar"): abre o novo agendamento ja com ela escolhida.
  if (state.novoAgendamentoPara && document.querySelector("#novo")) {
    const para = state.novoAgendamentoPara;
    state.novoAgendamentoPara = null;
    document.querySelector("#novo").click();
    const seletor = document.querySelector('#form-ag select[name="clientId"]');
    if (seletor) seletor.value = para;
  }
  document.querySelector("#nova-agenda-ponte")?.addEventListener("click", () => {
    const fundo = modal("Novo horário na agenda da PONTE",
      '<form id="form-agenda-ponte" class="form-grid">' +
      '<div class="full message info">A PONTE busca na SEFAZ e no ambiente nacional neste horário e guarda as notas lá. ' +
      "Exemplo: todo dia às 07:00, e o NÚCLEO copia às 09:00 com um agendamento \"só copiar\".</div>" +
      campo("Empresas", '<select name="clientId"><option value="">Toda a carteira</option>' +
        empresasLista.filter((item) => item.ativa && (item.fontes || []).includes("PONTE"))
          .map((item) => '<option value="' + item.clientId + '">' + esc(item.name) + "</option>").join("") + "</select>") +
      campo("Frequência", '<select name="frequencia">' + opcoes("diaria", [["diaria", "Diária"], ["semanal", "Semanal"],
        ["mensal", "Mensal"]]) + "</select>") +
      campo("Hora (Brasília)", '<select name="hora">' + opcoes("07:00", Array.from({ length: 48 }, (_, i) => {
        const hora = String(Math.floor(i / 2)).padStart(2, "0") + ":" + (i % 2 ? "30" : "00");
        return [hora, hora];
      })) + "</select>") +
      campo("Dia da semana (semanal)", '<select name="diaSemana">' + ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta",
        "Sábado"].map((dia, i) => '<option value="' + i + '"' + (i === 1 ? " selected" : "") + ">" + dia + "</option>").join("") + "</select>") +
      campo("Dia do mês (mensal)", '<select name="diaMes">' + opcoes("1", Array.from({ length: 28 }, (_, i) =>
        [String(i + 1), "Dia " + (i + 1)])) + "</select>") +
      grupoChecks("Documentos", [["nfe", "NF-e"], ["nfse", "NFS-e"], ["cte", "CT-e"]].map(([valor, rotulo]) =>
        '<label><input type="checkbox" name="documentos" value="' + valor + '" checked> ' + rotulo + "</label>").join(""), false) +
      '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
      '<button class="primary" type="submit">Criar na PONTE</button></div></form>');
    fundo.querySelector("#form-agenda-ponte").addEventListener("submit", async (evento) => {
      evento.preventDefault();
      const d = valores(evento.target);
      const [hora, minuto] = String(d.hora || "07:00").split(":").map(Number);
      const documentos = new FormData(evento.target).getAll("documentos");
      if (!documentos.length) return aviso("Escolha ao menos um documento", "warn");
      try {
        await api("/api/ponte/agenda", { method: "POST", body: JSON.stringify({ clientId: d.clientId || null, frequencia: d.frequencia,
          hora, minuto, diaSemana: Number(d.diaSemana), diaMes: Number(d.diaMes), documentos }) });
        fecharModal();
        aviso("Horário criado na agenda da PONTE", "success");
        render();
      } catch (erro) { aviso(erro.message, "error"); }
    });
  });
  for (const botao of document.querySelectorAll("[data-desligar-agenda]")) {
    botao.addEventListener("click", async () => {
      const ok = await confirmarAcao("Desligar horário da PONTE", "A PONTE deixa de buscar neste horário. Nada é apagado.", "Desligar");
      if (!ok) return;
      try {
        await api("/api/ponte/agenda/" + encodeURIComponent(botao.dataset.desligarAgenda), { method: "DELETE" });
        aviso("Horário desligado na PONTE", "success");
        render();
      } catch (erro) { aviso(erro.message, "error"); }
    });
  }
  document.querySelector("#rodar")?.addEventListener("click", async () => {
    try {
      const r = await api("/api/agendamentos/rodar", { method: "POST", body: "{}" });
      aviso(r.criadas ? r.criadas + " tarefa(s) criada(s)" : "Nada a criar agora: as regras ainda nao venceram ou ja foram criadas", "success");
    } catch (erro) { aviso(erro.message, "error"); }
  });
  for (const botao of document.querySelectorAll("[data-alternar]")) {
    botao.addEventListener("click", async () => {
      const item = lista.find((ag) => ag.id === botao.dataset.alternar);
      try { await api("/api/agendamentos/" + item.id, { method: "PATCH", body: JSON.stringify({ ativo: !item.ativo }) }); render(); }
      catch (erro) { aviso(erro.message, "error"); }
    });
  }
  for (const botao of document.querySelectorAll("[data-remover]")) {
    botao.addEventListener("click", async () => {
      const ok = await confirmarAcao("Remover agendamento",
        "O agendamento deixa de criar capturas. As capturas ja feitas e o acervo continuam como estao. " +
        "Para so parar por um tempo, use Pausar.", "Remover");
      if (!ok) return;
      try { await api("/api/agendamentos/" + botao.dataset.remover, { method: "DELETE" }); aviso("Agendamento removido", "success"); render(); }
      catch (erro) { aviso(erro.message, "error"); }
    });
  }
}

// ------------------------------------------------------- certificados A1

async function certificadosA1() {
  titulo("Certificados A1", "Cofre de certificados da captura");
  // O cofre da PONTE so aparece com a PONTE configurada; sem ela, a tela segue so com o daqui.
  const [dados, daPonte] = await Promise.all([api("/api/certificados-digitais"), api("/api/ponte/certificados?dias=60").catch(() => null)]);
  const cofre = dados.cofre;

  conteudo(
    (cofre.disponivel
      ? ""
      : '<div class="card"><div class="body"><div class="message danger-text"><strong>Cofre indisponivel.</strong> ' +
        esc(cofre.motivo || "") + " Sem cofre, o sistema recusa guardar certificado: nao grava arquivo nem senha em texto plano." +
        '</div><p class="muted">' + esc(cofre.comoResolver || "") + "</p></div></div>") +
    '<div class="card"><div class="head"><div><h2>Certificados guardados</h2>' +
      "<p>Arquivo e senha cifrados com AES-256-GCM; a chave fica fora do banco</p></div>" +
      (can("config") && cofre.disponivel ? '<button class="primary" id="enviar-pfx">Enviar certificado A1</button>' : "") + "</div>" +
      tabela(["Titular", "CNPJ", "Validade", "Situação", "Usado por", ""],
        dados.certificados.map((item) => [
          "<strong>" + esc(item.titular) + "</strong><br><span class=\"muted\">" + esc(item.emissor || "") + "</span>",
          esc(item.titularCnpj || "-"),
          dataCurta(item.validoDe) + " a " + dataCurta(item.validoAte) + '<br><span class="muted">' +
            (item.diasParaVencer < 0 ? "vencido ha " + Math.abs(item.diasParaVencer) + " dia(s)" : item.diasParaVencer + " dia(s) restantes") + "</span>",
          badge(item.situacao),
          (item.empresas || []).map((emp) => esc(emp.name)).join(", ") || '<span class="muted">nenhuma empresa</span>',
          can("config") && item.ativo ? '<button data-desativar-cert="' + item.id + '">Desativar</button>' : "-"
        ]), "Nenhum certificado no cofre") +
    "</div>" +
    (daPonte
      ? '<div class="card"><div class="head"><div><h2>Cofre da PONTE</h2><p>A1 dos clientes guardados na PONTE SEFAZ: ' +
        "vencendo nos próximos " + daPonte.dias + " dias e clientes sem A1</p></div></div>" +
        tabela(["Empresa", "CNPJ", "Titular", "Validade", "Situação", ""],
          [...daPonte.vencendo.map((item) => [
            "<strong>" + esc(item.nome) + "</strong>", esc(item.empresaCnpj), esc(item.titular || "-"), dataCurta(item.vencimento),
            badge(item.vencido ? "Vencido" : "Vencendo"),
            item.clientId ? '<button data-abrir="' + item.clientId + '">Abrir</button>' : "-"
          ]), ...daPonte.semCertificado.map((item) => [
            "<strong>" + esc(item.nome) + "</strong>", esc(item.empresaCnpj), "-", "-", badge("Pendente"),
            item.clientId ? '<button data-abrir="' + item.clientId + '">Abrir</button>' : "-"
          ])], "Nenhum A1 vencendo na PONTE e nenhum cliente sem A1 lá") +
        "</div>"
      : "") +
    '<div class="card"><div class="body"><div class="message info">' +
      "<strong>So A1 entra na rotina automatica.</strong> A3 (token ou cartao) exige PIN a cada uso, com alguem presente. " +
      "<br><strong>Certificado do Windows:</strong> o .pfx exportado pelo Windows costuma usar um formato antigo (RC2-40), " +
      "e o sistema le esse formato por conta propria. Se aparecer erro de formato legado, o arquivo usa uma cifra mais rara: " +
      "reexporte o certificado em AES-256.<br><strong>Procuracao:</strong> um certificado do escritorio pode atender varias empresas, desde " +
      "que cada uma tenha outorgado procuracao eletronica ao titular." +
    "</div></div></div>"
  );

  for (const botao of document.querySelectorAll("[data-abrir]")) botao.addEventListener("click", () => abrirEmpresa(botao.dataset.abrir));
  document.querySelector("#enviar-pfx")?.addEventListener("click", () => {
    const fundo = modal("Enviar certificado A1",
      '<form id="form-pfx" class="form-grid">' +
      campo("Arquivo .pfx ou .p12", '<input type="file" name="arquivo" accept=".pfx,.p12" required>', true) +
      campo("Senha do certificado", '<input type="password" name="senha" autocomplete="new-password" required>', true) +
      '<div class="full message info">O sistema abre o arquivo com a senha para conferir, le titular, CNPJ e validade, ' +
      "e guarda os dois cifrados. A senha nunca volta para a tela nem vai para a auditoria.</div>" +
      '<div class="form-actions full"><button type="button" data-fechar>Cancelar</button>' +
      '<button class="primary" type="submit">Guardar</button></div></form>');
    fundo.querySelector("#form-pfx").addEventListener("submit", async (evento) => {
      evento.preventDefault();
      const arquivo = evento.target.arquivo.files[0];
      const botao = evento.target.querySelector(".primary");
      botao.disabled = true;
      try {
        const salvo = await api("/api/certificados-digitais", {
          method: "POST",
          body: JSON.stringify({ arquivoBase64: await lerBase64(arquivo), senha: evento.target.senha.value })
        });
        fecharModal();
        aviso(salvo.aviso || ("Certificado de " + salvo.titular + " guardado, valido ate " + dataCurta(salvo.validoAte)), salvo.aviso ? "error" : "success");
        render();
      } catch (erro) {
        aviso(erro.message + (erro.dados?.comoResolver ? " " + erro.dados.comoResolver : ""), "error");
        botao.disabled = false;
      }
    });
  });
  for (const botao of document.querySelectorAll("[data-desativar-cert]")) {
    botao.addEventListener("click", async () => {
      const ok = await confirmarAcao("Desativar certificado",
        "O certificado deixa de ser usado na captura. O arquivo continua guardado no cofre e a trilha de " +
        "auditoria registra quem desativou.", "Desativar");
      if (!ok) return;
      try { await api("/api/certificados-digitais/" + botao.dataset.desativarCert, { method: "DELETE" }); aviso("Certificado desativado", "success"); render(); }
      catch (erro) { aviso(erro.message, "error"); }
    });
  }
}

// ---------------------------------------------------------- agente local

// ------------------------------------------------- pastas pelo navegador
//
// Sem programa instalado: no Chrome ou no Edge do computador do escritorio, o
// contador escolhe a pasta de cada empresa (File System Access API). A escolha
// fica guardada neste navegador (IndexedDB) e a tela grava ali o XML e o PDF
// que faltam, na mesma arrumacao do espelho (ano, mes, documento, emitidas ou
// recebidas, XML ou PDF). Arquivo diferente ja existente nunca e sobrescrito.

const BANCO_PASTAS = "nucleo-pastas";
const pastasSuportadas = () => typeof window.showDirectoryPicker === "function";
let gravandoPastas = null;

function abrirBancoPastas() {
  return new Promise((ok, falha) => {
    const pedido = indexedDB.open(BANCO_PASTAS, 1);
    pedido.onupgradeneeded = () => pedido.result.createObjectStore("pastas");
    pedido.onsuccess = () => ok(pedido.result);
    pedido.onerror = () => falha(pedido.error);
  });
}

async function pastaGuardada(clientId) {
  try {
    const banco = await abrirBancoPastas();
    return await new Promise((ok) => {
      const pedido = banco.transaction("pastas").objectStore("pastas").get(clientId);
      pedido.onsuccess = () => ok(pedido.result || null);
      pedido.onerror = () => ok(null);
    });
  } catch { return null; }
}

async function guardarPasta(clientId, pasta) {
  const banco = await abrirBancoPastas();
  await new Promise((ok, falha) => {
    const transacao = banco.transaction("pastas", "readwrite");
    if (pasta) transacao.objectStore("pastas").put(pasta, clientId);
    else transacao.objectStore("pastas").delete(clientId);
    transacao.oncomplete = ok;
    transacao.onerror = () => falha(transacao.error);
  });
}

/** "granted", "prompt" ou "denied". Pedir a permissao so funciona dentro de um clique. */
async function permissaoDaPasta(pasta, pedir = false) {
  try {
    let estado = await pasta.queryPermission({ mode: "readwrite" });
    if (estado === "prompt" && pedir) estado = await pasta.requestPermission({ mode: "readwrite" });
    return estado;
  } catch { return "denied"; }
}

async function sha256Hex(bytes) {
  const resumo = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(resumo)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Grava em <pasta>/<destino> sem sobrescrever: "gravado", "ja_existia" ou "conflito". */
async function gravarNaPasta(raiz, destino, bytes, sha) {
  const partes = String(destino).split("/").filter(Boolean);
  const nome = partes.pop();
  let pasta = raiz;
  for (const parte of partes) pasta = await pasta.getDirectoryHandle(parte, { create: true });
  let existente = null;
  try { existente = await pasta.getFileHandle(nome); } catch { existente = null; }
  if (existente) {
    const atual = new Uint8Array(await (await existente.getFile()).arrayBuffer());
    return (await sha256Hex(atual)) === sha ? "ja_existia" : "conflito";
  }
  const arquivo = await pasta.getFileHandle(nome, { create: true });
  const escrita = await arquivo.createWritable();
  await escrita.write(bytes);
  await escrita.close();
  return "gravado";
}

/** Uma passada numa empresa: pede a fila, baixa, grava e confirma. */
async function gravarPastaDaEmpresa(clientId, raiz) {
  const saida = { gravado: 0, ja_existia: 0, conflito: 0, erro: 0 };
  for (let rodada = 0; rodada < 20; rodada += 1) {
    const fila = await api("/api/pastas/fila?clienteId=" + encodeURIComponent(clientId) + "&limite=100");
    if (!fila.length) break;
    const resultados = [];
    for (const item of fila) {
      let situacao = "erro";
      let erro = null;
      try {
        const resposta = await fetch("/api/pastas/arquivo/" + item.documentoId + "/" + item.tipoArquivo,
          { headers: { authorization: "Bearer " + state.token } });
        if (!resposta.ok) throw new Error("download recusado (" + resposta.status + ")");
        const bytes = new Uint8Array(await resposta.arrayBuffer());
        if ((await sha256Hex(bytes)) !== item.sha256) throw new Error("arquivo chegou diferente do acervo");
        situacao = await gravarNaPasta(raiz, item.destino, bytes, item.sha256);
      } catch (falha) { erro = falha.message; }
      saida[situacao] += 1;
      resultados.push({ ...item, situacao, erro });
    }
    await api("/api/pastas/confirmar", { method: "POST", body: JSON.stringify({ resultados }) });
    // Erro volta para a fila: nao insiste na mesma passada.
    if (resultados.every((item) => item.situacao === "erro")) break;
  }
  return saida;
}

/** Todas as empresas com pasta escolhida NESTE navegador e com permissao liberada. */
async function gravarPastas({ pedir = false, avisar = false } = {}) {
  if (!pastasSuportadas() || !state.token || !can("export")) return null;
  if (gravandoPastas) return gravandoPastas;
  gravandoPastas = (async () => {
    const total = { gravado: 0, ja_existia: 0, conflito: 0, erro: 0, semPermissao: 0 };
    const empresas = (await api("/api/pastas")).filter((item) => item.modo === "navegador");
    for (const empresa of empresas) {
      const raiz = await pastaGuardada(empresa.clientId);
      if (!raiz) continue;
      if (await permissaoDaPasta(raiz, pedir) !== "granted") { total.semPermissao += 1; continue; }
      const r = await gravarPastaDaEmpresa(empresa.clientId, raiz);
      for (const chave of Object.keys(r)) total[chave] += r[chave];
    }
    if (avisar || total.gravado || total.conflito) {
      aviso(total.gravado + " arquivo(s) gravado(s) nas pastas" + (total.conflito ? ", " + total.conflito + " conflito(s)" : "") +
        (total.semPermissao ? "; " + total.semPermissao + " pasta(s) esperando liberar" : ""), total.conflito ? "error" : "success");
    }
    return total;
  })();
  try { return await gravandoPastas; } catch (erro) { if (avisar) aviso(erro.message, "error"); return null; }
  finally { gravandoPastas = null; }
}

/** Pasta da empresa para mostrar: a do navegador pelo nome, a do servidor ou do programa pelo caminho. */
function rotuloPasta(pasta) {
  return String(pasta).startsWith("navegador:")
    ? esc(pasta.slice(10)) + ' <span class="muted">· escolhida no navegador</span>'
    : "<code>" + esc(pasta) + "</code>";
}

function cartaoPastasNavegador(lista, locais) {
  const suportado = pastasSuportadas();
  const estadoLocal = (item) => {
    const local = locais.get(item.clientId);
    if (item.modo !== "navegador") return item.modo === "agente" ? '<span class="muted">pelo programa</span>' : '<span class="muted">sem pasta</span>';
    if (!local) return '<span class="muted">escolhida em outro computador</span>';
    return local.permissao === "granted" ? badge("Liberada") : badge("Pendente");
  };
  return '<div class="card"><div class="head"><div><h2>Pastas neste computador</h2>' +
      "<p>Escolha a pasta de cada empresa: o XML e o PDF vão para lá sozinhos, sem programa instalado</p></div>" +
      '<div class="actions">' + (suportado && can("export") ? '<button class="primary" id="gravar-pastas">Gravar agora</button>' : "") + "</div></div>" +
    (suportado
      ? '<div class="body"><div class="message info">Funciona no Chrome ou no Edge deste computador, com o NÚCLEO aberto: ' +
        "grava na hora e de novo a cada 5 minutos. Dentro da pasta da empresa, a arrumação é ano, mês, documento, emitidas ou " +
        "recebidas, XML ou PDF. Arquivo diferente que já estiver lá nunca é sobrescrito: vira pendência para você olhar.</div></div>"
      : '<div class="body"><div class="message warn">Este navegador não deixa o site gravar em pastas do computador. ' +
        "Abra o NÚCLEO no Chrome ou no Edge, no computador do escritório.</div></div>") +
    tabela(["Empresa", "Pasta", "Neste computador", "A gravar", "Gravados", ""],
      lista.map((item) => [
        "<strong>" + esc(item.nome) + "</strong>",
        item.pasta ? esc(item.pasta) : '<span class="muted">nenhuma</span>',
        estadoLocal(item),
        item.pendentes ? "<strong>" + item.pendentes + "</strong>" : "0",
        item.gravados + (item.conflitos ? ' <span class="error-count">' + item.conflitos + " conflito(s)</span>" : ""),
        suportado && can("export")
          ? '<div class="actions"><button data-escolher-pasta="' + item.clientId + '">' + (item.modo === "navegador" && locais.get(item.clientId)
              ? "Trocar" : "Escolher pasta") + "</button>" +
            (item.modo === "navegador" && locais.get(item.clientId)?.permissao !== "granted" && locais.get(item.clientId)
              ? '<button data-liberar-pasta="' + item.clientId + '">Liberar</button>' : "") +
            (item.modo === "navegador" ? '<button data-tirar-pasta="' + item.clientId + '">Tirar</button>' : "") + "</div>"
          : "-"
      ]), "Nenhuma empresa configurada na captura") +
  "</div>";
}

function ligarPastasNavegador(lista) {
  document.querySelector("#gravar-pastas")?.addEventListener("click", async (evento) => {
    evento.target.disabled = true;
    await gravarPastas({ pedir: true, avisar: true });
    render();
  });
  for (const botao of document.querySelectorAll("[data-escolher-pasta]")) {
    botao.addEventListener("click", async () => {
      const empresa = lista.find((item) => item.clientId === botao.dataset.escolherPasta);
      let raiz;
      try {
        raiz = await window.showDirectoryPicker({ id: "nucleo-" + empresa.clientId.slice(0, 20), mode: "readwrite" });
      } catch { return; }
      try {
        await guardarPasta(empresa.clientId, raiz);
        await api("/api/pastas/empresas/" + empresa.clientId, { method: "PUT", body: JSON.stringify({ nome: raiz.name }) });
        aviso("Pasta de " + empresa.nome + ": " + raiz.name + ". Gravando...", "success");
        await gravarPastas({ avisar: true });
        render();
      } catch (erro) { aviso(erro.message, "error"); }
    });
  }
  for (const botao of document.querySelectorAll("[data-liberar-pasta]")) {
    botao.addEventListener("click", async () => {
      const raiz = await pastaGuardada(botao.dataset.liberarPasta);
      if (raiz && await permissaoDaPasta(raiz, true) === "granted") await gravarPastas({ avisar: true });
      render();
    });
  }
  for (const botao of document.querySelectorAll("[data-tirar-pasta]")) {
    botao.addEventListener("click", async () => {
      const empresa = lista.find((item) => item.clientId === botao.dataset.tirarPasta);
      const ok = await confirmarAcao("Tirar a pasta", "As notas de " + esc(empresa.nome) + " deixam de ir para a pasta " +
        esc(empresa.pasta) + ". Nada do que já foi gravado lá é apagado.", "Tirar");
      if (!ok) return;
      try {
        await guardarPasta(empresa.clientId, null);
        await api("/api/pastas/empresas/" + empresa.clientId, { method: "PUT", body: JSON.stringify({ nome: "" }) });
        render();
      } catch (erro) { aviso(erro.message, "error"); }
    });
  }
}

async function agente() {
  titulo("Pastas", "XML e PDF na pasta de cada empresa");
  const [tokens, lista] = await Promise.all([
    can("config") ? api("/api/agente/tokens") : Promise.resolve([]),
    api("/api/pastas")
  ]);
  const servidor = location.origin;
  const locais = new Map();
  if (pastasSuportadas()) {
    for (const item of lista) {
      const raiz = await pastaGuardada(item.clientId);
      if (raiz) locais.set(item.clientId, { nome: raiz.name, permissao: await permissaoDaPasta(raiz) });
    }
  }

  conteudo(
    cartaoPastasNavegador(lista, locais) +
    '<div class="card"><div class="head"><div><h2>Programa no computador</h2><p>Opcional: para gravar mesmo com o NÚCLEO fechado</p></div></div>' +
    '<div class="body"><div class="message info">' +
      "Quando o servidor roda no Render ele nao enxerga o disco do seu computador. O agente e um programa pequeno que " +
      "roda no computador do escritorio: pergunta ao servidor o que falta gravar, baixa, confere o SHA-256 e grava na " +
      "pasta de cada cliente. Arquivo diferente ja existente nunca e sobrescrito." +
    "</div>" +
    "<p><strong>Como instalar no computador do escritorio</strong> (precisa do Node 22.5 ou mais novo):</p>" +
    '<pre style="background:#f9fafc;border:1px solid var(--line);border-radius:6px;padding:12px;overflow:auto">' +
      esc("cd \"C:\\caminho\\do\\projeto\"\n" +
      "$env:NUCLEO_SERVIDOR = \"" + servidor + "\"\n" +
      "$env:NUCLEO_AGENTE_TOKEN = \"<token gerado abaixo>\"\n" +
      "npm run agente") + "</pre>" +
    '<p class="muted">Ele roda a cada 5 minutos. Para uma passada so: <code>npm run agente -- --uma-vez</code>. ' +
    "Para iniciar com o Windows, crie uma tarefa no Agendador de Tarefas apontando para esse comando.</p>" +
    "</div></div>" +
    (can("config")
      ? '<div class="card"><div class="head"><div><h2>Tokens</h2><p>Cada computador com o seu</p></div>' +
        '<button class="primary" id="novo-token">Gerar token</button></div>' +
        tabela(["Nome", "Criado", "Último uso", "Situação", ""],
          tokens.map((item) => [
            esc(item.nome), dataHora(item.criadoEm) + '<br><span class="muted">' + esc(item.criadoPor || "") + "</span>",
            item.ultimoUso ? dataHora(item.ultimoUso) : '<span class="muted">nunca</span>',
            badge(item.ativo ? "ativa" : "inativa"),
            item.ativo ? '<button data-revogar="' + item.id + '">Revogar</button>' : "-"
          ]), "Nenhum token") + "</div>"
      : "")
  );

  ligarPastasNavegador(lista);
  document.querySelector("#novo-token")?.addEventListener("click", async () => {
    try {
      const criado = await api("/api/agente/tokens", { method: "POST", body: JSON.stringify({ nome: "Computador do escritorio" }) });
      const fundo = modal("Token do agente",
        '<div class="message warn"><strong>Copie agora.</strong> O token nao sera mostrado de novo.</div>' +
        '<pre id="token-agente" style="background:#f9fafc;border:1px solid var(--line);border-radius:6px;padding:14px;overflow:auto">' + esc(criado.token) + "</pre>" +
        '<div class="form-actions"><button class="primary" type="button" id="copiar-token">Copiar token</button></div>');
      fundo.querySelector("#copiar-token").addEventListener("click", async (evento) => {
        try {
          await navigator.clipboard.writeText(criado.token);
          evento.target.textContent = "Copiado";
        } catch {
          // Sem permissao de area de transferencia: seleciona para o Ctrl+C.
          getSelection().selectAllChildren(fundo.querySelector("#token-agente"));
          evento.target.textContent = "Selecionado: aperte Ctrl+C";
        }
      });
      render();
    } catch (erro) { aviso(erro.message, "error"); }
  });
  for (const botao of document.querySelectorAll("[data-revogar]")) {
    botao.addEventListener("click", async () => {
      const ok = await confirmarAcao("Revogar token do agente",
        "O computador que usa este token para de gravar nas pastas dos clientes ate receber um token novo.", "Revogar");
      if (!ok) return;
      try { await api("/api/agente/tokens/" + botao.dataset.revogar, { method: "DELETE" }); aviso("Token revogado", "success"); render(); }
      catch (erro) { aviso(erro.message, "error"); }
    });
  }
}


// -------------------------------------------------------------------- inicio

carregarMarca().finally(render);

// Pastas escolhidas neste navegador: grava logo depois de entrar e a cada 5 minutos, com o NÚCLEO aberto.
setTimeout(() => gravarPastas(), 20_000);
setInterval(() => gravarPastas(), 5 * 60_000);
