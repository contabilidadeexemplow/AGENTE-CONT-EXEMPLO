// Webservices da SEFAZ (Ambiente Nacional) para NF-e e CT-e:
//
//   NFeDistribuicaoDFe  - documentos de interesse do CNPJ (NF-e recebidas,
//                         resumos, eventos), por NSU
//   CTeDistribuicaoDFe  - o mesmo para CT-e
//   NFeRecepcaoEvento4  - manifestacao do destinatario (Ciencia da Operacao,
//                         210210), assinada em XMLDSig
//
// SOAP 1.2 sobre mTLS com o certificado A1. Regras que a SEFAZ impoe e que,
// ignoradas, bloqueiam o CNPJ por uma hora (cStat 656, consumo indevido):
//   - quando ultNSU alcanca maxNSU, ou volta 137 (nenhum documento), so se
//     consulta de novo depois de uma hora;
//   - o CNPJ consultado precisa ter a mesma raiz do certificado (rejeicao 593):
//     procuracao NAO vale aqui, diferente do ADN da NFS-e.
//
// Os servidores do Ambiente Nacional usam cadeia GlobalSign (AC SERPRO),
// conferido em 08/10/2026: o Node confia sem CA extra.

import https from "node:https";
import { gunzipSync } from "node:zlib";
import { parseXml, deep, deepAll, text } from "./xml.mjs";
import { assinar, escaparTexto, NS_NFE } from "./xmldsig.mjs";
import { opcoesTlsDoA1 } from "./certificados.mjs";

export const ENDPOINTS = {
  producao: {
    nfeDistribuicao: "https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
    cteDistribuicao: "https://www1.cte.fazenda.gov.br/CTeDistribuicaoDFe/CTeDistribuicaoDFe.asmx",
    nfeEvento: "https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx"
  },
  homologacao: {
    nfeDistribuicao: "https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
    cteDistribuicao: "https://hom1.cte.fazenda.gov.br/CTeDistribuicaoDFe/CTeDistribuicaoDFe.asmx",
    nfeEvento: "https://hom1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx"
  }
};

export const CODIGO_UF = {
  AC: 12, AL: 27, AP: 16, AM: 13, BA: 29, CE: 23, DF: 53, ES: 32, GO: 52, MA: 21, MT: 51, MS: 50,
  MG: 31, PA: 15, PB: 25, PR: 41, PE: 26, PI: 22, RJ: 33, RN: 24, RS: 43, RO: 11, RR: 14, SC: 42,
  SP: 35, SE: 28, TO: 17
};

export class ErroSefaz extends Error {
  constructor(mensagem, { cStat = null, status = null, transitorio = false, autenticacao = false, bloquearMs = 0 } = {}) {
    super(mensagem);
    this.name = "ErroSefaz";
    this.cStat = cStat;
    this.status = status;
    this.transitorio = transitorio;
    this.autenticacao = autenticacao;
    this.bloquearMs = bloquearMs;
  }
}

const UMA_HORA = 61 * 60_000;
const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nsu15(valor) {
  return String(Number(valor) || 0).padStart(15, "0");
}

function envelope(corpo) {
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>' +
    corpo + "</soap12:Body></soap12:Envelope>";
}

/** docZip: GZip + Base64 com o atributo schema dizendo o que e. */
function decodificarDocZip(no) {
  const schema = no.attrs.schema || "";
  const nsu = Number(no.attrs.NSU);
  try {
    const xml = gunzipSync(Buffer.from(no.text.trim(), "base64")).toString("utf8");
    return { nsu, schema, xml, erro: null };
  } catch (erro) {
    return { nsu, schema, xml: null, erro: "docZip ilegivel: " + erro.message };
  }
}

export class ClienteSefaz {
  constructor({ pfx, senha, ambiente = "producao", endpoints = {}, ca, timeoutMs = 60_000, tentativas = 3, esperaMaximaMs = 8000, esperaFimMs = UMA_HORA }) {
    this.endpoints = { ...ENDPOINTS[ambiente === "homologacao" ? "homologacao" : "producao"], ...endpoints };
    this.tpAmb = ambiente === "homologacao" ? 2 : 1;
    // PEM, e nao o .pfx: o .pfx cru so abria com --openssl-legacy-provider (A1
    // do Windows em RC2-40). Aberto aqui, o A1 que nao abre para na hora, como
    // falha de certificado, em vez de virar "SEFAZ inacessivel" a cada tentativa.
    let tlsDoA1;
    try {
      tlsDoA1 = pfx ? opcoesTlsDoA1(pfx, senha, ca) : (ca ? { ca } : {});
    } catch (erro) {
      throw new ErroSefaz("Certificado A1 nao abriu: " + erro.message, { autenticacao: true });
    }
    this.agente = new https.Agent({ ...tlsDoA1, keepAlive: true, maxSockets: 1, minVersion: "TLSv1.2" });
    this.timeoutMs = timeoutMs;
    this.tentativas = tentativas;
    this.esperaMaximaMs = esperaMaximaMs;
    this.esperaFimMs = esperaFimMs;
    this.chamadas = 0;
  }

