// Clientes HTTP de SIEG, Dominio (Onvio API) e Acessorias, pelas APIs oficiais.
//
// SIEG (integracoes.sieg.com/clientes-sieg/docs, base https://api.sieg.com):
//   - POST /api/v1/create-jwt com X-Client-Id e X-Secret-Key (credenciais do
//     sistema parceiro, dadas pela SIEG no cadastro de parceiro) -> { Token },
//     valido por 24 h e reutilizado ate vencer;
//   - toda chamada leva Authorization: Bearer {jwt} e X-API-Key (a chave que o
//     escritorio gera em app.sieg.com > Minha conta > Integracoes API SIEG);
//   - baixar-xmls: TipoXml (1 NF-e, 2 CT-e, 3 NFS-e, 4 NFC-e), Take ate 50,
//     Skip, DataEmissaoInicio/Fim e o CNPJ pelo papel; 2 requisicoes por minuto
//     por API Key (429 acima disso);
//   - send-xml: { Xml: base64 } -> { isSuccess, errorMessage }; 409 = empresa
//     invalida no SIEG.
// A documentacao diverge sobre a resposta do download (ZIP em base64 ou lista
// em "data"): xmlsDaResposta aceita as duas formas.
//
// Dominio (suporte.dominioatendimento.com, solucao 8476 "Integracao API para ERPs"):
//   - token: POST https://auth.thomsonreuters.com/oauth/token, client_credentials
//     com o client_id e o client_secret dados pela Dominio ao ERP homologado,
//     audience fixa; vale 24 h e deve ser pedido UMA vez por dia (acima de 40
//     pedidos a integracao e bloqueada): o token fica guardado no cofre;
//   - a chave que o contador gera por CNPJ (Onvio Gestao > API > Chave) e
//     conferida em activation/info e trocada pela integrationKey em
//     activation/enable;
//   - envio: POST /dominio/invoice/v3/batches, multipart com file[] (XML) e
//     query {"boxeFile": false}; consulta: GET /dominio/invoice/v3/batches/{id}.
//
// Acessorias (api.acessorias.com/documentation):
//   - Authorization: Bearer <API Token> (engrenagem > API Token); 100
//     requisicoes por minuto, 429 sem corpo acima disso;
//   - erro de negocio volta com HTTP 200 e { "Erro": "..." }: o corpo e
//     conferido sempre, nao so o status;
//   - companies (20 por pagina), deliveries (50 por pagina, DtInitial e DtFinal
//     obrigatorios) e econtinuo (PDF de guia, o robo da baixa na entrega).

import { isZip, extractXml } from "./zip.mjs";

export const SIEG_PRODUCAO = "https://api.sieg.com";
export const DOMINIO_AUTH = "https://auth.thomsonreuters.com/oauth/token";
export const DOMINIO_API = "https://api.onvio.com.br/dominio";
export const DOMINIO_AUDIENCE = "409f91f6-dc17-44c8-a5d8-e0a1bafd8b67";
export const ACESSORIAS_PRODUCAO = "https://api.acessorias.com";

export const TIPO_XML_SIEG = { "NF-e": 1, "CT-e": 2, "NFS-e": 3, "NFC-e": 4 };

/** Em quais campos de CNPJ a empresa aparece em cada documento, no filtro do SIEG. */
export const PAPEIS_SIEG = {
  "NF-e": ["CnpjEmit", "CnpjDest"],
  "NFC-e": ["CnpjEmit"],
  "CT-e": ["CnpjEmit", "CnpjTom", "CnpjDest", "CnpjRem"],
  "NFS-e": ["CnpjEmit", "CnpjTom"]
};

export class ErroIntegracao extends Error {
  constructor(mensagem, { status = null, autenticacao = false, transitorio = false, definitivo = false } = {}) {
    super(mensagem);
    this.name = "ErroIntegracao";
    this.status = status;
    this.autenticacao = autenticacao;
    this.transitorio = transitorio;
    this.definitivo = definitivo || autenticacao;
  }
}

