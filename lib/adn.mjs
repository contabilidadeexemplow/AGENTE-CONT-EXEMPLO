// Cliente da API de Distribuicao de DF-e do ADN (NFS-e nacional).
//
//   GET {base}/DFe/{NSU}?lote=true[&cnpjConsulta=CNPJ]
//
// Autenticacao por mTLS com o certificado A1. A extensao usava a sessao do
// Chrome (credentials:'include'), e quem fazia o handshake era o navegador; aqui
// o proprio Node apresenta o certificado.
//
// Comportamento portado da extensao (certificado.js / background.js), que
// funciona contra o ADN real:
//   - o lote volta com os documentos de NSU MAIOR que o pedido;
//   - 404 e StatusProcessamento NENHUM_DOCUMENTO_LOCALIZADO = fim da caixa, nao erro;
//   - ArquivoXml vem em GZip + Base64; ausente = resumo, sem arquivo;
//   - 429, 502, 503 e 504 sao transitorios: espera, respeita Retry-After e
//     aumenta o espacamento entre chamadas;
//   - erro vem como { Erros: [ { Codigo, Descricao } ] }.

import https from "node:https";
import { gunzipSync } from "node:zlib";
import { opcoesTlsDoA1 } from "./certificados.mjs";

export const ADN_PRODUCAO = "https://adn.nfse.gov.br/contribuintes";
export const ADN_RESTRITA = "https://adn.producaorestrita.nfse.gov.br/contribuintes";

// Sefin Nacional: eventos de uma NFS-e pela chave (Manual dos Contribuintes,
// API Eventos: GET /nfse/{chave}/eventos/{tipo}/{seq}). Mesmo mTLS do ADN; o
// XML do evento vem em eventoXmlGZipB64, como a PONTE ja usa em producao.
export const SEFIN_PRODUCAO = "https://sefin.nfse.gov.br/SefinNacional";
export const SEFIN_RESTRITA = "https://sefin.producaorestrita.nfse.gov.br/SefinNacional";

/** Sefin do mesmo ambiente do ADN configurado (producao, restrita ou o simulador). */
export function sefinDoAdn(adnBase) {
  if (!adnBase || adnBase === ADN_PRODUCAO) return SEFIN_PRODUCAO;
  if (adnBase === ADN_RESTRITA) return SEFIN_RESTRITA;
  return String(adnBase).replace(/\/contribuintes\/?$/, "") + "/SefinNacional";
}

const TRANSITORIOS = new Set([429, 502, 503, 504]);

// Espacamento por host, compartilhado por todas as empresas do processo: o
// limite do ADN provavelmente e por origem, nao por certificado.
const ritmo = new Map();

function ritmoDe(host, minimo) {
  if (!ritmo.has(host)) ritmo.set(host, { ultimo: 0, espaco: minimo, minimo });
  return ritmo.get(host);
}

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ErroAdn extends Error {
  constructor(mensagem, { status = null, codigo = null, transitorio = false, autenticacao = false } = {}) {
    super(mensagem);
    this.name = "ErroAdn";
    this.status = status;
    this.codigo = codigo;
    this.transitorio = transitorio;
    this.autenticacao = autenticacao;
  }
}

function motivoDoErro(corpo) {
  if (!corpo) return { motivo: "", codigo: "" };
  try {
    const json = JSON.parse(corpo);
    const lista = json.Erros || json.erros || json.Alertas || json.alertas;
    const texto = (item) => {
      for (const chave of ["Descricao", "descricao", "Mensagem", "mensagem", "message", "Message", "erro"]) {
        if (typeof item?.[chave] === "string" && item[chave].trim()) return item[chave].trim();
      }
      return "";
    };
    if (Array.isArray(lista) && lista.length) {
      return {
        codigo: lista[0].Codigo || lista[0].codigo || "",
        motivo: lista.map((item) => [item.Codigo || item.codigo || "", texto(item)].filter(Boolean).join(": ")).join("; ")
      };
    }
    return { codigo: "", motivo: texto(json) };
  } catch {
    return { codigo: "", motivo: /^\s*</.test(corpo) ? "" : corpo.trim().slice(0, 300) };
  }
}

/** ArquivoXml: GZip + Base64. Devolve o XML ou lanca. */
export function decodificarArquivo(base64) {
  const bytes = Buffer.from(String(base64), "base64");
  if (!bytes.length) throw new Error("ArquivoXml vazio");
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return gunzipSync(bytes).toString("utf8");
  const texto = bytes.toString("utf8");
  if (texto.trimStart().startsWith("<")) return texto;
  throw new Error("ArquivoXml nao e GZip nem XML");
}

