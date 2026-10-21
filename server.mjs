// NUCLEO FISCAL - operacao fiscal do escritorio.
//
// API Node sem dependencias externas. Persistencia em SQLite (node:sqlite),
// com migrations versionadas. Captura, conferencia, apuracao, vigilancia e
// auditoria calculam de verdade; os conectores de portal declaram o que exigem
// e falham com 501 em vez de fingir conexao.

import { createServer } from "node:http";
import { gerarPdfTabela } from "./lib/pdf-relatorio.mjs";
import { criarXlsx } from "./lib/planilha.mjs";
import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { abrir, versaoEsquema, fechar, bd } from "./lib/banco.mjs";
import {
  usuarios, sessoes, clientes, certificados, documentos, conferencias, alertas,
  ocorrencias, apuracoes, rotinas, importacoes, uploads, relatorios, regras,
  integracoes, configuracoes, auditoria
} from "./lib/repositorio.mjs";
import { semear, avisoDeSemeadura, MODO_DEMO } from "./lib/semente.mjs";
import { montarDashboard, configuracao } from "./lib/painel.mjs";

import { validarChave } from "./lib/documentos.mjs";
import { conferir } from "./lib/conferencia.mjs";
import { apurar, apurarDeDocumentos, dentroDaVigencia, ANEXOS, VIGENCIA } from "./lib/simples.mjs";
import { vigiar, LIMITES_PADRAO, lerValidadeCertificado } from "./lib/monitores.mjs";
import { assinaturaConfigurada, gerarChave as gerarChaveAuditoria } from "./lib/auditoria.mjs";
import { capturarDeArquivos, estadoAdaptadores, capturarPor, CapturaNaoConfigurada } from "./lib/captura.mjs";
import { estadoCofre, chaveConfigurada, mascarar, gerarChave as gerarChaveCofre } from "./lib/segredos.mjs";
import { PERMISSOES, PERFIS, validarCnpj, somenteDigitos, conferirForcaSenha } from "./lib/estado.mjs";
import { criarLimitador, origemDoPedido } from "./lib/limite-tentativas.mjs";
import { configurarAcervo } from "./lib/acervo.mjs";
import { armazemDoAmbiente, restaurarBanco, iniciarGuarda, espelho, enviarArquivosLocais } from "./lib/nuvem.mjs";
import { criarRotasCaptura } from "./lib/rotas-captura.mjs";
import { criarRotasIntegracoes, testarExterno } from "./lib/rotas-integracoes.mjs";
import { lerMarca } from "./lib/marca.mjs";
import { iniciarFila } from "./lib/fila.mjs";
import { tarefasDevidas, PRIORIDADE } from "./lib/agendador.mjs";
import {
  sincronizarEmpresa, importarArquivos, baixarPorChaves, LIMITE_CHAVES_POR_VEZ, trazerCarteiraDaPonte,
  revisarCancelamentosNfse, carteiraDaPonte, limiteDoPlano, limiteDoPlanoConferido, mensagemDoPlanoCheio, corrigirLeiturasAntigas,
  fecharPendenciasDePdfFeito
} from "./lib/motor-captura.mjs";
import { ClientePonte, PONTE_PRODUCAO } from "./lib/ponte.mjs";
import { caminhoEntrada, lerEntrada, arquivarEntrada } from "./lib/entrada.mjs";
import { pastaAcessivel } from "./lib/pastas.mjs";
import {
  empresasCaptura, certificadosDigitais, pendencias as pendenciasCaptura, tarefas as tarefasCaptura,
  agendamentos as agendamentosCaptura, cursores as cursoresCaptura, pastaMonitorada, acervoDocs, ponteEstado
} from "./lib/repo-captura.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(join(root, "public"));
const dataDir = process.env.NUCLEO_DATA_DIR || join(root, "data");
const bancoArquivo = process.env.NUCLEO_BANCO || join(dataDir, "nucleo.db");
const uploadDir = join(dataDir, "uploads");
const port = Number(process.env.PORT || 4175);
const LIMITE_UPLOAD = 100 * 1024 * 1024;
const LIMITE_CORPO = 140 * 1024 * 1024;

// Captura automatica. Producao fala com o ADN real; testes e homologacao
// apontam NUCLEO_ADN_BASE para o simulador ou para a producao restrita.
function configuracaoCaptura() {
  return {
    adnBase: process.env.NUCLEO_ADN_BASE || undefined,
    adnCa: process.env.NUCLEO_ADN_CA ? readFileSyncSeguro(process.env.NUCLEO_ADN_CA) : undefined,
    // Sefin Nacional (eventos da NFS-e pela chave): o padrao segue o ambiente do ADN.
    sefinBase: process.env.NUCLEO_SEFIN_BASE || undefined,
    // Revisao de cancelamentos da NFS-e depois de cada captura pelo ADN
    // (NUCLEO_REVISAR_EVENTOS=1; ligada no render.yaml). O botao funciona sempre.
    revisarEventos: process.env.NUCLEO_REVISAR_EVENTOS === "1",
    espacamentoMs: Number(process.env.NUCLEO_ADN_ESPACAMENTO_MS || 700),
    tentativas: Number(process.env.NUCLEO_ADN_TENTATIVAS || 5),
    esperaMaximaMs: Number(process.env.NUCLEO_ADN_ESPERA_MAX_MS || 8000),
    modoPasta: process.env.NUCLEO_MODO_PASTA || "auto",
    fuso: process.env.NUCLEO_FUSO || "America/Sao_Paulo",
    // SEFAZ (NF-e e CT-e). Endpoints so se trocam para homologacao propria ou
    // para o simulador dos testes; o padrao e o Ambiente Nacional de producao.
    sefazAmbiente: process.env.NUCLEO_SEFAZ_AMBIENTE === "homologacao" ? "homologacao" : "producao",
    sefazEndpoints: Object.fromEntries(Object.entries({
      nfeDistribuicao: process.env.NUCLEO_SEFAZ_NFE_DIST,
      cteDistribuicao: process.env.NUCLEO_SEFAZ_CTE_DIST,
      nfeEvento: process.env.NUCLEO_SEFAZ_NFE_EVENTO
    }).filter(([, valor]) => valor)),
    sefazCa: process.env.NUCLEO_SEFAZ_CA ? readFileSyncSeguro(process.env.NUCLEO_SEFAZ_CA) : undefined,
    // Espera depois de chegar ao fim. A SEFAZ exige uma hora; menos que isso
    // so faz sentido contra o simulador.
    sefazEsperaMs: process.env.NUCLEO_SEFAZ_ESPERA_MIN !== undefined
      ? Number(process.env.NUCLEO_SEFAZ_ESPERA_MIN) * 60_000 : undefined,
    // PONTE SEFAZ: endereco e chave do escritorio, cifrados no cofre (Integracoes).
    ponte: lerConfigPonte(),
    ponteEsperaMs: process.env.NUCLEO_PONTE_ESPERA_MS !== undefined ? Number(process.env.NUCLEO_PONTE_ESPERA_MS) : undefined
  };
}

function lerConfigPonte() {
  try {
    return integracoes.config("ponte") || null;
  } catch {
    // Cofre sem chave: a captura pela PONTE diz o que falta quando for usada.
    return null;
  }
}

function readFileSyncSeguro(caminho) {
  try {
    return readFileSync(caminho);
  } catch (erro) {
    console.error("Nao foi possivel ler o arquivo de CA (" + caminho + "): " + erro.message);
    return undefined;
  }
}

// ------------------------------------------------------------------- helpers

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

// Tentativas de senha (ver lib/limite-tentativas.mjs). Os limites podem ser
// apertados por variavel; os testes usam o padrao.
const tentativasPorConta = criarLimitador({ maximo: Number(process.env.NUCLEO_LOGIN_MAX_CONTA || 5) });
const tentativasPorOrigem = criarLimitador({ maximo: Number(process.env.NUCLEO_LOGIN_MAX_ORIGEM || 20) });

function recusarPorTentativas(res, ate) {
  const segundos = Math.max(1, Math.ceil((ate - Date.now()) / 1000));
  res.setHeader("retry-after", String(segundos));
  return json(res, 429, {
    error: "Muitas tentativas de senha. Tente de novo em " + Math.ceil(segundos / 60) + " minuto(s).",
    tenteDeNovoEmSegundos: segundos
  });
}

// Cabecalhos de seguranca em toda resposta. O sistema fica num endereco
// publico: sem frame-ancestors, outra pagina poderia embuti-lo e enganar o
// clique; sem a CSP, um XML malicioso que escapasse do esc() rodaria script.
// A tela nao usa script embutido nem recurso de fora, entao a politica e a
// mais fechada possivel; style-src aceita inline pelos atributos style das telas.
// Imagem por https: o logo e o favicon da marca do escritorio podem estar fora daqui.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; " +
  "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function cabecalhosDeSeguranca(req, res) {
  res.setHeader("content-security-policy", CSP);
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  // HSTS so quando o pedido chegou por HTTPS (o Render termina o TLS e avisa
  // em x-forwarded-proto). Em http://localhost ele travaria o navegador.
  if (String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https") {
    res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
}

// Telas de fora (o app Lovable de cada contabilidade) chamando a API deste
// NUCLEO: so os enderecos de NUCLEO_ORIGENS (separados por virgula, com
// https://). A sessao vai no Bearer, nunca em cookie: sem credenciais no CORS.
const ORIGENS_PERMITIDAS = new Set(String(process.env.NUCLEO_ORIGENS || "").split(",")
  .map((item) => item.trim().replace(/\/+$/, "")).filter((item) => /^https?:\/\/[^\s/]+$/i.test(item)));

/** Cabecalhos de CORS para origem permitida. Devolve true se o pedido era so a pergunta (OPTIONS). */
function cors(req, res) {
  const origem = String(req.headers.origin || "").replace(/\/+$/, "");
  if (!origem || !ORIGENS_PERMITIDAS.has(origem)) return false;
  res.setHeader("access-control-allow-origin", origem);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-expose-headers", "content-disposition, x-sha256, x-nfe-emitidas");
  if (req.method !== "OPTIONS") return false;
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-max-age", "600");
  res.writeHead(204);
  res.end();
  return true;
}

