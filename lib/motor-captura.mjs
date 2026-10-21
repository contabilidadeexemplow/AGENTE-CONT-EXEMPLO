// Motor de captura: drena a fonte de uma empresa (ADN da NFS-e, ou a
// distribuicao de NF-e e CT-e da SEFAZ), guarda, confere, gera PDF e espelha
// na pasta do cliente.
//
// Garantias, na ordem em que importam:
//
// 1. O cursor de NSU so avanca DEPOIS que o lote inteiro esta gravado no
//    banco, numa transacao. Processo morto no meio retoma do ultimo lote
//    confirmado: sem buraco e sem duplicata.
// 2. Todo NSU devolvido pelo portal fica registrado em rastreio_nsu com o que
//    foi feito dele. Nada e descartado em silencio.
// 3. O que falta vira pendencia com o dado suficiente para ir atras: chave,
//    NSU, motivo. O que o portal confirma que nao existe (NSU pulado) fica
//    registrado como "confirmada", separado do que esta realmente faltando.
// 4. Falha de PDF ou de pasta nao derruba o XML: cada etapa tem a propria
//    pendencia e o proprio reprocessamento.
// 5. SEFAZ: a regra de uma hora entre consultas depois de chegar ao fim e
//    respeitada pelo proprio motor (cursores.bloqueado_ate). Insistir antes
//    rende o bloqueio 656 do CNPJ.

import { ClienteAdn, ErroAdn, ADN_PRODUCAO, sefinDoAdn } from "./adn.mjs";
import { ClienteSefaz, ErroSefaz, manifestacaoAceita } from "./sefaz.mjs";
import { abrirParaAssinatura } from "./pkcs12.mjs";
import { lerPfx, cobreCnpj } from "./certificados.mjs";
import { lerDocumento, lerResumoNfe, validarChave } from "./documentos.mjs";
import { listZip, readEntry, isZip } from "./zip.mjs";
import { ClientePonte, PONTE_PRODUCAO, DOCUMENTOS_PONTE, lerIndicePonte, ultimasCompetencias, planoDaCarteira } from "./ponte.mjs";
import { conferir } from "./conferencia.mjs";
import { gerarDanfse } from "./danfse.mjs";
import { gerarDanfe, gerarDacte } from "./pdf-fiscal.mjs";
import * as acervo from "./acervo.mjs";
import { caminhoRelativo, nomeArquivo, nomeEvento, pastaAcessivel, gravarSemSobrescrever } from "./pastas.mjs";
import { transacao } from "./banco.mjs";
import { clientes, documentos, conferencias, regras, configuracoes } from "./repositorio.mjs";
import {
  certificadosDigitais, empresasCaptura, cursores, rastreio, pendencias, arquivos, eventos, gravacoes,
  manifestacoes, ponteEstado, revisaoEventos, periodosCaptura, acervoDocs, termosGuarda
} from "./repo-captura.mjs";
import { chaveConfigurada } from "./segredos.mjs";
import { CODIGO_UF } from "./sefaz.mjs";

export const FONTES = {
  PONTE: "NF-e, NFS-e e CT-e pela PONTE SEFAZ",
  ADN: "NFS-e (Ambiente Nacional)",
  NFE: "NF-e (SEFAZ)",
  CTE: "CT-e (SEFAZ)"
};

export const TIPOS_PENDENCIA = {
  resumo_sem_xml: "Portal informou a nota, mas sem o XML",
  xml_invalido: "XML chegou corrompido ou ilegivel",
  xml_divergente: "Mesma chave com conteudo diferente do ja guardado",
  nota_referenciada_ausente: "Evento de uma nota que nao esta no acervo",
  pdf_nao_gerado: "XML guardado, PDF (DANFSe, DANFE ou DACTE) nao gerado",
  conflito_pasta: "Arquivo diferente ja existe na pasta do cliente",
  gravacao_pasta: "Falha ao gravar na pasta do cliente",
  lacuna_nsu: "NSU pulado pelo portal (nao ha documento nele)",
  ponte_pacote: "A PONTE nao entregou o pacote de um mes"
};

// Eventos que encerram a nota. NFS-e (NT 008): cancelamento, cancelamento
// deferido por analise fiscal, cancelamento por oficio. NF-e/CT-e: 110111
// cancelamento, 110112 cancelamento por substituicao. 105102 = substituicao.
const CANCELAMENTOS = new Set(["101101", "105104", "305101", "110111", "110112"]);
const SUBSTITUICAO = "105102";
const CIENCIA = "210210";

export class ErroCaptura extends Error {
  constructor(mensagem, { definitivo = false, autenticacao = false, adiarAte = null } = {}) {
    super(mensagem);
    this.name = "ErroCaptura";
    this.definitivo = definitivo;
    this.autenticacao = autenticacao;
    // Nao e falha: a fonte exige esperar ate este instante (ms).
    this.adiarAte = adiarAte;
  }
}

// A mesma nota entre dois clientes da carteira e emitida para um e recebida
// para o outro: a identidade do documento no acervo e por empresa.
export function identidade(clienteId, chave) {
  return clienteId + ":" + chave;
}

function papelDe(documento, cnpj) {
  if (documento.emitter?.cnpj === cnpj) return "emitida";
  if (documento.recipient?.doc === cnpj) return "recebida";
  return "outro";
}

// A coluna "operacao" gravada e a visao da EMPRESA da carteira (recebida =
// entrada, o resto = saida): e dela que a apuracao e os monitores tiram receita
// e faturamento. Nao e a operacao fiscal da nota: a conferencia tributaria le o
// tpNF do proprio XML (documento.tpNF, que segue intacto nos dados gravados),
// porque a nota de entrada emitida pela propria empresa (devolucao, importacao)
// e "emitida" e, mesmo assim, de entrada.
function operacaoDaEmpresa(papel) {
  return papel === "recebida" ? "entrada" : "saida";
}

function querPapel(tipos, papel) {
  if (tipos === "emitidas") return papel === "emitida";
  if (tipos === "recebidas") return papel === "recebida";
  return true;
}

function marcaDaguaDe(chave) {
  const lista = eventos.daChave(chave);
  if (lista.some((item) => CANCELAMENTOS.has(item.tipo))) return "CANCELADA";
  if (lista.some((item) => item.tipo === SUBSTITUICAO)) return "SUBSTITUIDA";
  return "";
}

function horario(ms) {
  return new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
}