export class ClienteAdn {
  /**
   * @param {object} opcoes
   * @param {Buffer} opcoes.pfx         certificado A1 (ja decifrado do cofre)
   * @param {string} opcoes.senha       senha do PFX
   * @param {string} [opcoes.base]      ADN_PRODUCAO, ADN_RESTRITA ou um simulador
   * @param {string|Buffer} [opcoes.ca] CA extra (testes, ou cadeia nao publica)
   */
  constructor({ pfx, senha, base = ADN_PRODUCAO, ca, espacamentoMs = 700, tentativas = 5, timeoutMs = 30_000,
    esperaMaximaMs = 8000 }) {
    this.base = base.replace(/\/+$/, "");
    this.esperaMaximaMs = esperaMaximaMs;
    this.host = new URL(this.base).host;
    this.tentativas = tentativas;
    this.timeoutMs = timeoutMs;
    this.ritmo = ritmoDe(this.host, espacamentoMs);
    // PEM, e nao o .pfx: o .pfx cru so abria com --openssl-legacy-provider (A1
    // do Windows em RC2-40). Aberto aqui, o A1 que nao abre para na hora, como
    // falha de certificado, em vez de virar "portal inacessivel" a cada tentativa.
    let tlsDoA1;
    try {
      tlsDoA1 = pfx ? opcoesTlsDoA1(pfx, senha, ca) : (ca ? { ca } : {});
    } catch (erro) {
      throw new ErroAdn("Certificado A1 nao abriu: " + erro.message, { autenticacao: true });
    }
    this.agente = new https.Agent({
      ...tlsDoA1, keepAlive: true, maxSockets: 2,
      minVersion: "TLSv1.2"
    });
    this.chamadas = 0;
  }

  fechar() {
    this.agente.destroy();
  }

  async esperarVez() {
    const passou = Date.now() - this.ritmo.ultimo;
    if (passou < this.ritmo.espaco) await dormir(this.ritmo.espaco - passou);
    this.ritmo.ultimo = Date.now();
  }

  requisitar(url) {
    return new Promise((resolve, reject) => {
      const pedido = https.request(url, {
        method: "GET",
        agent: this.agente,
        headers: { accept: "application/json" },
        timeout: this.timeoutMs
      }, (resposta) => {
        const partes = [];
        resposta.on("data", (parte) => partes.push(parte));
        resposta.on("end", () => resolve({
          status: resposta.statusCode,
          headers: resposta.headers,
          corpo: Buffer.concat(partes).toString("utf8")
        }));
        resposta.on("error", reject);
      });
      pedido.on("timeout", () => pedido.destroy(Object.assign(new Error("tempo esgotado"), { code: "ETIMEDOUT" })));
      pedido.on("error", reject);
      pedido.end();
    });
  }

  /**
   * Um lote a partir do NSU informado (exclusivo).
   * Devolve { fim, documentos:[{ nsu, chave, tipo, xml, resumo, erro }], status }.
   */
  async lote(nsu, { cnpjConsulta } = {}) {
    const url = this.base + "/DFe/" + Number(nsu) + "?lote=true" +
      (cnpjConsulta ? "&cnpjConsulta=" + encodeURIComponent(String(cnpjConsulta).replace(/\D/g, "")) : "");

    for (let tentativa = 0; tentativa < this.tentativas; tentativa += 1) {
      await this.esperarVez();
      this.chamadas += 1;
      let resposta;
      try {
        resposta = await this.requisitar(url);
      } catch (erro) {
        // Falha de handshake com o certificado nao melhora tentando de novo.
        if (/certificate|handshake|alert|ssl|tls/i.test(erro.message) && !/ETIMEDOUT|ECONNRESET/.test(erro.code || "")) {
          throw new ErroAdn("Falha no mTLS: " + erro.message, { autenticacao: true });
        }
        if (tentativa < this.tentativas - 1) { await dormir(Math.min(this.esperaMaximaMs, 1500 * (tentativa + 1))); continue; }
        throw new ErroAdn("Portal inacessivel: " + erro.message, { transitorio: true });
      }

      if (TRANSITORIOS.has(resposta.status)) {
        const retryAfter = Number.parseInt(resposta.headers["retry-after"] || "", 10);
        const espera = Math.min(this.esperaMaximaMs, Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000 * 2 ** tentativa);
        if (resposta.status === 429) {
          this.ritmo.espaco = Math.min(5000, Math.round(this.ritmo.espaco * 1.5));
        }
        if (tentativa < this.tentativas - 1) { await dormir(espera); continue; }
        throw new ErroAdn(resposta.status === 429
          ? "ADN limitando requisicoes (429)"
          : "ADN instavel (HTTP " + resposta.status + ")", { status: resposta.status, transitorio: true });
      }

      if (resposta.status === 404) return { fim: true, documentos: [], status: 404 };

      if (resposta.status === 401 || resposta.status === 403) {
        const { motivo, codigo } = motivoDoErro(resposta.corpo);
        throw new ErroAdn("ADN recusou o certificado (HTTP " + resposta.status + ")" + (motivo ? ": " + motivo : ""),
          { status: resposta.status, codigo, autenticacao: true });
      }

      if (resposta.status < 200 || resposta.status >= 300) {
        const { motivo, codigo } = motivoDoErro(resposta.corpo);
        throw new ErroAdn("ADN respondeu HTTP " + resposta.status + (motivo ? ": " + motivo : ""),
          { status: resposta.status, codigo });
      }

      // Resposta boa: o espacamento volta devagar para o minimo.
      this.ritmo.espaco = Math.max(this.ritmo.minimo, Math.round(this.ritmo.espaco * 0.9));

      let dados;
      try {
        dados = JSON.parse(resposta.corpo);
      } catch {
        throw new ErroAdn("Resposta do ADN nao e JSON", { status: resposta.status });
      }

      if (dados.StatusProcessamento === "REJEICAO") {
        const { motivo, codigo } = motivoDoErro(resposta.corpo);
        throw new ErroAdn("ADN rejeitou a consulta" + (motivo ? ": " + motivo : ""), { status: resposta.status, codigo });
      }

      const lote = Array.isArray(dados.LoteDFe) ? dados.LoteDFe : [];
      if (dados.StatusProcessamento === "NENHUM_DOCUMENTO_LOCALIZADO" || !lote.length) {
        return { fim: true, documentos: [], status: resposta.status };
      }

      const documentos = lote.map((item) => {
        const numero = typeof item.NSU === "number" ? item.NSU : Number.parseInt(item.NSU, 10);
        const saida = {
          nsu: Number.isFinite(numero) ? numero : null,
          chave: String(item.ChaveAcesso || "").replace(/\D/g, ""),
          tipo: String(item.TipoDocumento || "").toUpperCase(),
          xml: null,
          resumo: !item.ArquivoXml,
          erro: null
        };
        if (item.ArquivoXml) {
          try {
            saida.xml = decodificarArquivo(item.ArquivoXml);
          } catch (erro) {
            saida.erro = erro.message;
          }
        }
        return saida;
      });

      return { fim: false, documentos, status: resposta.status };
    }

    throw new ErroAdn("Tentativas esgotadas", { transitorio: true });
  }