async function body(req) {
  const chunks = [];
  let tamanho = 0;
  for await (const chunk of req) {
    tamanho += chunk.length;
    if (tamanho > LIMITE_CORPO) {
      throw Object.assign(new Error("Corpo da requisicao acima do limite"), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON invalido no corpo da requisicao"), { status: 400 });
  }
}

function tokenDe(req) {
  return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
}

function auth(req, res) {
  const atual = sessoes.usuarioDe(tokenDe(req));
  if (!atual) { json(res, 401, { error: "Nao autenticado" }); return null; }
  // Senha a trocar bloqueia o resto do sistema, nao apenas avisa.
  if (atual.mustChangePassword) {
    json(res, 403, {
      error: "Troca de senha obrigatoria antes de usar o sistema",
      code: "TROCAR_SENHA",
      comoResolver: "Envie a senha nova em POST /api/auth/trocar-senha"
    });
    return null;
  }
  return atual;
}

function exigir(req, res, permissao) {
  const atual = auth(req, res);
  if (!atual) return null;
  if (!PERMISSOES[atual.role]?.includes(permissao)) {
    json(res, 403, { error: "Sem permissao: " + permissao });
    return null;
  }
  return atual;
}

function auditar(atual, action, target, data = null) {
  return auditoria.anexar({ user: atual?.email || "sistema", action, target, data });
}

function safeName(valor) {
  return String(valor || "arquivo").split(/[\\/]/).pop()
    .replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "arquivo";
}

function limites() {
  return { ...LIMITES_PADRAO, ...(configuracao().limites || {}) };
}

// ------------------------------------------------- captura, conferencia, vigilancia

function conferirEGravar(documento, registro) {
  const resultado = conferir(documento, regras.ativas());
  conferencias.salvar(resultado, { clienteId: registro.clientId, documentoId: registro.id });
  return resultado;
}

async function processarLote({ atual, arquivos, modulo, metodo, uploadId = null }) {
  const inicio = Date.now();
  const captura = capturarDeArquivos(arquivos, { chavesConhecidas: documentos.identidadesConhecidas() });

  const gravados = [];
  const semCliente = [];
  let irregulares = 0;

  for (const documento of captura.documentos) {
    if (documento.kind === "Evento") {
      if (documento.event === "110111") documentos.marcarCancelado(documento.key, documento.reason);
      continue;
    }

    const cliente = clientes.porCnpj(documento.emitter.cnpj);
    if (!cliente) {
      semCliente.push({ key: documento.key, cnpj: documento.emitter.cnpj, name: documento.emitter.name });
    }

    const registro = documentos.inserir(documento, {
      clienteId: cliente?.id || null,
      capturadoPor: atual.email,
      uploadId
    });
    gravados.push(registro);

    const resultado = conferirEGravar(documento, registro);
    if (resultado.summary.status === "Irregular") irregulares += 1;
  }

  const importacao = importacoes.inserir({
    module: modulo,
    method: metodo,
    status: gravados.length ? "Finalizado" : "Erro",
    clients: new Set(gravados.map((item) => item.clientId).filter(Boolean)).size,
    documents: gravados.length,
    duplicates: captura.duplicados.length,
    errors: captura.falhas.map((item) => item.name + ": " + item.error),
    unlinked: semCliente,
    uploadId,
    durationMs: Date.now() - inicio,
    details: gravados.length
      ? gravados.length + " documento(s) capturado(s), " + captura.duplicados.length +
        " duplicado(s), " + captura.falhas.length + " falha(s)"
      : "Nenhum documento valido no lote"
  });

  ocorrencias.inserir({
    titulo: "Importacao " + modulo + ": " + gravados.length + " documento(s), " + irregulares + " irregular(es)",
    fonte: modulo.toUpperCase(),
    severidade: irregulares ? "atencao" : "informativo"
  });
  auditar(atual, "Importacao de documentos", importacao.id, {
    modulo, metodo, documentos: gravados.length, duplicados: captura.duplicados.length,
    falhas: captura.falhas.length, irregulares
  });

  executarVigilancia();
  return { importacao, captura: captura.resumo, irregulares };
}

// Pasta monitorada: le a pasta configurada e importa so o conteudo que ainda
// nao foi lido (sha256). O arquivo fica onde esta: a pasta pode ser de outro
// sistema. Arquivo modificado ha menos de 5 s ainda pode estar sendo copiado.
async function lerPastaMonitorada() {
  const caminho = integracoes.config("pasta")?.caminho;
  if (!caminho) return { configurada: false, caminho: null, total: 0, novos: [] };
  let itens;
  try {
    itens = await readdir(caminho, { withFileTypes: true });
  } catch (erro) {
    throw Object.assign(new Error("O servidor nao consegue abrir a pasta " + caminho + ": " + erro.code), { status: 422 });
  }
  const novos = [];
  let total = 0;
  for (const item of itens) {
    if (!item.isFile() || ![".xml", ".zip"].includes(extname(item.name).toLowerCase())) continue;
    total += 1;
    const completo = join(caminho, item.name);
    const info = await stat(completo);
    if (Date.now() - info.mtimeMs < 5000) continue;
    const bytes = await readFile(completo);
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    if (pastaMonitorada.jaLido(sha)) continue;
    novos.push({ name: item.name, content: bytes, sha, tamanho: bytes.length });
  }
  return { configurada: true, caminho, total, novos };
}

async function importarPastaMonitorada(atual) {
  const lida = await lerPastaMonitorada();
  if (!lida.configurada || !lida.novos.length) {
    return { configurada: lida.configurada, caminho: lida.caminho, arquivos: lida.total, novos: 0 };
  }
  const resultado = await processarLote({
    atual, arquivos: lida.novos.map(({ name, content }) => ({ name, content })), modulo: "Pasta monitorada", metodo: "Pasta"
  });
  for (const item of lida.novos) pastaMonitorada.marcarLido(item.sha, item.name, item.tamanho);
  return {
    configurada: true, caminho: lida.caminho, arquivos: lida.total, novos: lida.novos.length,
    documentos: resultado.importacao.documents, duplicados: resultado.importacao.duplicates,
    irregulares: resultado.irregulares, importacao: resultado.importacao
  };
}

// Teste de conector que trabalha por empresa: diz, empresa por empresa, se
// esta pronta, sem consultar o portal (na SEFAZ, consulta a toa conta na
// regra de uma hora).
function testarPorEmpresa(nome) {
  const fontes = nome === "adn" ? ["ADN"] : ["NFE", "CTE"];
  const rotulo = { ADN: "NFS-e", NFE: "NF-e", CTE: "CT-e" };
  const empresas = empresasCaptura.listar().filter((item) =>
    item.configurada && item.ativa && fontes.some((fonte) => (item.fontes || ["ADN"]).includes(fonte)));
  if (!empresas.length) {
    return {
      http: 422, ok: false, status: "Sem empresa",
      mensagem: "Nenhuma empresa com " + fontes.map((fonte) => rotulo[fonte]).join(" ou ") + " ligada.",
      comoResolver: "Em Captura de notas > Empresas > Configurar, escolha o certificado A1 e marque os documentos" +
        (nome === "receita" ? " (NF-e e CT-e exigem o A1 da propria empresa e a UF)." : ".")
    };
  }
  const linhas = [];
  let problemas = 0;
  for (const empresa of empresas) {
    const partes = [];
    const cert = empresa.certificado;
    if (!cert || !cert.ativo) { partes.push("sem certificado ativo"); problemas += 1; }
    else if (cert.diasParaVencer < 0) { partes.push("certificado vencido em " + cert.validoAte); problemas += 1; }
    else partes.push("certificado valido ate " + cert.validoAte);
    const cursores = cursoresCaptura.daEmpresa(empresa.clientId);
    const tarefas = tarefasCaptura.listar({ clienteId: empresa.clientId, limite: 30 });
    for (const fonte of fontes.filter((item) => (empresa.fontes || ["ADN"]).includes(item))) {
      const ultima = tarefas.find((item) => item.fonte === fonte && ["concluida", "erro"].includes(item.situacao));
      const cursor = cursores.find((item) => item.fonte === fonte);
      if (ultima?.situacao === "erro") { partes.push(rotulo[fonte] + ": ultima captura com erro (" + ultima.erro + ")"); problemas += 1; }
      else if (cursor?.ultimoSucesso) partes.push(rotulo[fonte] + ": ultima captura certa em " + cursor.ultimoSucesso.slice(0, 16).replace("T", " "));
      else partes.push(rotulo[fonte] + ": ainda nao capturou");
    }
    linhas.push(empresa.name + ": " + partes.join("; "));
  }
  return {
    http: 200, ok: problemas === 0, status: problemas ? "Com pendencias" : "Pronto",
    mensagem: linhas.join("\n"), resumo: { empresas: empresas.length, problemas }
  };
}

function executarVigilancia(atual = null) {
  const resultado = vigiar({
    clients: clientes.listar(),
    certificates: certificados.paraVigilancia(),
    documents: documentos.paraVigilancia(),
    imports: importacoes.paraVigilancia(),
    processes: rotinas.paraVigilancia(),
    assessments: apuracoes.paraVigilancia(),
    conferences: conferencias.paraVigilancia(),
    empresasCaptura: empresasCaptura.listar(),
    certificadosDigitais: certificadosDigitais.listar(),
    pendenciasAbertas: pendenciasCaptura.listar({ situacao: "aberta", limite: 100000 }),
    ponteEstados: ponteEstado.listar()
  }, { limites: limites(), anteriores: alertas.listar() });

  alertas.substituir(resultado.alertas);
  if (atual) auditar(atual, "Vigilancia executada", "alertas", resultado.resumo);
  for (const novo of resultado.novos) {
    ocorrencias.inserir({
      titulo: "Alerta aberto: " + novo.title,
      fonte: novo.source,
      severidade: novo.severity,
      clienteId: novo.clientId
    });
  }
  return resultado;
}

// Marca do escritorio (NUCLEO_MARCA_JSON, no formato do manifesto do kit da PONTE).
const MARCA = lerMarca(process.env.NUCLEO_MARCA_JSON);
for (const item of MARCA.avisos) console.error("[marca] " + item);

// -------------------------------------------------------------------- rotas

const routes = [
  // Publica: a tela de login ja mostra o nome, o logo e as cores do escritorio.
  ["GET", /^\/api\/marca$/, (req, res) => json(res, 200, MARCA.marca)],

  ["GET", /^\/api\/health$/, (req, res) => json(res, 200, {
    ok: true,
    version: "3.1.0",
    esquema: versaoEsquema(),
    documentos: documentos.contar(),
    conferencias: conferencias.contar(),
    alertas: alertas.contarPendentes(),
    auditoria: auditoria.verificar().valid ? "integra" : "ADULTERADA",
    auditoriaAssinada: assinaturaConfigurada(),
    nuvem: guarda ? (({ ultimoEnvio, pendente, envios }) => ({ ativa: true, ultimaCopia: ultimoEnvio, pendente, copias: envios }))(guarda.estado()) : { ativa: false },
    cofreSegredos: chaveConfigurada(),
    modoDemo: MODO_DEMO
  })],

  // ---------------------------------------------------------------- sessao

  ["POST", /^\/api\/auth\/login$/, async (req, res) => {
    const input = await body(req);
    const email = String(input.email || "").toLowerCase().trim();
    const origem = origemDoPedido(req);
    // A trava vem ANTES de conferir a senha: travado, nem a senha certa entra,
    // senao o contador so atrasaria quem ja chutou certo.
    const travado = Math.max(tentativasPorConta.bloqueadoAte(email), tentativasPorOrigem.bloqueadoAte(origem));
    if (travado) return recusarPorTentativas(res, travado);
    const encontrado = usuarios.porEmail(email);
    if (!encontrado || !usuarios.conferirSenha(encontrado, input.password)) {
      const travouConta = tentativasPorConta.falhou(email);
      const travouOrigem = tentativasPorOrigem.falhou(origem);
      if (travouConta || travouOrigem) {
        auditar({ email: "seguranca" }, "Login travado por tentativas", email || "sem-email", {
          email, origem, motivo: travouConta ? "conta" : "origem"
        });
        return recusarPorTentativas(res, Math.max(travouConta, travouOrigem));
      }
      return json(res, 401, { error: "Credenciais invalidas" });
    }
    tentativasPorConta.acertou(email);
    const token = sessoes.criar(encontrado.id);
    auditar(encontrado, "Login", encontrado.id);
    json(res, 200, {
      token,
      mustChangePassword: encontrado.mustChangePassword,
      user: {
        id: encontrado.id, name: encontrado.name, email: encontrado.email,
        role: encontrado.role, permissions: PERMISSOES[encontrado.role],
        mustChangePassword: encontrado.mustChangePassword
      }
    });
  }],

  ["POST", /^\/api\/auth\/logout$/, async (req, res) => {
    const token = tokenDe(req);
    const atual = sessoes.usuarioDe(token);
    sessoes.remover(token);
    if (atual) auditar(atual, "Logout", atual.id);
    json(res, 200, { ok: true });
  }],

  // Nao passa por auth(): e justamente a rota que desbloqueia quem precisa trocar.
  ["POST", /^\/api\/auth\/trocar-senha$/, async (req, res) => {
    const atual = sessoes.usuarioDe(tokenDe(req));
    if (!atual) return json(res, 401, { error: "Nao autenticado" });
    const input = await body(req);
    const chaveTroca = "troca:" + atual.id;
    const travadoTroca = tentativasPorConta.bloqueadoAte(chaveTroca);
    if (travadoTroca) return recusarPorTentativas(res, travadoTroca);
    if (!usuarios.conferirSenha(atual, input.senhaAtual)) {
      const travou = tentativasPorConta.falhou(chaveTroca);
      if (travou) {
        auditar(atual, "Troca de senha travada por tentativas", atual.id, { origem: origemDoPedido(req) });
        return recusarPorTentativas(res, travou);
      }
      return json(res, 403, { error: "Senha atual incorreta" });
    }
    tentativasPorConta.acertou(chaveTroca);
    const forca = conferirForcaSenha(input.senhaNova);
    if (!forca.ok) return json(res, 422, { error: forca.motivo });
    if (input.senhaNova === input.senhaAtual) {
      return json(res, 422, { error: "A senha nova precisa ser diferente da atual" });
    }
    usuarios.trocarSenha(atual.id, input.senhaNova);
    auditar(atual, "Senha alterada", atual.id);
    json(res, 200, { ok: true });
  }],

  ["GET", /^\/api\/me$/, (req, res) => {
    const atual = sessoes.usuarioDe(tokenDe(req));
    if (!atual) return json(res, 401, { error: "Nao autenticado" });
    json(res, 200, {
      id: atual.id, name: atual.name, email: atual.email, role: atual.role,
      permissions: PERMISSOES[atual.role], mustChangePassword: atual.mustChangePassword
    });
  }],

  // ------------------------------------------------------------- dashboard

  ["GET", /^\/api\/dashboard$/, (req, res) => {
    if (!auth(req, res)) return;
    json(res, 200, montarDashboard());
  }],

  // ---------------------------------------------------------------- alertas

  ["GET", /^\/api\/alerts$/, (req, res) => {
    if (!auth(req, res)) return;
    json(res, 200, alertas.listar());
  }],

  ["POST", /^\/api\/alerts\/executar$/, async (req, res) => {
    const atual = exigir(req, res, "import");
    if (!atual) return;
    json(res, 200, executarVigilancia(atual).resumo);
  }],

  ["PATCH", /^\/api\/alerts\/([^/]+)\/(resolve|ignore)$/, async (req, res, match) => {
    const atual = exigir(req, res, "write");
    if (!atual) return;
    const item = alertas.porId(match[1]);
    if (!item) return json(res, 404, { error: "Alerta nao encontrado" });
    const input = await body(req).catch(() => ({}));
    if (match[2] === "ignore" && !String(input.reason || "").trim()) {
      return json(res, 422, { error: "Ignorar um alerta exige justificativa" });
    }
    const situacao = match[2] === "resolve" ? "Resolvido" : "Ignorado";
    const atualizado = alertas.tratar(item.id, {
      situacao, usuario: atual.email, motivo: input.reason || null
    });
    const acao = match[2] === "resolve" ? "Alerta resolvido" : "Alerta ignorado";
    auditar(atual, acao, item.id, { code: item.code, clientId: item.clientId, reason: input.reason || null });
    ocorrencias.inserir({
      titulo: acao + ": " + item.title,
      fonte: item.source, severidade: item.severity, clienteId: item.clientId
    });
    json(res, 200, atualizado);
  }],

  // ------------------------------------------------------------ ocorrencias

  ["GET", /^\/api\/occurrences$/, (req, res) => {
    if (!auth(req, res)) return;
    json(res, 200, ocorrencias.listar());
  }],

  // ----------------------------------------------------------- certificados

  ["GET", /^\/api\/certificates$/, (req, res) => {
    if (!auth(req, res)) return;
    json(res, 200, certificados.listar());
  }],

  ["POST", /^\/api\/certificates$/, async (req, res) => {
    const atual = exigir(req, res, "write");
    if (!atual) return;
    const input = await body(req);
    if (!input.clientId || !clientes.porId(input.clientId)) {
      return json(res, 422, { error: "clientId obrigatorio e precisa existir" });
    }
    let validade = input.expiresAt;
    let lido = null;

    // .cer/.pem: a validade vem do proprio certificado, nao da digitacao.
    if (input.contentBase64) {
      lido = lerValidadeCertificado(Buffer.from(input.contentBase64, "base64"));
      if (lido.ok) validade = lido.validTo;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(validade || ""))) {
      return json(res, 422, {
        error: "Validade obrigatoria no formato AAAA-MM-DD",
        hint: lido && !lido.ok
          ? "O arquivo enviado nao e PEM/DER legivel (" + lido.reason + "). " +
            "PFX/P12 exige a senha do cliente e nao e lido aqui: informe a data manualmente."
          : undefined
      });
    }
    const item = certificados.criar({
      clientId: input.clientId,
      type: input.type || "A1",
      expiresAt: validade,
      usage: input.usage || "",
      subject: lido?.ok ? lido.subject : null,
      issuer: lido?.ok ? lido.issuer : null,
      serial: lido?.ok ? lido.serial : null,
      readFromFile: Boolean(lido?.ok)
    });
    auditar(atual, "Certificado cadastrado", item.id, { clientId: item.clientId, expiresAt: item.expiresAt });
    executarVigilancia();
    json(res, 201, item);
  }],

  // --------------------------------------------------------------- clientes

  ["GET", /^\/api\/clients$/, (req, res) => {
    if (!auth(req, res)) return;
    json(res, 200, clientes.listar());
  }],

  ["POST", /^\/api\/clients$/, async (req, res) => {
    const atual = exigir(req, res, "write");
    if (!atual) return;
    const input = await body(req);
    if (!input.cnpj || !input.name) return json(res, 422, { error: "CNPJ e razao social sao obrigatorios" });
    const validacao = validarCnpj(input.cnpj);
    if (!validacao.valid) return json(res, 422, { error: "CNPJ invalido: " + validacao.reason });
    if (clientes.existeCnpj(input.cnpj)) return json(res, 409, { error: "CNPJ ja cadastrado" });
    // Plano do escritorio (informado pela PONTE): o limite e a quantidade de empresas.
    let plano;
    try {
      plano = await limiteDoPlanoConferido(configuracaoCaptura());
    } catch (erro) {
      return json(res, 502, { error: erro.message });
    }
    if (plano.cheio) return json(res, 422, { error: mensagemDoPlanoCheio(plano), plano: plano.plano });

    const item = clientes.criar(input);
    auditar(atual, "Cliente criado", item.id, { cnpj: item.cnpj, name: item.name });

    const vinculados = clientes.vincularOrfaos(item.id, item.cnpjDigits);
    if (vinculados) {
      auditar(atual, "Documentos vinculados ao novo cliente", item.id, { vinculados });
      ocorrencias.inserir({
        titulo: vinculados + " documento(s) orfao(s) vinculado(s) a " + item.name,
        fonte: "CAD", clienteId: item.id
      });
    }

    executarVigilancia();
    json(res, 201, { ...clientes.porId(item.id), linkedDocuments: vinculados });
  }],

  ["PATCH", /^\/api\/clients\/([^/]+)$/, async (req, res, match) => {
    const atual = exigir(req, res, "write");
    if (!atual) return;
    const antes = clientes.porId(match[1]);
    if (!antes) return json(res, 404, { error: "Cliente nao encontrado" });
    const input = await body(req);
    if (input.cnpj !== undefined) {
      const validacao = validarCnpj(input.cnpj);
      if (!validacao.valid) return json(res, 422, { error: "CNPJ invalido: " + validacao.reason });
      if (clientes.existeCnpj(input.cnpj, antes.id)) {
        return json(res, 409, { error: "CNPJ ja cadastrado em outro cliente" });
      }
    }
    const depois = clientes.atualizar(antes.id, input);
    auditar(atual, "Cliente atualizado", antes.id, {
      antes: { name: antes.name, taxRegime: antes.taxRegime, anexo: antes.anexo, rbt12: antes.rbt12 },
      depois: { name: depois.name, taxRegime: depois.taxRegime, anexo: depois.anexo, rbt12: depois.rbt12 }
    });
    executarVigilancia();
    json(res, 200, depois);
  }],

  ["GET", /^\/api\/modules\/([^/]+)\/companies$/, (req, res, match) => {
    if (!auth(req, res)) return;
    json(res, 200, clientes.porModulo(decodeURIComponent(match[1])));
  }],

  // ------------------------------------------------- visoes dos documentos

  ["GET", /^\/api\/services\/nfse$/, (req, res) => {
    if (!auth(req, res)) return;
    json(res, 200, documentos.visaoNfse());
  }],

  ["GET", /^\/api\/federal\/docs$/, (req, res) => {
    if (!auth(req, res)) return;
    json(res, 200, documentos.visaoFederal());
  }],

  ["GET", /^\/api\/documents\/([^/]+)$/, (req, res, match) => {
    if (!auth(req, res)) return;
    const documento = documentos.porChaveOuId(match[1]);
    if (!documento) return json(res, 404, { error: "Documento nao encontrado" });
    json(res, 200, {
      documento,
      conferencia: conferencias.porChave(documento.key),
      clientName: clientes.nome(documento.clientId)
    });
  }],

  // ----------------------------------------------------------- conferencia

  ["GET", /^\/api\/conferencias$/, (req, res) => {
    if (!auth(req, res)) return;
    json(res, 200, { documentos: conferencias.listar(), consolidado: conferencias.consolidado() });
  }],

  ["GET", /^\/api\/conferencias\/([^/]+)$/, (req, res, match) => {
    if (!auth(req, res)) return;
    const item = conferencias.porChave(match[1]);
    if (!item) return json(res, 404, { error: "Conferencia nao encontrada" });
    json(res, 200, item);
  }],

  ["POST", /^\/api\/conferencias\/([^/]+)\/reconferir$/, async (req, res, match) => {
    const atual = exigir(req, res, "import");
    if (!atual) return;
    const documento = documentos.porChaveOuId(match[1]);
    if (!documento) return json(res, 404, { error: "Documento nao encontrado" });
    const resultado = conferirEGravar(documento, documento);
    auditar(atual, "Reconferencia", documento.key, {
      status: resultado.summary.status, achados: resultado.summary.total
    });
    executarVigilancia();
    json(res, 200, conferencias.porChave(documento.key));
  }],

  ["POST", /^\/api\/conferencias\/([^/]+)\/justificar$/, async (req, res, match) => {
    const atual = exigir(req, res, "write");
    if (!atual) return;
    const input = await body(req);
    const texto = String(input.justification || "").trim();
    if (texto.length < 10) {
      return json(res, 422, { error: "Justificativa precisa ter ao menos 10 caracteres" });
    }
    const alvo = conferencias.porChave(match[1]);
    if (!alvo) return json(res, 404, { error: "Conferencia nao encontrada" });

    const resultado = conferencias.justificar(match[1], {
      codigo: input.code || null,
      item: input.item === undefined ? null : input.item,
      texto,
      usuario: atual.email
    });
    if (!resultado.justificados) {
      return json(res, 404, { error: "Nenhum achado corresponde ao filtro informado" });
    }
    auditar(atual, "Divergencia justificada", alvo.documentKey, {
      code: input.code ?? null, item: input.item ?? null,
      justificados: resultado.justificados, justification: texto
    });
    executarVigilancia();
    json(res, 200, resultado);
  }],

  // ------------------------------------------------------- simples nacional

  ["GET", /^\/api\/simples\/assessments$/, (req, res) => {
    if (!auth(req, res)) return;
    json(res, 200, apuracoes.listar());
  }],

  ["GET", /^\/api\/simples\/tabelas$/, (req, res) => {
    if (!auth(req, res)) return;
    json(res, 200, { vigencia: VIGENCIA, anexos: ANEXOS });
  }],

  ["POST", /^\/api\/simples\/simular$/, async (req, res) => {
    if (!auth(req, res)) return;
    const input = await body(req);
    if (input.receitaMes === undefined) return json(res, 422, { error: "receitaMes obrigatorio" });
    if (input.rbt12 === undefined) return json(res, 422, { error: "rbt12 obrigatorio" });
    try {
      json(res, 200, apurar(input));
    } catch (erro) {
      json(res, 422, { error: erro.message });
    }
  }],

  ["POST", /^\/api\/simples\/apurar$/, async (req, res) => {
    const atual = exigir(req, res, "import");
    if (!atual) return;
    const input = await body(req);
    const cliente = clientes.porId(input.clientId);
    if (!cliente) return json(res, 404, { error: "Cliente nao encontrado" });
    if (!/^\d{2}\/\d{4}$/.test(String(input.period || ""))) {
      return json(res, 422, { error: "Competencia obrigatoria no formato MM/AAAA" });
    }
    if (cliente.taxRegime !== "Simples Nacional") {
      return json(res, 422, { error: "Cliente nao e optante do Simples Nacional" });
    }
    const rbt12 = input.rbt12 ?? cliente.rbt12;
    if (!rbt12) {
      return json(res, 422, {
        error: "RBT12 nao informado",
        hint: "Informe rbt12 na requisicao ou no cadastro do cliente. Sem a receita dos 12 meses " +
          "anteriores nao existe aliquota efetiva."
      });
    }

    // Competencia fora da vigencia das tabelas conferidas produz DAS errado.
    const vigencia = dentroDaVigencia(input.period);
    if (vigencia.aplicavel === false && !input.confirmarForaDeVigencia) {
      return json(res, 422, {
        error: "Competencia fora da vigencia das tabelas",
        motivo: vigencia.motivo,
        vigencia: VIGENCIA,
        comoResolver: "Transcreva e confira os anexos da vigencia correta em lib/simples.mjs. " +
          "Para gravar mesmo assim, assumindo o risco, reenvie com confirmarForaDeVigencia: true."
      });
    }

    const resultado = apurarDeDocumentos({
      documentos: documentos.doCliente(cliente.id),
      competencia: input.period,
      rbt12: Number(rbt12),
      anexo: input.anexo ?? cliente.anexo,
      folha12: input.folha12 ?? cliente.folha12 ?? undefined,
      cnpj: cliente.cnpjDigits
    });

    const registro = apuracoes.salvar(resultado, {
      clienteId: cliente.id, competencia: input.period, usuario: atual.email
    });

    auditar(atual, "Apuracao do Simples Nacional", registro.id, {
      clientId: cliente.id, competencia: input.period, anexo: resultado.anexo,
      faixa: resultado.faixa, rbt12: resultado.rbt12, receita: resultado.receitaMes,
      aliquotaEfetiva: resultado.aliquotaEfetiva, das: resultado.das,
      // Cada parcela no seu anexo: o numero de cada uma fica na trilha.
      segmentos: (resultado.segmentos || []).map((item) => ({
        segmento: item.segmento, anexo: item.anexo, receita: item.receita,
        aliquotaEfetiva: item.aliquotaEfetiva, das: item.das
      })),
      vigenciaAplicavel: resultado.vigenciaAplicavel,
      confirmadoForaDeVigencia: Boolean(input.confirmarForaDeVigencia)
    });
    ocorrencias.inserir({
      titulo: "Apuracao " + input.period + ": DAS " + Number(resultado.das).toFixed(2) +
        " (" + resultado.origem.documentos + " documento(s))",
      fonte: "SIMPLES", clienteId: cliente.id
    });

    executarVigilancia();
    json(res, 201, registro);
  }],

  // ------------------------------------------------------------ importacao

  ["GET", /^\/api\/imports$/, (req, res) => {
    if (!auth(req, res)) return;
    json(res, 200, importacoes.listar());
  }],

  ["POST", /^\/api\/federal\/imports$/, async (req, res) => {
    const atual = exigir(req, res, "import");
    if (!atual) return;
    const input = await body(req);
    const modulo = input.module || "Federal";

    if (input.uploadId) {
      const upload = uploads.porId(input.uploadId);
      if (!upload) return json(res, 404, { error: "Upload nao encontrado" });
      const conteudo = await lerUpload(upload);
      const resultado = await processarLote({
        atual, arquivos: [{ name: upload.filename, content: conteudo }],
        modulo, metodo: "XML/ZIP", uploadId: upload.id
      });
      return json(res, resultado.importacao.status === "Erro" ? 422 : 201, resultado);
    }

    if (input.files?.length || input.xml) {
      const arquivos = input.xml
        ? [{ name: input.filename || "corpo.xml", content: input.xml }]
        : input.files.map((item) => ({
            name: item.name || "arquivo.xml",
            content: item.contentBase64 ? Buffer.from(item.contentBase64, "base64") : String(item.content || "")
          }));
      const resultado = await processarLote({ atual, arquivos, modulo, metodo: "XML/ZIP" });
      return json(res, resultado.importacao.status === "Erro" ? 422 : 201, resultado);
    }

    // Chave de acesso: valida o DV e baixa a NF-e pela SEFAZ, com o A1 da
    // empresa destinataria (consulta por chave da distribuicao).
    if (input.method === "Chave de acesso" || input.keys) {
      const chaves = String(input.keys || "").split(/[\n;,]/).map((item) => item.trim()).filter(Boolean);
      if (!chaves.length) return json(res, 422, { error: "Informe ao menos uma chave de acesso" });
      const validadas = chaves.map((chave) => ({ chave, ...validarChave(chave) }));
      const invalidas = validadas.filter((item) => !item.valid);
      if (invalidas.length) {
        return json(res, 422, {
          error: "Chave(s) de acesso invalida(s)",
          detalhes: invalidas.map((item) => item.chave + ": " + item.reason)
        });
      }
      const aptas = empresasCaptura.listar()
        .filter((item) => item.configurada && item.ativa && (item.fontes || []).includes("NFE"))
        .map((item) => ({ id: item.clientId, nome: item.name, cnpj: item.cnpj }));
      const clienteId = input.clientId || input.clienteId;
      if (!clienteId) {
        return json(res, 422, {
          error: "Escolha a empresa destinataria das notas",
          chavesValidas: validadas.length,
          empresas: aptas,
          comoResolver: aptas.length
            ? "A SEFAZ entrega a NF-e a quem e destinatario dela, com o certificado dele."
            : "Nenhuma empresa tem NF-e ligada. Em Captura de notas > Empresas > Configurar, marque NF-e (SEFAZ) " +
              "e informe a UF, com o A1 da propria empresa."
        });
      }
      if (validadas.length > LIMITE_CHAVES_POR_VEZ) {
        return json(res, 422, { error: "Maximo de " + LIMITE_CHAVES_POR_VEZ + " chaves por vez: a SEFAZ bloqueia consulta em excesso" });
      }
      try {
        const resultado = await baixarPorChaves({
          clienteId, chaves: validadas.map((item) => item.chave), usuario: atual.email, configuracao: configuracaoCaptura()
        });
        auditar(atual, "Download de NF-e por chave", clienteId, {
          chaves: validadas.length, baixadas: resultado.baixadas, resumos: resultado.resumos,
          naoBaixadas: resultado.naoBaixadas
        });
        executarVigilancia();
        return json(res, 200, resultado);
      } catch (erro) {
        return json(res, erro.definitivo || erro.autenticacao ? 422 : 502, { error: erro.message });
      }
    }

    json(res, 422, {
      error: "Informe uploadId, files, xml ou keys",
      metodosDisponiveis: ["XML/ZIP por upload", "XML no corpo", "chave de acesso (NF-e, com a empresa destinataria)"]
    });
  }],

  // ---------------------------------------------------------------- captura

  ["GET", /^\/api\/captura\/adaptadores$/, (req, res) => {
    if (!auth(req, res)) return;
    json(res, 200, estadoAdaptadores(integracoes.todasAsChaves()));
  }],

  ["POST", /^\/api\/captura\/([^/]+)$/, async (req, res, match) => {
    const atual = exigir(req, res, "import");
    if (!atual) return;
    const nome = match[1];
    if (nome === "pasta") {
      try {
        const resultado = await importarPastaMonitorada(atual);
        if (!resultado.configurada) return json(res, 422, { error: "Configure o caminho da pasta monitorada antes" });
        auditar(atual, "Pasta monitorada importada", "pasta", {
          arquivos: resultado.arquivos, novos: resultado.novos, documentos: resultado.documentos || 0
        });
        return json(res, 200, resultado);
      } catch (erro) {
        return json(res, erro.status || 500, { error: erro.message });
      }
    }
    try {
      const resultado = await capturarPor(nome, {
        config: integracoes.config(nome),
        chavesConhecidas: documentos.identidadesConhecidas(),
        arquivos: []
      });
      auditar(atual, "Captura por adaptador", nome, resultado.resumo);
      json(res, 200, { adaptador: nome, resumo: resultado.resumo, documentos: resultado.documentos.length });
    } catch (erro) {
      if (erro instanceof CapturaNaoConfigurada) {
        return json(res, 501, {
          error: erro.message, adaptador: erro.adaptador,
          faltando: erro.faltando, comoResolver: erro.comoResolver
        });
      }
      json(res, 500, { error: erro.message });
    }
  }],

  // ------------------------------------------------------------- uploads

  ["GET", /^\/api\/uploads$/, (req, res) => {
    if (!auth(req, res)) return;
    json(res, 200, uploads.listar());
  }],

  ["POST", /^\/api\/uploads$/, async (req, res) => {
    const atual = exigir(req, res, "import");
    if (!atual) return;
    const input = await body(req);
    const filename = safeName(input.filename);
    const ext = extname(filename).toLowerCase();
    const permitidas = [".xml", ".zip", ".txt", ".csv", ".xlsx", ".xls", ".pfx", ".p12", ".pdf", ".cer", ".crt", ".pem"];
    const erros = [];
    if (!permitidas.includes(ext)) erros.push("Extensao nao suportada: " + (ext || "sem extensao"));
    if (!input.contentBase64) erros.push("Conteudo obrigatorio");
    if (input.contentBase64 && !/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(input.contentBase64)) {
      erros.push("Conteudo Base64 invalido");
    }
    if (erros.length) return json(res, 422, { error: "Upload rejeitado", errors: erros });

    const bytes = Buffer.from(input.contentBase64, "base64");
    if (!bytes.length) return json(res, 422, { error: "Conteudo vazio" });
    if (bytes.length > LIMITE_UPLOAD) return json(res, 422, { error: "Arquivo acima do limite de 100 MB" });

    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const igual = uploads.porSha(sha);
    if (igual) {
      auditar(atual, "Upload identico reaproveitado", igual.id, { sha256: sha });
      const { storedName, ...limpo } = igual;
      return json(res, 200, { ...limpo, reused: true });
    }

    const item = {
      id: crypto.randomUUID(),
      filename,
      storedName: crypto.randomUUID() + "_" + filename,
      kind: input.kind || "geral",
      size: bytes.length,
      sha256: sha,
      date: new Date().toISOString(),
      status: "Armazenado",
      uploadedBy: atual.email
    };
    await gravarUpload(item, bytes);
    uploads.inserir(item);
    auditar(atual, "Upload armazenado", item.id, { filename, size: item.size, sha256: sha });
    const { storedName, ...limpo } = item;
    json(res, 201, limpo);
  }],

  ["GET", /^\/api\/uploads\/([^/]+)\/download$/, async (req, res, match) => {
    const atual = exigir(req, res, "export");
    if (!atual) return;
    const item = uploads.porId(match[1]);
    if (!item) return json(res, 404, { error: "Upload nao encontrado" });
    const bytes = await lerUpload(item);
    auditar(atual, "Download de upload", item.id);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="' + item.filename.replace(/"/g, "") + '"'
    });
    res.end(bytes);
  }],

  // ------------------------------------------------------------ relatorios

  ["GET", /^\/api\/reports$/, (req, res) => {
    if (!auth(req, res)) return;
    json(res, 200, relatorios.listar());
  }],

  ["POST", /^\/api\/reports$/, async (req, res) => {
    const atual = exigir(req, res, "export");
    if (!atual) return;
    const input = await body(req);
    const tipo = input.type || "conferencia";
    const tiposValidos = ["conferencia", "documentos", "apuracao", "alertas", "auditoria"];
    if (!tiposValidos.includes(tipo)) {
      return json(res, 422, { error: "Tipo invalido", tiposValidos });
    }
    const item = {
      id: crypto.randomUUID(),
      name: input.name || "Relatorio de " + tipo,
      type: tipo,
      module: input.module || "Geral",
      period: input.period || configuracao().defaultPeriod,
      clientId: input.clientId || null,
      status: "Finalizado",
      rows: Math.max(0, linhasRelatorio(tipo, { clientId: input.clientId || null }).length - 1),
      file: "",
      requestedBy: atual.email,
      requestedAt: new Date().toISOString()
    };
    item.file = "/api/reports/" + item.id + "/download";
    relatorios.inserir(item);
    auditar(atual, "Relatorio gerado", item.id, { tipo, period: item.period, rows: item.rows });
    json(res, 201, item);
  }],

  ["GET", /^\/api\/reports\/([^/]+)\/download$/, async (req, res, match) => {
    const atual = exigir(req, res, "export");
    if (!atual) return;
    const item = relatorios.porId(match[1]);
    if (!item) return json(res, 404, { error: "Relatorio nao encontrado" });
    // O mesmo relatorio em CSV (padrao), Excel ou PDF.
    const formato = new URL(req.url, "http://local").searchParams.get("formato") || "csv";
    if (!["csv", "xlsx", "pdf"].includes(formato)) return json(res, 422, { error: "Formato invalido: csv, xlsx ou pdf" });
    const arquivo = item.type + "-" + item.id.slice(0, 8);
    if (formato === "csv") {
      const csv = montarCsv(item);
      auditar(atual, "Download de relatorio", item.id, { formato, linhas: csv.split("\n").length - 1 });
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="' + arquivo + '.csv"'
      });
      return res.end("﻿" + csv);
    }
    const linhas = linhasRelatorio(item.type, { clientId: item.clientId });
    const contexto = "Competência " + (item.period || "-") + " · gerado em " + new Date(item.requestedAt).toLocaleString("pt-BR") +
      " por " + item.requestedBy + (item.clientId ? " · " + (clientes.nome(item.clientId) || "") : "");
    auditar(atual, "Download de relatorio", item.id, { formato, linhas: linhas.length - 1 });
    if (formato === "xlsx") {
      const xlsx = criarXlsx({ titulo: item.name, autor: MARCA.marca.nome, abas: [{ nome: item.type,
        colunas: linhas[0].map((titulo) => ({ titulo: String(titulo), largura: Math.min(40, Math.max(10, String(titulo).length + 4)) })),
        linhas: linhas.slice(1) }] });
      res.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": 'attachment; filename="' + arquivo + '.xlsx"'
      });
      return res.end(xlsx);
    }
    const pdf = await gerarPdfTabela({ titulo: item.name, subtitulo: contexto, linhas, marca: MARCA.marca.nome });
    res.writeHead(200, { "content-type": "application/pdf", "content-disposition": 'attachment; filename="' + arquivo + '.pdf"' });
    res.end(pdf);
  }],

  // ---------------------------------------------------------------- regras

  ["GET", /^\/api\/rules$/, (req, res) => {
    if (!auth(req, res)) return;
    json(res, 200, regras.listar());
  }],

  ["POST", /^\/api\/rules$/, async (req, res) => {
    const atual = exigir(req, res, "config");
    if (!atual) return;
    const input = await body(req);
    if (!input.module || !input.type || !input.key || !input.description) {
      return json(res, 422, { error: "Modulo, tipo, chave e descricao sao obrigatorios" });
    }
    const item = regras.criar(input);
    auditar(atual, "Regra criada", item.id, item);
    json(res, 201, item);
  }],

  ["PATCH", /^\/api\/rules\/([^/]+)$/, async (req, res, match) => {
    const atual = exigir(req, res, "config");
    if (!atual) return;
    const antes = regras.porId(match[1]);
    if (!antes) return json(res, 404, { error: "Regra nao encontrada" });
    const depois = regras.atualizar(antes.id, await body(req));
    auditar(atual, "Regra atualizada", antes.id, { antes, depois });
    json(res, 200, depois);
  }],

  // ----------------------------------------------------------- integracoes

  ["GET", /^\/api\/integrations$/, (req, res) => {
    if (!auth(req, res)) return;
    const totalClientes = clientes.listar().length;
    const errosImportacao = importacoes.contarErros();
    json(res, 200, estadoAdaptadores(integracoes.todasAsChaves()).map((item) => ({
      id: item.id,
      name: item.nome,
      description: item.descricao,
      status: item.status,
      implemented: item.implementado,
      requirements: item.requisitos,
      missing: item.faltando,
      howTo: item.comoResolver,
      connectedCompanies: item.pronto ? totalClientes : 0,
      errors: errosImportacao
    })));
  }],

  ["GET", /^\/api\/cofre$/, (req, res) => {
    const atual = exigir(req, res, "config");
    if (!atual) return;
    json(res, 200, {
      ...estadoCofre(),
      auditoriaAssinada: assinaturaConfigurada(),
      exemploChaveCofre: chaveConfigurada() ? undefined : gerarChaveCofre(),
      exemploChaveAuditoria: assinaturaConfigurada() ? undefined : gerarChaveAuditoria()
    });
  }],

  ["PATCH", /^\/api\/integrations\/([^/]+)$/, async (req, res, match) => {
    const nome = match[1];
    // A chave da PONTE alcanca todos os certificados da carteira na ponte:
    // trocar e do dono (permissao "equipe"), como o site ja dizia. O operador
    // tem "config" e trocava pela tela do proprio agente.
    const atual = exigir(req, res, nome === "ponte" ? "equipe" : "config");
    if (!atual) return;
    const disponiveis = estadoAdaptadores({}).map((item) => item.id);
    if (!disponiveis.includes(nome)) {
      return json(res, 404, { error: "Adaptador nao encontrado", disponiveis });
    }
    if (!chaveConfigurada()) {
      const estado = estadoCofre();
      return json(res, 503, {
        error: "Cofre de segredos indisponivel: credencial nao sera gravada em texto plano",
        motivo: estado.motivo,
        comoResolver: estado.comoResolver
      });
    }
    const input = await body(req);
    const gravadas = integracoes.salvar(nome, input.config || {}, atual.email);
    // Valor de credencial nunca na auditoria: apenas quais chaves mudaram.
    auditar(atual, "Integracao configurada", nome, { chaves: gravadas });
    json(res, 200, {
      ...estadoAdaptadores(integracoes.todasAsChaves()).find((item) => item.id === nome),
      credenciais: mascarar(Object.fromEntries(gravadas.map((chave) => [chave, true])))
    });
  }],

  // Traz a carteira do escritorio na PONTE: cria os clientes que faltam e liga a
  // captura pela PONTE em todos. Configuracao ja existente de NFS-e (ADN) fica.
  ["POST", /^\/api\/integrations\/ponte\/carteira$/, async (req, res) => {
    // Cria empresas e liga a busca pela ponte em todas: do dono, como no site.
    const atual = exigir(req, res, "equipe");
    if (!atual) return;
    const input = await body(req);
    try {
      const resultado = await trazerCarteiraDaPonte({
        configuracao: configuracaoCaptura(), criarClientes: input.criarClientes !== false, usuario: atual.email
      });
      auditar(atual, "Carteira da PONTE trazida", "ponte", {
        carteira: resultado.carteira, criadas: resultado.criadas.map((item) => item.cnpj),
        ligadas: resultado.ligadas.map((item) => item.id), jaLigadas: resultado.jaLigadas.length
      });
      executarVigilancia();
      json(res, 200, resultado);
    } catch (erro) {
      json(res, erro.definitivo || erro.autenticacao ? 422 : 502, { error: erro.message });
    }
  }],

  ["POST", /^\/api\/integrations\/([^/]+)\/test$/, async (req, res, match) => {
    const atual = exigir(req, res, "config");
    if (!atual) return;
    const nome = match[1];
    const estado = estadoAdaptadores(integracoes.todasAsChaves()).find((item) => item.id === nome);
    if (!estado) return json(res, 404, { error: "Adaptador nao encontrado" });

    if (nome === "adn" || nome === "receita") {
      const { http, ...resultado } = testarPorEmpresa(nome);
      auditar(atual, "Teste de integracao", nome, { resultado: resultado.status, resumo: resultado.resumo || null });
      return json(res, http, { adaptador: nome, ...resultado });
    }
    if (nome === "ponte") {
      const config = lerConfigPonte();
      if (!config?.chave) {
        return json(res, 422, { adaptador: nome, ok: false, status: "Falta configurar", faltando: ["url", "chave"],
          mensagem: "Informe o endereco da PONTE e a chave do escritorio em Configurar." });
      }
      try {
        const ponte = new ClientePonte({ base: config.url || PONTE_PRODUCAO, chave: config.chave, tentativas: 1 });
        const resposta = await carteiraDaPonte(ponte);
        const carteira = resposta.clientes || [];
        const plano = limiteDoPlano();
        const nossas = new Map(empresasCaptura.listar().map((item) => [item.cnpjDigits, item]));
        const ativos = carteira.filter((item) => item.ativo !== false);
        const comCert = ativos.filter((item) => item.temCertificado).length;
        const aqui = ativos.filter((item) => nossas.has(item.empresaCnpj));
        const ligadas = aqui.filter((item) => (nossas.get(item.empresaCnpj).fontes || []).includes("PONTE")).length;
        const forasDaqui = ativos.filter((item) => !nossas.has(item.empresaCnpj));
        auditar(atual, "Teste de integracao", nome, { resultado: "Conectado", carteira: ativos.length, ligadas });
        return json(res, 200, {
          adaptador: nome, ok: true, status: "Conectado",
          mensagem: "Carteira do escritorio na PONTE: " + ativos.length + " cliente(s), " + comCert + " com A1.\n" +
            aqui.length + " tambem cadastrado(s) no NUCLEO; " + ligadas + " com a PONTE ligada na captura." +
            (forasDaqui.length ? "\nNa PONTE e ainda nao no NUCLEO: " +
              forasDaqui.slice(0, 10).map((item) => (item.apelido || item.empresaCnpj)).join(", ") +
              (forasDaqui.length > 10 ? " e mais " + (forasDaqui.length - 10) : "") + "." : "") +
            (plano.plano ? "\nPlano " + plano.plano.nome + ": " + plano.emUso + " de " +
              (plano.limite || "ilimitadas") + " empresa(s) no NUCLEO." : ""),
          resumo: { carteira: ativos.length, comCertificado: comCert, noNucleo: aqui.length, ligadas, plano: plano.plano }
        });
      } catch (erro) {
        auditar(atual, "Teste de integracao", nome, { resultado: "erro", erro: erro.message });
        return json(res, erro.autenticacao ? 422 : 502, { adaptador: nome, ok: false, status: "Erro", erro: erro.message,
          mensagem: erro.message });
      }
    }

    if (nome === "prefeitura") {
      const comPasta = empresasCaptura.listar().filter((item) => item.configurada && item.pastaDestino).length;
      const importadas = acervoDocs.nfsePrefeitura();
      auditar(atual, "Teste de integracao", nome, { resultado: "Pronto", comPasta, importadas });
      return json(res, 200, {
        adaptador: nome, ok: true, status: "Pronto",
        mensagem: "Importar XML: no painel de cada empresa (XML, ZIP e o PDF da prefeitura).\n" +
          "Pasta de entrada: " + comPasta + " empresa(s) com pasta configurada; solte os XML na pasta ENTRADA dentro da pasta da empresa.\n" +
          "NFS-e de prefeitura no acervo: " + importadas + ".",
        resumo: { empresasComPasta: comPasta, nfseImportadas: importadas }
      });
    }

    if (!estado.implementado) {
      auditar(atual, "Teste de integracao", nome, { resultado: "nao implementado" });
      return json(res, 501, {
        adaptador: nome, ok: false, status: "Nao implementado",
        faltando: estado.requisitos, comoResolver: estado.comoResolver,
        aviso: "Este conector nao existe neste repositorio. Nao ha como testar conexao."
      });
    }
    if (estado.faltando.length) {
      auditar(atual, "Teste de integracao", nome, { resultado: "falta configurar", faltando: estado.faltando });
      return json(res, 422, { adaptador: nome, ok: false, status: "Falta configurar", faltando: estado.faltando });
    }

    if (["sieg", "dominio", "acessorias"].includes(nome)) {
      try {
        const resultado = await testarExterno(nome);
        auditar(atual, "Teste de integracao", nome, { resultado: "Conectado" });
        return json(res, 200, { adaptador: nome, ok: true, status: "Conectado", ...resultado });
      } catch (erro) {
        auditar(atual, "Teste de integracao", nome, { resultado: "erro", erro: erro.message });
        return json(res, erro.autenticacao || erro.definitivo ? 422 : 502, { adaptador: nome, ok: false, status: "Erro",
          erro: erro.message, mensagem: erro.message });
      }
    }

    if (nome === "pasta") {
      try {
        const lida = await lerPastaMonitorada();
        auditar(atual, "Teste de integracao", nome, { resultado: "ok", arquivos: lida.total, novos: lida.novos.length });
        return json(res, 200, {
          adaptador: nome, ok: true, status: "Conectado",
          mensagem: "A pasta " + lida.caminho + " abriu: " + lida.total + " arquivo(s) XML/ZIP, " + lida.novos.length +
            " ainda nao importado(s). Use Importar agora, ou espere a leitura automatica (a cada minuto).",
          resumo: { arquivos: lida.total, novos: lida.novos.length }
        });
      } catch (erro) {
        auditar(atual, "Teste de integracao", nome, { resultado: "erro", erro: erro.message });
        return json(res, 502, { adaptador: nome, ok: false, status: "Erro", erro: erro.message });
      }
    }

    try {
      const resultado = await capturarPor(nome, {
        config: integracoes.config(nome), chavesConhecidas: new Set(), arquivos: []
      });
      auditar(atual, "Teste de integracao", nome, { resultado: "ok", resumo: resultado.resumo });
      json(res, 200, { adaptador: nome, ok: true, status: "Conectado", resumo: resultado.resumo,
        mensagem: "Leitura de XML e ZIP funcionando. Envie arquivos em Importacoes ou em Arquivos." });
    } catch (erro) {
      auditar(atual, "Teste de integracao", nome, { resultado: "erro", erro: erro.message });
      json(res, 502, { adaptador: nome, ok: false, status: "Erro", erro: erro.message });
    }
  }],

  // ------------------------------------------------------- processamentos

  ["GET", /^\/api\/processes$/, (req, res) => {
    if (!auth(req, res)) return;
    json(res, 200, rotinas.listar());
  }],

  ["POST", /^\/api\/processes$/, async (req, res) => {
    const atual = exigir(req, res, "import");
    if (!atual) return;
    const input = await body(req);
    const tipo = input.type || "Vigilancia";
    if (!["Vigilancia", "Reconferencia"].includes(tipo)) {
      return json(res, 422, {
        error: "Tipo de rotina desconhecido: " + tipo,
        tiposValidos: ["Vigilancia", "Reconferencia"]
      });
    }

    const inicio = Date.now();
    const id = rotinas.inserir({ tipo, alvo: input.target || "Todos", iniciadoPor: atual.email });
    try {
      let detalhe = "";
      let resultadoRotina = null;
      if (tipo === "Vigilancia") {
        const resultado = executarVigilancia(atual);
        detalhe = resultado.resumo.novos + " alerta(s) novo(s), " + resultado.resumo.pendentes +
          " pendente(s), " + resultado.resumo.encerrados + " encerrado(s)";
        resultadoRotina = resultado.resumo;
      } else {
        const ativas = regras.ativas();
        let achados = 0;
        let total = 0;
        for (const documento of documentos.naoCancelados()) {
          const resultado = conferir(documento, ativas);
          conferencias.salvar(resultado, { clienteId: documento.clientId, documentoId: documento.id });
          achados += resultado.summary.total;
          total += 1;
        }
        detalhe = achados + " achado(s) em " + total + " documento(s)";
        resultadoRotina = { documentos: total, achados };
        executarVigilancia(atual);
      }
      const job = rotinas.concluir(id, {
        situacao: "Finalizado", detalhe, duracaoMs: Date.now() - inicio, resultado: resultadoRotina
      });
      auditar(atual, "Rotina " + tipo, id, { status: "Finalizado", details: detalhe });
      json(res, 201, job);
    } catch (erro) {
      const job = rotinas.concluir(id, {
        situacao: "Erro", detalhe: erro.message, duracaoMs: Date.now() - inicio
      });
      auditar(atual, "Rotina " + tipo, id, { status: "Erro", details: erro.message });
      json(res, 500, job);
    }
  }],

  // --------------------------------------------------------- configuracoes

  ["GET", /^\/api\/settings$/, (req, res) => {
    const atual = exigir(req, res, "config");
    if (!atual) return;
    json(res, 200, configuracao());
  }],

  ["PATCH", /^\/api\/settings$/, async (req, res) => {
    const atual = exigir(req, res, "equipe");
    if (!atual) return;
    const input = await body(req);
    if (input.officeName !== undefined && !String(input.officeName).trim()) {
      return json(res, 422, { error: "Nome do escritorio obrigatorio" });
    }
    if (input.defaultPeriod !== undefined && !/^\d{2}\/\d{4}$/.test(String(input.defaultPeriod))) {
      return json(res, 422, { error: "Competencia deve usar MM/AAAA" });
    }
    // Limite que nao e numero, negativo, DAS fora do mes ou teto do Simples zero:
    // recusado com o nome, em vez de gravado. O teto 0 dividia por zero na
    // vigilancia, e o dia 0 do DAS virava o ultimo dia do mes anterior.
    const limitesNovos = {};
    for (const [nome, bruto] of Object.entries(input.limites || {})) {
      if (bruto === null || bruto === undefined || bruto === "") continue;
      const valor = Number(bruto);
      if (!Number.isFinite(valor) || valor < 0) return json(res, 422, { error: "Limite invalido em " + nome + ": use um numero de 0 para cima" });
      if (nome === "dasVencimentoDia" && (valor < 1 || valor > 31 || !Number.isInteger(valor))) {
        return json(res, 422, { error: "Dia do vencimento do DAS vai de 1 a 31" });
      }
      if (nome === "limiteSimples" && valor <= 0) return json(res, 422, { error: "O teto do Simples precisa ser maior que zero" });
      limitesNovos[nome] = valor;
    }
    const antes = configuracao();
    const depois = {
      ...antes,
      officeName: input.officeName ?? antes.officeName,
      defaultPeriod: input.defaultPeriod ?? antes.defaultPeriod,
      modules: { ...antes.modules, ...(input.modules || {}) },
      limites: { ...antes.limites, ...limitesNovos }
    };
    configuracoes.gravar("app", depois);
    auditar(atual, "Configuracoes atualizadas", "settings", { antes, depois });
    if (input.limites) executarVigilancia(atual);
    json(res, 200, configuracao());
  }],

  // ------------------------------------------------------------- usuarios

  ["GET", /^\/api\/users$/, (req, res) => {
    const atual = exigir(req, res, "equipe");
    if (!atual) return;
    json(res, 200, usuarios.listar());
  }],

  ["POST", /^\/api\/users$/, async (req, res) => {
    const atual = exigir(req, res, "equipe");
    if (!atual) return;
    const input = await body(req);
    if (!input.name || !input.email) return json(res, 422, { error: "Nome e e-mail sao obrigatorios" });
    if (!PERFIS.includes(input.role)) {
      return json(res, 422, { error: "Perfil invalido", perfisValidos: PERFIS });
    }
    if (usuarios.porEmail(String(input.email).toLowerCase())) {
      return json(res, 409, { error: "E-mail ja cadastrado" });
    }
    // Senha provisoria gerada aqui e devolvida uma vez, com troca obrigatoria.
    const provisoria = input.password || crypto.randomBytes(18).toString("base64url");
    if (input.password) {
      const forca = conferirForcaSenha(input.password);
      if (!forca.ok) return json(res, 422, { error: forca.motivo });
    }
    const criado = usuarios.criar({
      name: input.name, email: input.email, password: provisoria,
      role: input.role, mustChangePassword: true
    });
    auditar(atual, "Usuario criado", criado.id, { email: criado.email, role: criado.role });
    const { password, ...limpo } = criado;
    json(res, 201, { ...limpo, senhaProvisoria: provisoria });
  }],

  ["DELETE", /^\/api\/users\/([^/]+)$/, async (req, res, match) => {
    const atual = exigir(req, res, "equipe");
    if (!atual) return;
    const alvo = usuarios.porId(match[1]);
    if (!alvo) return json(res, 404, { error: "Usuario nao encontrado" });
    if (alvo.id === atual.id) return json(res, 422, { error: "Nao e possivel desativar o proprio usuario" });
    if (alvo.role === "admin" && usuarios.listar().filter((item) => item.role === "admin").length <= 1) {
      return json(res, 422, { error: "Nao e possivel desativar o unico administrador" });
    }
    usuarios.desativar(alvo.id);
    auditar(atual, "Usuario desativado", alvo.id, { email: alvo.email });
    json(res, 200, { ok: true });
  }],

  // -------------------------------------------------------------- auditoria

  ["GET", /^\/api\/audit-log$/, (req, res) => {
    const atual = exigir(req, res, "config");
    if (!atual) return;
    const url = new URL(req.url, "http://local");
    json(res, 200, {
      integridade: auditoria.verificar(),
      appendOnly: true,
      eventos: auditoria.consultar({
        user: url.searchParams.get("user") || undefined,
        action: url.searchParams.get("action") || undefined,
        target: url.searchParams.get("target") || undefined,
        limite: Number(url.searchParams.get("limite") || 200)
      })
    });
  }],

  ["GET", /^\/api\/audit-log\/verificar$/, (req, res) => {
    const atual = exigir(req, res, "config");
    if (!atual) return;
    json(res, 200, auditoria.verificar());
  }],

  ["GET", /^\/api\/audit-log\/historico\/([^/]+)$/, (req, res, match) => {
    const atual = exigir(req, res, "config");
    if (!atual) return;
    json(res, 200, { target: match[1], eventos: auditoria.historico(match[1]) });
  }]
];