const esperar = (ms) => new Promise((fim) => setTimeout(fim, ms));
const DIA_MS = 24 * 3600_000;

/** Mensagem legivel de uma resposta de erro, qualquer que seja o formato. */
function mensagemDe(dados) {
  if (!dados) return "";
  if (typeof dados === "string") return dados.slice(0, 300);
  if (Array.isArray(dados.Mensagens)) return dados.Mensagens.join("; ");
  if (Array.isArray(dados.Erros)) return dados.Erros.map((e) => e.Descricao || e.message || JSON.stringify(e)).join("; ");
  return String(dados.errorMessage || dados.message || dados.Message || dados.Erro || dados.error_description ||
    dados.error || dados.title || JSON.stringify(dados).slice(0, 300));
}

/**
 * Uma chamada HTTP com nova tentativa no que e passageiro (rede, 429, 502, 503,
 * 504), respeitando o Retry-After. Devolve { status, dados } com o corpo ja lido.
 */
async function pedir(url, { metodo = "GET", cabecalhos = {}, corpo, tentativas = 3, esperaMs = 1000, dormir = esperar,
  nome = "servico", limiteEsperaMs = 120_000 } = {}) {
  for (let tentativa = 1; ; tentativa += 1) {
    let resposta;
    try {
      resposta = await fetch(url, { method: metodo, headers: cabecalhos, body: corpo, signal: AbortSignal.timeout(90_000) });
    } catch (erro) {
      if (tentativa < tentativas) { await dormir(esperaMs * tentativa); continue; }
      throw new ErroIntegracao(nome + " nao respondeu: " + (erro.cause?.message || erro.message), { transitorio: true });
    }
    if ([429, 502, 503, 504].includes(resposta.status) && tentativa < tentativas) {
      await resposta.arrayBuffer().catch(() => null);
      const pedido = Number(resposta.headers.get("retry-after"));
      await dormir(Math.min(Number.isFinite(pedido) && pedido > 0 ? pedido * 1000 : esperaMs * 2 ** (tentativa - 1), limiteEsperaMs));
      continue;
    }
    const texto = await resposta.text();
    let dados = null;
    try { dados = texto ? JSON.parse(texto) : null; } catch { dados = texto; }
    return { status: resposta.status, dados };
  }
}

/** CNPJ com pontuacao, como a Acessorias usa no identificador. */
export function cnpjFormatado(cnpj) {
  const d = String(cnpj || "").replace(/\D/g, "");
  return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : d;
}

/**
 * Os XML de uma resposta de download do SIEG, qualquer que seja a forma: XML
 * em texto, XML em base64, ZIP em base64, numa lista solta ou em "data".
 */
export function xmlsDaResposta(dados) {
  const saida = [];
  const visitar = (valor) => {
    if (valor === null || valor === undefined) return;
    if (Array.isArray(valor)) { for (const item of valor) visitar(item); return; }
    if (typeof valor === "object") {
      if (valor.success === false || valor.isFailure === true || valor.Status === "Erro") {
        throw new ErroIntegracao("SIEG: " + mensagemDe(valor));
      }
      for (const chave of ["data", "Data", "xmls", "Xmls", "XMLs", "Xml", "xml", "XmlBase64", "Arquivo", "arquivo", "Conteudo"]) {
        if (chave in valor) visitar(valor[chave]);
      }
      return;
    }
    if (typeof valor !== "string") return;
    const texto = valor.trim();
    if (!texto) return;
    if (texto.startsWith("<")) { saida.push(Buffer.from(texto, "utf8")); return; }
    const bytes = Buffer.from(texto, "base64");
    if (isZip(bytes)) {
      for (const item of extractXml(bytes)) saida.push(Buffer.from(item.content, "utf8"));
      return;
    }
    const xml = bytes.toString("utf8").replace(/^﻿/, "").trimStart();
    if (xml.startsWith("<")) saida.push(Buffer.from(xml, "utf8"));
  };
  visitar(dados);
  return saida;
}

