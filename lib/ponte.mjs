// Cliente da PONTE SEFAZ, pela porta do ESCRITORIO DE CONTABILIDADE.
//
// A PONTE ja faz, em producao, a parte cara da captura para a carteira de um
// escritorio: guarda o A1 de cada cliente no cofre dela, varre a Distribuicao
// DF-e (NF-e e CT-e) e o ADN (NFS-e) todo dia, com UM ponteiro de NSU por CNPJ,
// e manifesta ciencia em lote. O NUCLEO consome isso em vez de repetir:
//
//   - consultar a SEFAZ pelo mesmo CNPJ em paralelo com a PONTE faz os dois
//     cairem na rejeicao 656 (consumo indevido, uma hora de bloqueio) - o
//     ponteiro unico dela existe justamente para evitar isso;
//   - o certificado do cliente fica num lugar so.
//
// Contrato lido de PONTE-SEFAZ/src/webapp/app.ts e escritorio-radar.ts
// (10/10/2026). Autenticacao: header x-api-key com a chave do cadastro que tem
// o modulo de contabilidade ligado (tem_escritorio).
//
//   GET  /api/escritorio/carteira                    clientes do escritorio
//   POST /api/escritorio/radar/varrer                {cnpj, documentos}
//   GET  /api/escritorio/pacote?cnpj&competencia&documentos   ZIP + indice.csv
//   POST /api/escritorio/radar/manifestar            {cnpj, chaves, tipoEvento}
//   GET  /api/escritorio/notas?cnpj&competencia&documentos    listagem (emitidas pela PONTE, NFS-e com situacao)
//   GET  /api/nota/{chave}/xml  (x-empresa-cnpj)     XML de nota emitida pela PONTE
//   POST /api/escritorio/nfse/conferir-cancelamentos {competencia, cnpj}
//   POST/PATCH/DELETE /api/escritorio/carteira[/:cnpj]           incluir, alterar, encerrar o vinculo
//   POST/DELETE /api/escritorio/carteira/:cnpj/certificado       A1 no cofre da PONTE
//   POST /api/escritorio/carteira/:cnpj/termo[/assinado], GET .../termo/assinado
//   GET  /api/escritorio/certificados?dias           A1 vencendo e clientes sem A1
//
// Contrato das rotas novas lido de PONTE-SEFAZ e4a8f91 (10/10/2026).
//
// O pacote e pedido por competencia E por tipo de documento: a funcao da
// Vercel devolve no maximo 4,5 MB, e um mes inteiro de NF-e de um cliente
// grande passa disso.

export const PONTE_PRODUCAO = "https://ponte-sefaz.vercel.app";
export const DOCUMENTOS_PONTE = ["nfe", "nfse", "cte"];