  /**
   * Evento de uma NFS-e na Sefin Nacional (cliente aberto com base SEFIN_*).
   * Devolve o XML do evento, ou null quando a nota nao tem esse evento (404).
   * So o 200 com o XML conta como evento: qualquer outra resposta lanca, e
   * quem chama trata a nota como "nao conferida", nunca como cancelada.
   */
  async eventoNfse(chave, tipo, seq = 1) {
    const url = this.base + "/nfse/" + encodeURIComponent(chave) + "/eventos/" + encodeURIComponent(tipo) + "/" + Number(seq);
    for (let tentativa = 0; tentativa < this.tentativas; tentativa += 1) {
      await this.esperarVez();
      this.chamadas += 1;
      let resposta;
      try {
        resposta = await this.requisitar(url);
      } catch (erro) {
        if (/certificate|handshake|alert|ssl|tls/i.test(erro.message) && !/ETIMEDOUT|ECONNRESET/.test(erro.code || "")) {
          throw new ErroAdn("Falha no mTLS: " + erro.message, { autenticacao: true });
        }
        if (tentativa < this.tentativas - 1) { await dormir(Math.min(this.esperaMaximaMs, 1500 * (tentativa + 1))); continue; }
        throw new ErroAdn("Sefin Nacional inacessivel: " + erro.message, { transitorio: true });
      }
      if (TRANSITORIOS.has(resposta.status)) {
        const retryAfter = Number.parseInt(resposta.headers["retry-after"] || "", 10);
        if (resposta.status === 429) this.ritmo.espaco = Math.min(5000, Math.round(this.ritmo.espaco * 1.5));
        if (tentativa < this.tentativas - 1) {
          await dormir(Math.min(this.esperaMaximaMs, Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000 * 2 ** tentativa));
          continue;
        }
        throw new ErroAdn("Sefin Nacional instavel (HTTP " + resposta.status + ")", { status: resposta.status, transitorio: true });
      }
      if (resposta.status === 404) return null;
      const { motivo, codigo } = motivoDoErro(resposta.corpo);
      if (resposta.status === 401 || resposta.status === 403) {
        throw new ErroAdn("Sefin Nacional recusou o certificado (HTTP " + resposta.status + ")" + (motivo ? ": " + motivo : ""),
          { status: resposta.status, codigo, autenticacao: true });
      }
      if (resposta.status < 200 || resposta.status >= 300) {
        throw new ErroAdn("Sefin Nacional respondeu HTTP " + resposta.status + (motivo ? ": " + motivo : ""), { status: resposta.status, codigo });
      }
      let dados;
      try { dados = JSON.parse(resposta.corpo); } catch { throw new ErroAdn("Resposta da Sefin Nacional nao e JSON", { status: resposta.status }); }
      const arquivo = dados.eventoXmlGZipB64 || dados.EventoXmlGZipB64;
      if (!arquivo) throw new ErroAdn("A Sefin Nacional respondeu sem o XML do evento", { status: resposta.status });
      return decodificarArquivo(arquivo);
    }
    throw new ErroAdn("Tentativas esgotadas", { transitorio: true });
  }
}