// ---------------------------------------------------------------------- SIEG

export class ClienteSieg {
  constructor({ base = SIEG_PRODUCAO, clientId, secretKey, apiKey, intervaloMs = 31_000, dormir = esperar, agora = Date.now,
    tokenGuardado = null, guardarToken = null } = {}) {
    this.base = String(base).replace(/\/+$/, "");
    this.clientId = clientId;
    this.secretKey = secretKey;
    this.apiKey = apiKey;
    this.intervaloMs = intervaloMs;
    this.dormir = dormir;
    this.agora = agora;
    this.token = tokenGuardado && tokenGuardado.expira > agora() ? tokenGuardado : null;
    this.guardarToken = guardarToken;
    this.ultimoDownload = 0;
    this.chamadas = 0;
  }

  async jwt(renovar = false) {
    if (!renovar && this.token && this.token.expira > this.agora()) return this.token.valor;
    if (!this.clientId || !this.secretKey) {
      throw new ErroIntegracao("SIEG: faltam o ClientId e a SecretKey do sistema parceiro", { definitivo: true });
    }
    const r = await pedir(this.base + "/api/v1/create-jwt", {
      metodo: "POST", cabecalhos: { "X-Client-Id": this.clientId, "X-Secret-Key": this.secretKey, accept: "application/json" },
      tentativas: 2, dormir: this.dormir, nome: "SIEG"
    });
    if (r.status === 401 || r.status === 403) {
      throw new ErroIntegracao("SIEG recusou o ClientId e a SecretKey (" + r.status + "): confira as credenciais do cadastro de parceiro",
        { status: r.status, autenticacao: true });
    }
    const valor = r.dados?.Token || r.dados?.token;
    if (r.status >= 400 || !valor) throw new ErroIntegracao("SIEG nao gerou o token (" + r.status + "): " + mensagemDe(r.dados), { status: r.status });
    // Vale 24 h; renova uma hora antes para nao vencer no meio de um lote.
    this.token = { valor, expira: this.agora() + DIA_MS - 3600_000 };
    this.guardarToken?.(this.token);
    return valor;
  }

  async requisitar(caminho, corpo, { download = false } = {}) {
    if (!this.apiKey) throw new ErroIntegracao("SIEG: falta a API Key do escritorio", { definitivo: true });
    if (download) {
      // 2 por minuto por API Key: espera o intervalo desde o ultimo download.
      const falta = this.ultimoDownload + this.intervaloMs - this.agora();
      if (falta > 0) await this.dormir(falta);
      this.ultimoDownload = this.agora();
    }
    for (let vez = 0; vez < 2; vez += 1) {
      const token = await this.jwt(vez > 0);
      this.chamadas += 1;
      const r = await pedir(this.base + caminho, {
        metodo: "POST", corpo: JSON.stringify(corpo), tentativas: 3, esperaMs: Math.max(this.intervaloMs, 1), dormir: this.dormir,
        nome: "SIEG", cabecalhos: { authorization: "Bearer " + token, "X-API-Key": this.apiKey,
          "content-type": "application/json", accept: "application/json" }
      });
      if (r.status === 401 && vez === 0) continue;
      if (r.status === 401 || r.status === 403) {
        throw new ErroIntegracao("SIEG recusou a API Key (" + r.status + "): gere outra em Minha conta > Integracoes API SIEG",
          { status: r.status, autenticacao: true });
      }
      if (r.status === 404) return null;
      if (r.status === 429) throw new ErroIntegracao("SIEG: limite de requisicoes atingido; tente de novo em alguns minutos", { status: 429, transitorio: true });
      if (r.status === 409) throw new ErroIntegracao("SIEG: empresa invalida no SIEG (409). Cadastre o CNPJ no SIEG.", { status: 409 });
      if (r.status >= 400) throw new ErroIntegracao("SIEG respondeu " + r.status + ": " + mensagemDe(r.dados), { status: r.status });
      return r.dados;
    }
    return null;
  }