function brl(valor) {
  return "R$ " + Number(valor || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Certificado da empresa aberto do cofre, com as checagens comuns as fontes. */
function credencial(empresa) {
  if (!empresa?.configurada) {
    throw new ErroCaptura("Empresa sem configuracao de captura", { definitivo: true });
  }
  if (!empresa.certificadoId) {
    throw new ErroCaptura("Empresa sem certificado vinculado", { definitivo: true });
  }
  const certificado = certificadosDigitais.porId(empresa.certificadoId);
  if (!certificado || !certificado.ativo) {
    throw new ErroCaptura("Certificado vinculado esta inativo ou foi removido", { definitivo: true });
  }
  if (certificado.diasParaVencer < 0) {
    throw new ErroCaptura("Certificado de " + certificado.titular + " venceu em " + certificado.validoAte +
      ": a consulta nao foi feita", { definitivo: true, autenticacao: true });
  }
  const segredo = certificadosDigitais.segredo(certificado.id);
  if (!segredo) throw new ErroCaptura("Nao foi possivel abrir o certificado no cofre", { definitivo: true });
  return { certificado, segredo };
}

/** Abre a credencial da empresa e devolve o cliente HTTP do ADN. */
function abrirCliente(empresa, cliente, configuracao) {
  const { certificado, segredo } = credencial(empresa);

  // Certificado do proprio CNPJ dispensa o parametro; matriz, filial ou
  // escritorio com procuracao consultam pelo cnpjConsulta.
  const cnpjConsulta = certificado.titularCnpj === cliente.cnpjDigits ? null : cliente.cnpjDigits;

  return {
    certificado,
    cnpjConsulta,
    adn: new ClienteAdn({
      pfx: segredo.pfx,
      senha: segredo.senha,
      base: configuracao.adnBase || ADN_PRODUCAO,
      ca: configuracao.adnCa,
      espacamentoMs: configuracao.espacamentoMs ?? 700,
      tentativas: configuracao.tentativas ?? 5,
      esperaMaximaMs: configuracao.esperaMaximaMs ?? 8000
    })
  };
}

/**
 * Cliente SEFAZ da empresa. A distribuicao de NF-e/CT-e so atende o
 * certificado da mesma raiz de CNPJ: procuracao vale no ADN, nao aqui.
 * Checar antes evita a rejeicao 593 e o consumo de uma consulta.
 */
function abrirSefaz(empresa, cliente, configuracao) {
  const { certificado, segredo } = credencial(empresa);
  const raizCertificado = certificado.raizCnpj || String(certificado.titularCnpj || "").slice(0, 8);
  if (!raizCertificado || raizCertificado !== cliente.cnpjDigits.slice(0, 8)) {
    throw new ErroCaptura("A SEFAZ so entrega NF-e e CT-e ao certificado da propria empresa (mesma raiz de CNPJ). " +
      "O certificado vinculado e de " + certificado.titular + ". Procuracao vale para a NFS-e, nao para a SEFAZ: " +
      "cadastre o A1 do cliente para esta fonte.", { definitivo: true, autenticacao: true });
  }
  if (!empresa.uf) {
    throw new ErroCaptura("Informe a UF da empresa na configuracao da captura: ela vai no pedido a SEFAZ",
      { definitivo: true });
  }
  return {
    certificado,
    segredo,
    sefaz: new ClienteSefaz({
      pfx: segredo.pfx,
      senha: segredo.senha,
      ambiente: configuracao.sefazAmbiente || "producao",
      endpoints: configuracao.sefazEndpoints || {},
      ca: configuracao.sefazCa,
      tentativas: configuracao.sefazTentativas ?? 3,
      esperaMaximaMs: configuracao.esperaMaximaMs ?? 8000,
      ...(configuracao.sefazEsperaMs !== undefined ? { esperaFimMs: configuracao.sefazEsperaMs } : {})
    })
  };
}

/**
 * Processa um lote: grava arquivos (assincrono), depois tudo no banco numa
 * transacao, incluindo o avanco do cursor. Devolve o que precisa de etapa
 * posterior (PDF, pasta, manifestacao).
 *
 * avancarPara: NSU que o cursor assume (SEFAZ devolve o ultNSU do lote);
 * null = maior NSU dos itens. semCursor: busca por faixa ou por chave, que
 * nao mexe no cursor nem no rastreio sequencial.
 */
async function processarLote({ itens, cliente, fonte, tarefaId, contador, semCursor = false, avancarPara = null,
  semRastreio = false }) {
  // 1. Le e guarda os XML fora da transacao (escrita em disco e assincrona).
  const preparados = [];
  for (const item of itens) {
    const base = { item };
    if (item.resumo) { preparados.push({ ...base, tipo: "resumo" }); continue; }
    if (item.erro) { preparados.push({ ...base, tipo: "falha", motivo: item.erro }); continue; }
    try {
      const documento = lerDocumento(item.xml, fonte + " NSU " + item.nsu);
      const guardado = await acervo.guardar(item.xml, "xml");
      preparados.push({ ...base, tipo: documento.kind === "Evento" ? "evento" : "documento", documento, guardado });
    } catch (erro) {
      preparados.push({ ...base, tipo: "falha", motivo: erro.message });
    }
  }

  // 2. Grava no banco e avanca o cursor, tudo ou nada.
  const novos = [];
  const eventosNovos = [];
  const resumosNovos = [];
  const regrasAtivas = regras.ativas();
  const registrar = (dados) => { if (!semRastreio) rastreio.registrar(dados); };

  transacao(() => {
    for (const p of preparados) {
      const { item } = p;
      const referenciaNsu = "NSU " + item.nsu;

      if (p.tipo === "resumo") {
        registrar({ clienteId: cliente.id, fonte, nsu: item.nsu, resultado: "resumo",
          chave: item.chave || null, tipoDocumento: item.tipo, tarefaId });
        const jaTem = item.chave ? documentos.porIdentidade(identidade(cliente.id, item.chave)) : null;
        if (!jaTem) {
          const r = item.dadosResumo;
          pendencias.abrir({ clienteId: cliente.id, fonte, tipo: "resumo_sem_xml",
            referencia: item.chave || referenciaNsu, chave: item.chave || null, nsu: item.nsu,
            situacao: item.situacaoPendencia || "aberta",
            dados: r ? { documento: "NF-e", emitente: r.emitente?.nome || null, emitenteCnpj: r.emitente?.cnpj || null,
              emissao: r.emissao ? String(r.emissao).slice(0, 10) : null, valor: r.valor ?? null, situacaoNota: r.situacao || null } : null,
            detalhe: item.detalhe || ("O portal informou o NSU " + item.nsu + (item.chave ? " e a chave" : "") +
              ", mas nao entregou o XML. Nova busca da faixa pode trazer o arquivo.") });
          resumosNovos.push(item);
        }
        contador.resumos += 1;
        continue;
      }

      if (p.tipo === "falha") {
        registrar({ clienteId: cliente.id, fonte, nsu: item.nsu, resultado: "falha",
          chave: item.chave || null, tipoDocumento: item.tipo, tarefaId });
        pendencias.abrir({ clienteId: cliente.id, fonte, tipo: "xml_invalido", referencia: referenciaNsu,
          chave: item.chave || null, nsu: item.nsu, detalhe: p.motivo });
        contador.falhas += 1;
        continue;
      }

      if (p.tipo === "evento") {
        const evento = p.documento;
        const chave = evento.key || item.chave;
        eventos.inserir({ clienteId: cliente.id, chave, nsu: item.nsu, tipo: evento.event,
          descricao: evento.description, motivo: evento.reason, quando: evento.issuedAt,
          caminho: p.guardado.caminho, sha256: p.guardado.sha256 });
        if (CANCELAMENTOS.has(evento.event)) documentos.marcarCancelado(chave, evento.reason);
        registrar({ clienteId: cliente.id, fonte, nsu: item.nsu, resultado: "evento",
          chave, tipoDocumento: "EVENTO", tarefaId });
        eventosNovos.push({ chave, tipo: evento.event });
        contador.eventos += 1;
        continue;
      }

      // Documento fiscal com XML.
      const documento = p.documento;
      const chave = documento.key || item.chave;
      const existente = documentos.porIdentidade(identidade(cliente.id, chave));

      if (existente) {
        const guardado = arquivos.um(existente.id, "xml");
        if (guardado && guardado.sha256 !== p.guardado.sha256) {
          pendencias.abrir({ clienteId: cliente.id, fonte, tipo: "xml_divergente", referencia: chave, chave,
            nsu: item.nsu, documentoId: existente.id,
            detalhe: "NSU " + item.nsu + " trouxe XML diferente do ja guardado (" + guardado.sha256.slice(0, 12) +
              " x " + p.guardado.sha256.slice(0, 12) + "). O guardado foi mantido." });
        } else if (!guardado) {
          arquivos.salvar(existente.id, "xml", p.guardado);
        }
        registrar({ clienteId: cliente.id, fonte, nsu: item.nsu, resultado: "duplicado",
          chave, tipoDocumento: item.tipo, documentoId: existente.id, tarefaId });
        contador.duplicados += 1;
        continue;
      }

      const papel = papelDe(documento, cliente.cnpjDigits);
      const competencia = documento.competencia || (documento.issuedAt ? String(documento.issuedAt).slice(0, 7) : null);
      const registro = documentos.inserir(
        { ...documento, operation: operacaoDaEmpresa(papel), identity: identidade(cliente.id, chave), key: chave },
        { clienteId: cliente.id, capturadoPor: "captura " + fonte, fonte, nsu: item.nsu, papel, competencia }
      );
      arquivos.salvar(registro.id, "xml", p.guardado);
      conferencias.salvar(conferirSemDerrubar(documento, regrasAtivas, chave),
        { clienteId: cliente.id, documentoId: registro.id });

      registrar({ clienteId: cliente.id, fonte, nsu: item.nsu, resultado: "documento",
        chave, tipoDocumento: item.tipo, documentoId: registro.id, tarefaId });

      // O que estava pendente desta nota deixou de estar.
      for (const tipo of ["resumo_sem_xml", "nota_referenciada_ausente"]) {
        pendencias.resolverPorReferencia({ clienteId: cliente.id, fonte, tipo, referencia: chave });
      }
      pendencias.resolverPorReferencia({ clienteId: cliente.id, fonte, tipo: "resumo_sem_xml", referencia: referenciaNsu });
      pendencias.resolverPorReferencia({ clienteId: cliente.id, fonte, tipo: "xml_invalido", referencia: referenciaNsu });

      novos.push({ registro, documento, papel, xml: item.xml, xmlGuardado: p.guardado });
      contador[papel === "emitida" ? "emitidas" : papel === "recebida" ? "recebidas" : "outras"] += 1;
      contador.porCompetencia[competencia || "sem"] = (contador.porCompetencia[competencia || "sem"] || 0) + 1;
    }

    if (!semCursor) {
      const maior = avancarPara ?? Math.max(...itens.map((item) => item.nsu).filter(Number.isFinite));
      if (Number.isFinite(maior)) cursores.avancar(cliente.id, fonte, maior);
    }
  });

  return { novos, eventosNovos, resumosNovos };
}

/**
 * A conferencia tributaria nao pode custar o documento: se ela falhar, o XML
 * fica guardado e a nota aparece como "Atencao" com o motivo.
 */
function conferirSemDerrubar(documento, regrasAtivas, chave) {
  try {
    return conferir(documento, regrasAtivas);
  } catch (erro) {
    return {
      documentKey: chave, kind: documento.kind, number: documento.number, issuedAt: documento.issuedAt,
      emitter: documento.emitter?.cnpj || null,
      findings: [{
        code: "CONFERENCIA_FALHOU", severity: "atencao", scope: "documento", item: null, expected: null, found: null,
        difference: null, title: "A conferencia automatica nao rodou neste documento",
        basis: erro.message, rule: "Documento guardado; refaca a conferencia depois da correcao"
      }],
      summary: { total: 1, critico: 0, atencao: 1, informativo: 0, status: "Atencao" }
    };
  }
}

/** PDF de cada tipo de documento. NFC-e nao tem representacao aqui. */
function geradorPdf(kind) {
  if (kind === "NFS-e") return gerarDanfse;
  if (kind === "NF-e") return gerarDanfe;
  if (kind === "CT-e") return gerarDacte;
  return null;
}

/** Gera o PDF de cada nota nova; falha vira pendencia e nao derruba nada. */
async function gerarPdfs(novos, cliente, fonte, contador) {
  for (const novo of novos) {
    const gerar = geradorPdf(novo.documento.kind);
    // NFS-e de prefeitura (ABRASF): o PDF e o da prefeitura, quando vem junto.
    if (!gerar || novo.documento.standard === "ABRASF") continue;
    try {
      const pdf = await gerar(novo.xml, { marcaDagua: marcaDaguaDe(novo.registro.key) });
      const guardado = await acervo.guardar(pdf, "pdf");
      arquivos.salvar(novo.registro.id, "pdf", guardado);
      pendencias.resolverPorReferencia({ clienteId: cliente.id, fonte, tipo: "pdf_nao_gerado", referencia: novo.registro.key });
      contador.pdfs += 1;
    } catch (erro) {
      pendencias.abrir({ clienteId: cliente.id, fonte, tipo: "pdf_nao_gerado", referencia: novo.registro.key,
        chave: novo.registro.key, documentoId: novo.registro.id, detalhe: erro.message });
      contador.pdfFalhas += 1;
    }
  }
}

/** Agenda o espelho dos arquivos de um documento na pasta do cliente. */
export function agendarEspelho(documento, empresa, cliente) {
  if (!empresa?.pastaDestino || !querPapel(empresa.tipos, documento.papel)) return 0;
  let agendados = 0;
  const lista = arquivos.doDocumento(documento.id);
  for (const tipoArquivo of ["xml", "pdf"]) {
    const arquivo = lista[tipoArquivo];
    if (!arquivo) continue;
    const nome = nomeArquivo({
      numero: documento.number, papel: documento.papel, emitente: documento.emitter?.name,
      destinatario: documento.recipient?.name, nsu: documento.nsu, chave: documento.key, tipo: documento.kind
    }, tipoArquivo);
    gravacoes.agendar({
      documentoId: documento.id,
      tipoArquivo,
      clienteId: cliente.id,
      destino: caminhoRelativo({ cnpj: cliente.cnpjDigits, competencia: documento.competencia,
        papel: documento.papel, tipoArquivo, arquivo: nome, tipo: documento.kind }),
      sha256: arquivo.sha256
    });
    agendados += 1;
  }
  // Os eventos da nota (cancelamento, substituicao, ciencia, carta de correcao)
  // vao junto, na pasta EVENTOS do mes da nota, como a extensao fazia. Cada um
  // vira um arquivo da propria nota: o espelho e o agente local gravam igual.
  for (const evento of eventos.daChave(documento.key, cliente.id)) {
    if (!evento.caminho || !evento.sha256) continue;
    const tipoArquivo = "evento-" + evento.sha256.slice(0, 12);
    if (!lista[tipoArquivo]) arquivos.salvar(documento.id, tipoArquivo, { caminho: evento.caminho, sha256: evento.sha256, tamanho: 0 });
    gravacoes.agendar({
      documentoId: documento.id,
      tipoArquivo,
      clienteId: cliente.id,
      destino: caminhoRelativo({ cnpj: cliente.cnpjDigits, competencia: documento.competencia, papel: documento.papel,
        tipoArquivo: "xml", tipo: "Evento",
        arquivo: nomeEvento({ tipo: evento.tipo, numero: documento.number, chave: documento.key, sha256: evento.sha256 }) }),
      sha256: evento.sha256
    });
    agendados += 1;
  }
  return agendados;
}

// NFS-e, NF-e e CT-e da mesma empresa rodam em paralelo (a trava da fila e
// por empresa e fonte), mas a pasta e uma so: duas gravacoes simultaneas do
// mesmo arquivo disputam o rename. O espelho de cada empresa roda em fila.
const filaEspelho = new Map();

/**
 * Grava na pasta do cliente o que esta pendente, quando a pasta e acessivel a
 * este processo. Quando nao e (servidor na nuvem), deixa para o agente local.
 */
export function espelharPendentes(clienteId, opcoes = {}) {
  const anterior = filaEspelho.get(clienteId) || Promise.resolve();
  const atual = anterior.catch(() => {}).then(() => espelharAgora(clienteId, opcoes));
  filaEspelho.set(clienteId, atual);
  atual.finally(() => { if (filaEspelho.get(clienteId) === atual) filaEspelho.delete(clienteId); }).catch(() => {});
  return atual;
}

async function espelharAgora(clienteId, { modoPasta = "auto" } = {}) {
  const saida = { gravado: 0, ja_existia: 0, conflito: 0, erro: 0, paraAgente: 0 };
  const lista = gravacoes.pendentes({ clienteId, limite: 5000 });
  if (!lista.length) return saida;

  const pasta = lista[0].pastaDestino;
  // Pasta escolhida no navegador ("navegador:<nome>"): quem grava e a tela, no computador do escritorio.
  const doNavegador = String(pasta || "").startsWith("navegador:");
  const servidorGrava = !doNavegador && (modoPasta === "servidor" || (modoPasta === "auto" && await pastaAcessivel(pasta)));
  if (!servidorGrava) {
    saida.paraAgente = lista.length;
    return saida;
  }

  for (const item of lista) {
    try {
      const bytes = await acervo.ler(item.caminhoAcervo);
      const resultado = await gravarSemSobrescrever(item.pastaDestino, item.destino, bytes);
      gravacoes.marcar(item.documentoId, item.tipoArquivo, resultado.situacao, { por: "servidor" });
      saida[resultado.situacao] += 1;
      if (resultado.situacao === "conflito") {
        pendencias.abrir({ clienteId: item.clientId, fonte: "PASTA", tipo: "conflito_pasta",
          referencia: item.destino, documentoId: item.documentoId,
          detalhe: "Ja existe um arquivo diferente em " + resultado.caminho + ". Nada foi sobrescrito." });
      } else {
        pendencias.resolverPorReferencia({ clienteId: item.clientId, fonte: "PASTA", tipo: "gravacao_pasta", referencia: item.destino });
      }
    } catch (erro) {
      gravacoes.marcar(item.documentoId, item.tipoArquivo, "erro", { erro: erro.message, por: "servidor" });
      pendencias.abrir({ clienteId: item.clientId, fonte: "PASTA", tipo: "gravacao_pasta",
        referencia: item.destino, documentoId: item.documentoId, detalhe: erro.message });
      saida.erro += 1;
    }
  }
  return saida;
}

/**
 * Agenda o espelho de toda nota do acervo que ainda nao tem. Devolve quantos
 * documentos foram agendados aqui: diferente de zero significa que algo tinha
 * ficado para tras (queda, pasta configurada depois).
 */
export function reconciliarEspelho(empresa, cliente) {
  if (!empresa?.pastaDestino) return 0;
  let agendados = 0;
  for (const id of gravacoes.documentosSemEspelho(cliente.id)) {
    if (agendarEspelho(documentos.porId(id), empresa, cliente)) agendados += 1;
  }
  // Evento que chegou depois da nota ja estar na pasta.
  for (const id of eventos.documentosComEventoSemArquivo(cliente.id)) {
    if (agendarEspelho(documentos.porId(id), empresa, cliente)) agendados += 1;
  }
  return agendados;
}

/**
 * Pasta nova: agenda de novo cada documento da empresa, recalculando o caminho
 * dentro da pasta (o de uma versao antiga pode ter outra arrumacao).
 */
export function reagendarEspelho(empresa, cliente) {
  if (!empresa?.pastaDestino) return 0;
  let agendados = 0;
  for (const id of gravacoes.documentosComArquivo(cliente.id)) {
    if (agendarEspelho(documentos.porId(id), empresa, cliente)) agendados += 1;
  }
  return agendados;
}

/** CNPJ do emitente embutido na chave de acesso de NF-e e CT-e (posicoes 7 a 20). */
function emitenteDaChave(chave) {
  return /^\d{44}$/.test(String(chave || "")) ? chave.slice(6, 20) : null;
}

/**
 * Eventos de notas que nao estao no acervo: identificadas e nao capturadas.
 * Na SEFAZ, evento de nota que a propria empresa emitiu (manifestacao do
 * cliente dela, por exemplo) nao e falta: a distribuicao nunca entrega ao
 * emitente o XML que ele mesmo emitiu.
 */
function conferirEventosOrfaos(cliente, fonte, eventosVistos) {
  let orfaos = 0;
  let deEmitidas = 0;
  for (const evento of eventosVistos) {
    if (!evento.chave) continue;
    if (documentos.porIdentidade(identidade(cliente.id, evento.chave))) {
      pendencias.resolverPorReferencia({ clienteId: cliente.id, fonte, tipo: "nota_referenciada_ausente", referencia: evento.chave });
      continue;
    }
    if (fonte !== "ADN" && emitenteDaChave(evento.chave) === cliente.cnpjDigits) {
      deEmitidas += 1;
      continue;
    }
    pendencias.abrir({ clienteId: cliente.id, fonte, tipo: "nota_referenciada_ausente", referencia: evento.chave,
      chave: evento.chave,
      detalhe: "O portal entregou o evento " + evento.tipo + " da chave " + evento.chave +
        ", mas a nota em si nao veio. Pode ser anterior ao periodo que o portal ainda mantem." });
    orfaos += 1;
  }
  return { orfaos, deEmitidas };
}

/** Lacunas de NSU: registradas como confirmadas pelo portal, nao como falta. */
function registrarLacunas(clienteId, fonte) {
  const lacunas = rastreio.lacunas(clienteId, fonte);
  for (const lacuna of lacunas) {
    const referencia = lacuna.de === lacuna.ate ? "NSU " + lacuna.de : "NSU " + lacuna.de + "-" + lacuna.ate;
    pendencias.abrir({ clienteId, fonte, tipo: "lacuna_nsu", referencia, nsu: lacuna.de, situacao: "confirmada",
      detalhe: "O portal pulou " + (lacuna.ate - lacuna.de + 1) + " NSU entre os documentos que entregou. " +
        "Pela forma como o lote funciona, nao ha documento deste contribuinte nesses numeros." });
  }
  return lacunas.length;
}

/** Nota cancelada ou substituida depois do PDF: regera com a marca d'agua. */
async function aplicarEventosNosPdfs({ eventosVistos, novosTodos, cliente, empresa, fonte }) {
  // Nota cancelada no mesmo lote que chegou: o PDF ja foi gerado sem marca.
  for (const evento of eventosVistos) {
    const novo = novosTodos.find((item) => item.registro.key === evento.chave);
    if (novo && (CANCELAMENTOS.has(evento.tipo) || evento.tipo === SUBSTITUICAO)) {
      await gerarPdfs([novo], cliente, fonte, { pdfs: 0, pdfFalhas: 0 });
    }
  }
  // Evento de nota que ja estava no acervo antes: regera o PDF com a marca.
  for (const evento of eventosVistos) {
    if (novosTodos.some((item) => item.registro.key === evento.chave)) continue;
    const existente = documentos.porIdentidade(identidade(cliente.id, evento.chave));
    if (!existente || !(CANCELAMENTOS.has(evento.tipo) || evento.tipo === SUBSTITUICAO)) continue;
    const xml = arquivos.um(existente.id, "xml");
    if (!xml) continue;
    const bytes = await acervo.ler(xml.caminho);
    await gerarPdfs([{ registro: existente, documento: existente, xml: bytes.toString("utf8") }], cliente, fonte,
      { pdfs: 0, pdfFalhas: 0 });
    agendarEspelho(documentos.porId(existente.id), empresa, cliente);
  }
}

async function finalizarEspelho(empresa, cliente, configuracao) {
  let espelho = { gravado: 0, ja_existia: 0, conflito: 0, erro: 0, paraAgente: 0, reconciliados: 0 };
  if (empresa?.pastaDestino) {
    espelho.reconciliados = reconciliarEspelho(empresa, cliente);
    espelho = { ...espelho, ...(await espelharPendentes(cliente.id, { modoPasta: configuracao.modoPasta })) };
  }
  return espelho;
}

function novoContador() {
  return {
    lotes: 0, emitidas: 0, recebidas: 0, outras: 0, eventos: 0, duplicados: 0, resumos: 0,
    falhas: 0, pdfs: 0, pdfFalhas: 0, porCompetencia: {}
  };
}

/**
 * Sincroniza uma empresa a partir do cursor (ou so uma faixa de NSU, sem
 * mexer no cursor). Lanca ErroCaptura/ErroAdn/ErroSefaz; quem chama decide se
 * repete.
 */
export async function sincronizarEmpresa({ clienteId, fonte = "ADN", tarefaId = null, configuracao = {}, faixa = null,
  soCopiar = false }) {
  if (fonte === "NFE" || fonte === "CTE") return sincronizarSefaz({ clienteId, fonte, tarefaId, configuracao, faixa });
  if (fonte === "PONTE") return sincronizarPonte({ clienteId, tarefaId, configuracao, faixa, soCopiar });
  if (fonte !== "ADN") throw new ErroCaptura("Fonte " + fonte + " nao existe", { definitivo: true });

  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  const empresa = empresasCaptura.porCliente(clienteId);
  if (!faixa && !empresa?.ativa) throw new ErroCaptura("Captura desativada para esta empresa", { definitivo: true });

  const { adn, cnpjConsulta, certificado } = abrirCliente(empresa, cliente, configuracao);
  const inicio = Date.now();
  const nsuInicial = faixa ? faixa.de - 1 : cursores.ler(clienteId, fonte).ultimoNsu;
  let cursor = nsuInicial;
  const contador = novoContador();
  const novosTodos = [];
  const eventosVistos = [];

  try {
    for (let lote = 0; lote < (configuracao.limiteLotes ?? 5000); lote += 1) {
      const resposta = await adn.lote(cursor, { cnpjConsulta });
      if (resposta.fim) break;

      let itens = resposta.documentos.filter((item) => Number.isFinite(item.nsu) && item.nsu > cursor)
        .sort((a, b) => a.nsu - b.nsu);
      if (!itens.length) break;
      const maior = itens.at(-1).nsu;
      if (faixa) itens = itens.filter((item) => item.nsu >= faixa.de && item.nsu <= faixa.ate);

      contador.lotes += 1;
      const { novos, eventosNovos } = await processarLote({
        itens, cliente, fonte, tarefaId, contador, semCursor: Boolean(faixa)
      });
      novosTodos.push(...novos);
      eventosVistos.push(...eventosNovos);

      // O PDF sai logo apos o lote: interrupcao depois daqui perde no maximo
      // PDFs, que a pendencia recupera.
      await gerarPdfs(novos, cliente, fonte, contador);
      if (empresa?.pastaDestino) {
        for (const novo of novos) agendarEspelho(documentos.porId(novo.registro.id), empresa, cliente);
      }

      if (maior <= cursor) break;
      cursor = maior;
      if (faixa && cursor >= faixa.ate) break;
    }
  } finally {
    adn.fechar();
  }

  await aplicarEventosNosPdfs({ eventosVistos, novosTodos, cliente, empresa, fonte });
  const { orfaos } = conferirEventosOrfaos(cliente, fonte, eventosVistos);
  const lacunas = registrarLacunas(clienteId, fonte);
  const espelho = await finalizarEspelho(empresa, cliente, configuracao);

  if (!faixa) cursores.marcarSucesso(clienteId, fonte);

  return {
    fonte,
    empresa: cliente.name,
    cnpj: cliente.cnpj,
    certificado: certificado.titular,
    viaProcuracao: Boolean(cnpjConsulta),
    nsuInicial,
    nsuFinal: cursor,
    chamadas: adn.chamadas,
    duracaoMs: Date.now() - inicio,
    ...contador,
    novos: contador.emitidas + contador.recebidas + contador.outras,
    notasReferenciadasAusentes: orfaos,
    lacunasNsu: lacunas,
    espelho
  };
}

// ------------------------------------------------------------------ SEFAZ

/**
 * docZip da SEFAZ para o formato de item do lote.
 * procNFe/procCTe: documento; resNFe: resumo (XML so depois da ciencia);
 * resEvento/procEvento: evento.
 */
function itemSefaz(doc, fonte) {
  const base = { nsu: doc.nsu, tipo: (doc.schema || "").replace(/_v[\d.]+\.xsd$/, "") || fonte };
  if (doc.erro || !doc.xml) return { ...base, erro: doc.erro || "docZip vazio" };
  if (base.tipo === "resNFe") {
    const resumo = lerResumoNfe(doc.xml);
    if (!resumo) return { ...base, erro: "resNFe ilegivel" };
    const cancelada = resumo.situacao === "cancelada";
    const descricao = "NF-e de " + (resumo.emitente.nome || resumo.emitente.cnpj) + ", emitida em " +
      String(resumo.emissao || "").slice(0, 10) + ", " + brl(resumo.valor) + ".";
    return {
      ...base,
      resumo: true,
      chave: resumo.chave,
      dadosResumo: resumo,
      situacaoPendencia: cancelada ? "confirmada" : "aberta",
      detalhe: cancelada
        ? descricao + " Nota CANCELADA pelo emitente: a SEFAZ nao entrega o XML de nota cancelada."
        : descricao + " A SEFAZ so entrega o XML completo depois da manifestacao do destinatario " +
          "(Ciencia da Operacao). Manifeste aqui ou ative a ciencia automatica da empresa."
    };
  }
  return { ...base, xml: doc.xml };
}

/** Envia a Ciencia da Operacao de uma nota e registra o resultado. */
async function enviarCiencia({ sefaz, assinatura, cliente, chave, origem, usuario = null }) {
  let resultado;
  try {
    resultado = await sefaz.manifestar({
      cnpj: cliente.cnpjDigits, chave, chavePrivada: assinatura.chavePrivada, certificadoDer: assinatura.certificadoDer
    });
  } catch (erro) {
    const registro = manifestacoes.registrar({ clienteId: cliente.id, chave, tipoEvento: CIENCIA, situacao: "erro",
      motivo: erro.message, origem, usuario });
    return { aceita: false, registro, motivo: erro.message, transitorio: Boolean(erro.transitorio) };
  }
  const aceita = manifestacaoAceita(resultado.cStat);
  const guardado = await acervo.guardar(resultado.xmlEnviado, "xml");
  const registro = manifestacoes.registrar({
    clienteId: cliente.id, chave, tipoEvento: CIENCIA, situacao: aceita ? "aceita" : "recusada",
    protocolo: resultado.protocolo || null, cStat: resultado.cStat, motivo: resultado.motivo, origem, usuario,
    caminho: guardado.caminho, sha256: guardado.sha256
  });
  if (aceita && !documentos.porIdentidade(identidade(cliente.id, chave))) {
    pendencias.abrir({ clienteId: cliente.id, fonte: "NFE", tipo: "resumo_sem_xml", referencia: chave, chave,
      detalhe: "Ciencia da Operacao registrada" + (resultado.protocolo ? " (protocolo " + resultado.protocolo + ")" : "") +
        ". O XML completo chega numa proxima consulta a SEFAZ." });
  }
  return { aceita, registro, cStat: resultado.cStat, motivo: resultado.motivo, protocolo: resultado.protocolo };
}

/** Converte erro da SEFAZ em decisao para a fila (adiar, repetir, encerrar). */
function tratarErroSefaz(erro, clienteId, fonte) {
  if (erro instanceof ErroSefaz && erro.bloquearMs) {
    const ate = Date.now() + erro.bloquearMs;
    cursores.bloquear(clienteId, fonte, ate);
    return new ErroCaptura(erro.message + " Nova consulta liberada as " + horario(ate) + ".", { adiarAte: ate });
  }
  if (erro instanceof ErroSefaz && !erro.transitorio) erro.definitivo = true;
  return erro;
}

async function sincronizarSefaz({ clienteId, fonte, tarefaId, configuracao, faixa }) {
  if (faixa) {
    throw new ErroCaptura("A SEFAZ nao tem busca por faixa de NSU: para nota especifica use a consulta por chave",
      { definitivo: true });
  }
  const modelo = fonte === "NFE" ? "nfe" : "cte";
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  const empresa = empresasCaptura.porCliente(clienteId);
  if (!empresa?.ativa) throw new ErroCaptura("Captura desativada para esta empresa", { definitivo: true });

  const estado = cursores.ler(clienteId, fonte);
  if (estado.bloqueadoAte && estado.bloqueadoAte > Date.now()) {
    throw new ErroCaptura("SEFAZ: esta empresa ja foi consultada ate o fim ha menos de uma hora. " +
      "Nova consulta liberada as " + horario(estado.bloqueadoAte) + " (regra da SEFAZ contra consumo indevido).",
    { adiarAte: estado.bloqueadoAte });
  }

  const { sefaz, certificado, segredo } = abrirSefaz(empresa, cliente, configuracao);
  const inicio = Date.now();
  const nsuInicial = estado.ultimoNsu;
  let cursor = nsuInicial;
  let liberaEm = null;
  const contador = novoContador();
  const novosTodos = [];
  const eventosVistos = [];
  const ciencias = { enviadas: 0, aceitas: [], recusadas: [] };
  let assinatura = null;

  try {
    for (let lote = 0; lote < (configuracao.limiteLotes ?? 5000); lote += 1) {
      let resposta;
      try {
        resposta = await sefaz.distribuicao(modelo, { cnpj: cliente.cnpjDigits, uf: empresa.uf, ultNSU: cursor });
      } catch (erro) {
        throw tratarErroSefaz(erro, clienteId, fonte);
      }

      const itens = resposta.documentos.filter((doc) => Number.isFinite(doc.nsu) && doc.nsu > cursor)
        .sort((a, b) => a.nsu - b.nsu)
        .map((doc) => itemSefaz(doc, fonte));
      const proximo = Math.max(cursor, resposta.ultNSU || 0, ...itens.map((item) => item.nsu));

      if (itens.length) {
        contador.lotes += 1;
        const { novos, eventosNovos } = await processarLote({
          itens, cliente, fonte, tarefaId, contador, avancarPara: proximo
        });
        novosTodos.push(...novos);
        eventosVistos.push(...eventosNovos);
        await gerarPdfs(novos, cliente, fonte, contador);
        if (empresa.pastaDestino) {
          for (const novo of novos) agendarEspelho(documentos.porId(novo.registro.id), empresa, cliente);
        }
      } else if (proximo > cursor) {
        cursores.avancar(clienteId, fonte, proximo);
      }

      if (resposta.fim) {
        liberaEm = Date.now() + resposta.bloquearMs;
        cursores.bloquear(clienteId, fonte, liberaEm);
        break;
      }
      if (proximo <= cursor) break;
      cursor = proximo;
    }

    // Ciencia automatica: so com opcao explicita da empresa, so NF-e. Alcanca
    // todo resumo em aberto, inclusive os de antes de a opcao ser ligada.
    // Resumo de nota cancelada fica "confirmada" e nao entra aqui.
    if (fonte === "NFE" && empresa.manifestarCiencia) {
      const abertas = pendencias.listar({ clienteId, situacao: "aberta", tipo: "resumo_sem_xml", limite: 5000 })
        .filter((item) => item.fonte === "NFE" && /^\d{44}$/.test(item.chave || ""));
      for (const pendencia of abertas) {
        if (ciencias.enviadas >= (configuracao.limiteCiencias ?? 500)) break;
        const anterior = manifestacoes.porChave(cliente.id, pendencia.chave, CIENCIA);
        if (anterior?.situacao === "aceita" || anterior?.situacao === "recusada") continue;
        assinatura ||= abrirParaAssinatura(segredo.pfx, segredo.senha);
        const resultado = await enviarCiencia({ sefaz, assinatura, cliente, chave: pendencia.chave, origem: "automatica" });
        ciencias.enviadas += 1;
        (resultado.aceita ? ciencias.aceitas : ciencias.recusadas)
          .push({ chave: pendencia.chave, cStat: resultado.cStat || null, motivo: resultado.motivo || null });
      }
    }
  } finally {
    sefaz.fechar();
  }

  await aplicarEventosNosPdfs({ eventosVistos, novosTodos, cliente, empresa, fonte });
  const { orfaos, deEmitidas } = conferirEventosOrfaos(cliente, fonte, eventosVistos);
  const lacunas = registrarLacunas(clienteId, fonte);
  const espelho = await finalizarEspelho(empresa, cliente, configuracao);
  cursores.marcarSucesso(clienteId, fonte);

  return {
    fonte,
    empresa: cliente.name,
    cnpj: cliente.cnpj,
    certificado: certificado.titular,
    viaProcuracao: false,
    nsuInicial,
    nsuFinal: cursores.ler(clienteId, fonte).ultimoNsu,
    chamadas: sefaz.chamadas,
    duracaoMs: Date.now() - inicio,
    ...contador,
    novos: contador.emitidas + contador.recebidas + contador.outras,
    notasReferenciadasAusentes: orfaos,
    eventosDeNotasEmitidas: deEmitidas,
    lacunasNsu: lacunas,
    ciencias,
    liberaEm: liberaEm ? new Date(liberaEm).toISOString() : null,
    // Ciencia aceita: o XML completo so vem na proxima consulta, que a regra
    // da SEFAZ libera em uma hora. Quem chama agenda a volta.
    seguimentoEm: ciencias.aceitas.length && liberaEm ? liberaEm : null,
    espelho
  };
}

/**
 * Ciencia da Operacao pedida por uma pessoa (pendencia de resumo), seguida da
 * consulta pela chave: se a SEFAZ ja liberou o XML, ele entra na hora.
 */
export async function cienciaManual({ clienteId, chave, usuario, configuracao = {} }) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  if (!/^\d{44}$/.test(String(chave || ""))) throw new ErroCaptura("Chave de acesso invalida", { definitivo: true });
  const empresa = empresasCaptura.porCliente(clienteId);
  const { sefaz, segredo } = abrirSefaz(empresa, cliente, configuracao);
  try {
    const assinatura = abrirParaAssinatura(segredo.pfx, segredo.senha);
    const resultado = await enviarCiencia({ sefaz, assinatura, cliente, chave, origem: "manual", usuario });
    let baixado = null;
    if (resultado.aceita) {
      try {
        baixado = await baixarPorChave({ sefaz, cliente, empresa, chave, configuracao });
      } catch (erro) {
        // 656 vale para o CNPJ inteiro: a captura por NSU tambem precisa esperar.
        if (erro.bloquearMs) cursores.bloquear(cliente.id, "NFE", Date.now() + erro.bloquearMs);
        baixado = { novos: 0, erro: erro.message };
      }
    }
    return { ...resultado, baixado };
  } finally {
    sefaz.fechar();
  }
}

/** Consulta uma NF-e pela chave (consChNFe) e processa o que vier, sem mexer no cursor. */
async function baixarPorChave({ sefaz, cliente, empresa, chave, configuracao }) {
  const resposta = await sefaz.distribuicao("nfe", { cnpj: cliente.cnpjDigits, uf: empresa.uf, chave });
  const itens = resposta.documentos.map((doc) => itemSefaz(doc, "NFE"));
  const contador = novoContador();
  if (!itens.length) return { novos: 0, resumos: 0, motivo: resposta.motivo };
  const { novos } = await processarLote({
    itens, cliente, fonte: "NFE", tarefaId: null, contador, semCursor: true, semRastreio: true
  });
  await gerarPdfs(novos, cliente, "NFE", contador);
  if (empresa.pastaDestino) {
    for (const novo of novos) agendarEspelho(documentos.porId(novo.registro.id), empresa, cliente);
    await espelharPendentes(cliente.id, { modoPasta: configuracao.modoPasta });
  }
  return { novos: novos.length, resumos: contador.resumos, pdfs: contador.pdfs, motivo: resposta.motivo };
}

// A SEFAZ bloqueia o CNPJ (656) quando a consulta por chave passa do razoavel.
export const LIMITE_CHAVES_POR_VEZ = 20;

/**
 * Baixa NF-e pela chave de acesso, para a empresa DESTINATARIA, com o A1 dela
 * (consulta consChNFe da distribuicao). O que nao da para baixar volta com o
 * motivo, chave por chave:
 *   - CT-e nao tem consulta por chave: chega pela captura de CT-e (NSU);
 *   - NFC-e nao e distribuida ao comprador;
 *   - a SEFAZ nao devolve ao emitente a nota que ele mesmo emitiu;
 *   - nota so em resumo depende da Ciencia da Operacao (automatica, se a
 *     empresa permitir; senao fica a pendencia com o botao).
 */
export async function baixarPorChaves({ clienteId, chaves, usuario = null, configuracao = {} }) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  const lista = [...new Set((chaves || []).map((item) => String(item).replace(/\D/g, "")).filter(Boolean))];
  if (!lista.length) throw new ErroCaptura("Informe ao menos uma chave de acesso", { definitivo: true });
  if (lista.length > LIMITE_CHAVES_POR_VEZ) {
    throw new ErroCaptura("Maximo de " + LIMITE_CHAVES_POR_VEZ + " chaves por vez: consulta em excesso faz a SEFAZ " +
      "bloquear o CNPJ por uma hora", { definitivo: true });
  }
  const empresa = empresasCaptura.porCliente(clienteId);
  const resultados = [];
  const anotar = (chave, situacao, motivo) => resultados.push({ chave, situacao, motivo });
  const paraConsultar = [];

  for (const chave of lista) {
    const modelo = chave.slice(20, 22);
    if (documentos.porIdentidade(identidade(clienteId, chave))) {
      anotar(chave, "ja_no_acervo", "A nota ja esta no acervo desta empresa");
    } else if (modelo === "57" || modelo === "67") {
      anotar(chave, "fora_do_alcance", "CT-e: a SEFAZ nao tem consulta por chave. Ele chega pela captura de CT-e da empresa");
    } else if (modelo === "65") {
      anotar(chave, "fora_do_alcance", "NFC-e: a SEFAZ nao distribui cupom ao comprador");
    } else if (modelo !== "55") {
      anotar(chave, "fora_do_alcance", "Modelo " + modelo + " nao e NF-e");
    } else if (emitenteDaChave(chave) === cliente.cnpjDigits) {
      anotar(chave, "fora_do_alcance", "Nota emitida pela propria empresa: a SEFAZ nao devolve ao emitente. " +
        "Importe o XML do emissor");
    } else {
      paraConsultar.push(chave);
    }
  }

  if (paraConsultar.length) {
    const { sefaz, segredo } = abrirSefaz(empresa, cliente, configuracao);
    let assinatura = null;
    try {
      for (let indice = 0; indice < paraConsultar.length; indice += 1) {
        const chave = paraConsultar[indice];
        try {
          let baixado = await baixarPorChave({ sefaz, cliente, empresa, chave, configuracao });
          if (!baixado.novos && baixado.resumos && empresa.manifestarCiencia) {
            assinatura ||= abrirParaAssinatura(segredo.pfx, segredo.senha);
            const ciencia = await enviarCiencia({ sefaz, assinatura, cliente, chave, origem: "chave", usuario });
            if (ciencia.aceita) baixado = await baixarPorChave({ sefaz, cliente, empresa, chave, configuracao });
            else { anotar(chave, "resumo", "Ciencia recusada pela SEFAZ: " + (ciencia.motivo || "sem motivo")); continue; }
          }
          if (baixado.novos) anotar(chave, "baixada", "XML e PDF no acervo");
          else if (baixado.resumos) {
            anotar(chave, "resumo", "A SEFAZ so entrega o XML depois da Ciencia da Operacao: use Manifestar ciencia " +
              "na pendencia, ou ligue a ciencia automatica da empresa");
          } else {
            anotar(chave, "nao_encontrada", "A SEFAZ nao tem esta nota para o CNPJ " + cliente.cnpj + " (" +
              (baixado.motivo || "nenhum documento") + "). A empresa precisa ser a destinataria, e a SEFAZ so guarda " +
              "os ultimos meses");
          }
        } catch (erro) {
          if (erro.bloquearMs) {
            cursores.bloquear(cliente.id, "NFE", Date.now() + erro.bloquearMs);
            for (const resto of paraConsultar.slice(indice)) {
              anotar(resto, "adiada", "A SEFAZ pediu uma hora de espera (consumo indevido). Tente depois de " +
                horario(Date.now() + erro.bloquearMs));
            }
            break;
          }
          if (erro.autenticacao) throw erro;
          anotar(chave, "recusada", erro.message);
        }
      }
    } finally {
      sefaz.fechar();
    }
  }

  const contar = (situacao) => resultados.filter((item) => item.situacao === situacao).length;
  return {
    empresa: cliente.name,
    resultados,
    baixadas: contar("baixada"),
    resumos: contar("resumo"),
    jaNoAcervo: contar("ja_no_acervo"),
    naoBaixadas: resultados.length - contar("baixada") - contar("ja_no_acervo")
  };
}

