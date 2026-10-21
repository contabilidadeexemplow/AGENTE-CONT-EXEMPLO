// Rotas HTTP da captura automatica. Montadas pelo server.mjs, que entrega os
// helpers de sessao, permissao, corpo e auditoria.

import { lerPfx, cobreCnpj, ERRO_SENHA, ERRO_LEGADO, ERRO_ARQUIVO } from "./certificados.mjs";
import { chaveConfigurada, estadoCofre } from "./segredos.mjs";
import * as acervo from "./acervo.mjs";
import { criarZip } from "./zip.mjs";
import { criarXlsx } from "./planilha.mjs";
import { caminhoRelativo, nomeArquivo, mesmaPasta } from "./pastas.mjs";
import { tarefasDevidas, descreverAgendamento, PRIORIDADE } from "./agendador.mjs";
import {
  sincronizarEmpresa, espelharPendentes, regerarPdf, agendarEspelho, reconciliarEspelho, cienciaManual,
  cienciaPelaPonte, importarArquivos, TIPOS_PENDENCIA, FONTES, revisarCancelamentosNfse, limiteDoPlano,
  conferirCancelamentosPelaPonte, baixarPeriodoDaPonte, mapaDoPeriodo, competenciasEntre, cienciaEmLote,
  incluirNaPonte, encerrarNaPonte, enviarA1ParaPonte, termoDaPonte, guardarTermoAssinado, termoAssinadoDaPonte,
  certificadosDaPonte, alterarNaPonte, nfaDaPonte, agendaDaPonte, criarAgendaNaPonte, desligarAgendaNaPonte,
  descreverAgendaDaPonte, cadastrarEmpresaPeloCertificado, competenciasDaRotina, documentosDaEmpresa, removerA1DaPonte,
  reagendarEspelho
} from "./motor-captura.mjs";
import { entradaRelativa } from "./entrada.mjs";
import { prazosPreventivos, JANELA_DIAS, mesDeEmissaoDaChave, JANELA_DISTRIBUICAO_DIAS } from "./prevencao.mjs";
import { apurarPresumido, apurarRealEstimativa, apurarRealTrimestral, ATIVIDADES, ATIVIDADE_DO_DOCUMENTO, trimestre } from "./lucro.mjs";
import { CODIGO_UF } from "./sefaz.mjs";
import { clientes, documentos } from "./repositorio.mjs";
import {
  certificadosDigitais, empresasCaptura, cursores, agendamentos, tarefas, rastreio, pendencias,
  arquivos, eventos, gravacoes, tokensAgente, acervoDocs, manifestacoes, ponteEstado, lucro, termosGuarda
} from "./repo-captura.mjs";
import { gerarPdfTermo } from "./termo.mjs";
import { conferirAssinaturaDoTermo } from "./assinatura-pdf.mjs";
import { configuracao as configuracaoDoEscritorio } from "./painel.mjs";

const MODOS = ["proprio", "procuracao"];
const TIPOS = ["ambas", "emitidas", "recebidas"];
const FREQUENCIAS = ["mensal", "semanal", "diaria"];
const LIMITE_EXPORTACAO = 5000;
const LIMITE_RELACAO = 20000;

/** Colunas da relacao de notas em Excel; a pessoa escolhe quais (e a tela lista estas mesmas chaves). */
export const COLUNAS_RELACAO = [
  { chave: "empresa", titulo: "Empresa", largura: 34 }, { chave: "cnpjEmpresa", titulo: "CNPJ da empresa", largura: 20 },
  { chave: "documento", titulo: "Documento", largura: 10 }, { chave: "papel", titulo: "Papel", largura: 10 },
  { chave: "numero", titulo: "Numero", largura: 12 }, { chave: "serie", titulo: "Serie", largura: 7 },
  { chave: "emissao", titulo: "Emissao", tipo: "data", largura: 12 }, { chave: "competencia", titulo: "Competencia", largura: 12 },
  { chave: "emitente", titulo: "Emitente", largura: 34 }, { chave: "cnpjEmitente", titulo: "CNPJ do emitente", largura: 20 },
  { chave: "destinatario", titulo: "Destinatario ou tomador", largura: 34 },
  { chave: "cnpjDestinatario", titulo: "CNPJ do destinatario", largura: 20 },
  { chave: "valor", titulo: "Valor", tipo: "moeda", largura: 14 }, { chave: "situacao", titulo: "Situacao", largura: 12 },
  { chave: "conferencia", titulo: "Conferencia", largura: 14 }, { chave: "xml", titulo: "XML", largura: 6 },
  { chave: "pdf", titulo: "PDF", largura: 6 }, { chave: "chave", titulo: "Chave", largura: 52 }
];
const FONTES_SEFAZ = ["NFE", "CTE"];
const LIMITE_ARQUIVOS_IMPORTACAO = 2000;

/** [{ nome, conteudoBase64 }] do corpo para [{ nome, bytes }]; recusa o que nao e lista. */
function arquivosDoCorpo(input) {
  const lista = Array.isArray(input.arquivos) ? input.arquivos : null;
  if (!lista || !lista.length) return { erro: "Envie arquivos: [{ nome, conteudoBase64 }]" };
  if (lista.length > LIMITE_ARQUIVOS_IMPORTACAO) return { erro: "Maximo de " + LIMITE_ARQUIVOS_IMPORTACAO + " arquivos por envio" };
  return {
    arquivos: lista.map((item) => ({
      nome: String(item.nome || "arquivo").split(/[\\/]/).pop().slice(0, 200),
      bytes: Buffer.from(String(item.conteudoBase64 || ""), "base64")
    }))
  };
}

function resumoImportacao(resultado) {
  return {
    novos: resultado.novos, emitidas: resultado.emitidas, recebidas: resultado.recebidas, outras: resultado.outras,
    duplicados: resultado.duplicados, eventos: resultado.eventos, recusados: resultado.recusados,
    pdfsAnexados: resultado.pdfsAnexados, pdfsGerados: resultado.pdfsGerados, porTipo: resultado.porTipo
  };
}

/** Nome no esquema da pasta, para download e ZIP. */
function nomeDoDocumento(documento, extensao) {
  return nomeArquivo({
    numero: documento.number, papel: documento.papel, emitente: documento.emitter?.name,
    destinatario: documento.recipient?.name, nsu: documento.nsu, chave: documento.key, tipo: documento.kind
  }, extensao);
}

/** Enfileira uma tarefa manual por fonte ligada, pulando a que ja esta na fila. */
function enfileirarFontes(empresa, usuario) {
  const criadas = [];
  const jaNaFila = [];
  for (const fonte of empresa.fontes?.length ? empresa.fontes : ["ADN"]) {
    const aberta = tarefas.emAberto(empresa.clientId, fonte);
    if (aberta) { jaNaFila.push(tarefas.porId(aberta.id)); continue; }
    criadas.push(tarefas.enfileirar({
      clienteId: empresa.clientId, fonte, origem: "manual", prioridade: PRIORIDADE.manual, usuario
    }));
  }
  return { criadas, jaNaFila };
}