  /** Uma pagina de XML (ate 50) de um tipo, pelo CNPJ num papel, entre duas datas AAAA-MM-DD. */
  async baixarXmls({ tipo, campoCnpj, cnpj, de, ate, skip = 0, take = 50, eventos = false }) {
    if (!TIPO_XML_SIEG[tipo]) throw new ErroIntegracao("SIEG: tipo de documento sem codigo: " + tipo, { definitivo: true });
    const dados = await this.requisitar("/api/v1/baixar-xmls", {
      TipoXml: TIPO_XML_SIEG[tipo], Take: take, Skip: skip, DataEmissaoInicio: de, DataEmissaoFim: ate,
      [campoCnpj]: String(cnpj).replace(/\D/g, ""), BaixarEventos: eventos
    }, { download: true });
    return xmlsDaResposta(dados);
  }

  contar({ cnpj = null, campoCnpj = "CnpjEmit", de, ate }) {
    return this.requisitar("/api/v1/contar-xmls", {
      DataEmissaoInicio: de, DataEmissaoFim: ate, ...(cnpj ? { [campoCnpj]: String(cnpj).replace(/\D/g, "") } : {})
    });
  }

  /** Manda um XML para o cofre do SIEG. Devolve { ok, mensagem }. */
  async enviarXml(xml) {
    try {
      const dados = await this.requisitar("/api/v1/send-xml", { Xml: Buffer.from(xml).toString("base64") });
      const ok = dados?.isSuccess !== false && dados?.isFailure !== true;
      return { ok, mensagem: ok ? "" : mensagemDe(dados) };
    } catch (erro) {
      if (erro.autenticacao || erro.transitorio) throw erro;
      return { ok: false, mensagem: erro.message };
    }
  }
}

// ------------------------------------------------------------------- Dominio