/** Trilha, ocorrencia e alertas de uma revisao de cancelamentos da NFS-e. */
function registrarRevisaoDeCancelamentos(quem, clienteId, resumo) {
  auditar(quem, "Revisao de cancelamentos da NFS-e", clienteId, {
    notas: resumo.notas, conferidas: resumo.conferidas, semEvento: resumo.semEvento, puladas: resumo.puladas,
    canceladas: resumo.canceladas.map((item) => ({ chave: item.chave, evento: item.evento })),
    naoConferidas: resumo.naoConferidas.length, semCertificado: resumo.semCertificado || undefined
  });
  if (resumo.canceladas.length) {
    ocorrencias.inserir({
      titulo: resumo.canceladas.length + " NFS-e cancelada(s) depois de capturada(s): " +
        resumo.canceladas.map((item) => item.numero + " (" + item.descricao + ")").join(", "),
      fonte: "CAPTURA", severidade: "atencao", clienteId
    });
    executarVigilancia();
  }
}

const contextoCaptura = {
  json, body, auth, exigir, auditar, configuracaoCaptura, executarVigilancia, registrarRevisaoDeCancelamentos,
  modoDemo: MODO_DEMO, fila: null, rodarAgendador: () => []
};
routes.push(...criarRotasCaptura(contextoCaptura));
routes.push(...criarRotasIntegracoes(contextoCaptura));