// ------------------------------------------------------------- importacao

/**
 * Identificador de documento importado. Chave nacional quando ha (NF-e, CT-e,
 * NFS-e do padrao nacional); NFS-e de prefeitura (ABRASF) nao tem chave unica,
 * entao vale CNPJ do prestador + numero + serie.
 */
function chaveDoImportado(documento) {
  const chave = String(documento.key || "");
  if (/^\d{44}$/.test(chave) || /^\d{50}$/.test(chave)) return chave;
  return [documento.emitter?.cnpj || "sem-cnpj", documento.number || chave, documento.series].filter(Boolean).join("-");
}

/** O XML precisa ser desta empresa: emitente, destinatario ou citado nele. */
function mencionaEmpresa(documento, xml, cnpj) {
  if (documento.emitter?.cnpj === cnpj || documento.recipient?.doc === cnpj) return true;
  return String(xml).includes(cnpj);
}

/** ZIP aberto em arquivos soltos; cada item sabe de qual arquivo veio. */
function expandirArquivos(arquivos, limiteBytes = 512 * 1024 * 1024) {
  const saida = [];
  let total = 0;
  for (const arquivo of arquivos) {
    const bytes = Buffer.isBuffer(arquivo.bytes) ? arquivo.bytes : Buffer.from(arquivo.bytes || []);
    if (isZip(bytes)) {
      try {
        for (const entrada of listZip(bytes)) {
          total += entrada.uncompressedSize;
          if (total > limiteBytes) throw new Error("conteudo descomprimido passa do limite");
          saida.push({ arquivo: arquivo.nome, nome: entrada.name.split("/").pop(), origem: arquivo.nome + "/" + entrada.name,
            bytes: readEntry(bytes, entrada) });
        }
      } catch (erro) {
        saida.push({ arquivo: arquivo.nome, nome: arquivo.nome, origem: arquivo.nome, erro: "ZIP ilegivel: " + erro.message });
      }
      continue;
    }
    saida.push({ arquivo: arquivo.nome, nome: arquivo.nome, origem: arquivo.nome, bytes });
  }
  return saida;
}