export class ClienteDominio {
  constructor({ authUrl = DOMINIO_AUTH, base = DOMINIO_API, clientId, clientSecret, agora = Date.now, dormir = esperar,
    tokenGuardado = null, guardarToken = null } = {}) {
    this.authUrl = authUrl;
    this.base = String(base).replace(/\/+$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.agora = agora;
    this.dormir = dormir;
    this.token = tokenGuardado && tokenGuardado.expira > agora() ? tokenGuardado : null;
    this.guardarToken = guardarToken;
  }

  /** Token do ERP: um por dia, o mesmo para todos os clientes. */
  async accessToken() {
    if (this.token && this.token.expira > this.agora()) return this.token.valor;
    if (!this.clientId || !this.clientSecret) {
      throw new ErroIntegracao("Dominio: faltam o client_id e o client_secret dados pela Dominio na homologacao", { definitivo: true });
    }
    const corpo = new URLSearchParams({ grant_type: "client_credentials", client_id: this.clientId,
      client_secret: this.clientSecret, audience: DOMINIO_AUDIENCE }).toString();
    const r = await pedir(this.authUrl, {
      metodo: "POST", corpo, tentativas: 2, dormir: this.dormir, nome: "Dominio",
      cabecalhos: { authorization: "Basic " + Buffer.from(this.clientId + ":" + this.clientSecret).toString("base64"),
        "content-type": "application/x-www-form-urlencoded", accept: "application/json" }
    });
    if (r.status === 401 || r.status === 403) {
      throw new ErroIntegracao("Dominio recusou o client_id e o client_secret (" + r.status + "): " + mensagemDe(r.dados),
        { status: r.status, autenticacao: true });
    }
    const valor = r.dados?.access_token;
    if (r.status >= 400 || !valor) throw new ErroIntegracao("Dominio nao gerou o token (" + r.status + "): " + mensagemDe(r.dados), { status: r.status });
    const segundos = Math.min(Number(r.dados.expires_in) || 86_400, 86_400);
    this.token = { valor, expira: this.agora() + segundos * 1000 - 10 * 60_000 };
    this.guardarToken?.(this.token);
    return valor;
  }

  async chamar(metodo, caminho, chave, corpo = undefined, extra = {}) {
    const token = await this.accessToken();
    const r = await pedir(this.base + caminho, {
      metodo, corpo, tentativas: 3, dormir: this.dormir, nome: "Dominio",
      cabecalhos: { authorization: "Bearer " + token, "x-integration-key": chave, accept: "application/json", ...extra }
    });
    if (r.status === 401 || r.status === 403) {
      throw new ErroIntegracao("Dominio recusou a chave desta empresa (" + r.status + "): " + mensagemDe(r.dados),
        { status: r.status, autenticacao: true });
    }
    if (r.status >= 400) throw new ErroIntegracao("Dominio respondeu " + r.status + ": " + mensagemDe(r.dados), { status: r.status });
    return r.dados;
  }

  /** Quem e o dono da chave do contador: escritorio, cliente e CNPJ. */
  infoDaChave(chaveContador) {
    return this.chamar("GET", "/integration/v1/activation/info", chaveContador);
  }

  /** Troca a chave do contador pela integrationKey, a usada no envio. */
  async ativar(chaveContador) {
    const dados = await this.chamar("POST", "/integration/v1/activation/enable", chaveContador);
    const chave = typeof dados === "string" ? dados : dados?.integrationKey || dados?.IntegrationKey || dados?.integration_key;
    if (!chave) throw new ErroIntegracao("Dominio nao devolveu a integrationKey: " + mensagemDe(dados));
    return { integrationKey: chave, resposta: dados };
  }

  /** Um lote de XML. Devolve { id, resposta }. */
  async enviarLote(integrationKey, arquivos, { boxe = false } = {}) {
    const form = new FormData();
    for (const arquivo of arquivos) form.append("file[]", new Blob([arquivo.bytes], { type: "application/xml" }), arquivo.nome);
    form.append("query", new Blob([JSON.stringify({ boxeFile: Boolean(boxe) })], { type: "application/json" }));
    const dados = await this.chamar("POST", "/invoice/v3/batches", integrationKey, form);
    return { id: dados?.id || dados?.Id || dados?.batchId || dados?.loteId || null, resposta: dados };
  }

  consultarLote(integrationKey, id) {
    return this.chamar("GET", "/invoice/v3/batches/" + encodeURIComponent(id), integrationKey);
  }
}

/** Situacao de um lote do Dominio a partir da resposta da consulta. */
export function situacaoDoLote(resposta) {
  const texto = JSON.stringify(resposta || "").toLowerCase();
  if (/armazenado|processado|sucesso|success|stored|completed/.test(texto)) return "processado";
  if (/erro|error|rejeit|falha|invalid/.test(texto)) return "erro";
  return "aguardando";
}

// ---------------------------------------------------------------- Acessorias

const SEM_REGISTRO = /nenhum|n[aã]o (foi |foram )?encontrad|sem registro/i;

export class ClienteAcessorias {
  constructor({ base = ACESSORIAS_PRODUCAO, token, esperaMs = 2000, dormir = esperar } = {}) {
    this.base = String(base).replace(/\/+$/, "");
    this.tokenApi = token;
    this.esperaMs = esperaMs;
    this.dormir = dormir;
  }