// ----------------------------------------------------------- relatorios CSV

function csvLinha(valores) {
  return valores.map((valor) => {
    const texto = String(valor ?? "");
    return /[";\n]/.test(texto) ? '"' + texto.replace(/"/g, '""') + '"' : texto;
  }).join(";");
}

function linhasRelatorio(tipo, filtro = {}) {
  const cliente = filtro.clientId || null;

  if (tipo === "conferencia") {
    const linhas = [["Documento", "Tipo", "Numero", "Emissao", "Cliente", "Status", "Codigo", "Item",
      "Achado", "Esperado", "Encontrado", "Diferenca", "Conta", "Base normativa", "Justificativa"]];
    for (const linha of conferencias.paraRelatorio(cliente)) {
      linhas.push([
        linha.chave, linha.tipo, linha.numero, linha.emitido_em,
        linha.cliente_nome || "Nao vinculado", linha.situacao,
        linha.codigo || "", linha.item ?? "",
        linha.titulo || "Sem divergencia",
        linha.esperado === null || linha.esperado === undefined ? "" : JSON.parse(linha.esperado),
        linha.encontrado === null || linha.encontrado === undefined ? "" : JSON.parse(linha.encontrado),
        linha.diferenca ?? "", linha.conta || "", linha.base_normativa || "", linha.justificativa || ""
      ]);
    }
    return linhas;
  }

  if (tipo === "documentos") {
    const linhas = [["Chave", "Tipo", "Numero", "Serie", "Emissao", "Operacao", "Cliente",
      "Emitente CNPJ", "Destinatario", "Valor", "Cancelado", "Capturado em"]];
    const lista = cliente
      ? documentos.doCliente(cliente, { incluirCancelados: true })
      : documentos.naoCancelados();
    for (const documento of lista) {
      linhas.push([
        documento.key, documento.kind, documento.number, documento.series, documento.issuedAt,
        documento.operation, clientes.nome(documento.clientId), documento.emitter?.cnpj,
        documento.recipient?.name,
        documento.kind === "NFS-e" ? documento.service?.gross : documento.totals?.invoice,
        documento.cancelled ? "Sim" : "Nao", documento.capturedAt
      ]);
    }
    return linhas;
  }

  if (tipo === "apuracao") {
    const linhas = [["Cliente", "Competencia", "Anexo", "Faixa", "RBT12", "Receita do mes",
      "Aliquota nominal", "Deducao", "Aliquota efetiva", "DAS", "Tributo", "Aliquota do tributo",
      "Valor", "Memoria"]];
    for (const apuracao of apuracoes.paraRelatorio(cliente)) {
      // Receita segregada em mais de um anexo: uma linha por parcela e tributo,
      // com o anexo, as aliquotas, a receita e o DAS daquela parcela.
      const parcelas = (apuracao.segmentos || []).length > 1
        ? apuracao.segmentos.map((item) => ({
          base: [apuracao.clientName, apuracao.period, item.anexo + " (" + item.segmento + ")", item.faixa,
            apuracao.rbt12, item.receita, item.aliquotaNominal, item.deducao, item.aliquotaEfetiva, item.das],
          tributos: item.tributos, memoria: item.memoria
        }))
        : [{
          base: [apuracao.clientName, apuracao.period, apuracao.anexo, apuracao.faixa,
            apuracao.rbt12, apuracao.receitaMes, apuracao.aliquotaNominal, apuracao.deducao,
            apuracao.aliquotaEfetiva, apuracao.amount],
          tributos: apuracao.tributos, memoria: apuracao.memoria
        }];
      for (const parcela of parcelas) {
        const tributos = Object.entries(parcela.tributos || {});
        if (!tributos.length) {
          linhas.push([...parcela.base, "", "", "", (parcela.memoria || []).join(" | ")]);
          continue;
        }
        for (const [nome, valor] of tributos) {
          linhas.push([...parcela.base, nome, valor.aliquota, valor.valor, valor.memoria || ""]);
        }
      }
    }
    return linhas;
  }

  if (tipo === "alertas") {
    const linhas = [["Codigo", "Fonte", "Severidade", "Cliente", "Titulo", "Detalhe", "Status",
      "Detectado em", "Vence em", "Tratado por", "Justificativa"]];
    for (const linha of alertas.paraRelatorio(cliente)) {
      linhas.push([linha.codigo, linha.fonte, linha.severidade, linha.cliente_nome || "Nao vinculado",
        linha.titulo, linha.detalhe, linha.situacao, linha.detectado_em, linha.vence_em || "",
        linha.tratado_por || "", linha.motivo || ""]);
    }
    return linhas;
  }

  const linhas = [["Seq", "Data", "Usuario", "Acao", "Alvo", "Hash do conteudo", "Hash anterior",
    "Hash", "Assinatura"]];
  for (const evento of auditoria.todos()) {
    linhas.push([evento.seq, evento.at, evento.user, evento.action, evento.target,
      evento.dataHash, evento.prevHash, evento.hash, evento.signature || ""]);
  }
  return linhas;
}

function montarCsv(item) {
  const cabecalho = [
    csvLinha([MARCA.marca.nome + " - " + item.name]),
    csvLinha(["Tipo", item.type, "Competencia", item.period, "Gerado em", item.requestedAt,
      "Por", item.requestedBy]),
    ""
  ];
  const linhas = linhasRelatorio(item.type, { clientId: item.clientId });
  return [...cabecalho, ...linhas.map(csvLinha)].join("\n");
}

// -------------------------------------------------------------- arquivos

async function staticFile(req, res) {
  const requestPath = new URL(req.url, "http://local").pathname;
  const relativo = normalize(requestPath === "/" ? "/index.html" : decodeURIComponent(requestPath))
    .replace(/^([/\\])+/, "");
  let filePath = resolve(join(publicDir, relativo));

  if (filePath !== publicDir && !filePath.startsWith(publicDir + sep)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    let file;
    try {
      file = await readFile(filePath);
    } catch (erro) {
      if (!requestPath.endsWith("/")) throw erro;
      filePath = join(filePath, "index.html");
      file = await readFile(filePath);
    }
    const tipos = {
      ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".json": "application/json", ".svg": "image/svg+xml", ".md": "text/markdown", ".woff2": "font/woff2"
    };
    const tipo = tipos[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      // Fonte e binario: charset so faz sentido em texto.
      "content-type": tipo + (/^(text\/|application\/json|image\/svg)/.test(tipo) ? "; charset=utf-8" : ""),
      "x-content-type-options": "nosniff",
      // A fonte nao muda entre versoes: o navegador guarda por um ano.
      ...(tipo === "font/woff2" ? { "cache-control": "public, max-age=31536000, immutable" } : {})
    });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

// ----------------------------------------------------------------- servidor

// Guarda no Supabase (lib/nuvem.mjs), para o Render gratuito, que apaga o disco
// ao dormir. Sem NUCLEO_SUPABASE_URL e NUCLEO_SUPABASE_CHAVE, tudo fica so no disco.
let nuvem = null;
let restauro = null;
if (process.env.NUCLEO_SUPABASE_URL || process.env.NUCLEO_SUPABASE_CHAVE) {
  try {
    nuvem = armazemDoAmbiente(); // URL sem chave (ou chave sb_) tambem recusa subir
    await nuvem.garantirBucket();
    restauro = await restaurarBanco({ armazem: nuvem, arquivo: bancoArquivo, dataDir });
  } catch (erro) {
    console.error("NUVEM: " + erro.message);
    console.error("O servidor NAO sobe: abrir um banco vazio agora apagaria o que a nuvem guarda na proxima copia.");
    // Sair com conexao HTTP ainda fechando derruba o Node no Windows (assercao
    // do libuv, codigo 0xC0000409 no lugar do 1): espera as conexoes assentarem.
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.exit(1);
  }
}
const espelhoUploads = nuvem ? espelho(nuvem, "uploads/") : null;

abrir(bancoArquivo);
configurarAcervo(join(dataDir, "acervo"), nuvem ? espelho(nuvem, "acervo/") : null);
if (restauro?.enviarArquivosLocais) {
  const enviados = await enviarArquivosLocais({ armazem: nuvem, dataDir });
  console.log("nuvem: " + enviados + " arquivo(s) do disco enviados ao Supabase");
}
const guarda = nuvem ? iniciarGuarda({
  armazem: nuvem,
  banco: bd,
  origem: restauro.origem,
  intervaloMs: Number(process.env.NUCLEO_NUVEM_INTERVALO_MS || 5000),
  quietoMs: Number(process.env.NUCLEO_NUVEM_QUIETO_MS || 10_000),
  maxEsperaMs: Number(process.env.NUCLEO_NUVEM_MAX_ESPERA_MS || 60_000),
  parteMax: Number(process.env.NUCLEO_NUVEM_PARTE_MAX || 40 * 1024 * 1024),
  fuso: process.env.NUCLEO_FUSO || "America/Sao_Paulo"
}) : null;

// Uploads: no disco pelo nome, na nuvem pelo SHA-256 (o nome pode ter acento).
async function gravarUpload(item, bytes) {
  if (espelhoUploads) await espelhoUploads.enviar(item.sha256, bytes);
  await mkdir(uploadDir, { recursive: true });
  await writeFile(join(uploadDir, item.storedName), bytes);
}

async function lerUpload(item) {
  try {
    return await readFile(join(uploadDir, item.storedName));
  } catch (erro) {
    if (erro.code !== "ENOENT" || !espelhoUploads) throw erro;
    const bytes = await espelhoUploads.baixar(item.sha256);
    if (!bytes) throw erro;
    await mkdir(uploadDir, { recursive: true });
    await writeFile(join(uploadDir, item.storedName), bytes);
    return bytes;
  }
}

const semeado = semear();
const aviso = avisoDeSemeadura(semeado);

// Instalacao pelo kit da PONTE: na primeira subida, o endereco e a chave do
// escritorio vem do ambiente e vao para o cofre. Depois disso vale o cofre
// (Integracoes > PONTE SEFAZ): o ambiente nunca sobrescreve o que ja esta la.
function configurarPonteDaInstalacao(env) {
  if (!env.NUCLEO_PONTE_CHAVE) return null;
  if (!chaveConfigurada()) {
    console.error("[instalacao] NUCLEO_PONTE_CHAVE ignorada: sem NUCLEO_CHAVE_SEGREDOS o cofre nao grava segredo");
    return null;
  }
  if (integracoes.config("ponte")?.chave) return null;
  const url = String(env.NUCLEO_PONTE_URL || PONTE_PRODUCAO).trim().replace(/\/+$/, "");
  integracoes.salvar("ponte", { url, chave: env.NUCLEO_PONTE_CHAVE.trim() }, "instalacao");
  auditar(null, "Integracao configurada pela instalacao", "ponte", { chaves: ["url", "chave"], url });
  return url;
}
const ponteDaInstalacao = configurarPonteDaInstalacao(process.env);

// Vigilancia na subida: o estado de alertas reflete o acervo, nao o que ficou
// gravado na ultima execucao.
executarVigilancia();

// ------------------------------------------------- fila e agendador da captura

async function executarTarefa(tarefa) {
  // Agendamento que so copia da PONTE: a busca na SEFAZ fica com a agenda dela.
  const agendamento = tarefa.agendamentoId ? agendamentosCaptura.porId(tarefa.agendamentoId) : null;
  const resumo = await sincronizarEmpresa({
    clienteId: tarefa.clientId, fonte: tarefa.fonte, tarefaId: tarefa.id, configuracao: configuracaoCaptura(),
    soCopiar: Boolean(agendamento?.soCopiar)
  });
  ocorrencias.inserir({
    titulo: "Captura " + tarefa.fonte + ": " + resumo.novos + " documento(s) novo(s)" +
      (tarefa.competencia ? " (fechamento " + tarefa.competencia + ")" : ""),
    fonte: "CAPTURA", severidade: resumo.falhas || resumo.resumos ? "atencao" : "informativo",
    clienteId: tarefa.clientId
  });
  auditar({ email: "captura:" + tarefa.origem }, "Captura concluida", tarefa.id, {
    clientId: tarefa.clientId, fonte: tarefa.fonte, nsuInicial: resumo.nsuInicial, nsuFinal: resumo.nsuFinal,
    novos: resumo.novos, emitidas: resumo.emitidas, recebidas: resumo.recebidas, eventos: resumo.eventos,
    resumos: resumo.resumos, falhas: resumo.falhas, pdfs: resumo.pdfs
  });
  // A ciencia e um ato em nome do cliente: cada chave manifestada fica na trilha.
  if (resumo.ciencias?.enviadas) {
    auditar({ email: "captura:" + tarefa.origem }, "Ciencia da Operacao manifestada", tarefa.id, {
      clientId: tarefa.clientId, origem: "automatica",
      aceitas: resumo.ciencias.aceitas.map((item) => item.chave),
      recusadas: resumo.ciencias.recusadas.map((item) => ({ chave: item.chave, cStat: item.cStat, motivo: item.motivo }))
    });
  }
  // Depois da NFS-e pelo ADN, pergunta a Sefin se alguma nota recente foi
  // cancelada (de oficio, por substituicao) sem o evento passar pela caixa.
  const configuracao = configuracaoCaptura();
  if (tarefa.fonte === "ADN" && configuracao.revisarEventos) {
    try {
      resumo.revisaoEventos = await revisarCancelamentosNfse({ clienteId: tarefa.clientId, configuracao, meses: 2, limite: 100 });
      registrarRevisaoDeCancelamentos({ email: "captura:" + tarefa.origem }, tarefa.clientId, resumo.revisaoEventos);
    } catch (erro) {
      resumo.revisaoEventos = { erro: erro.message };
    }
  }
  // XML liberado pela ciencia so vem na proxima consulta, depois da janela da SEFAZ.
  if (resumo.seguimentoEm) {
    tarefasCaptura.enfileirar({
      clienteId: tarefa.clientId, fonte: tarefa.fonte, origem: "seguimento", competencia: tarefa.competencia,
      prioridade: PRIORIDADE.manual, aPartirDe: resumo.seguimentoEm + 60_000, usuario: "captura",
      chaveUnica: "seguimento:" + tarefa.id
    });
  }
  return resumo;
}

// Documento lido errado por uma versao antiga do leitor e corrigido no lugar,
// antes da primeira captura (que, senao, traria o certo como documento novo).
try {
  for (const item of await corrigirLeiturasAntigas()) {
    auditar(null, "Documento relido e corrigido", item.id, item);
    console.log("[reparo] " + item.cliente + ": " + item.de.tipo + " " + item.de.chave + " virou " + item.para.tipo + " " +
      item.para.chave);
  }
  for (const item of fecharPendenciasDePdfFeito()) {
    auditar(null, "Pendencia de PDF fechada: o PDF ja existe", item.id, item);
  }
} catch (erro) {
  console.error("[reparo] falhou:", erro.message);
}

const fila = iniciarFila({
  executar: executarTarefa,
  concorrencia: Number(process.env.NUCLEO_CAPTURA_CONCORRENCIA || 3),
  intervaloMs: Number(process.env.NUCLEO_FILA_INTERVALO_MS || 2000),
  aoTerminar: (tarefa, erro) => {
    if (erro) {
      auditar({ email: "captura:" + tarefa.origem }, "Captura com erro", tarefa.id, {
        clientId: tarefa.clientId, situacao: tarefa.situacao, erro: erro.message, tentativas: tarefa.tentativas
      });
      ocorrencias.inserir({
        titulo: "Captura falhou: " + erro.message, fonte: "CAPTURA",
        severidade: tarefa.situacao === "erro" ? "critico" : "atencao", clienteId: tarefa.clientId
      });
    }
    executarVigilancia();
  }
});

function rodarAgendador(agora = new Date()) {
  const devidas = tarefasDevidas({
    agendamentos: agendamentosCaptura.ativos(), empresas: empresasCaptura.ativas(),
    agora, fuso: configuracaoCaptura().fuso
  });
  const criadas = [];
  for (const item of devidas) {
    const tarefa = tarefasCaptura.enfileirar({
      clienteId: item.clienteId, fonte: item.fonte || "ADN", origem: item.origem, competencia: item.competencia,
      prioridade: item.prioridade, chaveUnica: item.chaveUnica, agendamentoId: item.agendamentoId,
      usuario: "agendador"
    });
    if (tarefa) criadas.push(tarefa);
  }
  if (criadas.length) {
    auditar({ email: "agendador" }, "Tarefas agendadas criadas", "agendador", {
      quantidade: criadas.length, competencias: [...new Set(criadas.map((item) => item.competencia))]
    });
    fila.tick();
  }
  return criadas;
}

// Pasta de entrada de cada empresa (NFS-e de prefeitura, NF-e do emissor):
// quando o servidor enxerga a pasta, ele mesmo importa; senao, o agente local.
let varrendoEntradas = false;
async function varrerEntradas() {
  const config = configuracaoCaptura();
  if (varrendoEntradas || config.modoPasta === "agente") return [];
  varrendoEntradas = true;
  const feitos = [];
  try {
    for (const empresa of empresasCaptura.listar()) {
      if (!empresa.configurada || !empresa.pastaDestino) continue;
      if (config.modoPasta !== "servidor" && !(await pastaAcessivel(empresa.pastaDestino))) continue;
      const diretorio = caminhoEntrada(empresa.pastaDestino, empresa.cnpjDigits);
      const lidos = await lerEntrada(diretorio);
      if (!lidos.length) continue;
      const resultado = await importarArquivos({
        clienteId: empresa.clientId, arquivos: lidos.map(({ nome, bytes }) => ({ nome, bytes })),
        usuario: "pasta de entrada", origem: "pasta de entrada", configuracao: config
      });
      await arquivarEntrada(diretorio, lidos, resultado.arquivos);
      auditar({ email: "pasta de entrada" }, "Notas importadas da pasta de entrada", empresa.clientId, {
        arquivos: lidos.length, novos: resultado.novos, duplicados: resultado.duplicados, recusados: resultado.recusados
      });
      feitos.push({ clientId: empresa.clientId, ...resultado });
    }
    if (feitos.length) executarVigilancia();
  } catch (erro) {
    console.error("pasta de entrada:", erro.message);
  } finally {
    varrendoEntradas = false;
  }
  return feitos;
}

contextoCaptura.fila = fila;
contextoCaptura.rodarAgendador = rodarAgendador;
contextoCaptura.varrerEntradas = varrerEntradas;
const relogioAgendador = setInterval(() => {
  try { rodarAgendador(); } catch (erro) { console.error("agendador:", erro.message); }
}, 60_000);
let avisouPasta = "";
async function lerPastasDeTempoEmTempo() {
  await varrerEntradas();
  try {
    await importarPastaMonitorada({ email: "pasta monitorada" });
    avisouPasta = "";
  } catch (erro) {
    // Pasta fora do alcance (servidor na nuvem): avisa uma vez, nao a cada minuto.
    if (avisouPasta !== erro.message) console.error("pasta monitorada:", erro.message);
    avisouPasta = erro.message;
  }
}
contextoCaptura.importarPastaMonitorada = importarPastaMonitorada;
const relogioEntradas = setInterval(lerPastasDeTempoEmTempo, Number(process.env.NUCLEO_ENTRADA_INTERVALO_MS || 60_000));
relogioEntradas.unref?.();
relogioAgendador.unref?.();

const server = createServer(async (req, res) => {
  cabecalhosDeSeguranca(req, res);
  if (cors(req, res)) return;
  const pathname = new URL(req.url, "http://local").pathname;
  for (const [method, pattern, handler] of routes) {
    const match = pathname.match(pattern);
    if (method === req.method && match) {
      try {
        return await handler(req, res, match);
      } catch (erro) {
        if (erro.status) return json(res, erro.status, { error: erro.message });
        console.error(req.method, pathname, erro);
        return json(res, 500, { error: "Erro interno" });
      }
    }
  }
  if (pathname.startsWith("/api/")) return json(res, 404, { error: "Rota nao encontrada" });
  return staticFile(req, res);
});

server.listen(port, () => {
  const integridade = auditoria.verificar();
  if (aviso) console.log(aviso);
  console.log("NUCLEO FISCAL em http://localhost:" + port);
  console.log("  banco               : " + bancoArquivo + " (esquema v" + versaoEsquema() + ")");
  console.log("  documentos          : " + documentos.contar());
  console.log("  conferencias        : " + conferencias.contar());
  console.log("  alertas pendentes   : " + alertas.contarPendentes());
  console.log("  auditoria           : " + integridade.length + " evento(s), " + integridade.reason);
  console.log("  cofre de segredos   : " + (chaveConfigurada() ? "configurado" : "NAO configurado"));
  if (ORIGENS_PERMITIDAS.size) console.log("  telas de fora (CORS): " + [...ORIGENS_PERMITIDAS].join(", "));
  if (MARCA.personalizada) console.log("  marca               : " + MARCA.marca.nome + (MARCA.avisos.length ? " (" + MARCA.avisos.length + " aviso(s))" : ""));
  if (ponteDaInstalacao) console.log("  PONTE SEFAZ         : configurada pela instalacao (" + ponteDaInstalacao + ")");
  console.log("  nuvem (Supabase)    : " + (nuvem ? "bucket " + nuvem.bucket + ", " + (restauro.restaurado
    ? "banco restaurado (" + restauro.motivo + ")" : restauro.motivo) : "desligada, tudo so no disco"));
  if (!assinaturaConfigurada()) {
    console.log("  aviso: NUCLEO_CHAVE_AUDITORIA nao configurada; a trilha detecta adulteracao");
    console.log("         casual, mas nao a de quem tem acesso de escrita ao banco.");
  }
});

let encerrando = false;
async function encerrar() {
  if (encerrando) return;
  encerrando = true;
  clearInterval(relogioAgendador);
  clearInterval(relogioEntradas);
  await fila.parar();
  // O Render avisa (SIGTERM) antes de dormir ou reiniciar: a ultima copia sobe aqui.
  if (guarda) {
    try {
      await guarda.parar();
    } catch (erro) {
      console.error("nuvem: a ultima copia do banco nao subiu:", erro.message);
    }
  }
  server.close(() => { fechar(); process.exit(0); });
}
process.on("SIGINT", encerrar);
process.on("SIGTERM", encerrar);
// Iniciado por outro processo com canal IPC (demonstracao, testes): se o pai
// morrer, o servidor encerra junto em vez de ficar orfao segurando a porta.
if (process.connected) process.on("disconnect", encerrar);

export { server };