const baseDoNome = (nome) => String(nome).replace(/\.[^.]+$/, "").toLowerCase();

/**
 * Importa XML que nao vem de portal com NSU: NFS-e de prefeitura com sistema
 * proprio, NF-e que a propria empresa emitiu (a SEFAZ nao devolve ao
 * emitente), nota recebida por e-mail. Entra no mesmo acervo, na mesma
 * conferencia e na mesma pasta que a captura.
 *
 * O PDF de mesmo nome do XML (o da prefeitura, por exemplo) e guardado junto;
 * sem ele, NF-e, CT-e e NFS-e nacional ganham PDF gerado aqui. Arquivo que nao
 * menciona o CNPJ da empresa e recusado: nao entra nota de outro cliente.
 *
 * @param {Array<{nome:string, bytes:Buffer}>} arquivos  XML, ZIP ou PDF
 */
export async function importarArquivos({ clienteId, arquivos: recebidos, usuario = null, origem = "upload", configuracao = {},
  fonte: fonteImportacao = "IMPORTACAO" }) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  const empresa = empresasCaptura.porCliente(clienteId);
  const cnpj = cliente.cnpjDigits;
  const itens = expandirArquivos(recebidos);
  const pdfs = new Map(itens.filter((item) => item.bytes && /\.pdf$/i.test(item.nome)).map((item) => [baseDoNome(item.nome), item]));
  const pdfsUsados = new Set();
  const resultado = {
    arquivos: [], novos: 0, emitidas: 0, recebidas: 0, outras: 0, duplicados: 0, eventos: 0, recusados: 0,
    pdfsAnexados: 0, pdfsGerados: 0, semPdf: 0, porTipo: {}
  };
  const anotar = (item, situacao, motivo = null, extra = {}) =>
    resultado.arquivos.push({ arquivo: item.arquivo, nome: item.origem, situacao, motivo, ...extra });
  const regrasAtivas = regras.ativas();
  const paraGerarPdf = [];
  const registros = [];
  const eventosVistos = [];

  for (const item of itens) {
    if (item.erro) { anotar(item, "recusado", item.erro); resultado.recusados += 1; continue; }
    if (/\.pdf$/i.test(item.nome)) continue;
    if (!/\.xml$/i.test(item.nome)) { anotar(item, "ignorado", "Nao e XML, ZIP nem PDF"); continue; }

    const xml = item.bytes.toString("utf8");
    let documento;
    try {
      documento = lerDocumento(xml, "importacao " + item.origem);
    } catch (erro) {
      anotar(item, "recusado", erro.message);
      resultado.recusados += 1;
      continue;
    }
    if (!mencionaEmpresa(documento, xml, cnpj)) {
      anotar(item, "recusado", "O XML nao menciona o CNPJ " + cliente.cnpj + ": nao e desta empresa");
      resultado.recusados += 1;
      continue;
    }

    if (documento.kind === "Evento") {
      const guardado = await acervo.guardar(xml, "xml");
      const novo = eventos.inserir({ clienteId, chave: documento.key, nsu: null, tipo: documento.event,
        descricao: documento.description, motivo: documento.reason, quando: documento.issuedAt,
        caminho: guardado.caminho, sha256: guardado.sha256 });
      if (CANCELAMENTOS.has(documento.event)) documentos.marcarCancelado(documento.key, documento.reason);
      eventosVistos.push({ chave: documento.key, tipo: documento.event });
      anotar(item, novo ? "evento" : "duplicado", null, { tipo: "Evento " + documento.event });
      if (novo) resultado.eventos += 1; else resultado.duplicados += 1;
      continue;
    }

    const chave = chaveDoImportado(documento);
    if (/^\d{44}$/.test(chave) && !validarChave(chave).valid) {
      anotar(item, "recusado", "Chave de acesso com digito verificador invalido");
      resultado.recusados += 1;
      continue;
    }

    const guardado = await acervo.guardar(xml, "xml");
    const pdfProprio = pdfs.get(baseDoNome(item.nome));
    const existente = documentos.porIdentidade(identidade(clienteId, chave));
    if (existente) {
      const xmlAtual = arquivos.um(existente.id, "xml");
      const divergente = xmlAtual && xmlAtual.sha256 !== guardado.sha256;
      if (pdfProprio && !arquivos.um(existente.id, "pdf")) {
        arquivos.salvar(existente.id, "pdf", await acervo.guardar(pdfProprio.bytes, "pdf"));
        pdfsUsados.add(baseDoNome(pdfProprio.nome));
        resultado.pdfsAnexados += 1;
        registros.push(existente.id);
      } else if (pdfProprio) {
        pdfsUsados.add(baseDoNome(pdfProprio.nome));
      }
      anotar(item, "duplicado", divergente ? "Ja existe no acervo com conteudo diferente; o guardado foi mantido" : null,
        { tipo: documento.kind, numero: documento.number });
      resultado.duplicados += 1;
      continue;
    }

    const papel = papelDe(documento, cnpj);
    const competencia = documento.competencia || (documento.issuedAt ? String(documento.issuedAt).slice(0, 7) : null);
    const registro = transacao(() => {
      const novo = documentos.inserir(
        { ...documento, key: chave, operation: operacaoDaEmpresa(papel), identity: identidade(clienteId, chave) },
        { clienteId, capturadoPor: (fonteImportacao === "PONTE" ? "captura " : "importacao ") + (usuario || origem),
          fonte: fonteImportacao, nsu: null, papel, competencia }
      );
      arquivos.salvar(novo.id, "xml", guardado);
      conferencias.salvar(conferirSemDerrubar({ ...documento, key: chave }, regrasAtivas, chave), { clienteId, documentoId: novo.id });
      // A nota que o portal so anunciou (ou da qual so veio o evento) chegou por aqui.
      for (const fonte of ["ADN", "NFE", "CTE", "PONTE"]) {
        for (const tipo of ["resumo_sem_xml", "nota_referenciada_ausente"]) {
          pendencias.resolverPorReferencia({ clienteId, fonte, tipo, referencia: chave, por: usuario || "importacao" });
        }
      }
      return novo;
    });

    if (pdfProprio) {
      arquivos.salvar(registro.id, "pdf", await acervo.guardar(pdfProprio.bytes, "pdf"));
      pdfsUsados.add(baseDoNome(pdfProprio.nome));
      resultado.pdfsAnexados += 1;
    } else if (geradorPdf(documento.kind) && documento.standard !== "ABRASF") {
      paraGerarPdf.push({ registro, documento, papel, xml });
    } else {
      resultado.semPdf += 1;
    }
    registros.push(registro.id);
    resultado.novos += 1;
    resultado[papel === "emitida" ? "emitidas" : papel === "recebida" ? "recebidas" : "outras"] += 1;
    resultado.porTipo[documento.kind] = (resultado.porTipo[documento.kind] || 0) + 1;
    anotar(item, "importado", null, { tipo: documento.kind, numero: documento.number, papel });
  }

  for (const [nome, pdf] of pdfs) {
    anotar(pdf, pdfsUsados.has(nome) ? "anexado" : "ignorado", pdfsUsados.has(nome) ? null : "PDF sem XML de mesmo nome");
  }

  const contador = { pdfs: 0, pdfFalhas: 0 };
  await gerarPdfs(paraGerarPdf, cliente, fonteImportacao, contador);
  resultado.pdfsGerados = contador.pdfs;
  await aplicarEventosNosPdfs({ eventosVistos, novosTodos: paraGerarPdf, cliente, empresa, fonte: fonteImportacao });

  if (empresa?.pastaDestino) {
    for (const id of registros) agendarEspelho(documentos.porId(id), empresa, cliente);
    resultado.espelho = await espelharPendentes(clienteId, { modoPasta: configuracao.modoPasta });
  }
  return resultado;
}

// ------------------------------------------------------------------ PONTE

function clienteDaPonte(configuracao) {
  const ponte = configuracao.ponte || {};
  if (!ponte.chave) {
    throw new ErroCaptura("Configure a PONTE SEFAZ em Sistema > Integracoes: endereco e chave do escritorio",
      { definitivo: true });
  }
  return new ClientePonte({ base: ponte.url || PONTE_PRODUCAO, chave: ponte.chave,
    tentativas: configuracao.ponteTentativas ?? 3, esperaMs: configuracao.ponteEsperaMs ?? 1500 });
}

/** Le o indice.csv que vem dentro do pacote da PONTE. */
function indiceDoPacote(zip) {
  try {
    const entrada = listZip(zip).find((item) => item.name.split("/").pop() === "indice.csv");
    return entrada ? lerIndicePonte(readEntry(zip, entrada).toString("utf8")) : [];
  } catch {
    return [];
  }
}

/**
 * Captura pela PONTE SEFAZ: em vez de consultar a SEFAZ e o ADN daqui, pede a
 * PONTE uma varredura do CNPJ e traz o pacote de cada mes da janela (NF-e,
 * NFS-e e CT-e). O que entra passa pela mesma importacao (acervo, conferencia,
 * PDF, pasta do cliente); o que a PONTE so tem em resumo vira pendencia com a
 * explicacao dela. Repetir e seguro: nota ja guardada volta como duplicada.
 */