  fechar() {
    this.agente.destroy();
  }

  postar(url, acao, corpo) {
    return new Promise((resolve, reject) => {
      const dados = Buffer.from(corpo, "utf8");
      const pedido = https.request(url, {
        method: "POST", agent: this.agente, timeout: this.timeoutMs,
        headers: { "content-type": 'application/soap+xml; charset=utf-8; action="' + acao + '"', "content-length": dados.length }
      }, (resposta) => {
        const partes = [];
        resposta.on("data", (parte) => partes.push(parte));
        resposta.on("end", () => resolve({ status: resposta.statusCode, corpo: Buffer.concat(partes).toString("utf8") }));
        resposta.on("error", reject);
      });
      pedido.on("timeout", () => pedido.destroy(Object.assign(new Error("tempo esgotado"), { code: "ETIMEDOUT" })));
      pedido.on("error", reject);
      pedido.end(dados);
    });
  }

  async chamar(url, acao, corpo) {
    for (let tentativa = 0; tentativa < this.tentativas; tentativa += 1) {
      this.chamadas += 1;
      let resposta;
      try {
        resposta = await this.postar(url, acao, corpo);
      } catch (erro) {
        if (/certificate|handshake|alert|ssl|tls/i.test(erro.message) && !/ETIMEDOUT|ECONNRESET/.test(erro.code || "")) {
          throw new ErroSefaz("Falha no mTLS com a SEFAZ: " + erro.message, { autenticacao: true });
        }
        if (tentativa < this.tentativas - 1) { await dormir(Math.min(this.esperaMaximaMs, 2000 * 2 ** tentativa)); continue; }
        throw new ErroSefaz("SEFAZ inacessivel: " + erro.message, { transitorio: true });
      }
      if (resposta.status === 403 || resposta.status === 401) {
        throw new ErroSefaz("SEFAZ recusou o certificado (HTTP " + resposta.status + ")", { status: resposta.status, autenticacao: true });
      }
      if (resposta.status >= 500) {
        if (tentativa < this.tentativas - 1) { await dormir(Math.min(this.esperaMaximaMs, 2000 * 2 ** tentativa)); continue; }
        throw new ErroSefaz("SEFAZ instavel (HTTP " + resposta.status + ")", { status: resposta.status, transitorio: true });
      }
      try {
        return parseXml(resposta.corpo);
      } catch {
        throw new ErroSefaz("Resposta da SEFAZ nao e XML (HTTP " + resposta.status + ")", { status: resposta.status, transitorio: true });
      }
    }
    throw new ErroSefaz("Tentativas esgotadas", { transitorio: true });
  }

