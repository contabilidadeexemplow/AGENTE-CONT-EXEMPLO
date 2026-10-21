// Captura de documentos fiscais.
//
// Duas metades, com honestidade sobre qual e qual:
//
// 1. Captura por arquivo (XML solto, lote de XMLs, ZIP): REAL e completa.
//    Le, valida, deduplica por chave de acesso e devolve os documentos.
//
// 2. Captura por portal: ADN (NFS-e) e SEFAZ (NF-e e CT-e) funcionam por
//    empresa, no motor de captura (lib/motor-captura.mjs); NFS-e de prefeitura
//    com sistema proprio entra por importacao e pela pasta de entrada de cada
//    empresa. SIEG, Dominio e Acessorias dependem de contrato, credencial ou
//    layout de terceiros: cada um declara o que falta e nao finge conexao,
//    porque um "Conectado" falso e pior do que um erro claro.

import { extractXml, isZip } from "./zip.mjs";
import { lerLote, validarChave } from "./documentos.mjs";

/** Transforma buffers em arquivos XML, expandindo ZIPs. */
export function expandirArquivos(arquivos, { maxBytes } = {}) {
  const xmls = [];
  const falhas = [];

  for (const arquivo of arquivos) {
    const buffer = Buffer.isBuffer(arquivo.content)
      ? arquivo.content
      : Buffer.from(String(arquivo.content), "utf8");

    if (isZip(buffer)) {
      try {
        const extraidos = extractXml(buffer, maxBytes ? { maxBytes } : {});
        if (!extraidos.length) {
          falhas.push({ name: arquivo.name, error: "ZIP sem nenhum arquivo .xml" });
        }
        for (const item of extraidos) {
          xmls.push({ name: arquivo.name + " > " + item.name, content: item.content });
        }
      } catch (error) {
        falhas.push({ name: arquivo.name, error: error.message });
      }
      continue;
    }

    xmls.push({ name: arquivo.name, content: buffer.toString("utf8") });
  }

  return { xmls, falhas };
}

/**
 * Captura por arquivo. Recebe [{name, content}] onde content e Buffer ou string.
 * `chavesConhecidas` evita reimportar o que ja esta na base.
 *
 * Retorna { documentos, duplicados, falhas, resumo }.
 */
export function capturarDeArquivos(arquivos, { chavesConhecidas = new Set(), maxBytes } = {}) {
  const { xmls, falhas: falhasZip } = expandirArquivos(arquivos, { maxBytes });
  const { documentos, falhas: falhasParse } = lerLote(xmls);

  const vistas = new Set();
  const aceitos = [];
  const duplicados = [];
  const invalidos = [];

  for (const documento of documentos) {
    // Eventos (cancelamento, CC-e) nao sao documento de receita: passam direto.
    if (documento.kind === "Evento") {
      aceitos.push(documento);
      continue;
    }

    const chave = documento.key;
    if (!chave) {
      invalidos.push({ name: documento.source, error: "Documento sem chave ou numero identificador" });
      continue;
    }

    // Chave de 44 digitos precisa passar no DV; NFS-e usa numero/codigo proprio.
    if (/^\d{44}$/.test(chave)) {
      const validacao = validarChave(chave);
      if (!validacao.valid) {
        invalidos.push({ name: documento.source, error: validacao.reason, key: chave });
        continue;
      }
    }

    const identidade = documento.kind === "NFS-e"
      ? documento.emitter.cnpj + ":" + documento.number + ":" + documento.series
      : chave;

    if (vistas.has(identidade)) {
      duplicados.push({ name: documento.source, key: chave, motivo: "Repetido no proprio lote" });
      continue;
    }
    if (chavesConhecidas.has(identidade)) {
      duplicados.push({ name: documento.source, key: chave, motivo: "Ja existe na base" });
      continue;
    }

    vistas.add(identidade);
    aceitos.push({ ...documento, identity: identidade });
  }

  const falhas = [...falhasZip, ...falhasParse, ...invalidos];

  return {
    documentos: aceitos,
    duplicados,
    falhas,
    resumo: {
      arquivosRecebidos: arquivos.length,
      xmlsEncontrados: xmls.length,
      documentosAceitos: aceitos.length,
      duplicados: duplicados.length,
      falhas: falhas.length,
      porTipo: aceitos.reduce((contagem, documento) => {
        contagem[documento.kind] = (contagem[documento.kind] || 0) + 1;
        return contagem;
      }, {})
    }
  };
}