async function sincronizarPonte({ clienteId, tarefaId, configuracao, faixa, soCopiar = false }) {
  if (faixa) throw new ErroCaptura("A PONTE nao trabalha por faixa de NSU: a captura dela e por mes", { definitivo: true });
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  const empresa = empresasCaptura.porCliente(clienteId);
  if (!empresa?.ativa) throw new ErroCaptura("Captura desativada para esta empresa", { definitivo: true });
  const ponte = clienteDaPonte(configuracao);
  const cnpj = cliente.cnpjDigits;
  const inicio = Date.now();

  // 0. O cliente precisa estar na carteira do escritorio na PONTE. Conferir
  // antes poupa uma dezena de pedidos que voltariam todos com a mesma recusa.
  const avisos = [];
  const vinculo = await vinculoNaPonte(ponte, cliente);
  if (!vinculo.temCertificado) avisos.push("A PONTE nao tem o A1 deste cliente: ela nao consegue varrer, so entrega o que ja tinha.");
  else if (vinculo.certificadoVencimento && new Date(vinculo.certificadoVencimento) < new Date()) {
    avisos.push("O A1 deste cliente na PONTE venceu em " + String(vinculo.certificadoVencimento).slice(0, 10) + ".");
  }
  if (vinculo.radar === false) avisos.push("O radar deste cliente esta desligado na PONTE.");

  // 1. Varredura agora, pela PONTE. Falha aqui nao impede trazer o que ela ja
  // tem; chave sem permissao de escrita (somente leitura) so pula este passo.
  let varredura;
  // Agendamento que so copia: a agenda da PONTE ja buscou na SEFAZ; pedir de
  // novo so disputaria com ela (429/656).
  if (soCopiar) varredura = { resultado: "so-copia", novas: 0, detalhe: "A agenda da PONTE faz a busca; aqui so copia." };
  else try {
    const r = await ponte.varrer(cnpj);
    const linha = (r.linhas || []).find((item) => item.empresaCnpj === cnpj);
    varredura = linha
      ? { resultado: linha.resultado, novas: linha.novas ?? 0, detalhe: linha.detalhe || null }
      : { resultado: (r.pendentes || []).includes(cnpj) ? "pendente" : "sem-linha", novas: 0 };
  } catch (erro) {
    if (erro.status === 404) {
      throw new ErroCaptura("O CNPJ " + cliente.cnpj + " nao esta na carteira do escritorio na PONTE (ou o vinculo foi " +
        "encerrado). Inclua o cliente la, com o A1 dele, ou desligue a PONTE nesta empresa.", { definitivo: true });
    }
    if (erro.autenticacao && !/somente leitura/i.test(erro.message)) throw new ErroCaptura(erro.message, { definitivo: true, autenticacao: true });
    varredura = { resultado: "nao-pedida", novas: 0, detalhe: erro.message };
  }

  // 2. O pacote de cada mes da janela, um tipo de documento por vez, e a
  // listagem do mes (as emitidas pela propria PONTE e a NFS-e cancelada).
  const contador = contadorDaPonte();
  const falhas = [];
  const resumosNfe = [];
  const competencias = competenciasDaRotina(empresa, configuracao, clienteId);
  await trazerCompetenciasDaPonte({ ponte, clienteId, cnpj, competencias, configuracao, contador, falhas, resumosNfe, avisos,
    documentosPonte: documentosDaEmpresa(empresa) });

  // 3. Ciencia automatica, se a empresa permitir: pela PONTE, que tem o A1.
  const ciencias = await cienciaAutomaticaPelaPonte({ ponte, empresa, clienteId, cnpj, resumosNfe, falhas });

  // 4. A conferencia da PONTE (furo de numeracao, cancelada depois, atraso,
  // CFOP fora do padrao) vai para a vigilancia daqui. Falha nao derruba nada.
  let achados = null;
  try {
    achados = ((await ponte.conferencia(cnpj)).achados || []).filter((item) => item.empresaCnpj === cnpj);
    ponteEstado.salvar(clienteId, { ...estadoDoVinculo(vinculo), achados });
  } catch (erro) {
    avisos.push("Conferencia da PONTE nao veio: " + erro.message);
  }

  if (!falhas.length) cursores.marcarSucesso(clienteId, "PONTE");
  const espelho = await finalizarEspelho(empresa, cliente, configuracao);
  return {
    fonte: "PONTE",
    achadosDaPonte: achados ? achados.length : null,
    empresa: cliente.name,
    cnpj: cliente.cnpj,
    varredura,
    competencias,
    chamadas: ponte.chamadas,
    duracaoMs: Date.now() - inicio,
    lotes: contador.pacotes,
    ...contador,
    eventos: 0,
    falhas: falhas.length,
    detalheFalhas: falhas,
    avisos,
    ciencias,
    espelho
  };
}

function contadorDaPonte() {
  return { novos: 0, emitidas: 0, recebidas: 0, outras: 0, duplicados: 0, recusados: 0, pdfs: 0, resumos: 0,
    canceladas: 0, pacotes: 0, emitidasPelaPonte: 0, porTipo: {} };
}

function somarImportacao(contador, r) {
  for (const campo of ["novos", "emitidas", "recebidas", "outras", "duplicados", "recusados"]) contador[campo] += r[campo] || 0;
  contador.pdfs += r.pdfsGerados || 0;
  for (const [tipo, quantos] of Object.entries(r.porTipo || {})) contador.porTipo[tipo] = (contador.porTipo[tipo] || 0) + quantos;
}

/**
 * Traz da PONTE cada competencia pedida: o pacote de cada tipo de documento e
 * a listagem do mes. Cada competencia trazida entra no mapa do periodo da
 * empresa, com quantos arquivos vieram e quantos so em resumo.
 */
async function trazerCompetenciasDaPonte({ ponte, clienteId, cnpj, competencias, configuracao, contador, falhas,
  resumosNfe, avisos, documentosPonte = DOCUMENTOS_PONTE }) {
  for (const competencia of competencias) {
    const doMes = { arquivos: 0, semXml: 0, falhas: 0 };
    for (const documento of documentosPonte) {
      const referencia = "PONTE " + competencia + " " + documento;
      let pacote;
      try {
        pacote = await ponte.pacote({ cnpj, competencia, documentos: documento });
      } catch (erro) {
        if (erro.autenticacao) throw new ErroCaptura(erro.message, { definitivo: true, autenticacao: true });
        if (erro.status === 404) throw new ErroCaptura(erro.message, { definitivo: true });
        falhas.push(referencia + ": " + erro.message);
        doMes.falhas += 1;
        pendencias.abrir({ clienteId, fonte: "PONTE", tipo: "ponte_pacote", referencia,
          detalhe: "O pacote de " + documento.toUpperCase() + " de " + competencia + " nao veio: " + erro.message +
            ". A proxima captura tenta de novo." });
        continue;
      }
      pendencias.resolverPorReferencia({ clienteId, fonte: "PONTE", tipo: "ponte_pacote", referencia });
      contador.pacotes += 1;
      doMes.arquivos += pacote.arquivos;
      doMes.semXml += pacote.semXml;
      const indice = indiceDoPacote(pacote.zip);
      if (pacote.arquivos > 0) {
        const r = await importarArquivos({ clienteId, arquivos: [{ nome: referencia + ".zip", bytes: pacote.zip }],
          usuario: "PONTE SEFAZ", origem: "ponte", configuracao, fonte: "PONTE" });
        somarImportacao(contador, r);
      }
      for (const linha of indice) {
        if (!linha.chave) continue;
        const guardado = documentos.porIdentidade(identidade(clienteId, linha.chave));
        if (linha.situacao === "cancelada" && guardado && !guardado.cancelled) {
          documentos.marcarCancelado(linha.chave, "Cancelada segundo a SEFAZ (informado pela PONTE)");
          contador.canceladas += 1;
        }
        if (linha.temXml || guardado) {
          pendencias.resolverPorReferencia({ clienteId, fonte: "PONTE", tipo: "resumo_sem_xml", referencia: linha.chave });
          continue;
        }
        contador.resumos += 1;
        if (linha.documento === "NF-e" && linha.situacao !== "cancelada") resumosNfe.push(linha.chave);
        pendencias.abrir({ clienteId, fonte: "PONTE", tipo: "resumo_sem_xml", referencia: linha.chave, chave: linha.chave,
          situacao: linha.situacao === "cancelada" ? "confirmada" : "aberta",
          dados: { documento: linha.documento || null, emitente: linha.emitente || null, emitenteCnpj: linha.emitenteCnpj || null,
            emissao: linha.emissao ? String(linha.emissao).slice(0, 10) : null,
            valor: linha.valor !== undefined && linha.valor !== "" && Number.isFinite(Number(linha.valor)) ? Number(linha.valor) : null,
            situacaoNota: linha.situacao || null },
          detalhe: linha.documento + " de " + (linha.emitente || linha.emitenteCnpj || "emitente nao informado") +
            (linha.emissao ? ", emitida em " + linha.emissao : "") + (linha.valor ? ", valor " + linha.valor : "") +
            ". A PONTE ainda nao tem o XML: " + (linha.observacao || "so o resumo chegou.") });
      }
    }

    // A listagem do mes traz o que o pacote nao leva. Falha aqui nao derruba a
    // captura: o pacote ja entrou.
    try {
      const r = await listagemDaPonte({ ponte, clienteId, cnpj, competencia, configuracao, contador, avisos,
        tiposDaListagem: ["nfe", "nfse"].filter((doc) => documentosPonte.includes(doc)) });
      doMes.arquivos += r.emitidasNovas;
    } catch (erro) {
      if (erro.autenticacao) throw new ErroCaptura(erro.message, { definitivo: true, autenticacao: true });
      avisos.push("A listagem de " + competencia + " da PONTE nao veio (" + erro.message + "): as notas emitidas pela PONTE " +
        "e os cancelamentos de NFS-e deste mes entram na proxima captura.");
    }
    periodosCaptura.registrar({ clienteId, competencia, fonte: "PONTE", ...doMes });
  }
}

/**
 * Listagem do mes na PONTE:
 *   - `emitidas`: NF-e e NFC-e que o cliente emitiu pela propria PONTE. O
 *     pacote nao as leva; o XML vem de /api/nota/{chave}/xml.
 *   - `servicos`: NFS-e com a situacao. A PONTE marca a cancelada (pela
 *     distribuicao ou pela conferencia por chave); no indice do pacote a NFS-e
 *     vem sem situacao.
 */
async function listagemDaPonte({ ponte, clienteId, cnpj, competencia, configuracao, contador, avisos = [],
  tiposDaListagem = ["nfe", "nfse"] }) {
  const saida = { emitidasNovas: 0, nfseCanceladas: [] };
  if (!tiposDaListagem.length) return saida;
  const r = await ponte.notas({ cnpj, competencia, documentos: tiposDaListagem });
  for (const nota of r.emitidas || []) {
    const chave = String(nota.chaveAcesso || "").replace(/\D/g, "");
    if (!/^\d{44}$/.test(chave) || (nota.empresaCnpj && nota.empresaCnpj !== cnpj)) continue;
    let guardado = documentos.porIdentidade(identidade(clienteId, chave));
    if (!guardado) {
      try {
        const xml = await ponte.xmlDaNota({ chave, cnpj });
        const imp = await importarArquivos({ clienteId, arquivos: [{ nome: "PONTE emitida " + chave + ".xml",
          bytes: Buffer.from(String(xml), "utf8") }], usuario: "PONTE SEFAZ", origem: "ponte", configuracao, fonte: "PONTE" });
        somarImportacao(contador, imp);
        contador.emitidasPelaPonte += imp.novos || 0;
        saida.emitidasNovas += imp.novos || 0;
      } catch (erro) {
        if (erro.autenticacao) throw erro;
        avisos.push("XML da " + (nota.modelo || "NF-e") + " " + (nota.numero || chave) + " emitida pela PONTE nao veio: " +
          erro.message);
        continue;
      }
      guardado = documentos.porIdentidade(identidade(clienteId, chave));
    }
    if (String(nota.situacao) === "3" && guardado && !guardado.cancelled) {
      documentos.marcarCancelado(chave, "Cancelada (nota emitida pela PONTE)");
      contador.canceladas += 1;
    }
  }
  for (const servico of r.servicos || []) {
    const chave = String(servico.chaveAcesso || "").replace(/\D/g, "");
    if (!chave || servico.situacao !== "cancelada") continue;
    const guardado = documentos.porIdentidade(identidade(clienteId, chave));
    if (guardado && !guardado.cancelled) {
      documentos.marcarCancelado(chave, "Cancelada segundo o ambiente nacional (informado pela PONTE)");
      contador.canceladas += 1;
      saida.nfseCanceladas.push({ chave, numero: guardado.number || null });
    }
  }
  return saida;
}

/** Ciencia automatica das NF-e que so vieram em resumo, se a empresa permitir. */
async function cienciaAutomaticaPelaPonte({ ponte, empresa, clienteId, cnpj, resumosNfe, falhas }) {
  const ciencias = { enviadas: 0, aceitas: [], recusadas: [] };
  if (!empresa.manifestarCiencia || !resumosNfe.length) return ciencias;
  try {
    const r = await ponte.manifestar({ cnpj, chaves: resumosNfe });
    for (const linha of r.linhas || []) {
      ciencias.enviadas += 1;
      manifestacoes.registrar({ clienteId, chave: linha.chave, tipoEvento: CIENCIA,
        situacao: linha.sucesso ? "aceita" : "recusada", cStat: linha.cStat || null, motivo: linha.xMotivo || null,
        origem: "ponte" });
      (linha.sucesso ? ciencias.aceitas : ciencias.recusadas).push({ chave: linha.chave, cStat: linha.cStat || null,
        motivo: linha.xMotivo || null });
    }
  } catch (erro) {
    falhas.push("ciencia: " + erro.message);
  }
  return ciencias;
}

/** O vinculo do cliente na carteira da PONTE; recusa quem nao esta la. */
async function vinculoNaPonte(ponte, cliente) {
  let vinculo;
  try {
    vinculo = ((await carteiraDaPonte(ponte)).clientes || [])
      .find((item) => item.empresaCnpj === cliente.cnpjDigits && item.ativo !== false);
  } catch (erro) {
    if (erro.autenticacao) throw new ErroCaptura(erro.message, { definitivo: true, autenticacao: true });
    throw new ErroCaptura(erro.message, { definitivo: Boolean(erro.definitivo) });
  }
  if (!vinculo) {
    ponteEstado.salvar(cliente.id, { naCarteira: false });
    throw new ErroCaptura("O CNPJ " + cliente.cnpj + " nao esta na carteira do escritorio na PONTE (ou o vinculo foi " +
      "encerrado). Inclua o cliente la, com o A1 dele, ou desligue a PONTE nesta empresa.", { definitivo: true });
  }
  ponteEstado.salvar(cliente.id, estadoDoVinculo(vinculo));
  return vinculo;
}

/** Documentos que a empresa busca pela PONTE (a regra dela; sem regra, todos). */
export function documentosDaEmpresa(empresa) {
  const escolhidos = (empresa?.documentosPonte || []).filter((doc) => DOCUMENTOS_PONTE.includes(doc));
  return escolhidos.length ? escolhidos : DOCUMENTOS_PONTE;
}

/**
 * Competencias da captura de rotina pela PONTE, pela regra da empresa: a
 * janela dos ultimos N meses (o padrao do sistema, ou o da empresa), nunca
 * antes do comeco do periodo dela, e, de uma vez, ate 12 meses do periodo que
 * ainda nao vieram (o historico entra sozinho, sem pesar toda rotina).
 */
export function competenciasDaRotina(empresa, configuracao = {}, clienteId = empresa?.clientId, agora = new Date()) {
  const desde = /^\d{4}-\d{2}$/.test(String(empresa?.periodoDesde || "")) ? empresa.periodoDesde : null;
  const janela = ultimasCompetencias(empresa?.periodoMeses || configuracao.ponteMeses || 4, agora)
    .filter((competencia) => !desde || competencia >= desde);
  if (!desde) return janela;
  const atual = ultimasCompetencias(1, agora)[0];
  if (desde > atual) return [];
  const jaVieram = new Set(periodosCaptura.porCliente(clienteId)
    .filter((linha) => linha.fonte === "PONTE" && !linha.falhas).map((linha) => linha.competencia));
  const faltam = competenciasEntre(desde, atual, 600).filter((competencia) => !janela.includes(competencia) && !jaVieram.has(competencia));
  return [...janela, ...faltam.slice(0, 12)];
}

/** Competencias AAAA-MM de `de` ate `ate`, inclusive, da mais nova para a mais velha. */
export function competenciasEntre(de, ate, maximo = 60) {
  if (!/^\d{4}-\d{2}$/.test(String(de)) || !/^\d{4}-\d{2}$/.test(String(ate))) {
    throw new ErroCaptura("Periodo invalido: use AAAA-MM", { definitivo: true });
  }
  if (de > ate) throw new ErroCaptura("O comeco do periodo e depois do fim", { definitivo: true });
  const saida = [];
  let [ano, mes] = ate.split("-").map(Number);
  while (true) {
    const atual = ano + "-" + String(mes).padStart(2, "0");
    if (atual < de) break;
    saida.push(atual);
    if (saida.length > maximo) {
      throw new ErroCaptura("Periodo de mais de " + maximo + " meses: peca em partes", { definitivo: true });
    }
    mes -= 1;
    if (!mes) { mes = 12; ano -= 1; }
  }
  return saida;
}