export class ErroPonte extends Error {
  constructor(mensagem, { status = null, transitorio = false, autenticacao = false, definitivo = false } = {}) {
    super(mensagem);
    this.name = "ErroPonte";
    this.status = status;
    this.transitorio = transitorio;
    this.autenticacao = autenticacao;
    this.definitivo = definitivo;
  }
}

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ClientePonte {
  constructor({ base = PONTE_PRODUCAO, chave, timeoutMs = 60_000, tentativas = 3, esperaMs = 1500 }) {
    if (!chave) throw new ErroPonte("Falta a chave do escritorio na PONTE", { definitivo: true });
    this.base = String(base || PONTE_PRODUCAO).replace(/\/+$/, "");
    this.chave = chave;
    this.timeoutMs = timeoutMs;
    this.tentativas = tentativas;
    this.esperaMs = esperaMs;
    this.chamadas = 0;
  }

  async requisitar(metodo, caminho, { corpo, binario = false, texto = false, cabecalhos = {} } = {}) {
    let ultimo = null;
    for (let tentativa = 0; tentativa < this.tentativas; tentativa += 1) {
      this.chamadas += 1;
      let resposta;
      try {
        resposta = await fetch(this.base + caminho, {
          method: metodo,
          headers: { "x-api-key": this.chave, accept: binario ? "*/*" : texto ? "application/xml" : "application/json",
            ...(corpo ? { "content-type": "application/json" } : {}), ...cabecalhos },
          body: corpo ? JSON.stringify(corpo) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch (erro) {
        ultimo = new ErroPonte("PONTE inacessivel: " + (erro.cause?.code || erro.message), { transitorio: true });
        if (tentativa < this.tentativas - 1) { await dormir(this.esperaMs * (tentativa + 1)); continue; }
        throw ultimo;
      }

      if (resposta.ok) {
        if (binario) return { bytes: Buffer.from(await resposta.arrayBuffer()), cabecalhos: resposta.headers };
        return texto ? resposta.text() : resposta.json();
      }

      const dados = await resposta.json().catch(() => ({}));
      const motivo = dados.erro || dados.error || ("HTTP " + resposta.status);
      const dica = dados.comoResolver ? " " + dados.comoResolver : "";
      if (resposta.status === 401 || resposta.status === 403) {
        throw new ErroPonte("A PONTE recusou a chave: " + motivo + dica, { status: resposta.status, autenticacao: true });
      }
      if (resposta.status === 404) {
        throw new ErroPonte(motivo + dica, { status: 404, definitivo: true });
      }
      if (resposta.status === 429 || resposta.status >= 500) {
        ultimo = new ErroPonte("PONTE instavel (" + motivo + ")", { status: resposta.status, transitorio: true });
        if (tentativa < this.tentativas - 1) { await dormir(this.esperaMs * (tentativa + 1)); continue; }
        throw ultimo;
      }
      throw new ErroPonte(motivo + dica, { status: resposta.status, definitivo: true });
    }
    throw ultimo || new ErroPonte("Tentativas esgotadas", { transitorio: true });
  }

  /** Clientes do escritorio na PONTE (com certificado, radar e ultima varredura). */
  carteira() {
    return this.requisitar("GET", "/api/escritorio/carteira");
  }

  /** Pede a PONTE uma varredura agora deste CNPJ (ela respeita a regra de uma hora). */
  varrer(cnpj, documentos = DOCUMENTOS_PONTE) {
    return this.requisitar("POST", "/api/escritorio/radar/varrer", { corpo: { cnpj, documentos } });
  }

  /** ZIP do mes: XML de cada documento e indice.csv com o que NAO veio e por que. */
  async pacote({ cnpj, competencia, documentos }) {
    const consulta = new URLSearchParams({ cnpj, competencia, documentos: [].concat(documentos).join(",") });
    const { bytes, cabecalhos } = await this.requisitar("GET", "/api/escritorio/pacote?" + consulta, { binario: true });
    return {
      zip: bytes,
      arquivos: Number(cabecalhos.get("x-arquivos") || 0),
      semXml: Number(cabecalhos.get("x-sem-xml") || 0)
    };
  }

  /** Achados da conferencia da PONTE para um CNPJ (so o que ela consegue provar). */
  conferencia(cnpj) {
    return this.requisitar("GET", "/api/escritorio/conferencia?cnpj=" + encodeURIComponent(cnpj));
  }

  /** Ciencia da Operacao (210210) pela PONTE: em lote ela so aceita ciencia. */
  manifestar({ cnpj, chaves }) {
    return this.requisitar("POST", "/api/escritorio/radar/manifestar", {
      corpo: { cnpj, chaves, tipoEvento: "210210" }
    });
  }

  /**
   * Listagem do mes: traz `emitidas` (NF-e e NFC-e que o cliente emitiu pela
   * PONTE, que o pacote nao leva) e `servicos` (NFS-e com a situacao, onde a
   * PONTE marca a cancelada; no indice do pacote a NFS-e vem sem situacao).
   */
  notas({ cnpj, competencia = null, documentos = ["nfe", "nfse"] }) {
    const consulta = new URLSearchParams({ cnpj, ...(competencia ? { competencia } : {}),
      documentos: [].concat(documentos).join(",") });
    return this.requisitar("GET", "/api/escritorio/notas?" + consulta);
  }

  /** XML de uma nota emitida pela PONTE: pede o CNPJ da empresa dona da nota. */
  xmlDaNota({ chave, cnpj }) {
    return this.requisitar("GET", "/api/nota/" + encodeURIComponent(chave) + "/xml", {
      texto: true, cabecalhos: { "x-empresa-cnpj": cnpj }
    });
  }

  /**
   * A PONTE pergunta ao ambiente nacional, nota a nota pela chave, se a NFS-e
   * do mes foi cancelada (101101) ou substituida (105102), com o A1 do cliente.
   * Devolve contagens; a nota cancelada aparece marcada em notas().
   */
  conferirCancelamentos({ cnpj, competencia }) {
    return this.requisitar("POST", "/api/escritorio/nfse/conferir-cancelamentos", { corpo: { cnpj, competencia } });
  }

  /** Inclui o cliente na carteira do escritorio na PONTE. */
  incluirNaCarteira({ empresaCnpj, apelido, codigoContabil, desde }) {
    return this.requisitar("POST", "/api/escritorio/carteira", {
      corpo: { empresaCnpj, apelido, codigoContabil, desde, radar: true }
    });
  }

  /** Muda apelido, codigo contabil ou radar do vinculo. */
  alterarNaCarteira(cnpj, campos) {
    return this.requisitar("PATCH", "/api/escritorio/carteira/" + cnpj, { corpo: campos });
  }

  /** Encerra o vinculo: a PONTE para de varrer; nada e apagado la nem aqui. */
  encerrarNaCarteira(cnpj) {
    return this.requisitar("DELETE", "/api/escritorio/carteira/" + cnpj);
  }

  /** Guarda o A1 do cliente no cofre da PONTE (o da matriz serve as filiais). */
  enviarCertificado(cnpj, { pfxBase64, pfxPassword, autorizadoPor, referencia }) {
    return this.requisitar("POST", "/api/escritorio/carteira/" + cnpj + "/certificado", {
      corpo: { pfxBase64, pfxPassword, autorizacao: { por: autorizadoPor, referencia } }
    });
  }

  /** Tira o A1 do cliente do cofre da PONTE (cliente que saiu, certificado trocado). */
  removerCertificado(cnpj) {
    return this.requisitar("DELETE", "/api/escritorio/carteira/" + cnpj + "/certificado");
  }

  /** Termo de guarda do certificado, em PDF, para o cliente assinar. */
  async gerarTermo(cnpj, { responsavelNome, responsavelCpf }) {
    const { bytes } = await this.requisitar("POST", "/api/escritorio/carteira/" + cnpj + "/termo", {
      corpo: { responsavelNome, responsavelCpf }, binario: true
    });
    return bytes;
  }

  /** Guarda na PONTE o termo assinado pelo cliente. */
  enviarTermoAssinado(cnpj, { arquivoBase64, nome, tipoMime, assinadoPor }) {
    return this.requisitar("POST", "/api/escritorio/carteira/" + cnpj + "/termo/assinado", {
      corpo: { arquivoBase64, nome, tipoMime, assinadoPor }
    });
  }

  /** Termo assinado guardado na PONTE. */
  async termoAssinado(cnpj) {
    const { bytes, cabecalhos } = await this.requisitar("GET", "/api/escritorio/carteira/" + cnpj + "/termo/assinado",
      { binario: true });
    return { bytes, tipo: cabecalhos.get("content-type") || "application/octet-stream",
      nome: /filename="([^"]+)"/.exec(cabecalhos.get("content-disposition") || "")?.[1] || "termo-assinado" };
  }

  /** Agenda da busca na PONTE: horarios, o maximo e o estado do relogio dela. */
  agenda() {
    return this.requisitar("GET", "/api/escritorio/agenda");
  }

  /** Cria um horario de busca na PONTE ({ frequencia, hora, minuto, diaSemana, diaMes, revarreduras, documentos, empresaCnpj }). */
  criarAgenda(corpo) {
    return this.requisitar("POST", "/api/escritorio/agenda", { corpo });
  }

  /** Desliga um horario da agenda da PONTE (desliga, nao apaga). */
  desligarAgenda(id) {
    return this.requisitar("DELETE", "/api/escritorio/agenda/" + encodeURIComponent(id));
  }

  /** Certificados do cofre da PONTE que vencem nos proximos `dias`, e quem nao tem A1. */
  certificados(dias = 60) {
    return this.requisitar("GET", "/api/escritorio/certificados?dias=" + dias);
  }
}

/** Separa um campo do CSV da PONTE: ";" com aspas dobradas quando o texto tem ";" ou aspas. */
function campos(linha) {
  const saida = [];
  let atual = "";
  let entreAspas = false;
  for (let i = 0; i < linha.length; i += 1) {
    const c = linha[i];
    if (entreAspas) {
      if (c === '"' && linha[i + 1] === '"') { atual += '"'; i += 1; }
      else if (c === '"') entreAspas = false;
      else atual += c;
    } else if (c === '"') entreAspas = true;
    else if (c === ";") { saida.push(atual); atual = ""; }
    else atual += c;
  }
  saida.push(atual);
  return saida;
}

/**
 * Le o indice.csv do pacote. Colunas da PONTE:
 * documento;cnpj_cliente;cliente;chave;emitente;emitente_cnpj;emissao;valor;situacao;xml_no_pacote;observacao
 */
export function lerIndicePonte(texto) {
  const linhas = String(texto || "").replace(/^﻿/, "").split(/\r?\n/).filter((linha) => linha.trim());
  if (!linhas.length) return [];
  const cabecalho = campos(linhas[0]).map((item) => item.trim());
  return linhas.slice(1).map((linha) => {
    const valores = campos(linha);
    const item = Object.fromEntries(cabecalho.map((nome, i) => [nome, (valores[i] ?? "").trim()]));
    return {
      documento: item.documento,
      cnpjCliente: item.cnpj_cliente,
      chave: String(item.chave || "").replace(/\D/g, ""),
      emitente: item.emitente,
      emitenteCnpj: item.emitente_cnpj,
      emissao: item.emissao,
      valor: item.valor,
      situacao: item.situacao,
      temXml: item.xml_no_pacote === "sim",
      observacao: item.observacao
    };
  });
}

/** Competencias AAAA-MM da atual para tras (a SEFAZ guarda cerca de 90 dias). */
/**
 * Plano do escritorio na PONTE, se a carteira trouxer: o limite e a quantidade
 * de empresas na carteira ("plano 1 suporta tantas, plano 2 tantas").
 * Devolve { nome, limiteEmpresas (null = sem limite), empresasNaCarteira } ou null.
 */
export function planoDaCarteira(resposta) {
  const plano = resposta?.plano;
  if (!plano || typeof plano !== "object") return null;
  const limite = Number(plano.limiteEmpresas);
  return {
    nome: String(plano.nome || "").trim() || "sem nome",
    limiteEmpresas: Number.isFinite(limite) && limite > 0 ? limite : null,
    empresasNaCarteira: Number.isFinite(Number(plano.empresasNaCarteira)) ? Number(plano.empresasNaCarteira) : null
  };
}

export function ultimasCompetencias(quantas, agora = new Date()) {
  const saida = [];
  for (let i = 0; i < quantas; i += 1) {
    const data = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - i, 1));
    saida.push(data.getUTCFullYear() + "-" + String(data.getUTCMonth() + 1).padStart(2, "0"));
  }
  return saida;
}