  async requisitar(metodo, caminho, corpo) {
    if (!this.tokenApi) throw new ErroIntegracao("Acessorias: falta o API Token", { definitivo: true });
    const r = await pedir(this.base + caminho, {
      metodo, corpo, tentativas: 3, esperaMs: this.esperaMs, dormir: this.dormir, nome: "Acessorias",
      cabecalhos: { authorization: "Bearer " + this.tokenApi, accept: "application/json" }
    });
    if (r.status === 401 || r.status === 403) {
      throw new ErroIntegracao("Acessorias recusou o API Token (" + r.status + "): gere outro na engrenagem > API Token",
        { status: r.status, autenticacao: true });
    }
    if (r.status === 404 || r.status === 204) return null;
    if (r.status === 429) throw new ErroIntegracao("Acessorias: limite de 100 requisicoes por minuto; tente em 1 minuto", { status: 429, transitorio: true });
    if (r.status >= 400) throw new ErroIntegracao("Acessorias respondeu " + r.status + ": " + mensagemDe(r.dados), { status: r.status });
    if (r.dados && typeof r.dados === "object" && !Array.isArray(r.dados) && r.dados.Erro) {
      if (SEM_REGISTRO.test(r.dados.Erro)) return null;
      throw new ErroIntegracao("Acessorias: " + r.dados.Erro);
    }
    return r.dados;
  }

  /** Uma pagina (20) de empresas; com obrigacoes, o resumo de entregas de cada uma. */
  async empresas(pagina = 1, { obrigacoes = false } = {}) {
    const dados = await this.requisitar("GET", "/companies/ListAll/?" + (obrigacoes ? "obligations&" : "") + "Pagina=" + pagina);
    return Array.isArray(dados) ? dados : dados ? [dados] : [];
  }

  async todasAsEmpresas({ obrigacoes = false, maxPaginas = 100 } = {}) {
    const todas = [];
    for (let pagina = 1; pagina <= maxPaginas; pagina += 1) {
      const lista = await this.empresas(pagina, { obrigacoes });
      todas.push(...lista);
      if (lista.length < 20) break;
    }
    return todas;
  }

  empresa(cnpj, { obrigacoes = true } = {}) {
    return this.requisitar("GET", "/companies/" + cnpjFormatado(cnpj) + "/" + (obrigacoes ? "?obligations" : ""));
  }

  /** Entregas (obrigacoes e tarefas) da empresa com prazo entre duas datas AAAA-MM-DD. */
  async entregas(cnpj, { de, ate, situacao = null, maxPaginas = 20 } = {}) {
    const todas = [];
    for (let pagina = 1; pagina <= maxPaginas; pagina += 1) {
      const dados = await this.requisitar("GET", "/deliveries/" + cnpjFormatado(cnpj) + "/?DtInitial=" + de + "&DtFinal=" + ate +
        (situacao ? "&situation=" + situacao : "") + "&config&Pagina=" + pagina);
      const empresas = Array.isArray(dados) ? dados : dados ? [dados] : [];
      const daPagina = empresas.flatMap((item) => item.Entregas || []);
      todas.push(...daPagina);
      if (daPagina.length < 50) break;
    }
    return todas;
  }

  /** Manda o PDF de uma guia para o robo e-Continuo. Devolve { ok, mensagem, pasta }. */
  async enviarGuia({ nome, bytes }) {
    const form = new FormData();
    form.append("arquivo", new Blob([bytes], { type: "application/pdf" }), nome);
    try {
      const dados = await this.requisitar("POST", "/econtinuo", form);
      return { ok: Boolean(dados?.msg), mensagem: dados?.msg || mensagemDe(dados) || "sem resposta", pasta: dados?.pathFolder || null };
    } catch (erro) {
      if (erro.autenticacao || erro.transitorio) throw erro;
      return { ok: false, mensagem: erro.message, pasta: null };
    }
  }
}

/** Regime da Acessorias no rotulo do NUCLEO, quando ha correspondencia. */
export function regimeDaAcessorias(regime) {
  const texto = String(regime || "").toLowerCase();
  if (texto.includes("presumido")) return "Lucro Presumido";
  if (texto.includes("real")) return "Lucro Real";
  if (texto.includes("simples") || texto.includes("mei")) return "Simples Nacional";
  return null;
}