/**
 * Baixa um periodo inteiro da PONTE para a empresa: cada competencia de `de`
 * ate `ate`, todos os tipos, emitidas e recebidas. E o que se faz ao trazer o
 * historico de um cliente novo, ou para fechar de novo um mes antigo. Repetir
 * e seguro: nota ja guardada volta como duplicada.
 */
export async function baixarPeriodoDaPonte({ clienteId, de, ate, configuracao = {} }) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  const empresa = empresasCaptura.porCliente(clienteId);
  if (!empresa?.configurada || !(empresa.fontes || []).includes("PONTE")) {
    throw new ErroCaptura("Esta empresa nao e capturada pela PONTE", { definitivo: true });
  }
  const competencias = competenciasEntre(de, ate);
  const ponte = clienteDaPonte(configuracao);
  const inicio = Date.now();
  await vinculoNaPonte(ponte, cliente);
  const contador = contadorDaPonte();
  const falhas = [];
  const resumosNfe = [];
  const avisos = [];
  await trazerCompetenciasDaPonte({ ponte, clienteId, cnpj: cliente.cnpjDigits, competencias, configuracao, contador,
    falhas, resumosNfe, avisos, documentosPonte: documentosDaEmpresa(empresa) });
  const ciencias = await cienciaAutomaticaPelaPonte({ ponte, empresa, clienteId, cnpj: cliente.cnpjDigits, resumosNfe, falhas });
  const espelho = await finalizarEspelho(empresa, cliente, configuracao);
  return { fonte: "PONTE", empresa: cliente.name, cnpj: cliente.cnpj, de, ate, competencias, duracaoMs: Date.now() - inicio,
    ...contador, falhas: falhas.length, detalheFalhas: falhas, avisos, ciencias, espelho, chamadas: ponte.chamadas };
}

/**
 * Mapa do periodo da empresa, mes a mes: o que esta no acervo (emitidas,
 * recebidas, canceladas) e quando cada competencia foi trazida da PONTE.
 */
export function mapaDoPeriodo(clienteId) {
  const meses = new Map();
  for (const linha of acervoDocs.historicoMensal(clienteId)) {
    if (linha.competencia === "sem-competencia") continue;
    meses.set(linha.competencia, { ...linha, trazidoEm: null, arquivos: null, semXml: null, falhas: null });
  }
  for (const linha of periodosCaptura.porCliente(clienteId)) {
    const atual = meses.get(linha.competencia) || { competencia: linha.competencia, emitidas: 0, recebidas: 0, outras: 0,
      valorEmitidas: 0, valorRecebidas: 0, canceladas: 0 };
    meses.set(linha.competencia, { ...atual, trazidoEm: linha.trazidoEm, arquivos: linha.arquivos, semXml: linha.semXml,
      falhas: linha.falhas });
  }
  const estado = ponteEstado.porCliente(clienteId);
  return {
    desde: estado?.desde || null,
    meses: [...meses.values()].sort((a, b) => b.competencia.localeCompare(a.competencia))
  };
}

/**
 * Cancelamentos da NFS-e de empresa capturada pela PONTE (o A1 fica la): a
 * PONTE pergunta ao ambiente nacional, nota a nota pela chave, e marca a
 * cancelada; a listagem do mes traz a marca para ca.
 */
export async function conferirCancelamentosPelaPonte({ clienteId, configuracao = {}, meses = 3, agora = new Date() }) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  const ponte = clienteDaPonte(configuracao);
  const cnpj = cliente.cnpjDigits;
  const resumo = { empresa: cliente.name, pelaPonte: true, competencias: ultimasCompetencias(meses, agora), conferidas: 0,
    canceladasNaPonte: 0, canceladas: [], naoConferidas: [], pendentes: 0, falhasNaPonte: 0, puladas: 0, avisos: [],
    semCertificado: null };
  const contador = contadorDaPonte();
  for (const competencia of resumo.competencias) {
    try {
      const r = await ponte.conferirCancelamentos({ cnpj, competencia });
      resumo.conferidas += r.conferidas || 0;
      resumo.canceladasNaPonte += r.canceladas || 0;
      resumo.pendentes += r.pendentes || 0;
      resumo.falhasNaPonte += r.falhas || 0;
      if (r.aviso) resumo.avisos.push(competencia + ": " + r.aviso);
    } catch (erro) {
      if (erro.autenticacao) throw new ErroCaptura(erro.message, { definitivo: true, autenticacao: true });
      resumo.avisos.push(competencia + ": a PONTE nao conferiu (" + erro.message + ")");
      if (erro.status === 422 || /certificado|prova/i.test(erro.message)) resumo.semCertificado = erro.message;
      continue;
    }
    try {
      const r = await listagemDaPonte({ ponte, clienteId, cnpj, competencia, configuracao, contador, avisos: resumo.avisos });
      resumo.canceladas.push(...r.nfseCanceladas);
    } catch (erro) {
      resumo.avisos.push(competencia + ": a listagem da PONTE nao veio (" + erro.message + ")");
    }
  }
  return resumo;
}

/** O que a carteira da PONTE diz do cliente, no formato de ponte_estado. */
function estadoDoVinculo(vinculo) {
  return {
    desde: vinculo.desde ? String(vinculo.desde).slice(0, 10) : null,
    naCarteira: true,
    temCertificado: Boolean(vinculo.temCertificado),
    certificadoVencimento: vinculo.certificadoVencimento ? String(vinculo.certificadoVencimento).slice(0, 10) : null,
    certificadoTitular: vinculo.certificadoTitular || null,
    radar: vinculo.radar !== false,
    // Varredura da PONTE: { iniciadaEm, terminadaEm, resultado, ... } (escritorio.ts).
    ultimaVarredura: vinculo.ultimaVarredura?.terminadaEm || vinculo.ultimaVarredura?.iniciadaEm || null
  };
}

/** Carteira da PONTE; guarda o plano do escritorio quando ela informa. */
async function carteiraDaPonte(ponte) {
  const resposta = await ponte.carteira();
  const plano = planoDaCarteira(resposta);
  if (plano) configuracoes.gravar("plano", { ...plano, lidoEm: new Date().toISOString() });
  return resposta;
}

/**
 * Plano do escritorio: o limite e a quantidade de empresas. Sem plano informado
 * pela PONTE, sem limite.
 */
export function limiteDoPlano() {
  const plano = configuracoes.ler("plano");
  const emUso = clientes.listar().length;
  const limite = plano?.limiteEmpresas || null;
  return { plano, emUso, limite, cheio: Boolean(limite && emUso >= limite) };
}

/**
 * O limite antes de criar empresa. Com a PONTE configurada e o plano nunca lido
 * (agente recem-subido), le a carteira dela primeiro. Sem resposta, recusa: a
 * empresa nova nao entra sem o limite conhecido. Sem PONTE configurada, sem limite.
 */
export async function limiteDoPlanoConferido(configuracao = {}) {
  if (configuracao.ponte?.chave && !configuracoes.ler("plano")) {
    try {
      await carteiraDaPonte(clienteDaPonte(configuracao));
    } catch (erro) {
      throw new ErroCaptura("O limite de empresas do plano vem da PONTE, e ela nao respondeu agora (" + erro.message +
        "). A empresa nao foi incluida: tente de novo em alguns minutos.");
    }
  }
  return limiteDoPlano();
}

export function mensagemDoPlanoCheio({ plano, emUso, limite }) {
  return "O plano " + plano.nome + " permite " + limite + " empresa(s), e o NUCLEO ja tem " + emUso +
    ". Para incluir mais, fale com o suporte para mudar de plano.";
}

export { carteiraDaPonte };

/**
 * Traz a carteira da PONTE para o NUCLEO: liga a captura pela PONTE em cada
 * empresa que ja existe aqui e, se pedido, cria as que faltam. Nao desliga a
 * NFS-e pelo ADN de quem ja tinha; NF-e e CT-e diretos saem, porque com a
 * PONTE ligada eles fariam a SEFAZ bloquear o CNPJ (656).
 */
export async function trazerCarteiraDaPonte({ configuracao = {}, criarClientes = true, usuario = null }) {
  const ponte = clienteDaPonte(configuracao);
  let carteira;
  try {
    carteira = ((await carteiraDaPonte(ponte)).clientes || []).filter((item) => item.ativo !== false);
  } catch (erro) {
    throw new ErroCaptura(erro.message, { definitivo: Boolean(erro.definitivo || erro.autenticacao), autenticacao: erro.autenticacao });
  }
  const saida = { carteira: carteira.length, ligadas: [], criadas: [], jaLigadas: [], semCertificadoNaPonte: [], foraDoPlano: [] };
  for (const vinculo of carteira) {
    const nome = vinculo.apelido || vinculo.fiscal?.razaoSocial || vinculo.certificadoTitular || vinculo.empresaCnpj;
    let cliente = clientes.porCnpj(vinculo.empresaCnpj);
    if (!cliente) {
      if (!criarClientes) continue;
      if (limiteDoPlano().cheio) {
        saida.foraDoPlano.push({ cnpj: vinculo.empresaCnpj, nome });
        continue;
      }
      cliente = clientes.criar({ cnpj: vinculo.empresaCnpj, name: String(nome).toUpperCase(), modules: ["Federal", "Servicos"] });
      saida.criadas.push({ id: cliente.id, nome: cliente.name, cnpj: cliente.cnpj });
    }
    const empresa = empresasCaptura.porCliente(cliente.id);
    const fontesAntes = empresa?.configurada ? (empresa.fontes || ["ADN"]) : [];
    if (fontesAntes.includes("PONTE")) {
      saida.jaLigadas.push({ id: cliente.id, nome: cliente.name });
    } else {
      const fontes = [...fontesAntes.filter((fonte) => !["NFE", "CTE", "PONTE"].includes(fonte)), "PONTE"];
      empresasCaptura.salvar(cliente.id, {
        modo: empresa?.modo || "proprio", fontes, ativa: true,
        ...(empresa?.configurada ? {} : { tipos: "ambas" })
      }, usuario || "PONTE SEFAZ");
      saida.ligadas.push({ id: cliente.id, nome: cliente.name, fontesAntes, fontes });
    }
    if (!vinculo.temCertificado) saida.semCertificadoNaPonte.push({ id: cliente.id, nome: cliente.name });
    ponteEstado.salvar(cliente.id, estadoDoVinculo(vinculo));
  }
  return saida;
}

/** Ciencia de uma NF-e pedida por uma pessoa, feita pela PONTE (que tem o A1). */
export async function cienciaPelaPonte({ clienteId, chave, usuario, configuracao = {} }) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  if (!/^\d{44}$/.test(String(chave || "")) || chave.slice(20, 22) !== "55") {
    throw new ErroCaptura("Ciencia so existe para NF-e (modelo 55)", { definitivo: true });
  }
  const ponte = clienteDaPonte(configuracao);
  let r;
  try {
    r = await ponte.manifestar({ cnpj: cliente.cnpjDigits, chaves: [chave] });
  } catch (erro) {
    throw new ErroCaptura(erro.message, { definitivo: Boolean(erro.definitivo || erro.autenticacao), autenticacao: erro.autenticacao });
  }
  const linha = (r.linhas || []).find((item) => item.chave === chave);
  if (!linha) {
    return { aceita: false, motivo: "A PONTE nao tem esta nota como pendente de manifestacao (ja manifestada, ou fora da " +
      "janela do escritorio)." };
  }
  const registro = manifestacoes.registrar({ clienteId, chave, tipoEvento: CIENCIA,
    situacao: linha.sucesso ? "aceita" : "recusada", cStat: linha.cStat || null, motivo: linha.xMotivo || null,
    origem: "ponte", usuario });
  if (linha.sucesso) {
    pendencias.abrir({ clienteId, fonte: "PONTE", tipo: "resumo_sem_xml", referencia: chave, chave,
      detalhe: "Ciencia registrada pela PONTE. O XML completo chega depois da proxima varredura dela; a proxima " +
        "captura desta empresa traz." });
  }
  return { aceita: Boolean(linha.sucesso), cStat: linha.cStat || null, motivo: linha.xMotivo || null, registro,
    proximoPasso: r.proximoPasso || null };
}

/**
 * Ciencia da Operacao em lote: todas as NF-e da empresa que estao so em
 * resumo (pendencia aberta). Pela PONTE quando ela captura a empresa (um
 * pedido so); direto na SEFAZ com o A1 daqui nos outros casos, uma a uma.
 */
export async function cienciaEmLote({ clienteId, usuario, configuracao = {}, somente = null }) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  const empresa = empresasCaptura.porCliente(clienteId);
  const abertas = pendencias.listar({ clienteId, situacao: "aberta", tipo: "resumo_sem_xml", limite: 5000 });
  // `somente`: as chaves que a pessoa marcou; o resto fica como esta, para liberar depois.
  const escolhidas = Array.isArray(somente) ? new Set(somente.map(String)) : null;
  const chaves = [...new Set(abertas.map((p) => String(p.chave || p.referencia || ""))
    .filter((chave) => /^\d{44}$/.test(chave) && chave.slice(20, 22) === "55" && (!escolhidas || escolhidas.has(chave))))];
  const saida = { empresa: cliente.name, pedidas: chaves.length, aceitas: [], recusadas: [], pelaPonte: false, proximoPasso: null };
  if (!chaves.length) return saida;

  if ((empresa?.fontes || []).includes("PONTE")) {
    saida.pelaPonte = true;
    const ponte = clienteDaPonte(configuracao);
    let r;
    try {
      r = await ponte.manifestar({ cnpj: cliente.cnpjDigits, chaves });
    } catch (erro) {
      throw new ErroCaptura(erro.message, { definitivo: Boolean(erro.definitivo || erro.autenticacao), autenticacao: erro.autenticacao });
    }
    for (const linha of r.linhas || []) {
      manifestacoes.registrar({ clienteId, chave: linha.chave, tipoEvento: CIENCIA,
        situacao: linha.sucesso ? "aceita" : "recusada", cStat: linha.cStat || null, motivo: linha.xMotivo || null,
        origem: "ponte", usuario });
      (linha.sucesso ? saida.aceitas : saida.recusadas).push({ chave: linha.chave, cStat: linha.cStat || null,
        motivo: linha.xMotivo || null });
      if (linha.sucesso) {
        pendencias.abrir({ clienteId, fonte: "PONTE", tipo: "resumo_sem_xml", referencia: linha.chave, chave: linha.chave,
          detalhe: "Ciencia registrada pela PONTE (em lote). O XML completo chega depois da proxima varredura dela; a " +
            "proxima captura desta empresa traz." });
      }
    }
    saida.proximoPasso = r.proximoPasso || null;
    return saida;
  }

  for (const chave of chaves) {
    try {
      const r = await cienciaManual({ clienteId, chave, usuario, configuracao });
      (r.aceita ? saida.aceitas : saida.recusadas).push({ chave, cStat: r.cStat || null, motivo: r.motivo || null });
    } catch (erro) {
      if (erro.autenticacao) throw erro;
      saida.recusadas.push({ chave, cStat: null, motivo: erro.message });
    }
  }
  return saida;
}

// ------------------------------------------- carteira do escritorio na PONTE
//
// O contador cuida da carteira da PONTE daqui: inclui o cliente, guarda o A1
// dele no cofre da PONTE (ou manda o que ja esta no cofre do NUCLEO), gera e
// guarda o termo de guarda do certificado, encerra o vinculo. A PONTE continua
// sendo quem fala com a SEFAZ e o ambiente nacional.

function erroDaPonte(erro) {
  return new ErroCaptura(erro.message, { definitivo: true, autenticacao: Boolean(erro.autenticacao) });
}