// ------------------------------------------------- adaptadores de portal

export class CapturaNaoConfigurada extends Error {
  constructor(adaptador, faltando, comoResolver) {
    super("Captura por " + adaptador + " nao configurada. Faltando: " + faltando.join(", "));
    this.name = "CapturaNaoConfigurada";
    this.code = "CAPTURA_NAO_CONFIGURADA";
    this.adaptador = adaptador;
    this.faltando = faltando;
    this.comoResolver = comoResolver;
  }
}

/**
 * Cada adaptador declara o que exige para funcionar. `capturar` so roda quando
 * todos os requisitos estao presentes na configuracao; caso contrario lanca
 * CapturaNaoConfigurada, que o servidor traduz em 501 com a lista do que falta.
 *
 * `implementado: false` significa exatamente isso: o conector de rede nao existe
 * neste repositorio. Preencher `capturar` e o trabalho da Fase 6 do plano.
 */
export const ADAPTADORES = {
  arquivo: {
    nome: "Arquivo (XML/ZIP)",
    implementado: true,
    requisitos: [],
    descricao: "Le XML e ZIP enviados pelo usuario. Caminho completo e testado.",
    async capturar({ arquivos, chavesConhecidas }) {
      return capturarDeArquivos(arquivos, { chavesConhecidas });
    }
  },

  pasta: {
    nome: "Pasta monitorada",
    implementado: true,
    requisitos: ["caminho"],
    descricao: "Le uma pasta deste servidor a cada minuto e importa os XML/ZIP novos. O arquivo fica onde esta: " +
      "o conteudo ja lido nao entra de novo.",
    async capturar({ config, chavesConhecidas }) {
      if (!config?.caminho) {
        throw new CapturaNaoConfigurada("pasta", ["caminho"],
          "Informe o diretorio a monitorar nas configuracoes da integracao.");
      }
      const { readdir, readFile } = await import("node:fs/promises");
      const { join, extname } = await import("node:path");
      const nomes = await readdir(config.caminho);
      const arquivos = [];
      for (const nome of nomes) {
        const ext = extname(nome).toLowerCase();
        if (ext !== ".xml" && ext !== ".zip") continue;
        arquivos.push({ name: nome, content: await readFile(join(config.caminho, nome)) });
      }
      return capturarDeArquivos(arquivos, { chavesConhecidas });
    }
  },

  adn: {
    nome: "ADN - NFS-e nacional",
    implementado: true,
    requisitos: [],
    descricao: "API oficial de distribuicao de DF-e, por NSU, com mTLS. Certificado A1 e configurado " +
      "por empresa em Captura de notas; procuracao via cnpjConsulta.",
    async capturar() {
      throw new CapturaNaoConfigurada("ADN", ["empresa"],
        "O ADN captura por empresa: use Captura de notas > Executar, ou os agendamentos.");
    }
  },

  ponte: {
    nome: "PONTE SEFAZ (carteira do escritorio)",
    implementado: true,
    requisitos: ["url", "chave"],
    descricao: "Traz NF-e, NFS-e e CT-e que a PONTE SEFAZ ja captura para a carteira do escritorio, sem guardar o A1 " +
      "de novo nem consultar a SEFAZ em paralelo com ela. Ligue em cada empresa, em Captura de notas.",
    comoResolver: "url: endereco da PONTE (https://ponte-sefaz.vercel.app). chave: a chave de API do cadastro do " +
      "escritorio na PONTE, com o modulo de contabilidade ligado.",
    async capturar() {
      throw new CapturaNaoConfigurada("PONTE", ["empresa"],
        "A PONTE captura por empresa: ligue \"PONTE SEFAZ\" em Captura de notas > Empresas > Configurar.");
    }
  },

  sieg: {
    nome: "SIEG",
    implementado: true,
    requisitos: ["clientId", "secretKey", "apiKey"],
    descricao: "Baixa do cofre do SIEG a NF-e, NFC-e, CT-e e NFS-e de cada empresa, por periodo, e envia ao SIEG o XML " +
      "capturado aqui. Por empresa, no painel dela.",
    comoResolver: "clientId e secretKey: credenciais do sistema parceiro, dadas pela SIEG no cadastro de parceiro " +
      "(integracoes.sieg.com, formulario de cadastro). apiKey: a chave do escritorio, gerada em app.sieg.com > Minha conta > " +
      "Integracoes API SIEG. O SIEG aceita 2 consultas de download por minuto: a baixa roda em segundo plano.",
    async capturar() {
      throw new CapturaNaoConfigurada("SIEG", ["empresa"],
        "O SIEG baixa por empresa: Captura de notas > Empresas > Painel > SIEG.");
    }
  },

  receita: {
    nome: "SEFAZ - distribuicao de NF-e e CT-e",
    implementado: true,
    requisitos: [],
    descricao: "NFeDistribuicaoDFe e CTeDistribuicaoDFe do Ambiente Nacional, por NSU, com mTLS e o A1 da " +
      "propria empresa; manifestacao de ciencia assinada em XMLDSig. Ligado por empresa em Captura de notas.",
    async capturar() {
      throw new CapturaNaoConfigurada("SEFAZ", ["empresa"],
        "A SEFAZ captura por empresa: ligue NF-e e CT-e em Captura de notas > Empresas > Configurar " +
        "(UF e A1 da propria empresa) e use Executar ou os agendamentos.");
    }
  },

  prefeitura: {
    nome: "Prefeitura (NFS-e de sistema proprio)",
    implementado: true,
    requisitos: [],
    descricao: "XML exportado do portal da prefeitura (padrao ABRASF), com o PDF dela: botao Importar XML no " +
      "painel da empresa, ou a pasta de entrada EMPRESAS/<CNPJ>/ENTRADA, lida sozinha.",
    async capturar() {
      throw new CapturaNaoConfigurada("Prefeitura", ["empresa"],
        "A NFS-e de prefeitura entra por empresa: Captura de notas > Empresas > Painel > Importar XML, " +
        "ou a pasta de entrada da empresa.");
    }
  },

  dominio: {
    nome: "Dominio (Thomson Reuters)",
    implementado: true,
    requisitos: ["clientId", "clientSecret"],
    descricao: "Envia o XML de NF-e, NFC-e e CT-e de cada empresa para a Escrita Fiscal do Dominio pela Onvio API, " +
      "em lotes, e confere se cada lote foi armazenado. A empresa e ativada com a chave que o contador gera no Onvio.",
    comoResolver: "clientId e clientSecret: dados pela Dominio ao sistema homologado como ERP (dominiosistemas.com.br > " +
      "Integracao com ERP > cadastro de parceiro). Depois, em cada empresa: a chave gerada em Onvio Gestao > API > Chave > " +
      "Nova habilitacao. O token e pedido uma vez por dia e fica no cofre.",
    async capturar() {
      throw new CapturaNaoConfigurada("Dominio", ["empresa"],
        "O Dominio recebe por empresa: Captura de notas > Empresas > Painel > Dominio.");
    }
  },

  acessorias: {
    nome: "Acessorias",
    implementado: true,
    requisitos: ["token"],
    descricao: "Obrigacoes atrasadas e dos proximos 30 dias de cada empresa, as entregas do mes no painel da empresa, " +
      "o cadastro das empresas que faltam aqui e o envio das guias em PDF para o robo e-Continuo dar baixa.",
    comoResolver: "token: o API Token do escritorio, gerado na Acessorias em engrenagem > API Token.",
    async capturar() {
      throw new CapturaNaoConfigurada("Acessorias", ["empresa"],
        "A Acessorias nao entrega notas: use Obrigacoes e Enviar guias em Integracoes, e as entregas no painel da empresa.");
    }
  }
};

/** Estado de cada adaptador, para a tela de integracoes mostrar a verdade. */
export function estadoAdaptadores(configuracoes = {}) {
  return Object.entries(ADAPTADORES).map(([chave, adaptador]) => {
    const config = configuracoes[chave] || {};
    const faltando = adaptador.requisitos.filter((requisito) => !config[requisito]);
    const pronto = adaptador.implementado && !faltando.length;
    return {
      id: chave,
      nome: adaptador.nome,
      descricao: adaptador.descricao,
      implementado: adaptador.implementado,
      requisitos: adaptador.requisitos,
      faltando,
      status: !adaptador.implementado
        ? "Nao implementado"
        : faltando.length ? "Falta configurar" : "Pronto",
      pronto,
      comoResolver: adaptador.comoResolver || null
    };
  });
}

/** Executa um adaptador por nome. */
export async function capturarPor(nome, contexto = {}) {
  const adaptador = ADAPTADORES[nome];
  if (!adaptador) throw new Error("Adaptador desconhecido: " + nome);
  return adaptador.capturar(contexto);
}