function csv(linhas) {
  return "﻿" + linhas.map((linha) => linha.map((valor) => {
    const texto = String(valor ?? "");
    return /[";\n]/.test(texto) ? '"' + texto.replace(/"/g, '""') + '"' : texto;
  }).join(";")).join("\n");
}

function filtrosDaUrl(req) {
  const url = new URL(req.url, "http://local");
  const pegar = (nome) => url.searchParams.get(nome) || undefined;
  return {
    clienteId: pegar("clienteId"), cnpj: pegar("cnpj"), competencia: pegar("competencia"),
    de: pegar("de"), ate: pegar("ate"), papel: pegar("papel"), numero: pegar("numero"),
    chave: pegar("chave"), busca: pegar("busca"), produto: pegar("produto"), situacao: pegar("situacao"), xml: pegar("xml"), pdf: pegar("pdf"),
    tipo: pegar("tipo"), fonte: pegar("fonte"), contraparte: pegar("contraparte"), valorMin: pegar("valorMin"), valorMax: pegar("valorMax"),
    pagina: Number(pegar("pagina") || 1), porPagina: Math.min(500, Number(pegar("porPagina") || 50))
  };
}

export function criarRotasCaptura(ctx) {
  const { json, body, auth, exigir, auditar, configuracaoCaptura, executarVigilancia, modoDemo } = ctx;

  // Revisoes de cancelamento em andamento ou concluidas, por empresa (memoria:
  // o resultado que importa fica na trilha e nas notas canceladas).
  const revisoes = new Map();
  // "Baixar periodo" em andamento ou concluido, por empresa.
  const periodos = new Map();

  /**
   * Apuracao do Lucro Presumido ou Real a partir das notas da empresa e do que
   * a pessoa informou. A atividade de cada tipo de documento define o percentual.
   */
  function calcularLucro(input) {
    const cliente = clientes.porId(input.clienteId);
    if (!cliente) throw new Error("Empresa nao encontrada");
    const regime = input.regime;
    if (!["presumido", "real-estimativa", "real-trimestral"].includes(regime)) throw new Error("Regime invalido");
    const atividadeDe = { ...ATIVIDADE_DO_DOCUMENTO, ...(input.atividades || {}) };
    for (const atividade of Object.values(atividadeDe)) if (!ATIVIDADES[atividade]) throw new Error("Atividade invalida: " + atividade);
    const porAtividade = (receitas) => {
      const saida = {};
      for (const [tipo, valor] of Object.entries(receitas)) {
        const atividade = atividadeDe[tipo] || "comercio";
        saida[atividade] = (saida[atividade] || 0) + valor;
      }
      return saida;
    };
    const somar = (lista, campo) => lista.reduce((s, item) => s + (item[campo] || 0), 0);
    const informadas = input.retencoes || {};
    const numero = (valor) => (valor === undefined || valor === null || valor === "" ? undefined : Number(valor));

    if (regime === "real-estimativa") {
      if (!/^\d{4}-\d{2}$/.test(String(input.periodo || ""))) throw new Error("Competencia invalida: use AAAA-MM");
      const mes = lucro.dadosDasNotas(cliente.id, [input.periodo])[input.periodo];
      const retencoes = { irpj: numero(informadas.irpj) ?? mes.retencoes.irpj, csll: numero(informadas.csll) ?? mes.retencoes.csll,
        pis: numero(informadas.pis) ?? 0, cofins: numero(informadas.cofins) ?? 0 };
      const resultado = apurarRealEstimativa({ competencia: input.periodo, receitasPorAtividade: porAtividade(mes.receitas),
        compras: numero(input.compras) ?? mes.compras, percentuais: input.percentuais || {}, retencoes, ajustes: input.ajustes || {} });
      return { cliente, resultado, notas: { [input.periodo]: mes }, retencoes };
    }

    const { ano, trimestre: t, meses } = trimestre(input.periodo);
    const anteriores = [];
    for (let i = 1; i < t; i += 1) anteriores.push(...trimestre(ano + "-T" + i).meses);
    const dados = lucro.dadosDasNotas(cliente.id, [...anteriores, ...meses]);
    const doTrimestre = meses.map((m) => dados[m]);
    const receitasTrimestre = {};
    for (const mes of doTrimestre) for (const [tipo, valor] of Object.entries(mes.receitas)) receitasTrimestre[tipo] = (receitasTrimestre[tipo] || 0) + valor;
    const retencoes = { irpj: numero(informadas.irpj) ?? somar(doTrimestre.map((m) => m.retencoes), "irpj"),
      csll: numero(informadas.csll) ?? somar(doTrimestre.map((m) => m.retencoes), "csll"),
      pis: numero(informadas.pis) ?? 0, cofins: numero(informadas.cofins) ?? 0 };
    const receitasMensais = Object.fromEntries(meses.map((m) => [m, dados[m].receita]));
    if (regime === "presumido") {
      const receitasTrimestresAnteriores = [];
      for (let i = 1; i < t; i += 1) receitasTrimestresAnteriores.push(trimestre(ano + "-T" + i).meses.reduce((s, m) => s + dados[m].receita, 0));
      const resultado = apurarPresumido({ periodo: input.periodo, receitasPorAtividade: porAtividade(receitasTrimestre), receitasMensais,
        receitasTrimestresAnteriores, percentuais: input.percentuais || {}, retencoes, ajustes: input.ajustes || {} });
      return { cliente, resultado, notas: Object.fromEntries(meses.map((m) => [m, dados[m]])), retencoes };
    }
    const resultado = apurarRealTrimestral({ periodo: input.periodo, lucroContabil: input.lucroContabil, adicoes: numero(input.adicoes) || 0,
      exclusoes: numero(input.exclusoes) || 0, prejuizoACompensar: numero(input.prejuizoACompensar) || 0,
      baseNegativaCsll: numero(input.baseNegativaCsll) || 0, receitasMensais,
      comprasMensais: Object.fromEntries(meses.map((m) => [m, dados[m].compras])), retencoes });
    return { cliente, resultado, notas: Object.fromEntries(meses.map((m) => [m, dados[m]])), retencoes };
  }

  const competenciaAtual = () => new Date().toISOString().slice(0, 7);

  /** Dispara o "Baixar periodo" em segundo plano (um por empresa de cada vez). */
  function iniciarBaixaDePeriodo(atual, clienteId, de, ate, meses = null) {
    const andamento = periodos.get(clienteId);
    if (andamento?.situacao === "executando") return andamento;
    const estado = { situacao: "executando", de, ate, meses, iniciadaEm: new Date().toISOString(), resumo: null, erro: null };
    periodos.set(clienteId, estado);
    auditar(atual, "Baixar periodo pedido", clienteId, { de, ate, meses });
    baixarPeriodoDaPonte({ clienteId, de, ate, configuracao: configuracaoCaptura() })
      .then((resumo) => {
        estado.situacao = "concluida";
        estado.resumo = resumo;
        estado.meses = resumo.competencias.length;
        auditar({ email: atual.email }, "Periodo baixado da PONTE", clienteId, {
          de, ate, novos: resumo.novos, duplicados: resumo.duplicados, resumos: resumo.resumos,
          falhas: resumo.falhas, emitidasPelaPonte: resumo.emitidasPelaPonte
        });
        executarVigilancia();
      })
      .catch((erro) => { estado.situacao = "falhou"; estado.erro = erro.message; });
    return estado;
  }

  /**
   * Cada empresa tem a sua pasta: duas na mesma misturariam os meses e os
   * tipos de nota de uma com os da outra.
   */
  function donaDaPasta(pasta, clienteId) {
    // Pasta do navegador e de cada computador: o mesmo nome em duas empresas nao e a mesma pasta.
    if (!pasta || String(pasta).startsWith("navegador:")) return null;
    return empresasCaptura.listar().find((item) => item.clientId !== clienteId && mesmaPasta(item.pastaDestino, pasta)) || null;
  }

  function pastaDeOutra(dona) {
    return "Essa pasta ja e da empresa " + dona.name + ". Cada empresa tem a sua pasta.";
  }

  /** Agente local: autentica pelo token, nao por sessao de usuario. */
  function agente(req, res) {
    const encontrado = tokensAgente.validar(String(req.headers["x-agente-token"] || ""));
    if (!encontrado) { json(res, 401, { error: "Token de agente invalido" }); return null; }
    return encontrado;
  }

  return [

    // ----------------------------------------------------- certificados A1

    ["GET", /^\/api\/certificados-digitais$/, (req, res) => {
      if (!exigir(req, res, "config")) return;
      json(res, 200, { cofre: estadoCofre(), certificados: certificadosDigitais.listar() });
    }],

    ["POST", /^\/api\/certificados-digitais$/, async (req, res) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      if (!chaveConfigurada()) {
        const estado = estadoCofre();
        return json(res, 503, {
          error: "Cofre de segredos indisponivel: o certificado nao sera guardado sem cifra",
          motivo: estado.motivo, comoResolver: estado.comoResolver
        });
      }
      const input = await body(req);
      if (!input.arquivoBase64 || input.senha === undefined) {
        return json(res, 422, { error: "Envie o arquivo .pfx (arquivoBase64) e a senha" });
      }
      const pfx = Buffer.from(String(input.arquivoBase64), "base64");
      let info;
      try {
        info = lerPfx(pfx, input.senha);
      } catch (erro) {
        if ([ERRO_SENHA, ERRO_LEGADO, ERRO_ARQUIVO].includes(erro.code)) {
          auditar(atual, "Certificado A1 recusado", "certificados", { motivo: erro.code });
          return json(res, 422, { error: erro.message, code: erro.code, comoResolver: erro.comoResolver });
        }
        throw erro;
      }
      const repetido = certificadosDigitais.porSha(info.sha256Arquivo);
      if (repetido) return json(res, 409, { error: "Este certificado ja esta no cofre", certificado: repetido });

      const salvo = certificadosDigitais.criar(info, pfx, input.senha, atual.email);
      // Nunca o arquivo nem a senha: so a identificacao do certificado.
      auditar(atual, "Certificado A1 guardado", salvo.id, {
        titular: info.titular, cnpj: info.titularCnpj, validoAte: info.validoAte, sha256: info.sha256Arquivo
      });
      executarVigilancia();
      json(res, 201, {
        ...salvo,
        aviso: info.vencido ? "Certificado vencido em " + info.validoAte + ": guardado, mas a captura nao o usara." : null
      });
    }],

    ["DELETE", /^\/api\/certificados-digitais\/([^/]+)$/, async (req, res, match) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      const certificado = certificadosDigitais.porId(match[1]);
      if (!certificado) return json(res, 404, { error: "Certificado nao encontrado" });
      const empresas = certificadosDigitais.empresasQueUsam(certificado.id);
      if (empresas.length) {
        return json(res, 409, {
          error: "Certificado em uso por " + empresas.length + " empresa(s): troque o certificado delas antes",
          empresas
        });
      }
      certificadosDigitais.desativar(certificado.id);
      auditar(atual, "Certificado A1 desativado", certificado.id, { titular: certificado.titular });
      json(res, 200, { ok: true });
    }],

    // -------------------------------------------------- empresas da carteira

    ["GET", /^\/api\/carteira$/, (req, res) => {
      if (!auth(req, res)) return;
      const lista = empresasCaptura.listar();
      const certs = certificadosDigitais.listar().filter((item) => item.ativo);
      const pend = pendencias.listar({ situacao: "aberta", limite: 100000 });
      const porTipo = {};
      for (const item of pend) porTipo[item.tipo] = (porTipo[item.tipo] || 0) + 1;
      const { plano, emUso, limite } = limiteDoPlano();
      json(res, 200, {
        plano: plano ? { nome: plano.nome, limiteEmpresas: limite, emUso } : null,
        empresas: {
          total: lista.length,
          configuradas: lista.filter((item) => item.configurada).length,
          ativas: lista.filter((item) => item.ativa).length,
          comErro: lista.filter((item) => item.ativa && item.ultimaTarefa === "erro").length
        },
        certificados: {
          validos: certs.filter((item) => item.situacao === "Valido").length,
          vencendo: certs.filter((item) => item.situacao === "Vencendo").length,
          vencidos: certs.filter((item) => item.situacao === "Vencido").length
        },
        agendamentos: agendamentos.ativos().length,
        fila: tarefas.contagem(),
        documentos: acervoDocs.contagemGeral(),
        pendencias: { abertas: pend.length, porTipo },
        espelho: gravacoes.contagem(),
        lista
      });
    }],

    ["GET", /^\/api\/captura\/empresas$/, (req, res) => {
      if (!auth(req, res)) return;
      json(res, 200, empresasCaptura.listar());
    }],

    ["GET", /^\/api\/captura\/empresas\/([^/]+)$/, (req, res, match) => {
      if (!auth(req, res)) return;
      const empresa = empresasCaptura.porCliente(match[1]);
      if (!empresa) return json(res, 404, { error: "Empresa nao encontrada" });
      const cliente = clientes.porId(match[1]);
      json(res, 200, {
        empresa,
        cliente,
        cursor: cursores.ler(match[1], "ADN"),
        cursores: cursores.daEmpresa(match[1]),
        entrada: empresa.pastaDestino ? entradaRelativa(empresa.cnpjDigits) : null,
        fontes: FONTES,
        manifestacoes: manifestacoes.listar({ clienteId: match[1], limite: 100 }),
        agendamentos: agendamentos.ativos()
          .filter((item) => !item.clientId || item.clientId === match[1])
          .map((item) => ({ ...item, descricao: descreverAgendamento(item) })),
        historico: acervoDocs.historicoMensal(match[1]),
        periodo: mapaDoPeriodo(match[1]),
        ponte: ponteEstado.porCliente(match[1]),
        regra: { documentos: documentosDaEmpresa(empresa), proximaRotina: competenciasDaRotina(empresa, configuracaoCaptura(), match[1]) },
        termo: termosGuarda.atual(match[1]), termos: termosGuarda.historico(match[1]),
        rastreio: rastreio.resumo(match[1], "ADN"),
        pendencias: pendencias.listar({ clienteId: match[1], limite: 200 }),
        tarefas: tarefas.listar({ clienteId: match[1], limite: 20 }),
        espelho: gravacoes.contagem(match[1])
      });
    }],

    ["PUT", /^\/api\/captura\/empresas\/([^/]+)$/, async (req, res, match) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      const cliente = clientes.porId(match[1]);
      if (!cliente) return json(res, 404, { error: "Empresa nao encontrada" });
      const input = await body(req);
      if (input.modo !== undefined && !MODOS.includes(input.modo)) {
        return json(res, 422, { error: "Modo invalido", validos: MODOS });
      }
      if (input.tipos !== undefined && !TIPOS.includes(input.tipos)) {
        return json(res, 422, { error: "Tipos invalidos", validos: TIPOS });
      }
      if (input.fontes !== undefined && (!Array.isArray(input.fontes) || !input.fontes.length ||
        input.fontes.some((fonte) => !FONTES[fonte]))) {
        return json(res, 422, { error: "Fontes invalidas: escolha ao menos uma", validas: Object.keys(FONTES) });
      }
      if (input.uf !== undefined && input.uf !== "" && !CODIGO_UF[String(input.uf).toUpperCase()]) {
        return json(res, 422, { error: "UF invalida: " + input.uf });
      }
      if (input.documentosPonte !== undefined && input.documentosPonte !== null && (!Array.isArray(input.documentosPonte) ||
        !input.documentosPonte.length || input.documentosPonte.some((doc) => !["nfe", "nfse", "cte"].includes(doc)))) {
        return json(res, 422, { error: "Documentos invalidos: escolha ao menos um entre nfe, nfse e cte" });
      }
      if (input.periodoDesde !== undefined && input.periodoDesde && !/^\d{4}-\d{2}$/.test(String(input.periodoDesde))) {
        return json(res, 422, { error: "Comeco do periodo invalido: use AAAA-MM" });
      }
      if (input.periodoMeses !== undefined && input.periodoMeses !== null && input.periodoMeses !== "" &&
        !(Number.isInteger(Number(input.periodoMeses)) && Number(input.periodoMeses) >= 1 && Number(input.periodoMeses) <= 12)) {
        return json(res, 422, { error: "A rotina olha de 1 a 12 meses para tras" });
      }

      // NF-e e CT-e: a SEFAZ so atende o certificado da mesma raiz e precisa da UF.
      const anterior = empresasCaptura.porCliente(cliente.id);
      const fontesFinais = input.fontes ?? anterior?.fontes ?? ["ADN"];
      // A PONTE ja le a SEFAZ por este CNPJ: ler daqui tambem faria os dois
      // cairem no bloqueio de uma hora (656), um por causa do outro.
      if (fontesFinais.includes("PONTE") && fontesFinais.some((fonte) => FONTES_SEFAZ.includes(fonte))) {
        return json(res, 422, {
          error: "Com a PONTE SEFAZ ligada, a NF-e e o CT-e desta empresa vem por ela",
          comoResolver: "Desmarque NF-e e CT-e diretos: a PONTE ja consulta a SEFAZ por este CNPJ, e duas consultas em " +
            "paralelo fazem a SEFAZ bloquear o CNPJ por uma hora."
        });
      }
      if (fontesFinais.some((fonte) => FONTES_SEFAZ.includes(fonte))) {
        const certificadoId = input.certificadoId ?? anterior?.certificadoId;
        const certificado = certificadoId ? certificadosDigitais.porId(certificadoId) : null;
        const raiz = certificado?.raizCnpj || String(certificado?.titularCnpj || "").slice(0, 8);
        if (certificado && raiz !== cliente.cnpjDigits.slice(0, 8)) {
          return json(res, 422, {
            error: "NF-e e CT-e pela SEFAZ exigem o certificado da propria empresa (mesma raiz de CNPJ)",
            comoResolver: "A procuracao do escritorio vale para a NFS-e. Para NF-e e CT-e, cadastre o A1 do cliente " +
              "ou deixe so a NFS-e ligada."
          });
        }
        const uf = input.uf ?? anterior?.uf;
        if (!uf) {
          return json(res, 422, { error: "Informe a UF da empresa: ela vai no pedido a SEFAZ" });
        }
      }

      let cobertura = null;
      if (input.certificadoId) {
        const certificado = certificadosDigitais.porId(input.certificadoId);
        if (!certificado || !certificado.ativo) return json(res, 422, { error: "Certificado nao encontrado ou inativo" });
        cobertura = cobreCnpj(certificado, cliente.cnpjDigits);
        const modo = input.modo || empresasCaptura.porCliente(cliente.id)?.modo || "proprio";
        if (!cobertura.cobre && modo !== "procuracao") {
          return json(res, 422, {
            error: "O certificado de " + certificado.titular + " nao e desta empresa nem do mesmo CNPJ raiz",
            comoResolver: "Use modo procuracao, depois de o cliente outorgar procuracao eletronica ao titular do certificado."
          });
        }
      }

      const pastaAnterior = empresasCaptura.porCliente(cliente.id)?.pastaDestino || "";
      const dona = donaDaPasta(input.pastaDestino, cliente.id);
      if (dona) return json(res, 422, { error: pastaDeOutra(dona) });
      const salvo = empresasCaptura.salvar(cliente.id, {
        modo: input.modo, certificadoId: input.certificadoId, pastaDestino: input.pastaDestino,
        tipos: input.tipos, ativa: input.ativa, fontes: input.fontes, uf: input.uf,
        manifestarCiencia: input.manifestarCiencia === undefined ? undefined : Boolean(input.manifestarCiencia),
        documentosPonte: input.documentosPonte, periodoDesde: input.periodoDesde,
        periodoMeses: input.periodoMeses === undefined ? undefined : (Number(input.periodoMeses) || null)
      }, atual.email);
      if (input.pastaDestino !== undefined && (input.pastaDestino || "") !== pastaAnterior) {
        gravacoes.reiniciarCliente(cliente.id);
        reconciliarEspelho(salvo, cliente);
      }
      // A1 do proprio cliente guardado aqui: o termo de guarda acompanha o certificado (aviso, nao trava).
      const certificadoDaEmpresa = salvo.certificadoId ? certificadosDigitais.porId(salvo.certificadoId) : null;
      if (certificadoDaEmpresa && salvo.modo === "proprio" && certificadoDaEmpresa.raizCnpj === cliente.cnpjDigits.slice(0, 8)) {
        termosGuarda.garantir({ clienteId: cliente.id, certificadoId: certificadoDaEmpresa.id, usuario: atual.email });
      }
      auditar(atual, "Captura configurada", cliente.id, {
        modo: salvo.modo, certificadoId: salvo.certificadoId, pastaDestino: salvo.pastaDestino,
        tipos: salvo.tipos, ativa: salvo.ativa, fontes: salvo.fontes, uf: salvo.uf,
        manifestarCiencia: salvo.manifestarCiencia, documentosPonte: salvo.documentosPonte, periodoDesde: salvo.periodoDesde,
        periodoMeses: salvo.periodoMeses
      });
      executarVigilancia();
      json(res, 200, { ...salvo, cobertura });
    }],

    // Revisao de cancelamentos da NFS-e pela chave (Sefin Nacional). Roda em
    // segundo plano: e uma consulta por nota, longa demais para o pedido esperar.
    ["POST", /^\/api\/captura\/empresas\/([^/]+)\/revisar-cancelamentos$/, async (req, res, match) => {
      const atual = exigir(req, res, "import");
      if (!atual) return;
      if (!clientes.porId(match[1])) return json(res, 404, { error: "Empresa nao encontrada" });
      // Padrao: as competencias dos ultimos 3 meses (o prazo de cancelamento e curto).
      const meses = Math.min(60, Math.max(1, Number((await body(req)).meses) || 3));
      const andamento = revisoes.get(match[1]);
      if (andamento?.situacao === "executando") return json(res, 202, andamento);
      const estado = { situacao: "executando", iniciadaEm: new Date().toISOString(), resumo: null, erro: null };
      revisoes.set(match[1], estado);
      const empresa = empresasCaptura.porCliente(match[1]);
      const pelaPonte = !empresa?.certificadoId && (empresa?.fontes || []).includes("PONTE");
      (pelaPonte ? conferirCancelamentosPelaPonte : revisarCancelamentosNfse)({ clienteId: match[1],
        configuracao: configuracaoCaptura(), meses })
        .then((resumo) => {
          estado.situacao = "concluida";
          estado.resumo = resumo;
          ctx.registrarRevisaoDeCancelamentos?.(atual, match[1], resumo);
        })
        .catch((erro) => { estado.situacao = "falhou"; estado.erro = erro.message; });
      json(res, 202, estado);
    }],

    ["GET", /^\/api\/captura\/empresas\/([^/]+)\/revisar-cancelamentos$/, (req, res, match) => {
      if (!auth(req, res)) return;
      json(res, 200, revisoes.get(match[1]) || { situacao: "nunca" });
    }],

    // Periodo da empresa: o mapa mes a mes e o "Baixar periodo" (de/ate), que
    // traz da PONTE cada competencia, todos os tipos, emitidas e recebidas.
    // Roda em segundo plano: sao tres pacotes e uma listagem por mes.
    ["GET", /^\/api\/captura\/empresas\/([^/]+)\/periodo$/, (req, res, match) => {
      if (!auth(req, res)) return;
      if (!clientes.porId(match[1])) return json(res, 404, { error: "Empresa nao encontrada" });
      json(res, 200, { ...mapaDoPeriodo(match[1]), baixa: periodos.get(match[1]) || { situacao: "nunca" } });
    }],

    // Nova empresa pelo certificado: carteira da PONTE, A1 no cofre dela, cliente
    // aqui com a regra de busca e, se pedido, o periodo trazido logo em seguida.
    // Empresa nova pelo A1. A rota antiga (/api/ponte/empresas/nova) continua: as duas fazem o mesmo.
    ["POST", /^\/api\/(?:ponte|captura)\/empresas\/nova$/, async (req, res) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      const input = await body(req);
      try {
        const r = await cadastrarEmpresaPeloCertificado({ pfxBase64: input.pfxBase64, senha: input.senha,
          autorizadoPor: input.autorizadoPor, referencia: input.referencia || null, cnpjEmpresa: input.cnpjEmpresa || null,
          desde: input.desde || null, documentosPonte: input.documentos || input.documentosPonte || null, configuracao: configuracaoCaptura(),
          usuario: atual.email, buscaPor: input.buscaPor === "ponte" ? "ponte" : "nucleo", uf: input.uf || null });
        auditar(atual, "Empresa cadastrada pelo certificado", r.cliente.id, {
          cnpj: r.cliente.cnpj, criado: r.criado, titular: r.titular, vencimento: r.vencimento, busca: r.busca || "ponte",
          fontes: r.fontes || ["PONTE"], autorizadoPor: String(input.autorizadoPor || "").trim(), periodoDesde: r.periodoDesde
        });
        let baixa = null;
        let captura = null;
        if (input.baixarAgora && r.busca === "nucleo") {
          captura = enfileirarFontes(empresasCaptura.porCliente(r.cliente.id), atual.email).criadas.length;
        } else if (input.baixarAgora && r.periodoDesde) {
          baixa = iniciarBaixaDePeriodo(atual, r.cliente.id, r.periodoDesde, competenciaAtual());
        }
        executarVigilancia();
        json(res, 201, { ...r, baixa, captura });
      } catch (erro) {
        json(res, 422, { error: erro.message });
      }
    }],

    // ----------------------------------------------- termo de guarda do A1
    // Do A1 do cliente guardado aqui. E aviso, nao trava: a busca usa o A1 sem ele.

    ["GET", /^\/api\/captura\/empresas\/([^/]+)\/termo$/, (req, res, match) => {
      if (!auth(req, res)) return;
      if (!clientes.porId(match[1])) return json(res, 404, { error: "Empresa nao encontrada" });
      const atualTermo = termosGuarda.atual(match[1]);
      json(res, 200, { estado: atualTermo ? atualTermo.situacao : "sem_certificado", atual: atualTermo,
        historico: termosGuarda.historico(match[1]) });
    }],

    ["GET", /^\/api\/captura\/empresas\/([^/]+)\/termo\/pdf$/, async (req, res, match) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      const cliente = clientes.porId(match[1]);
      const termo = cliente && termosGuarda.atual(cliente.id);
      if (!termo) return json(res, 404, { error: "Esta empresa nao tem A1 do cliente guardado no NUCLEO" });
      const certificado = certificadosDigitais.porId(termo.certificadoId) || {};
      const escritorio = configuracaoDoEscritorio();
      const pdf = await gerarPdfTermo({
        escritorio: { nome: escritorio.officeName, cnpj: escritorio.officeCnpj || null },
        cliente: { nome: cliente.name, cnpj: cliente.cnpjDigits }, certificado, termo, marca: escritorio.officeName
      });
      termosGuarda.marcarGerado(termo.id, atual.email);
      auditar(atual, "Termo de guarda do A1 gerado", cliente.id, { termo: termo.id, certificado: termo.certificadoId });
      res.writeHead(200, { "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="termo-guarda-a1-' + cliente.cnpjDigits + '.pdf"' });
      res.end(pdf);
    }],

    ["POST", /^\/api\/captura\/empresas\/([^/]+)\/termo\/assinado$/, async (req, res, match) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      const cliente = clientes.porId(match[1]);
      const termo = cliente && termosGuarda.atual(cliente.id);
      if (!termo) return json(res, 404, { error: "Esta empresa nao tem A1 do cliente guardado no NUCLEO" });
      const input = await body(req);
      const bytes = Buffer.from(String(input.conteudoBase64 || ""), "base64");
      if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return json(res, 422, { error: "Envie o termo assinado em PDF" });
      if (bytes.length > 15 * 1024 * 1024) return json(res, 422, { error: "PDF maior que 15 MB" });
      const guardado = await acervo.guardar(bytes, "pdf");
      const nome = String(input.nome || "termo-assinado.pdf").split(/[\\/]/).pop().slice(0, 200);
      // Confere e mostra, sem travar (a mesma regra da PONTE, F6 de 08/10/2026).
      const conferencia = conferirAssinaturaDoTermo(bytes, { cnpjCliente: cliente.cnpjDigits });
      const assinado = termosGuarda.marcarAssinado(termo.id, { caminho: guardado.caminho, sha256: guardado.sha256, nome,
        usuario: atual.email, conferencia });
      auditar(atual, "Termo de guarda do A1 assinado recebido", cliente.id, { termo: termo.id, sha256: guardado.sha256, arquivo: nome,
        conferencia: conferencia.nivel, assinante: conferencia.assinante || null, doCliente: conferencia.doCliente ?? null });
      executarVigilancia();
      json(res, 200, assinado);
    }],

    ["GET", /^\/api\/captura\/empresas\/([^/]+)\/termo\/([^/]+)\/assinado$/, async (req, res, match) => {
      if (!exigir(req, res, "export")) return;
      const termo = termosGuarda.porId(match[2]);
      if (!termo || termo.clientId !== match[1] || !termo.arquivoAssinado) return json(res, 404, { error: "Termo assinado nao encontrado" });
      res.writeHead(200, { "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="' + (termo.nomeArquivo || "termo-assinado.pdf").replace(/"/g, "") + '"' });
      res.end(await acervo.ler(termo.arquivoAssinado));
    }],

    ["POST", /^\/api\/captura\/empresas\/([^/]+)\/periodo$/, async (req, res, match) => {
      const atual = exigir(req, res, "import");
      if (!atual) return;
      const cliente = clientes.porId(match[1]);
      if (!cliente) return json(res, 404, { error: "Empresa nao encontrada" });
      const input = await body(req);
      const empresa = empresasCaptura.porCliente(match[1]);
      if (!empresa?.configurada) return json(res, 422, { error: "Configure a captura desta empresa antes" });
      if (!(empresa.fontes || []).includes("PONTE")) {
        return json(res, 422, { error: "Baixar periodo e da captura pela PONTE. A captura direta (ADN, SEFAZ) ja traz a " +
          "caixa inteira da empresa a partir de onde parou: use Capturar." });
      }
      let competencias;
      try { competencias = competenciasEntre(String(input.de || ""), String(input.ate || "")); }
      catch (erro) { return json(res, 400, { error: erro.message }); }
      json(res, 202, iniciarBaixaDePeriodo(atual, cliente.id, input.de, input.ate, competencias.length));
    }],

    // Ciencia da Operacao em lote: todas as NF-e so em resumo da empresa.
    ["POST", /^\/api\/captura\/empresas\/([^/]+)\/ciencia-em-lote$/, async (req, res, match) => {
      const atual = exigir(req, res, "write");
      if (!atual) return;
      if (!clientes.porId(match[1])) return json(res, 404, { error: "Empresa nao encontrada" });
      try {
        const input = await body(req);
        const r = await cienciaEmLote({ clienteId: match[1], usuario: atual.email, configuracao: configuracaoCaptura(),
          somente: Array.isArray(input.chaves) ? input.chaves : null });
        if (r.pedidas) {
          auditar(atual, "Ciencia da Operacao manifestada", match[1], {
            clientId: match[1], origem: "lote", pelaPonte: r.pelaPonte,
            aceitas: r.aceitas.map((item) => item.chave),
            recusadas: r.recusadas.map((item) => ({ chave: item.chave, cStat: item.cStat, motivo: item.motivo }))
          });
        }
        executarVigilancia();
        json(res, 200, r);
      } catch (erro) {
        json(res, erro.definitivo || erro.autenticacao ? 422 : 502, { error: erro.message });
      }
    }],

    // NF-e so em resumo, uma por uma: o que o portal informou de cada uma, o
    // prazo do XML na distribuicao e se a ciencia ja foi enviada. Nada e
    // manifestado aqui; liberar e escolha da pessoa, nota por nota ou marcadas.
    ["GET", /^\/api\/captura\/resumos$/, (req, res) => {
      if (!auth(req, res)) return;
      const url = new URL(req.url, "http://local");
      const clienteId = url.searchParams.get("clienteId") || undefined;
      const lista = pendencias.listar({ clienteId, situacao: "aberta", tipo: "resumo_sem_xml", limite: 5000 })
        .filter((item) => /^\d{44}$/.test(String(item.chave || "")) && String(item.chave).slice(20, 22) === "55")
        .map((item) => {
          // Pendencia antiga, de antes dos dados separados: le do texto do detalhe.
          const doTexto = /^(?:NF-e|CT-e) de (.+?)(?:, emitida em (\d{4}-\d{2}-\d{2}))?(?:, (?:valor )?R?\$?\s?([\d.,]+))?\./
            .exec(String(item.detalhe || "")) || [];
          const dados = item.dados || { emitente: doTexto[1] || null, emissao: doTexto[2] || null,
            valor: doTexto[3] ? Number(doTexto[3].includes(",") ? doTexto[3].replace(/\./g, "").replace(",", ".") : doTexto[3]) : null };
          const mes = mesDeEmissaoDaChave(item.chave);
          const manifestacao = manifestacoes.porChave(item.clientId, item.chave);
          return {
            id: item.id, clientId: item.clientId, clientName: item.clientName, fonte: item.fonte, chave: item.chave,
            emitente: dados.emitente || null,
            emitenteCnpj: dados.emitenteCnpj || String(item.chave).slice(6, 20),
            emissao: dados.emissao || null, valor: Number.isFinite(dados.valor) ? dados.valor : null,
            prazoXml: mes ? new Date(mes.getTime() + JANELA_DISTRIBUICAO_DIAS * 86_400_000).toISOString().slice(0, 10) : null,
            ciencia: manifestacao ? { situacao: manifestacao.situacao, enviadaEm: manifestacao.enviadaEm } : null,
            desde: item.criadaEm
          };
        })
        .sort((a, b) => String(a.prazoXml).localeCompare(String(b.prazoXml)) || String(b.emissao).localeCompare(String(a.emissao)));
      json(res, 200, { resumos: lista });
    }],

    // ------------------------------------------- Lucro Presumido e Lucro Real
    ["GET", /^\/api\/lucro\/atividades$/, (req, res) => {
      if (!auth(req, res)) return;
      json(res, 200, { atividades: ATIVIDADES, padrao: ATIVIDADE_DO_DOCUMENTO });
    }],

    ["POST", /^\/api\/lucro\/calcular$/, async (req, res) => {
      if (!auth(req, res)) return;
      try {
        const { cliente, resultado, notas, retencoes } = calcularLucro(await body(req));
        json(res, 200, { empresa: cliente.name, resultado, notas, retencoes });
      } catch (erro) {
        json(res, 422, { error: erro.message });
      }
    }],

    ["POST", /^\/api\/lucro\/apuracoes$/, async (req, res) => {
      const atual = exigir(req, res, "import");
      if (!atual) return;
      const input = await body(req);
      try {
        const { cliente, resultado } = calcularLucro(input);
        const id = lucro.gravar({ clienteId: cliente.id, regime: resultado.regime, periodo: resultado.periodo, total: resultado.total,
          entrada: input, resultado, usuario: atual.email });
        auditar(atual, "Apuracao do " + (resultado.regime === "presumido" ? "Lucro Presumido" : "Lucro Real") + " gravada", id, {
          clientId: cliente.id, periodo: resultado.periodo, total: resultado.total, tributos: resultado.tributos
        });
        json(res, 201, { id, resultado });
      } catch (erro) {
        json(res, 422, { error: erro.message });
      }
    }],

    ["GET", /^\/api\/lucro\/apuracoes$/, (req, res) => {
      if (!auth(req, res)) return;
      json(res, 200, lucro.listar(new URL(req.url, "http://local").searchParams.get("clienteId") || null));
    }],

    // Prevencao: o que vence nos proximos dias, por empresa (A1, NF-e em resumo, fechamento do mes).
    ["GET", /^\/api\/prevencao$/, (req, res) => {
      if (!auth(req, res)) return;
      const resumos = pendencias.listar({ situacao: "aberta", tipo: "resumo_sem_xml", limite: 20000 })
        .map((item) => ({ clientId: item.clientId, chave: String(item.chave || item.referencia || "") }));
      json(res, 200, {
        geradoEm: new Date().toISOString(), janelaDias: JANELA_DIAS,
        itens: prazosPreventivos({ empresas: empresasCaptura.listar(), certificados: certificadosDigitais.listar(),
          ponteEstados: ponteEstado.listar(), resumos })
      });
    }],

    // ------------------------------------- carteira do escritorio na PONTE
    ["POST", /^\/api\/ponte\/empresas\/([^/]+)\/incluir$/, async (req, res, match) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      if (!clientes.porId(match[1])) return json(res, 404, { error: "Empresa nao encontrada" });
      const input = await body(req);
      try {
        const r = await incluirNaPonte({ clienteId: match[1], configuracao: configuracaoCaptura(),
          desde: /^\d{4}-\d{2}-\d{2}$/.test(String(input.desde || "")) ? input.desde : null, usuario: atual.email });
        auditar(atual, "Empresa incluida na carteira da PONTE", match[1], { fontes: r.fontes });
        executarVigilancia();
        json(res, 200, r);
      } catch (erro) {
        json(res, 422, { error: erro.message });
      }
    }],

    ["POST", /^\/api\/ponte\/empresas\/([^/]+)\/alterar$/, async (req, res, match) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      if (!clientes.porId(match[1])) return json(res, 404, { error: "Empresa nao encontrada" });
      const input = await body(req);
      try {
        const r = await alterarNaPonte({ clienteId: match[1], configuracao: configuracaoCaptura(),
          apelido: input.apelido, codigoContabil: input.codigoContabil,
          radar: input.radar === undefined || input.radar === "" ? undefined : input.radar === true || input.radar === "true" });
        auditar(atual, "Vinculo alterado na PONTE", match[1], { alterados: r.alterados });
        json(res, 200, r);
      } catch (erro) {
        json(res, 422, { error: erro.message });
      }
    }],

    ["GET", /^\/api\/ponte\/empresas\/([^/]+)\/nfa$/, async (req, res, match) => {
      if (!auth(req, res)) return;
      if (!clientes.porId(match[1])) return json(res, 404, { error: "Empresa nao encontrada" });
      try {
        json(res, 200, { nfa: await nfaDaPonte({ clienteId: match[1], configuracao: configuracaoCaptura() }) });
      } catch (erro) {
        json(res, 422, { error: erro.message });
      }
    }],

    ["POST", /^\/api\/ponte\/empresas\/([^/]+)\/encerrar$/, async (req, res, match) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      if (!clientes.porId(match[1])) return json(res, 404, { error: "Empresa nao encontrada" });
      try {
        const r = await encerrarNaPonte({ clienteId: match[1], configuracao: configuracaoCaptura() });
        auditar(atual, "Vinculo encerrado na PONTE", match[1], {});
        executarVigilancia();
        json(res, 200, r);
      } catch (erro) {
        json(res, 422, { error: erro.message });
      }
    }],

    // O A1 vai para o cofre da PONTE. A senha passa por aqui e segue para a
    // PONTE; o NUCLEO nao a guarda (a do cofre daqui ja esta cifrada).
    ["POST", /^\/api\/ponte\/empresas\/([^/]+)\/certificado$/, async (req, res, match) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      if (!clientes.porId(match[1])) return json(res, 404, { error: "Empresa nao encontrada" });
      const input = await body(req);
      try {
        const r = await enviarA1ParaPonte({ clienteId: match[1], configuracao: configuracaoCaptura(),
          pfxBase64: input.pfxBase64 || null, senha: input.senha || null, usarDoCofre: input.usarDoCofre === true,
          autorizadoPor: input.autorizadoPor, referencia: input.referencia || null });
        auditar(atual, "A1 enviado ao cofre da PONTE", match[1], {
          titular: r.titular, vencimento: r.vencimento, origem: input.usarDoCofre ? "cofre do NUCLEO" : "arquivo",
          autorizadoPor: String(input.autorizadoPor || "").trim()
        });
        executarVigilancia();
        json(res, 200, r);
      } catch (erro) {
        json(res, 422, { error: erro.message });
      }
    }],

    ["POST", /^\/api\/ponte\/empresas\/([^/]+)\/certificado\/remover$/, async (req, res, match) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      if (!clientes.porId(match[1])) return json(res, 404, { error: "Empresa nao encontrada" });
      try {
        const r = await removerA1DaPonte({ clienteId: match[1], configuracao: configuracaoCaptura() });
        auditar(atual, "A1 tirado do cofre da PONTE", match[1], {});
        executarVigilancia();
        json(res, 200, r);
      } catch (erro) {
        json(res, 422, { error: erro.message });
      }
    }],

    ["POST", /^\/api\/ponte\/empresas\/([^/]+)\/termo$/, async (req, res, match) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      if (!clientes.porId(match[1])) return json(res, 404, { error: "Empresa nao encontrada" });
      const input = await body(req);
      try {
        const r = await termoDaPonte({ clienteId: match[1], configuracao: configuracaoCaptura(),
          responsavelNome: input.responsavelNome, responsavelCpf: input.responsavelCpf });
        auditar(atual, "Termo do certificado gerado na PONTE", match[1], { responsavel: input.responsavelNome });
        res.writeHead(200, { "content-type": "application/pdf", "content-disposition": 'attachment; filename="' + r.nome + '"' });
        res.end(r.pdf);
      } catch (erro) {
        json(res, 422, { error: erro.message });
      }
    }],

    ["POST", /^\/api\/ponte\/empresas\/([^/]+)\/termo\/assinado$/, async (req, res, match) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      if (!clientes.porId(match[1])) return json(res, 404, { error: "Empresa nao encontrada" });
      const input = await body(req);
      try {
        const r = await guardarTermoAssinado({ clienteId: match[1], configuracao: configuracaoCaptura(),
          arquivoBase64: input.arquivoBase64, nome: input.nome, tipoMime: input.tipoMime, assinadoPor: input.assinadoPor });
        auditar(atual, "Termo assinado guardado na PONTE", match[1], { nome: input.nome, assinadoPor: input.assinadoPor });
        json(res, 200, r);
      } catch (erro) {
        json(res, 422, { error: erro.message });
      }
    }],

    ["GET", /^\/api\/ponte\/empresas\/([^/]+)\/termo\/assinado$/, async (req, res, match) => {
      const atual = exigir(req, res, "export");
      if (!atual) return;
      if (!clientes.porId(match[1])) return json(res, 404, { error: "Empresa nao encontrada" });
      try {
        const r = await termoAssinadoDaPonte({ clienteId: match[1], configuracao: configuracaoCaptura() });
        res.writeHead(200, { "content-type": r.tipo, "content-disposition": 'attachment; filename="' + r.nome.replace(/"/g, "") + '"' });
        res.end(r.bytes);
      } catch (erro) {
        json(res, /nao ha termo/i.test(erro.message) ? 404 : 422, { error: erro.message });
      }
    }],

    // Agenda da busca na PONTE, cuidada daqui.
    ["GET", /^\/api\/ponte\/agenda$/, async (req, res) => {
      if (!auth(req, res)) return;
      try {
        const r = await agendaDaPonte({ configuracao: configuracaoCaptura() });
        json(res, 200, { ...r, agendas: r.agendas.map((item) => ({ ...item, descricao: descreverAgendaDaPonte(item) })) });
      } catch (erro) {
        json(res, 422, { error: erro.message });
      }
    }],

    ["POST", /^\/api\/ponte\/agenda$/, async (req, res) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      const input = await body(req);
      try {
        const r = await criarAgendaNaPonte({ configuracao: configuracaoCaptura(), frequencia: input.frequencia,
          hora: input.hora, minuto: input.minuto, diaSemana: input.diaSemana, diaMes: input.diaMes,
          revarreduras: input.revarreduras, documentos: input.documentos, clienteId: input.clientId || null });
        auditar(atual, "Horario criado na agenda da PONTE", "ponte-agenda", { frequencia: input.frequencia, hora: input.hora,
          minuto: input.minuto, clientId: input.clientId || null });
        json(res, 201, r);
      } catch (erro) {
        json(res, 422, { error: erro.message });
      }
    }],

    ["DELETE", /^\/api\/ponte\/agenda\/([^/]+)$/, async (req, res, match) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      try {
        const r = await desligarAgendaNaPonte({ configuracao: configuracaoCaptura(), id: decodeURIComponent(match[1]) });
        auditar(atual, "Horario desligado na agenda da PONTE", match[1], {});
        json(res, 200, r);
      } catch (erro) {
        json(res, 422, { error: erro.message });
      }
    }],

    ["GET", /^\/api\/ponte\/certificados$/, async (req, res) => {
      if (!auth(req, res)) return;
      const dias = Math.min(365, Math.max(1, Number(new URL(req.url, "http://local").searchParams.get("dias")) || 60));
      try {
        json(res, 200, await certificadosDaPonte({ configuracao: configuracaoCaptura(), dias }));
      } catch (erro) {
        json(res, 422, { error: erro.message });
      }
    }],

    ["POST", /^\/api\/captura\/empresas\/([^/]+)\/executar$/, async (req, res, match) => {
      const atual = exigir(req, res, "import");
      if (!atual) return;
      const empresa = empresasCaptura.porCliente(match[1]);
      if (!empresa?.configurada) return json(res, 422, { error: "Configure a captura desta empresa antes" });
      const { criadas, jaNaFila } = enfileirarFontes(empresa, atual.email);
      if (!criadas.length) return json(res, 200, { ...jaNaFila[0], jaNaFila: true, tarefas: jaNaFila });
      auditar(atual, "Captura manual solicitada", match[1], {
        tarefas: criadas.map((item) => item.id), fontes: criadas.map((item) => item.fonte)
      });
      ctx.fila?.tick();
      // Compativel com quem le uma tarefa so: a primeira vem no corpo, todas em "tarefas".
      json(res, 202, { ...criadas[0], tarefas: [...criadas, ...jaNaFila] });
    }],

    ["POST", /^\/api\/captura\/empresas\/executar-todas$/, async (req, res) => {
      const atual = exigir(req, res, "import");
      if (!atual) return;
      const criadas = [];
      for (const empresa of empresasCaptura.ativas()) {
        criadas.push(...enfileirarFontes(empresa, atual.email).criadas);
      }
      auditar(atual, "Captura manual da carteira", "carteira", { tarefas: criadas.length });
      ctx.fila?.tick();
      json(res, 202, { criadas: criadas.length });
    }],

    // XML que nao vem de portal com NSU: NFS-e de prefeitura com sistema
    // proprio, NF-e emitida pela propria empresa, nota recebida por e-mail.
    ["POST", /^\/api\/captura\/empresas\/([^/]+)\/importar$/, async (req, res, match) => {
      const atual = exigir(req, res, "import");
      if (!atual) return;
      if (!clientes.porId(match[1])) return json(res, 404, { error: "Empresa nao encontrada" });
      const { arquivos: lista, erro } = arquivosDoCorpo(await body(req));
      if (erro) return json(res, 422, { error: erro });
      const resultado = await importarArquivos({
        clienteId: match[1], arquivos: lista, usuario: atual.email, origem: "upload", configuracao: configuracaoCaptura()
      });
      auditar(atual, "Notas importadas na empresa", match[1], { arquivos: lista.length, ...resumoImportacao(resultado) });
      executarVigilancia();
      json(res, 200, resultado);
    }],

    // Le agora as pastas de entrada que o servidor enxerga (o relogio faz isso a cada minuto).
    ["POST", /^\/api\/captura\/entradas\/varrer$/, async (req, res) => {
      const atual = exigir(req, res, "import");
      if (!atual) return;
      const feitos = (await ctx.varrerEntradas?.()) || [];
      json(res, 200, {
        empresas: feitos.length,
        novos: feitos.reduce((soma, item) => soma + item.novos, 0),
        recusados: feitos.reduce((soma, item) => soma + item.recusados, 0),
        paraAgente: configuracaoCaptura().modoPasta === "agente"
      });
    }],

    // Busca uma faixa de NSU de novo, sem mexer no cursor (resumos que podem ter XML agora).
    ["POST", /^\/api\/captura\/empresas\/([^/]+)\/faixa$/, async (req, res, match) => {
      const atual = exigir(req, res, "import");
      if (!atual) return;
      const input = await body(req);
      const de = Number(input.de);
      const ate = Number(input.ate ?? input.de);
      if (!Number.isInteger(de) || de < 1 || !Number.isInteger(ate) || ate < de) {
        return json(res, 422, { error: "Faixa invalida: informe de e ate inteiros, de >= 1" });
      }
      if (ate - de > 500) return json(res, 422, { error: "Faixa maxima de 500 NSU por vez" });
      if (tarefas.emAberto(match[1], "ADN")?.situacao === "executando") {
        return json(res, 409, { error: "Ha uma captura em andamento para esta empresa: aguarde terminar" });
      }
      try {
        const resumo = await sincronizarEmpresa({
          clienteId: match[1], fonte: "ADN", configuracao: configuracaoCaptura(), faixa: { de, ate }
        });
        auditar(atual, "Faixa de NSU rebuscada", match[1], { de, ate, novos: resumo.novos });
        executarVigilancia();
        json(res, 200, resumo);
      } catch (erro) {
        json(res, erro.definitivo || erro.autenticacao ? 422 : 502, { error: erro.message });
      }
    }],

    // ---------------------------------------------------------- agendamentos

    ["GET", /^\/api\/agendamentos$/, (req, res) => {
      if (!auth(req, res)) return;
      json(res, 200, agendamentos.listar().map((item) => ({ ...item, descricao: descreverAgendamento(item) })));
    }],

    ["POST", /^\/api\/agendamentos$/, async (req, res) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      const input = await body(req);
      const erro = validarAgendamento(input);
      if (erro) return json(res, 422, { error: erro });
      const criado = agendamentos.criar({
        clientId: input.clientId || null,
        nome: input.nome || (input.frequencia === "mensal" ? "Fechamento mensal" : "Captura " + input.frequencia),
        frequencia: input.frequencia,
        diaMes: input.frequencia === "mensal" ? Number(input.diaMes) : null,
        diaSemana: input.frequencia === "semanal" ? Number(input.diaSemana) : null,
        hora: Number(input.hora ?? 6),
        minuto: Number(input.minuto ?? 0),
        revarreduras: input.frequencia === "mensal" ? (input.revarreduras ?? [5, 15]).map(Number) : [],
        ativo: input.ativo ?? true,
        soCopiar: input.soCopiar === true || input.soCopiar === "true"
      }, atual.email);
      auditar(atual, "Agendamento criado", criado.id, criado);
      json(res, 201, { ...criado, descricao: descreverAgendamento(criado) });
    }],

    ["PATCH", /^\/api\/agendamentos\/([^/]+)$/, async (req, res, match) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      const antes = agendamentos.porId(match[1]);
      if (!antes) return json(res, 404, { error: "Agendamento nao encontrado" });
      const input = await body(req);
      const erro = validarAgendamento({ ...antes, ...input });
      if (erro) return json(res, 422, { error: erro });
      const depois = agendamentos.atualizar(antes.id, input);
      auditar(atual, "Agendamento alterado", antes.id, { antes, depois });
      json(res, 200, { ...depois, descricao: descreverAgendamento(depois) });
    }],

    ["DELETE", /^\/api\/agendamentos\/([^/]+)$/, async (req, res, match) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      const antes = agendamentos.porId(match[1]);
      if (!antes) return json(res, 404, { error: "Agendamento nao encontrado" });
      agendamentos.remover(antes.id);
      auditar(atual, "Agendamento removido", antes.id, antes);
      json(res, 200, { ok: true });
    }],

    // Roda o agendador agora. `agora` simulado so em modo demonstracao.
    ["POST", /^\/api\/agendamentos\/rodar$/, async (req, res) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      const input = await body(req).catch(() => ({}));
      if (input.agora && !modoDemo) return json(res, 403, { error: "Horario simulado so em modo demonstracao" });
      const criadas = ctx.rodarAgendador(input.agora ? new Date(input.agora) : new Date());
      json(res, 200, { criadas: criadas.length, tarefas: criadas });
    }],

    // ------------------------------------------------------------- tarefas

    ["GET", /^\/api\/tarefas$/, (req, res) => {
      if (!auth(req, res)) return;
      const url = new URL(req.url, "http://local");
      json(res, 200, {
        contagem: tarefas.contagem(),
        emExecucao: ctx.fila?.emExecucao() || [],
        tarefas: tarefas.listar({
          situacao: url.searchParams.get("situacao") || undefined,
          clienteId: url.searchParams.get("clienteId") || undefined,
          limite: Number(url.searchParams.get("limite") || 200)
        })
      });
    }],

    ["GET", /^\/api\/tarefas\/([^/]+)$/, (req, res, match) => {
      if (!auth(req, res)) return;
      const tarefa = tarefas.porId(match[1]);
      if (!tarefa) return json(res, 404, { error: "Tarefa nao encontrada" });
      json(res, 200, tarefa);
    }],

    ["POST", /^\/api\/tarefas\/([^/]+)\/(cancelar|reprocessar|antecipar)$/, async (req, res, match) => {
      const atual = exigir(req, res, "import");
      if (!atual) return;
      const tarefa = tarefas.porId(match[1]);
      if (!tarefa) return json(res, 404, { error: "Tarefa nao encontrada" });
      let ok;
      if (match[2] === "cancelar") ok = tarefas.cancelar(tarefa.id);
      else if (match[2] === "reprocessar") ok = tarefas.reprocessar(tarefa.id);
      else { tarefas.antecipar(tarefa.id); ok = true; }
      if (!ok) return json(res, 409, { error: "A tarefa nao esta numa situacao que permita " + match[2] });
      auditar(atual, "Tarefa: " + match[2], tarefa.id, { clientId: tarefa.clientId });
      ctx.fila?.tick();
      json(res, 200, tarefas.porId(tarefa.id));
    }],

    // ----------------------------------------------------------- pendencias

    ["GET", /^\/api\/pendencias$/, (req, res) => {
      if (!auth(req, res)) return;
      const url = new URL(req.url, "http://local");
      json(res, 200, {
        tipos: TIPOS_PENDENCIA,
        pendencias: pendencias.listar({
          clienteId: url.searchParams.get("clienteId") || undefined,
          situacao: url.searchParams.get("situacao") || undefined,
          tipo: url.searchParams.get("tipo") || undefined
        })
      });
    }],

    ["POST", /^\/api\/pendencias\/([^/]+)\/reprocessar$/, async (req, res, match) => {
      const atual = exigir(req, res, "import");
      if (!atual) return;
      const pendencia = pendencias.porId(match[1]);
      if (!pendencia) return json(res, 404, { error: "Pendencia nao encontrada" });
      try {
        let resultado;
        if (pendencia.tipo === "pdf_nao_gerado") {
          resultado = await regerarPdf(pendencia.documentoId);
          const documento = documentos.porId(pendencia.documentoId);
          const empresa = empresasCaptura.porCliente(pendencia.clientId);
          agendarEspelho(documento, empresa, clientes.porId(pendencia.clientId));
          await espelharPendentes(pendencia.clientId, { modoPasta: configuracaoCaptura().modoPasta });
        } else if (pendencia.tipo === "conflito_pasta" || pendencia.tipo === "gravacao_pasta") {
          if (pendencia.documentoId) {
            for (const tipoArquivo of ["xml", "pdf"]) gravacoes.marcar(pendencia.documentoId, tipoArquivo, "pendente");
          }
          resultado = await espelharPendentes(pendencia.clientId, { modoPasta: configuracaoCaptura().modoPasta });
          if (resultado.conflito === 0 && resultado.erro === 0 && resultado.paraAgente === 0) {
            pendencias.marcar(pendencia.id, "resolvida", atual.email);
          }
        } else if (pendencia.fonte === "PONTE") {
          return json(res, 422, {
            error: "Esta nota vem pela PONTE SEFAZ",
            comoResolver: pendencia.tipo === "resumo_sem_xml" && String(pendencia.chave || "").slice(20, 22) === "55"
              ? "Use \"Manifestar ciencia\": a PONTE manifesta e o XML chega na proxima captura."
              : "Use Capturar agora na empresa: a PONTE varre de novo e o pacote do mes e buscado outra vez."
          });
        } else if (FONTES_SEFAZ.includes(pendencia.fonte) && pendencia.tipo === "resumo_sem_xml") {
          return json(res, 422, {
            error: "A SEFAZ so entrega o XML desta NF-e depois da manifestacao do destinatario",
            comoResolver: "Use \"Manifestar ciencia\" nesta pendencia, ou ligue a ciencia automatica da empresa."
          });
        } else if (FONTES_SEFAZ.includes(pendencia.fonte)) {
          return json(res, 422, {
            error: "A SEFAZ nao permite rebuscar um NSU isolado",
            comoResolver: "O documento ja foi entregue uma vez. Obtenha o XML com o emitente e importe; depois marque como resolvida."
          });
        } else if (pendencia.tipo === "resumo_sem_xml" || pendencia.tipo === "xml_invalido") {
          if (!pendencia.nsu) return json(res, 422, { error: "Pendencia sem NSU: use a busca por faixa" });
          resultado = await sincronizarEmpresa({
            clienteId: pendencia.clientId, fonte: pendencia.fonte, configuracao: configuracaoCaptura(),
            faixa: { de: pendencia.nsu, ate: pendencia.nsu }
          });
        } else {
          return json(res, 422, {
            error: "Este tipo de pendencia nao tem reprocessamento automatico",
            comoResolver: pendencia.tipo === "nota_referenciada_ausente"
              ? "A nota nao veio pelo portal. Obtenha o XML com o emitente e importe; depois marque como resolvida."
              : "Marque como resolvida com uma justificativa."
          });
        }
        auditar(atual, "Pendencia reprocessada", pendencia.id, { tipo: pendencia.tipo });
        executarVigilancia();
        json(res, 200, { pendencia: pendencias.porId(pendencia.id), resultado });
      } catch (erro) {
        json(res, 502, { error: erro.message, pendencia: pendencias.porId(pendencia.id) });
      }
    }],

    // Ciencia da Operacao (210210) pedida por uma pessoa: e um ato em nome do
    // cliente, registrado na SEFAZ. Nao confirma nem nega a operacao.
    ["POST", /^\/api\/pendencias\/([^/]+)\/ciencia$/, async (req, res, match) => {
      const atual = exigir(req, res, "write");
      if (!atual) return;
      const pendencia = pendencias.porId(match[1]);
      if (!pendencia) return json(res, 404, { error: "Pendencia nao encontrada" });
      const pelaPonte = pendencia.fonte === "PONTE";
      if ((pendencia.fonte !== "NFE" && !pelaPonte) || pendencia.tipo !== "resumo_sem_xml" || !pendencia.chave ||
        String(pendencia.chave).slice(20, 22) !== "55") {
        return json(res, 422, { error: "Ciencia so se aplica a resumo de NF-e (pendencia da SEFAZ ou da PONTE, com chave)" });
      }
      try {
        const resultado = await (pelaPonte ? cienciaPelaPonte : cienciaManual)({
          clienteId: pendencia.clientId, chave: pendencia.chave, usuario: atual.email, configuracao: configuracaoCaptura()
        });
        auditar(atual, "Ciencia da Operacao manifestada", pendencia.chave, {
          clientId: pendencia.clientId, origem: "manual", aceita: resultado.aceita, cStat: resultado.cStat || null,
          protocolo: resultado.protocolo || null, xmlBaixado: Boolean(resultado.baixado?.novos)
        });
        executarVigilancia();
        json(res, resultado.aceita ? 200 : 422, {
          ...resultado, registro: resultado.registro, pendencia: pendencias.porId(pendencia.id),
          ...(resultado.aceita ? {} : { error: "SEFAZ nao registrou a ciencia: " + (resultado.motivo || "sem motivo") })
        });
      } catch (erro) {
        json(res, erro.definitivo || erro.autenticacao ? 422 : 502, { error: erro.message });
      }
    }],

    ["GET", /^\/api\/captura\/manifestacoes$/, (req, res) => {
      if (!auth(req, res)) return;
      const url = new URL(req.url, "http://local");
      json(res, 200, manifestacoes.listar({ clienteId: url.searchParams.get("clienteId") || null }));
    }],

    ["PATCH", /^\/api\/pendencias\/([^/]+)$/, async (req, res, match) => {
      const atual = exigir(req, res, "write");
      if (!atual) return;
      const pendencia = pendencias.porId(match[1]);
      if (!pendencia) return json(res, 404, { error: "Pendencia nao encontrada" });
      const input = await body(req);
      if (!["resolvida", "aberta"].includes(input.situacao)) {
        return json(res, 422, { error: "situacao deve ser resolvida ou aberta" });
      }
      if (input.situacao === "resolvida" && String(input.justificativa || "").trim().length < 10) {
        return json(res, 422, { error: "Resolver manualmente exige justificativa de ao menos 10 caracteres" });
      }
      const atualizada = pendencias.marcar(pendencia.id, input.situacao, atual.email);
      auditar(atual, "Pendencia marcada como " + input.situacao, pendencia.id, {
        tipo: pendencia.tipo, referencia: pendencia.referencia, justificativa: input.justificativa || null
      });
      executarVigilancia();
      json(res, 200, atualizada);
    }],

    // --------------------------------------------------- acervo capturado

    ["GET", /^\/api\/acervo\/documentos$/, (req, res) => {
      if (!auth(req, res)) return;
      json(res, 200, acervoDocs.buscar(filtrosDaUrl(req)));
    }],

    ["GET", /^\/api\/acervo\/documentos\/([^/]+)$/, (req, res, match) => {
      if (!auth(req, res)) return;
      const documento = documentos.porId(match[1]);
      if (!documento) return json(res, 404, { error: "Documento nao encontrado" });
      json(res, 200, {
        documento,
        arquivos: arquivos.doDocumento(documento.id),
        eventos: eventos.daChave(documento.key)
      });
    }],

    ["GET", /^\/api\/acervo\/documentos\/([^/]+)\/(xml|pdf)$/, async (req, res, match) => {
      const atual = exigir(req, res, "export");
      if (!atual) return;
      const documento = documentos.porId(match[1]);
      const arquivo = documento ? arquivos.um(documento.id, match[2]) : null;
      if (!arquivo) return json(res, 404, { error: "Arquivo nao encontrado" });
      const bytes = await acervo.ler(arquivo.caminho);
      const nome = nomeDoDocumento(documento, match[2]);
      auditar(atual, "Download de " + match[2].toUpperCase(), documento.id, { chave: documento.key });
      res.writeHead(200, {
        "content-type": match[2] === "pdf" ? "application/pdf" : "application/xml; charset=utf-8",
        "content-disposition": 'attachment; filename="' + nome + '"'
      });
      res.end(bytes);
    }],

    ["GET", /^\/api\/acervo\/exportar$/, async (req, res) => {
      const atual = exigir(req, res, "export");
      if (!atual) return;
      const filtros = { ...filtrosDaUrl(req), pagina: 1, porPagina: LIMITE_EXPORTACAO + 1 };
      const resultado = acervoDocs.buscar(filtros);
      if (resultado.total > LIMITE_EXPORTACAO) {
        return json(res, 413, {
          error: "Exportacao com " + resultado.total + " documentos passa do limite de " + LIMITE_EXPORTACAO,
          comoResolver: "Filtre por empresa ou competencia."
        });
      }

      const entradas = [];
      const relatorio = [["Empresa", "CNPJ", "Tipo", "Competencia", "Papel", "Numero", "Chave", "Emissao", "Valor",
        "Situacao", "XML", "PDF", "SHA-256 do XML", "Caminho no ZIP"]];
      for (const item of resultado.documentos) {
        const documento = documentos.porId(item.id);
        const cliente = clientes.porId(item.clientId);
        const lista = arquivos.doDocumento(item.id);
        let caminhoXml = "";
        for (const tipoArquivo of ["xml", "pdf"]) {
          if (!lista[tipoArquivo]) continue;
          const nome = nomeDoDocumento(documento, tipoArquivo);
          const caminho = caminhoRelativo({ cnpj: cliente.cnpjDigits, competencia: documento.competencia,
            papel: documento.papel, tipoArquivo, arquivo: nome, tipo: documento.kind, comEmpresa: true });
          entradas.push({ nome: caminho, conteudo: await acervo.ler(lista[tipoArquivo].caminho) });
          if (tipoArquivo === "xml") caminhoXml = caminho;
        }
        relatorio.push([cliente.name, cliente.cnpj, documento.kind, documento.competencia, documento.papel, documento.number,
          documento.key, documento.issuedAt, item.valor, item.cancelada ? "Cancelada" : "Autorizada",
          lista.xml ? "sim" : "NAO", lista.pdf ? "sim" : "NAO", lista.xml?.sha256 || "", caminhoXml]);
      }

      const clientesNoZip = [...new Set(resultado.documentos.map((item) => item.clientId))];
      const abertas = clientesNoZip.flatMap((id) => pendencias.listar({ clienteId: id, situacao: "aberta" }));
      entradas.push({ nome: "CONFERENCIA.csv", conteudo: csv(relatorio) });
      entradas.push({ nome: "PENDENCIAS.csv", conteudo: csv([
        ["Empresa", "Tipo", "Referencia", "Chave", "NSU", "Detalhe", "Desde"],
        ...abertas.map((item) => [item.clientName, TIPOS_PENDENCIA[item.tipo] || item.tipo, item.referencia,
          item.chave || "", item.nsu ?? "", item.detalhe, item.criadaEm])
      ]) });

      const zip = criarZip(entradas);
      auditar(atual, "Exportacao em ZIP", "acervo", {
        documentos: resultado.documentos.length, arquivos: entradas.length - 2, filtros
      });
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="notas-' + new Date().toISOString().slice(0, 10) + '.zip"'
      });
      res.end(zip);
    }],

    // Relacao das notas em Excel, com os mesmos filtros da tela: uma linha por
    // nota e uma aba de resumo por empresa e competencia.
    ["GET", /^\/api\/acervo\/relacao$/, (req, res) => {
      const atual = exigir(req, res, "export");
      if (!atual) return;
      const filtros = { ...filtrosDaUrl(req), pagina: 1, porPagina: LIMITE_RELACAO + 1 };
      const resultado = acervoDocs.buscar(filtros);
      if (resultado.total > LIMITE_RELACAO) {
        return json(res, 413, { error: "A relacao com " + resultado.total + " notas passa do limite de " + LIMITE_RELACAO,
          comoResolver: "Filtre por empresa ou competencia." });
      }
      const cnpjDe = new Map(clientes.listar().map((cliente) => [cliente.id, cliente.cnpj]));
      const mesBr = (competencia) => /^\d{4}-\d{2}$/.test(String(competencia || "")) ? competencia.slice(5) + "/" + competencia.slice(0, 4) : "";
      // As colunas que a pessoa escolheu, na ordem da lista; sem escolha, todas.
      const pedidas = String(new URL(req.url, "http://local").searchParams.get("colunas") || "").split(",").filter(Boolean);
      const colunas = pedidas.length ? COLUNAS_RELACAO.filter((coluna) => pedidas.includes(coluna.chave)) : COLUNAS_RELACAO;
      if (!colunas.length) return json(res, 400, { error: "Escolha ao menos uma coluna" });
      const valoresDe = (item) => ({
        empresa: item.clientName, cnpjEmpresa: cnpjDe.get(item.clientId) || "", documento: item.tipo, papel: item.papel,
        numero: item.numero, serie: item.serie || "", emissao: item.emissao ? String(item.emissao).slice(0, 10) : null,
        competencia: mesBr(item.competencia), emitente: item.emitente?.nome || "", cnpjEmitente: item.emitente?.cnpj || "",
        destinatario: item.destinatario?.nome || "", cnpjDestinatario: item.destinatario?.cnpj || "", valor: item.valor ?? 0,
        situacao: item.cancelada ? "Cancelada" : "Autorizada", conferencia: item.conferencia, xml: item.xml ? "sim" : "nao",
        pdf: item.pdf ? "sim" : "nao", chave: item.chave
      });
      const notas = resultado.documentos.map((item) => { const v = valoresDe(item); return colunas.map((coluna) => v[coluna.chave]); });
      const resumo = new Map();
      for (const item of resultado.documentos) {
        const chave = item.clientId + "|" + item.competencia;
        const linha = resumo.get(chave) || { empresa: item.clientName, competencia: item.competencia, emitidas: 0, valorEmitidas: 0,
          recebidas: 0, valorRecebidas: 0, outras: 0, canceladas: 0 };
        if (item.papel === "emitida") { linha.emitidas += 1; linha.valorEmitidas += item.cancelada ? 0 : item.valor || 0; }
        else if (item.papel === "recebida") { linha.recebidas += 1; linha.valorRecebidas += item.cancelada ? 0 : item.valor || 0; }
        else linha.outras += 1;
        if (item.cancelada) linha.canceladas += 1;
        resumo.set(chave, linha);
      }
      const xlsx = criarXlsx({ titulo: "Relacao de notas", autor: "NUCLEO", abas: [
        { nome: "Notas", colunas: colunas.map(({ titulo, tipo, largura }) => ({ titulo, tipo, largura })), linhas: notas },
        { nome: "Resumo", colunas: [
          { titulo: "Empresa", largura: 34 }, { titulo: "Competencia", largura: 12 }, { titulo: "Emitidas", tipo: "numero", largura: 10 },
          { titulo: "Valor emitido", tipo: "moeda", largura: 16 }, { titulo: "Recebidas", tipo: "numero", largura: 10 },
          { titulo: "Valor recebido", tipo: "moeda", largura: 16 }, { titulo: "Outras", tipo: "numero", largura: 8 },
          { titulo: "Canceladas", tipo: "numero", largura: 11 }
        ], linhas: [...resumo.values()]
          .sort((a, b) => a.empresa.localeCompare(b.empresa) || String(b.competencia).localeCompare(String(a.competencia)))
          .map((l) => [l.empresa, mesBr(l.competencia), l.emitidas, l.valorEmitidas, l.recebidas, l.valorRecebidas, l.outras, l.canceladas]) }
      ] });
      auditar(atual, "Relacao de notas em Excel", "acervo", { documentos: notas.length, filtros });
      res.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": 'attachment; filename="relacao-de-notas-' + new Date().toISOString().slice(0, 10) + '.xlsx"'
      });
      res.end(xlsx);
    }],

    // ---------------------------------------------------------- agente local

    ["GET", /^\/api\/agente\/tokens$/, (req, res) => {
      if (!exigir(req, res, "config")) return;
      json(res, 200, tokensAgente.listar());
    }],

    ["POST", /^\/api\/agente\/tokens$/, async (req, res) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      const input = await body(req);
      const criado = tokensAgente.criar(String(input.nome || "Agente do escritorio").slice(0, 80), atual.email);
      auditar(atual, "Token de agente criado", criado.id, { nome: criado.nome });
      json(res, 201, { ...criado, aviso: "Guarde o token agora: ele nao sera mostrado de novo." });
    }],

    ["DELETE", /^\/api\/agente\/tokens\/([^/]+)$/, async (req, res, match) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      if (!tokensAgente.revogar(match[1])) return json(res, 404, { error: "Token nao encontrado" });
      auditar(atual, "Token de agente revogado", match[1]);
      json(res, 200, { ok: true });
    }],

    ["GET", /^\/api\/agente\/fila$/, (req, res) => {
      const quem = agente(req, res);
      if (!quem) return;
      const url = new URL(req.url, "http://local");
      json(res, 200, gravacoes.pendentes({ limite: Math.min(1000, Number(url.searchParams.get("limite") || 200)) })
        .map(({ caminhoAcervo, ...item }) => item));
    }],

    // Escolha das pastas no computador do escritorio (agente/escolher-pastas.ps1):
    // a janela lista as empresas e devolve a pasta escolhida no seletor do
    // Windows, sem ninguem colar caminho.
    ["GET", /^\/api\/agente\/empresas$/, (req, res) => {
      if (!agente(req, res)) return;
      json(res, 200, empresasCaptura.listar()
        .filter((item) => item.configurada)
        .map((item) => ({ clientId: item.clientId, nome: String(item.name || "").trim(), cnpj: item.cnpjDigits,
          pastaDestino: item.pastaDestino || "" })));
    }],

    ["PUT", /^\/api\/agente\/empresas\/([^/]+)\/pasta$/, async (req, res, match) => {
      const quem = agente(req, res);
      if (!quem) return;
      const cliente = clientes.porId(match[1]);
      const empresa = cliente && empresasCaptura.porCliente(cliente.id);
      if (!empresa?.configurada) return json(res, 404, { error: "Empresa nao encontrada na captura" });
      const pasta = String((await body(req)).pastaDestino || "").trim();
      // Caminho do Windows (C:\... ou \\servidor\...) escolhido no seletor: nada relativo nem com controle.
      if (pasta && (!/^([A-Za-z]:[\\/]|\\\\)/.test(pasta) || pasta.length > 400 || /[\u0000-\u001f]/.test(pasta))) {
        return json(res, 422, { error: "Pasta invalida: escolha uma pasta deste computador" });
      }
      const dona = donaDaPasta(pasta, cliente.id);
      if (dona) return json(res, 422, { error: pastaDeOutra(dona) });
      const anterior = empresa.pastaDestino || "";
      const salvo = empresasCaptura.salvar(cliente.id, { pastaDestino: pasta || null }, "agente:" + quem.nome);
      if (pasta !== anterior) {
        gravacoes.reiniciarCliente(cliente.id);
        reconciliarEspelho(salvo, cliente);
      }
      auditar({ email: "agente:" + quem.nome }, "Pasta da empresa escolhida no computador do escritorio", cliente.id,
        { anterior, pastaDestino: salvo.pastaDestino });
      json(res, 200, { clientId: cliente.id, nome: cliente.name, pastaDestino: salvo.pastaDestino || "" });
    }],

    // Pastas de entrada que o agente deve olhar: empresas com pasta configurada.
    ["GET", /^\/api\/agente\/entradas$/, (req, res) => {
      if (!agente(req, res)) return;
      json(res, 200, empresasCaptura.listar()
        .filter((item) => item.configurada && item.pastaDestino)
        .map((item) => ({ clientId: item.clientId, cnpj: item.cnpjDigits, nome: item.name,
          pastaDestino: item.pastaDestino, entrada: entradaRelativa(item.cnpjDigits) })));
    }],

    ["POST", /^\/api\/agente\/importar\/([^/]+)$/, async (req, res, match) => {
      const quem = agente(req, res);
      if (!quem) return;
      if (!clientes.porId(match[1])) return json(res, 404, { error: "Empresa nao encontrada" });
      const { arquivos: lista, erro } = arquivosDoCorpo(await body(req));
      if (erro) return json(res, 422, { error: erro });
      const resultado = await importarArquivos({
        clienteId: match[1], arquivos: lista, usuario: "agente:" + quem.nome, origem: "pasta de entrada",
        configuracao: configuracaoCaptura()
      });
      auditar({ email: "agente:" + quem.nome }, "Notas importadas da pasta de entrada", match[1],
        { arquivos: lista.length, ...resumoImportacao(resultado) });
      executarVigilancia();
      json(res, 200, resultado);
    }],

    ["GET", /^\/api\/agente\/arquivo\/([^/]+)\/(xml|pdf|evento-[0-9a-f]{12})$/, async (req, res, match) => {
      if (!agente(req, res)) return;
      const arquivo = arquivos.um(match[1], match[2]);
      if (!arquivo) return json(res, 404, { error: "Arquivo nao encontrado" });
      const bytes = await acervo.ler(arquivo.caminho);
      res.writeHead(200, { "content-type": "application/octet-stream", "x-sha256": arquivo.sha256 });
      res.end(bytes);
    }],

    ["POST", /^\/api\/agente\/confirmar$/, async (req, res) => {
      const quem = agente(req, res);
      if (!quem) return;
      const resultados = confirmarGravacoes((await body(req)).resultados, "agente:" + quem.nome, "do agente " + quem.nome);
      auditar({ email: "agente:" + quem.nome }, "Espelho confirmado pelo agente", quem.id, resumoGravacoes(resultados));
      json(res, 200, { ok: true, recebidos: resultados.length });
    }],

    // ------------------------------------------------- pastas pelo navegador
    // Sem programa instalado: no Chrome ou no Edge, o contador escolhe a pasta de
    // cada empresa no proprio computador (File System Access API) e a tela grava
    // ali o XML e o PDF que faltam. Mesma fila e mesmas regras do agente: o nome
    // e o caminho dentro da pasta sao os do espelho, e nada e sobrescrito.

    ["GET", /^\/api\/pastas$/, (req, res) => {
      if (!auth(req, res)) return;
      json(res, 200, empresasCaptura.listar().filter((item) => item.configurada).map((item) => {
        const contagem = gravacoes.contagem(item.clientId);
        const pasta = item.pastaDestino || "";
        return {
          clientId: item.clientId, nome: String(item.name || "").trim(), cnpj: item.cnpjDigits,
          modo: !pasta ? "nenhuma" : pasta.startsWith("navegador:") ? "navegador" : "agente",
          pasta: pasta.startsWith("navegador:") ? pasta.slice(10) : pasta,
          pendentes: (contagem.pendente || 0) + (contagem.erro || 0), gravados: (contagem.gravado || 0) + (contagem.ja_existia || 0),
          conflitos: contagem.conflito || 0
        };
      }));
    }],

    ["PUT", /^\/api\/pastas\/empresas\/([^/]+)$/, async (req, res, match) => {
      const atual = exigir(req, res, "export");
      if (!atual) return;
      const cliente = clientes.porId(match[1]);
      const empresa = cliente && empresasCaptura.porCliente(cliente.id);
      if (!empresa?.configurada) return json(res, 404, { error: "Empresa nao encontrada na captura" });
      const nome = String((await body(req)).nome || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120);
      const pasta = nome ? "navegador:" + nome : null;
      const anterior = empresa.pastaDestino || "";
      const salvo = empresasCaptura.salvar(cliente.id, { pastaDestino: pasta }, atual.email);
      if ((pasta || "") !== anterior) {
        gravacoes.reiniciarCliente(cliente.id);
        if (pasta) reagendarEspelho(salvo, cliente);
      }
      auditar(atual, "Pasta da empresa escolhida no navegador", cliente.id, { anterior, pastaDestino: pasta });
      const contagem = gravacoes.contagem(cliente.id);
      json(res, 200, { clientId: cliente.id, pasta: nome, pendentes: (contagem.pendente || 0) + (contagem.erro || 0) });
    }],

    ["GET", /^\/api\/pastas\/fila$/, (req, res) => {
      if (!exigir(req, res, "export")) return;
      const url = new URL(req.url, "http://local");
      const clienteId = url.searchParams.get("clienteId");
      if (!clienteId || !clientes.porId(clienteId)) return json(res, 422, { error: "Informe a empresa (clienteId)" });
      json(res, 200, gravacoes.pendentes({ clienteId, limite: Math.min(500, Number(url.searchParams.get("limite") || 100)) })
        .map(({ caminhoAcervo, pastaDestino, ...item }) => item));
    }],

    ["GET", /^\/api\/pastas\/arquivo\/([^/]+)\/(xml|pdf|evento-[0-9a-f]{12})$/, async (req, res, match) => {
      if (!exigir(req, res, "export")) return;
      const arquivo = arquivos.um(match[1], match[2]);
      if (!arquivo) return json(res, 404, { error: "Arquivo nao encontrado" });
      const bytes = await acervo.ler(arquivo.caminho);
      res.writeHead(200, { "content-type": "application/octet-stream", "x-sha256": arquivo.sha256 });
      res.end(bytes);
    }],

    ["POST", /^\/api\/pastas\/confirmar$/, async (req, res) => {
      const atual = exigir(req, res, "export");
      if (!atual) return;
      const resultados = confirmarGravacoes((await body(req)).resultados, "navegador:" + atual.email, "do navegador de " + atual.email);
      if (resultados.length) auditar(atual, "Notas gravadas nas pastas pelo navegador", "pastas", resumoGravacoes(resultados));
      json(res, 200, { ok: true, recebidos: resultados.length });
    }]
  ];

  /** Marca na fila o que o agente ou o navegador gravou; conflito e erro viram pendencia. */
  function confirmarGravacoes(lista, por, deQuem) {
    const resultados = (Array.isArray(lista) ? lista : [])
      .filter((item) => ["gravado", "ja_existia", "conflito", "erro"].includes(item?.situacao));
    for (const item of resultados) {
      gravacoes.marcar(item.documentoId, item.tipoArquivo, item.situacao, { erro: item.erro || null, por });
      if (item.situacao === "conflito" || item.situacao === "erro") {
        pendencias.abrir({
          clienteId: item.clientId, fonte: "PASTA",
          tipo: item.situacao === "conflito" ? "conflito_pasta" : "gravacao_pasta",
          referencia: item.destino, documentoId: item.documentoId,
          detalhe: (item.situacao === "conflito"
            ? "Ja existe arquivo diferente na pasta " + deQuem + ". Nada foi sobrescrito."
            : "Nao foi possivel gravar na pasta " + deQuem + ": ") + (item.erro || "")
        });
      } else if (item.clientId && item.destino) {
        pendencias.resolverPorReferencia({ clienteId: item.clientId, fonte: "PASTA", tipo: "gravacao_pasta", referencia: item.destino });
      }
    }
    return resultados;
  }

  function resumoGravacoes(resultados) {
    return {
      itens: resultados.length,
      porSituacao: resultados.reduce((acc, item) => { acc[item.situacao] = (acc[item.situacao] || 0) + 1; return acc; }, {})
    };
  }
}