/** Inclui o cliente na carteira da PONTE e liga a captura dele por ela. */
export async function incluirNaPonte({ clienteId, configuracao = {}, desde = null, usuario = null }) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  const ponte = clienteDaPonte(configuracao);
  let r;
  try {
    r = await ponte.incluirNaCarteira({ empresaCnpj: cliente.cnpjDigits, apelido: cliente.name,
      desde: desde || undefined });
  } catch (erro) {
    throw erroDaPonte(erro);
  }
  ponteEstado.salvar(clienteId, estadoDoVinculo(r.cliente || { empresaCnpj: cliente.cnpjDigits }));
  const empresa = empresasCaptura.porCliente(clienteId);
  const fontesAntes = empresa?.configurada ? (empresa.fontes || ["ADN"]) : [];
  if (!fontesAntes.includes("PONTE")) {
    empresasCaptura.salvar(clienteId, {
      modo: empresa?.modo || "proprio", ativa: true,
      fontes: [...fontesAntes.filter((fonte) => !["NFE", "CTE", "PONTE"].includes(fonte)), "PONTE"],
      ...(empresa?.configurada ? {} : { tipos: "ambas" })
    }, usuario || "PONTE SEFAZ");
  }
  return { vinculo: r.cliente || null, fontes: empresasCaptura.porCliente(clienteId).fontes };
}

/** Muda na PONTE o apelido, o codigo contabil ou o radar (busca automatica dela) do cliente. */
export async function alterarNaPonte({ clienteId, configuracao = {}, apelido, codigoContabil, radar }) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  // So vai o que foi preenchido: campo vazio nao apaga o que esta la.
  const campos = Object.fromEntries(Object.entries({ apelido, codigoContabil, radar })
    .filter(([, valor]) => valor !== undefined && valor !== null && valor !== ""));
  if (!Object.keys(campos).length) throw new ErroCaptura("Nada para mudar", { definitivo: true });
  let r;
  try {
    r = await clienteDaPonte(configuracao).alterarNaCarteira(cliente.cnpjDigits, campos);
  } catch (erro) {
    throw erroDaPonte(erro);
  }
  if (r.cliente) ponteEstado.salvar(clienteId, estadoDoVinculo(r.cliente));
  return { vinculo: r.cliente || null, alterados: Object.keys(campos) };
}

/** NFA do produtor rural que a PONTE emitiu para o cliente: so a lista (o arquivo fica no SIARE). */
export async function nfaDaPonte({ clienteId, configuracao = {} }) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  let r;
  try {
    r = await clienteDaPonte(configuracao).notas({ cnpj: cliente.cnpjDigits, documentos: ["nfa"] });
  } catch (erro) {
    throw erroDaPonte(erro);
  }
  return (r.rurais || []).filter((item) => !item.clienteCnpj || item.clienteCnpj === cliente.cnpjDigits)
    .map((item) => ({ id: item.id, numero: item.numeroNfa || null, protocolo: item.protocolo || null,
      produtorIe: item.produtorIe || null, emitidaEm: item.emitidaEm || item.criadoEm || null }))
    .sort((a, b) => String(b.emitidaEm).localeCompare(String(a.emitidaEm)));
}

/**
 * Cadastro de empresa pelo certificado, num passo so: o A1 diz a razao social
 * e o CNPJ; a empresa entra na carteira do escritorio na PONTE, o A1 vai para o
 * cofre dela, o cliente nasce aqui com a captura pela PONTE e a regra de busca.
 * Filial com o A1 da matriz: informe o CNPJ da filial (mesma raiz).
 */
/** Fonte de busca direta de cada documento: NFS-e pelo ADN, NF-e e CT-e pela SEFAZ. */
const FONTE_DO_DOCUMENTO = { nfse: "ADN", nfe: "NFE", cte: "CTE" };

/**
 * Empresa nova pelo A1 do cliente. Por padrao a busca e do proprio NUCLEO
 * (decisao do dono em 11/10/2026: "o nucleo faria a busca"): o A1 fica no cofre
 * daqui, as fontes sao ADN, NF-e e CT-e diretos, e nasce o termo de guarda
 * pendente. buscaPor "ponte" mantem o caminho antigo (A1 no cofre da PONTE).
 */
export async function cadastrarEmpresaPeloCertificado({ pfxBase64, senha, autorizadoPor, referencia = null, cnpjEmpresa = null,
  desde = null, documentosPonte = null, configuracao = {}, usuario = null, buscaPor = "nucleo", uf = null }) {
  if (buscaPor === "nucleo") {
    return cadastrarComBuscaNoNucleo({ pfxBase64, senha, autorizadoPor, referencia, cnpjEmpresa, desde, documentos: documentosPonte,
      configuracao, usuario, uf });
  }
  const { pfx, certificado, cnpj, cobertura } = lerCertificadoDoCadastro({ pfxBase64, senha, autorizadoPor, cnpjEmpresa, desde });
  const existente = clientes.porCnpj(cnpj);
  if (!existente) {
    const plano = await limiteDoPlanoConferido(configuracao);
    if (plano.cheio) throw new ErroCaptura(mensagemDoPlanoCheio(plano), { definitivo: true });
  }
  const nome = String(existente?.name || (cnpj === certificado.titularCnpj ? certificado.titular : "") || certificado.titular)
    .toUpperCase();

  const ponte = clienteDaPonte(configuracao);
  try {
    await ponte.incluirNaCarteira({ empresaCnpj: cnpj, apelido: nome, desde: desde ? desde + "-01" : undefined });
  } catch (erro) {
    throw erroDaPonte(erro);
  }
  let guardado;
  try {
    guardado = await ponte.enviarCertificado(cnpj, { pfxBase64: pfx.toString("base64"), pfxPassword: senha,
      autorizadoPor: String(autorizadoPor).trim(), referencia: referencia || undefined });
  } catch (erro) {
    throw new ErroCaptura("A empresa entrou na carteira da PONTE, mas o A1 nao foi guardado la: " + erro.message +
      ". Tente de novo pelo painel da empresa (Enviar A1).", { definitivo: true });
  }

  const cliente = existente || clientes.criar({ cnpj, name: nome, modules: ["Federal", "Servicos"] });
  const empresa = empresasCaptura.porCliente(cliente.id);
  const fontesAntes = empresa?.configurada ? (empresa.fontes || []) : [];
  empresasCaptura.salvar(cliente.id, {
    modo: "proprio", ativa: true,
    fontes: [...fontesAntes.filter((fonte) => !["NFE", "CTE", "PONTE"].includes(fonte)), "PONTE"],
    ...(empresa?.configurada ? {} : { tipos: "ambas" }),
    documentosPonte: Array.isArray(documentosPonte) && documentosPonte.length
      ? documentosPonte.filter((doc) => DOCUMENTOS_PONTE.includes(doc)) : undefined,
    periodoDesde: desde || undefined
  }, usuario || "cadastro pelo certificado");
  await vinculoNaPonte(ponte, cliente).catch(() => null);
  return {
    cliente: { id: cliente.id, nome: cliente.name, cnpj: cliente.cnpj }, criado: !existente,
    titular: guardado.titular || certificado.titular, vencimento: String(guardado.vencimento || certificado.validoAte).slice(0, 10),
    cobertura: cobertura.motivo, periodoDesde: desde || null
  };
}

/** Le o A1, confere que serve para o CNPJ e devolve o que o cadastro precisa. Nao grava nada. */
function lerCertificadoDoCadastro({ pfxBase64, senha, autorizadoPor, cnpjEmpresa, desde }) {
  if (!pfxBase64 || !senha) throw new ErroCaptura("Envie o arquivo .pfx e a senha dele", { definitivo: true });
  if (!String(autorizadoPor || "").trim()) {
    throw new ErroCaptura("Diga quem autorizou a guarda do certificado (o cliente que delegou)", { definitivo: true });
  }
  const pfx = Buffer.from(pfxBase64, "base64");
  let certificado;
  try {
    certificado = lerPfx(pfx, senha);
  } catch (erro) {
    throw new ErroCaptura(erro.message, { definitivo: true });
  }
  if (certificado.vencido) throw new ErroCaptura("Este A1 venceu em " + certificado.validoAte + ": peca o novo ao cliente", { definitivo: true });
  const cnpj = String(cnpjEmpresa || certificado.titularCnpj || "").replace(/\D/g, "");
  if (cnpj.length !== 14) {
    throw new ErroCaptura("O certificado nao traz CNPJ (e-CPF?): informe o CNPJ da empresa", { definitivo: true });
  }
  const cobertura = cobreCnpj(certificado, cnpj);
  if (!cobertura.cobre) {
    throw new ErroCaptura("Este A1 e de " + certificado.titular + " e nao serve para o CNPJ " + cnpj + " (" + cobertura.motivo +
      "). Para filial, o A1 da matriz serve.", { definitivo: true });
  }
  if (desde !== null && desde !== "" && !/^\d{4}-\d{2}$/.test(String(desde))) {
    throw new ErroCaptura("Comeco do periodo invalido: use AAAA-MM", { definitivo: true });
  }
  return { pfx, certificado, cnpj, cobertura };
}

async function cadastrarComBuscaNoNucleo({ pfxBase64, senha, autorizadoPor, referencia, cnpjEmpresa, desde, documentos, configuracao,
  usuario, uf }) {
  const { pfx, certificado, cnpj, cobertura } = lerCertificadoDoCadastro({ pfxBase64, senha, autorizadoPor, cnpjEmpresa, desde });
  const docs = (Array.isArray(documentos) && documentos.length ? documentos : Object.keys(FONTE_DO_DOCUMENTO))
    .filter((doc) => FONTE_DO_DOCUMENTO[doc]);
  if (!docs.length) throw new ErroCaptura("Escolha ao menos um documento para buscar", { definitivo: true });
  const fontes = docs.map((doc) => FONTE_DO_DOCUMENTO[doc]);
  const ufEmpresa = String(uf || "").trim().toUpperCase();
  if (fontes.some((fonte) => fonte === "NFE" || fonte === "CTE") && !CODIGO_UF[ufEmpresa]) {
    throw new ErroCaptura("Escolha a UF da empresa: ela vai no pedido de NF-e e CT-e a SEFAZ", { definitivo: true });
  }
  if (!chaveConfigurada()) {
    throw new ErroCaptura("Cofre de segredos sem chave (NUCLEO_CHAVE_SEGREDOS): o A1 nao e guardado sem cifra", { definitivo: true });
  }
  const existente = clientes.porCnpj(cnpj);
  if (!existente) {
    const plano = await limiteDoPlanoConferido(configuracao);
    if (plano.cheio) throw new ErroCaptura(mensagemDoPlanoCheio(plano), { definitivo: true });
  }
  // A PONTE ainda buscando esta empresa (A1 no cofre dela): buscar daqui tambem
  // faria os dois cairem no bloqueio de uma hora da SEFAZ (656).
  const empresaAntes = existente ? empresasCaptura.porCliente(existente.id) : null;
  if (existente && (empresaAntes?.fontes || []).includes("PONTE") && ponteEstado.porCliente(existente.id)?.temCertificado) {
    throw new ErroCaptura("Esta empresa e buscada pela PONTE, com o A1 no cofre dela. Para o NUCLEO buscar, tire antes o A1 da PONTE " +
      "(painel da empresa > Remover A1): as duas buscando o mesmo CNPJ fazem a SEFAZ bloquear por uma hora.", { definitivo: true });
  }

  let guardado = certificadosDigitais.porSha(certificado.sha256Arquivo);
  if (guardado && !guardado.ativo) {
    throw new ErroCaptura("Este A1 esta desativado no cofre do NUCLEO (Certificados A1): envie o certificado novo do cliente",
      { definitivo: true });
  }
  if (!guardado) guardado = certificadosDigitais.criar(certificado, pfx, senha, usuario || "cadastro pelo certificado");

  const nome = String(existente?.name || (cnpj === certificado.titularCnpj ? certificado.titular : "") || certificado.titular)
    .toUpperCase();
  const cliente = existente || clientes.criar({ cnpj, name: nome, modules: ["Federal", "Servicos"] });
  const fontesAntes = empresaAntes?.configurada ? (empresaAntes.fontes || []) : [];
  empresasCaptura.salvar(cliente.id, {
    modo: "proprio", ativa: true, certificadoId: guardado.id, uf: ufEmpresa || undefined,
    fontes: [...fontesAntes.filter((fonte) => !["ADN", "NFE", "CTE", "PONTE"].includes(fonte)), ...fontes],
    ...(empresaAntes?.configurada ? {} : { tipos: "ambas" }),
    documentosPonte: docs, periodoDesde: desde || undefined
  }, usuario || "cadastro pelo certificado");
  const termo = termosGuarda.garantir({ clienteId: cliente.id, certificadoId: guardado.id, autorizadoPor: String(autorizadoPor).trim(),
    referencia, usuario });

  // O plano da contabilidade e contado na carteira da PONTE: a empresa entra la
  // SEM o A1, e a PONTE nao busca por ela (so busca quem tem A1 guardado la).
  const avisos = [];
  if (configuracao.ponte?.chave) {
    try {
      await clienteDaPonte(configuracao).incluirNaCarteira({ empresaCnpj: cnpj, apelido: nome, desde: desde ? desde + "-01" : undefined });
    } catch (erro) {
      avisos.push("A empresa nao entrou na carteira da PONTE (contagem do plano): " + erro.message);
    }
  }
  return {
    cliente: { id: cliente.id, nome: cliente.name, cnpj: cliente.cnpj }, criado: !existente, busca: "nucleo", fontes,
    titular: certificado.titular, vencimento: certificado.validoAte, certificadoId: guardado.id, cobertura: cobertura.motivo,
    periodoDesde: desde || null, termo: { id: termo.id, situacao: termo.situacao }, avisos
  };
}

// ------------------------------------------------- agenda da busca na PONTE

const DIAS_SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** A agenda da PONTE com o nome da empresa daqui em cada horario (ou "toda a carteira"). */
export async function agendaDaPonte({ configuracao = {} }) {
  let r;
  try {
    r = await clienteDaPonte(configuracao).agenda();
  } catch (erro) {
    throw erroDaPonte(erro);
  }
  const porCnpj = new Map(clientes.listar().map((cliente) => [cliente.cnpjDigits, cliente]));
  return {
    maximo: r.maximo ?? null,
    relogio: r.relogio || null,
    agendas: (r.agendas || []).map((item) => ({ ...item,
      empresa: item.empresaCnpj ? porCnpj.get(item.empresaCnpj)?.name || item.empresaCnpj : "Toda a carteira",
      clientId: item.empresaCnpj ? porCnpj.get(item.empresaCnpj)?.id || null : null }))
  };
}

/** Cria um horario de busca na PONTE. Hora de Brasilia, como la. */
export async function criarAgendaNaPonte({ configuracao = {}, frequencia, hora, minuto = 0, diaSemana, diaMes, revarreduras,
  documentos, clienteId }) {
  if (!["diaria", "semanal", "mensal"].includes(frequencia)) throw new ErroCaptura("Frequencia invalida", { definitivo: true });
  const cliente = clienteId ? clientes.porId(clienteId) : null;
  if (clienteId && !cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  const corpo = {
    frequencia, hora: Number(hora), minuto: Number(minuto || 0),
    ...(frequencia === "semanal" ? { diaSemana: Number(diaSemana) } : {}),
    ...(frequencia === "mensal" ? { diaMes: Number(diaMes) } : {}),
    ...(Array.isArray(revarreduras) && revarreduras.length ? { revarreduras: revarreduras.map(Number) } : {}),
    ...(Array.isArray(documentos) && documentos.length ? { documentos } : {}),
    ...(cliente ? { empresaCnpj: cliente.cnpjDigits } : {})
  };
  try {
    return await clienteDaPonte(configuracao).criarAgenda(corpo);
  } catch (erro) {
    throw erroDaPonte(erro);
  }
}

export async function desligarAgendaNaPonte({ configuracao = {}, id }) {
  try {
    return await clienteDaPonte(configuracao).desligarAgenda(id);
  } catch (erro) {
    throw erroDaPonte(erro);
  }
}

export function descreverAgendaDaPonte(item) {
  const hora = String(item.hora).padStart(2, "0") + ":" + String(item.minuto || 0).padStart(2, "0");
  const dia = DIAS_SEMANA[Number(item.diaSemana) || 0];
  const quando = item.frequencia === "mensal" ? "Todo dia " + item.diaMes + " às " + hora
    : item.frequencia === "semanal" ? (["domingo", "sábado"].includes(dia) ? "Todo " : "Toda ") + dia + " às " + hora
    : "Todo dia às " + hora;
  return item.descricao || quando;
}

/** Encerra o vinculo na PONTE: ela para de varrer; nada e apagado la nem aqui. */
export async function encerrarNaPonte({ clienteId, configuracao = {} }) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  let r;
  try {
    r = await clienteDaPonte(configuracao).encerrarNaCarteira(cliente.cnpjDigits);
  } catch (erro) {
    throw erroDaPonte(erro);
  }
  ponteEstado.salvar(clienteId, { naCarteira: false });
  return { aviso: r.aviso || "Vinculo encerrado na PONTE." };
}