  /**
   * Um lote de distribuicao. modelo = "nfe" | "cte".
   * Com `chave` (so NF-e), consulta aquela nota (consChNFe) em vez do NSU:
   * serve para buscar o XML logo depois da ciencia, sem mexer no cursor.
   * Devolve { fim, ultNSU, maxNSU, cStat, motivo, documentos:[{nsu, schema, xml, erro}], bloquearMs }.
   */
  async distribuicao(modelo, { cnpj, uf, ultNSU = 0, chave = null }) {
    const cUF = CODIGO_UF[String(uf || "").toUpperCase()];
    if (!cUF) throw new ErroSefaz("UF do interessado invalida ou ausente: " + uf);
    const nfe = modelo === "nfe";
    const wsdl = nfe
      ? "http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"
      : "http://www.portalfiscal.inf.br/cte/wsdl/CTeDistribuicaoDFe";
    const ns = nfe ? NS_NFE : "http://www.portalfiscal.inf.br/cte";
    const operacao = nfe ? "nfeDistDFeInteresse" : "cteDistDFeInteresse";
    const mensagem = nfe ? "nfeDadosMsg" : "cteDadosMsg";
    if (chave && !nfe) throw new ErroSefaz("Consulta por chave so existe na distribuicao de NF-e");
    const pedido = chave
      ? "<consChNFe><chNFe>" + String(chave).replace(/\D/g, "") + "</chNFe></consChNFe>"
      : "<distNSU><ultNSU>" + nsu15(ultNSU) + "</ultNSU></distNSU>";
    const corpo = envelope(
      "<" + operacao + ' xmlns="' + wsdl + '"><' + mensagem + ">" +
      '<distDFeInt xmlns="' + ns + '" versao="' + (nfe ? "1.01" : "1.00") + '">' +
      "<tpAmb>" + this.tpAmb + "</tpAmb><cUFAutor>" + cUF + "</cUFAutor>" +
      "<CNPJ>" + String(cnpj).replace(/\D/g, "") + "</CNPJ>" +
      pedido +
      "</distDFeInt></" + mensagem + "></" + operacao + ">"
    );

    const xml = await this.chamar(nfe ? this.endpoints.nfeDistribuicao : this.endpoints.cteDistribuicao,
      wsdl + "/" + operacao, corpo);
    const ret = deep(xml, "retDistDFeInt");
    if (!ret) throw new ErroSefaz("Resposta sem retDistDFeInt", { transitorio: true });

    const cStat = text(ret, "cStat");
    const motivo = text(ret, "xMotivo");
    const ultimo = Number(text(ret, "ultNSU")) || Number(ultNSU) || 0;
    const maximo = Number(text(ret, "maxNSU")) || ultimo;

    if (cStat === "656") {
      throw new ErroSefaz("SEFAZ bloqueou por consumo indevido (656): aguardar uma hora. " + motivo,
        { cStat, transitorio: true, bloquearMs: this.esperaFimMs });
    }
    if (cStat === "593" || cStat === "594" || cStat === "641") {
      throw new ErroSefaz("SEFAZ recusou o CNPJ consultado (" + cStat + "): " + motivo +
        ". O certificado precisa ser da mesma raiz de CNPJ; procuracao nao vale na distribuicao de NF-e/CT-e.",
        { cStat, autenticacao: true });
    }
    if (cStat === "137") {
      return { fim: true, ultNSU: ultimo, maxNSU: maximo, cStat, motivo, documentos: [], bloquearMs: this.esperaFimMs };
    }
    if (cStat !== "138") {
      throw new ErroSefaz("SEFAZ rejeitou a consulta (" + cStat + "): " + motivo, { cStat });
    }

    const documentos = deepAll(ret, "docZip").map(decodificarDocZip);
    if (chave) return { fim: true, ultNSU: ultimo, maxNSU: maximo, cStat, motivo, documentos, bloquearMs: 0 };
    const fim = ultimo >= maximo;
    return { fim, ultNSU: ultimo, maxNSU: maximo, cStat, motivo, documentos, bloquearMs: fim ? this.esperaFimMs : 0 };
  }

  /**
   * Manifestacao do destinatario. tipo 210210 = Ciencia da Operacao: libera o
   * XML completo na distribuicao sem confirmar nem negar a operacao.
   * Devolve { cStat, motivo, protocolo, xmlEnviado }.
   */
  async manifestar({ cnpj, chave, chavePrivada, certificadoDer, tipo = "210210", descricao = "Ciencia da Operacao",
    agora = new Date(), fuso = "-03:00" }) {
    const id = "ID" + tipo + chave + "01";
    const local = new Date(agora.getTime() - 3 * 3600_000).toISOString().slice(0, 19) + fuso;
    const inf = '<infEvento Id="' + id + '">' +
      "<cOrgao>91</cOrgao><tpAmb>" + this.tpAmb + "</tpAmb>" +
      "<CNPJ>" + String(cnpj).replace(/\D/g, "") + "</CNPJ><chNFe>" + chave + "</chNFe>" +
      "<dhEvento>" + local + "</dhEvento><tpEvento>" + tipo + "</tpEvento>" +
      "<nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>" +
      '<detEvento versao="1.00"><descEvento>' + escaparTexto(descricao) + "</descEvento></detEvento>" +
      "</infEvento>";
    const assinatura = assinar({ elementoXml: inf, nome: "infEvento", id, chavePrivada, certificadoDer });
    const envEvento = '<envEvento xmlns="' + NS_NFE + '" versao="1.00"><idLote>' + Date.now().toString().slice(-15) +
      '</idLote><evento versao="1.00">' + inf + assinatura + "</evento></envEvento>";
    const wsdl = "http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4";
    const xml = await this.chamar(this.endpoints.nfeEvento, wsdl + "/nfeRecepcaoEvento",
      envelope('<nfeDadosMsg xmlns="' + wsdl + '">' + envEvento + "</nfeDadosMsg>"));

    const lote = deep(xml, "retEnvEvento");
    if (!lote) throw new ErroSefaz("Resposta sem retEnvEvento", { transitorio: true });
    const retorno = deep(lote, "retEvento") || lote;
    return {
      cStatLote: text(lote, "cStat"),
      cStat: text(deep(retorno, "infEvento") || retorno, "cStat") || text(lote, "cStat"),
      motivo: text(deep(retorno, "infEvento") || retorno, "xMotivo") || text(lote, "xMotivo"),
      protocolo: text(retorno, "nProt"),
      xmlEnviado: envEvento
    };
  }
}

/** cStat da manifestacao que significam "ja esta registrado". */
export function manifestacaoAceita(cStat) {
  return ["135", "136", "573"].includes(String(cStat));
}