function validarAgendamento(entrada) {
  if (!FREQUENCIAS.includes(entrada.frequencia)) return "Frequencia deve ser mensal, semanal ou diaria";
  const hora = Number(entrada.hora ?? 6);
  const minuto = Number(entrada.minuto ?? 0);
  if (!Number.isInteger(hora) || hora < 0 || hora > 23) return "Hora deve ser de 0 a 23";
  if (!Number.isInteger(minuto) || minuto < 0 || minuto > 59) return "Minuto deve ser de 0 a 59";
  if (entrada.frequencia === "mensal") {
    const dia = Number(entrada.diaMes);
    if (!Number.isInteger(dia) || dia < 1 || dia > 28) return "Dia do mes deve ser de 1 a 28 (todo mes tem)";
    const revs = entrada.revarreduras ?? [];
    if (!Array.isArray(revs) || revs.some((item) => !Number.isInteger(Number(item)) || Number(item) < 1 || Number(item) > 27)) {
      return "Revarreduras devem ser dias depois, de 1 a 27";
    }
  }
  if (entrada.frequencia === "semanal") {
    const dia = Number(entrada.diaSemana);
    if (!Number.isInteger(dia) || dia < 0 || dia > 6) return "Dia da semana deve ser de 0 (domingo) a 6 (sabado)";
  }
  if (entrada.clientId && !clientes.porId(entrada.clientId)) return "Empresa do agendamento nao encontrada";
  return null;
}