/**
 * Guarda o A1 do cliente no cofre da PONTE. Vem do arquivo enviado agora ou do
 * que ja esta no cofre do NUCLEO. O arquivo e aberto aqui antes de sair: senha
 * errada ou certificado de outro CNPJ param aqui, com o motivo.
 */
export async function enviarA1ParaPonte({ clienteId, configuracao = {}, pfxBase64 = null, senha = null, usarDoCofre = false,
  autorizadoPor, referencia = null }) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  if (!String(autorizadoPor || "").trim()) {
    throw new ErroCaptura("Diga quem autorizou a guarda do certificado na PONTE (o cliente que delegou)", { definitivo: true });
  }
  let pfx;
  let senhaPfx;
  if (usarDoCofre) {
    const { segredo } = credencial(empresasCaptura.porCliente(clienteId));
    pfx = segredo.pfx;
    senhaPfx = segredo.senha;
  } else {
    if (!pfxBase64 || !senha) throw new ErroCaptura("Envie o arquivo .pfx e a senha dele", { definitivo: true });
    pfx = Buffer.from(pfxBase64, "base64");
    senhaPfx = senha;
  }
  let certificado;
  try {
    certificado = lerPfx(pfx, senhaPfx);
  } catch (erro) {
    throw new ErroCaptura(erro.message, { definitivo: true });
  }
  const cobertura = cobreCnpj(certificado, cliente.cnpjDigits);
  if (!cobertura.cobre) {
    throw new ErroCaptura("Este A1 e de " + (certificado.titular || "outro titular") + " e nao serve para o CNPJ " +
      cliente.cnpj + " (" + cobertura.motivo + "). Para filial, o A1 da matriz serve.", { definitivo: true });
  }
  const ponte = clienteDaPonte(configuracao);
  let r;
  try {
    r = await ponte.enviarCertificado(cliente.cnpjDigits, { pfxBase64: pfx.toString("base64"), pfxPassword: senhaPfx,
      autorizadoPor: String(autorizadoPor).trim(), referencia: referencia || undefined });
  } catch (erro) {
    throw erroDaPonte(erro);
  }
  await vinculoNaPonte(ponte, cliente).catch(() => null);
  return { titular: r.titular || certificado.titular, vencimento: String(r.vencimento || certificado.validoAte || "").slice(0, 10),
    diasRestantes: r.diasRestantes ?? null, cobertura: cobertura.motivo, aviso: r.aviso || null };
}

/**
 * Tira o A1 do cliente do cofre da PONTE. A PONTE deixa de varrer por ele ate
 * outro A1 ser enviado; nada do que ja foi capturado e apagado.
 */
export async function removerA1DaPonte({ clienteId, configuracao = {} }) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  const ponte = clienteDaPonte(configuracao);
  try {
    await ponte.removerCertificado(cliente.cnpjDigits);
  } catch (erro) {
    throw erroDaPonte(erro);
  }
  await vinculoNaPonte(ponte, cliente).catch(() => null);
  return { removido: true, aviso: "A1 tirado do cofre da PONTE. A busca desta empresa para ate outro A1 ser enviado." };
}

/** Termo de guarda do certificado (PDF gerado pela PONTE) para o cliente assinar. */
export async function termoDaPonte({ clienteId, configuracao = {}, responsavelNome, responsavelCpf }) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  if (!String(responsavelNome || "").trim()) throw new ErroCaptura("Informe o responsavel pelo cliente", { definitivo: true });
  try {
    return { pdf: await clienteDaPonte(configuracao).gerarTermo(cliente.cnpjDigits, { responsavelNome, responsavelCpf }),
      nome: "TERMO-A1-" + cliente.cnpjDigits + ".pdf" };
  } catch (erro) {
    throw erroDaPonte(erro);
  }
}

/** Guarda na PONTE o termo assinado pelo cliente. */
export async function guardarTermoAssinado({ clienteId, configuracao = {}, arquivoBase64, nome, tipoMime, assinadoPor }) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  if (!arquivoBase64) throw new ErroCaptura("Envie o termo assinado", { definitivo: true });
  try {
    return await clienteDaPonte(configuracao).enviarTermoAssinado(cliente.cnpjDigits,
      { arquivoBase64, nome, tipoMime, assinadoPor });
  } catch (erro) {
    throw erroDaPonte(erro);
  }
}

/** O termo assinado que esta guardado na PONTE. */
export async function termoAssinadoDaPonte({ clienteId, configuracao = {} }) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  try {
    return await clienteDaPonte(configuracao).termoAssinado(cliente.cnpjDigits);
  } catch (erro) {
    throw erroDaPonte(erro);
  }
}

/** Certificados do cofre da PONTE: vencendo nos proximos dias e clientes sem A1. */
export async function certificadosDaPonte({ configuracao = {}, dias = 60 }) {
  try {
    const r = await clienteDaPonte(configuracao).certificados(dias);
    const porCnpj = new Map(clientes.listar().map((cliente) => [cliente.cnpjDigits, cliente]));
    const comCliente = (item) => ({ ...item, clientId: porCnpj.get(item.empresaCnpj)?.id || null,
      nome: porCnpj.get(item.empresaCnpj)?.name || item.apelido || item.empresaCnpj });
    return { dias: r.dias ?? dias, vencendo: (r.vencendo || []).map(comCliente), semCertificado: (r.semCertificado || []).map(comCliente) };
  } catch (erro) {
    throw erroDaPonte(erro);
  }
}

// ----------------------------------------- revisao de cancelamentos da NFS-e
//
// A captura pelo ADN ja traz os eventos da caixa da empresa. Mas a NFS-e que
// entrou por outro caminho (importacao, pasta de entrada, chave avulsa) nunca
// seria perguntada de novo, e o municipio pode cancelar de oficio, o prestador
// pode cancelar ou substituir depois. Aqui o NUCLEO pergunta a Sefin Nacional,
// nota por nota, pela chave (GET /nfse/{chave}/eventos/{tipo}/1).
//
//   - so NFS-e nacional (chave de 50 digitos) ainda nao cancelada, das
//     competencias dos ultimos N meses;
//   - "sem_evento" nao e perguntada de novo no mesmo dia; "nao_conferida"
//     (a Sefin nao respondeu direito) entra na proxima;
//   - so o XML do evento cancela a nota: 404 e "sem evento", e qualquer outra
//     resposta e "nao conferida", nunca "cancelada";
//   - usa o A1 da empresa guardado aqui. Empresa so pela PONTE (A1 la) fica de
//     fora: o achado "cancelada depois" da conferencia da PONTE cobre.

export const EVENTOS_DE_CANCELAMENTO_NFSE = [
  ["101101", "Cancelamento de NFS-e"],
  ["105102", "Cancelamento por substituicao"],
  ["305101", "Cancelamento de oficio pelo municipio"],
  ["105104", "Cancelamento deferido por analise fiscal"]
];

const UM_DIA_MS = 24 * 60 * 60 * 1000;

export async function revisarCancelamentosNfse({ clienteId, configuracao = {}, meses = 3, limite = 200, agora = new Date() }) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) throw new ErroCaptura("Empresa nao encontrada", { definitivo: true });
  const empresa = empresasCaptura.porCliente(clienteId);
  const resumo = { empresa: cliente.name, notas: 0, conferidas: 0, semEvento: 0, canceladas: [], naoConferidas: [],
    puladas: 0, semCertificado: null };
  if (!empresa?.certificadoId) {
    resumo.semCertificado = "Sem A1 desta empresa no NUCLEO. " + (empresa?.fontes?.includes("PONTE")
      ? "Ela e capturada pela PONTE: a conferencia da PONTE (cancelada depois) cobre os cancelamentos."
      : "Envie o A1 em Certificados A1.");
    return resumo;
  }

  const desde = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - (meses - 1), 1)).toISOString().slice(0, 7);
  const candidatas = documentos.doCliente(clienteId)
    .filter((doc) => doc.kind === "NFS-e" && /^\d{50}$/.test(String(doc.key || "")) && String(doc.competencia || "") >= desde)
    .sort((a, b) => String(b.competencia).localeCompare(String(a.competencia)));
  resumo.notas = candidatas.length;

  const { segredo } = credencial(empresa);
  const sefin = new ClienteAdn({
    pfx: segredo.pfx, senha: segredo.senha,
    base: configuracao.sefinBase || sefinDoAdn(configuracao.adnBase || ADN_PRODUCAO),
    ca: configuracao.adnCa,
    espacamentoMs: configuracao.espacamentoMs ?? 700,
    tentativas: configuracao.tentativas ?? 5,
    esperaMaximaMs: configuracao.esperaMaximaMs ?? 8000
  });
  try {
    for (const doc of candidatas) {
      if (resumo.conferidas >= limite) break;
      const ultima = revisaoEventos.ultima(doc.id);
      if (ultima?.resultado === "sem_evento" && agora - new Date(ultima.conferidoEm) < UM_DIA_MS) {
        resumo.puladas += 1;
        continue;
      }
      resumo.conferidas += 1;
      let achado = null;
      try {
        for (const [tipo, descricao] of EVENTOS_DE_CANCELAMENTO_NFSE) {
          const xml = await sefin.eventoNfse(doc.key, tipo);
          if (xml) { achado = { tipo, descricao, xml }; break; }
        }
      } catch (erro) {
        if (erro.autenticacao) {
          // Certificado recusado vale para todas as notas: para aqui.
          revisaoEventos.registrar(doc.id, "nao_conferida", erro.message);
          resumo.naoConferidas.push({ chave: doc.key, numero: doc.number, motivo: erro.message });
          resumo.parouPor = erro.message;
          break;
        }
        revisaoEventos.registrar(doc.id, "nao_conferida", erro.message);
        resumo.naoConferidas.push({ chave: doc.key, numero: doc.number, motivo: erro.message });
        continue;
      }
      if (!achado) {
        revisaoEventos.registrar(doc.id, "sem_evento");
        resumo.semEvento += 1;
        continue;
      }

      const guardado = await acervo.guardar(achado.xml, "xml");
      const quando = (achado.xml.match(/<dhEvento>([^<]+)</) || achado.xml.match(/<dhProc>([^<]+)</) || [])[1] || agora.toISOString();
      eventos.inserir({ clienteId, chave: doc.key, nsu: null, tipo: achado.tipo, descricao: achado.descricao,
        motivo: "Consulta da chave na Sefin Nacional", quando, caminho: guardado.caminho, sha256: guardado.sha256 });
      documentos.marcarCancelado(doc.key, achado.descricao + " (consulta da chave na Sefin Nacional)");
      revisaoEventos.registrar(doc.id, "cancelada", achado.tipo);
      try {
        await regerarPdf(doc.id);
        agendarEspelho(documentos.porId(doc.id), empresa, cliente);
      } catch { /* o PDF com a marca sai na proxima regeracao; a nota ja esta cancelada */ }
      resumo.canceladas.push({ chave: doc.key, numero: doc.number, competencia: doc.competencia, evento: achado.tipo,
        descricao: achado.descricao });
    }
  } finally {
    sefin.fechar();
  }
  return resumo;
}

/** Regera o PDF de um documento (reprocessamento de pendencia). */
/**
 * Corrige no lugar o documento que uma versao antiga do leitor leu errado. O
 * caso conhecido: o CT-e lista as NF-e da carga (infDoc/infNFe) e entrava como
 * uma NF-e vazia, com a chave "sem-cnpj". Rele o XML guardado; se agora sai uma
 * chave valida, o mesmo registro passa a ser o documento certo, com papel,
 * conferencia e PDF refeitos. Nada e apagado. Devolve o que foi corrigido.
 */
export async function corrigirLeiturasAntigas() {
  const corrigidos = [];
  const regrasAtivas = regras.ativas();
  for (const doc of documentos.comChaveSuspeita()) {
    const arquivoXml = arquivos.um(doc.id, "xml");
    const cliente = doc.clientId ? clientes.porId(doc.clientId) : null;
    if (!arquivoXml || !cliente) continue;
    let lido;
    try {
      lido = lerDocumento((await acervo.ler(arquivoXml.caminho)).toString("utf8"), doc.source || "");
    } catch {
      continue;
    }
    const chave = chaveDoImportado(lido);
    if (!/^(\d{44}|\d{50})$/.test(chave) || chave === doc.key) continue;
    // O documento certo ja entrou por outro caminho: este fica como esta, para alguem olhar.
    if (documentos.porIdentidade(identidade(cliente.id, chave))) continue;
    const papel = papelDe(lido, cliente.cnpjDigits);
    const competencia = lido.competencia || (lido.issuedAt ? String(lido.issuedAt).slice(0, 7) : null);
    transacao(() => {
      documentos.corrigirLeitura(doc.id, { ...lido, key: chave, identity: identidade(cliente.id, chave),
        operation: operacaoDaEmpresa(papel) }, { papel, competencia });
      conferencias.trocarChave(doc.key, chave);
      conferencias.salvar(conferirSemDerrubar({ ...lido, key: chave }, regrasAtivas, chave),
        { clienteId: cliente.id, documentoId: doc.id });
    });
    let pdf = "refeito";
    try { await regerarPdf(doc.id); } catch (erro) { pdf = "falhou: " + erro.message; }
    corrigidos.push({ id: doc.id, cliente: cliente.name, de: { tipo: doc.kind, chave: doc.key },
      para: { tipo: lido.kind, chave, numero: lido.number || null, papel, competencia }, pdf });
  }
  return corrigidos;
}

/**
 * Pendencia de PDF que ficou aberta embora o documento ja tenha PDF (refeito
 * depois, ou corrigido pelo reparo da leitura): fecha, dizendo por que.
 */
export function fecharPendenciasDePdfFeito() {
  const fechadas = [];
  for (const pendencia of pendencias.listar({ situacao: "aberta", tipo: "pdf_nao_gerado", limite: 5000 })) {
    if (!pendencia.documentoId || !arquivos.um(pendencia.documentoId, "pdf")) continue;
    pendencias.resolverPorReferencia({ clienteId: pendencia.clientId, fonte: pendencia.fonte, tipo: pendencia.tipo,
      referencia: pendencia.referencia, por: "reparo: o PDF ja foi gerado" });
    fechadas.push({ id: pendencia.id, referencia: pendencia.referencia, documentoId: pendencia.documentoId });
  }
  return fechadas;
}

export async function regerarPdf(documentoId) {
  const documento = documentos.porId(documentoId);
  if (!documento) throw new Error("Documento nao encontrado");
  const xml = arquivos.um(documentoId, "xml");
  if (!xml) throw new Error("Documento sem XML no acervo");
  const bytes = await acervo.ler(xml.caminho);
  const contador = { pdfs: 0, pdfFalhas: 0 };
  await gerarPdfs([{ registro: documento, documento, xml: bytes.toString("utf8") }],
    { id: documento.clientId }, documento.fonte || "ADN", contador);
  if (contador.pdfFalhas) throw new Error("O PDF continua falhando; veja a pendencia");
  return contador;
}

export { ErroAdn, ErroSefaz };
