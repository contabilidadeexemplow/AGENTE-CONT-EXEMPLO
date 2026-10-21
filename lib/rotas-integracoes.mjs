// Rotas de SIEG, Dominio e Acessorias. Montadas pelo server.mjs, como as da
// captura. As credenciais ficam no cofre (Integracoes > Configurar); a chave do
// contador no Dominio e por empresa, e vira a integrationKey guardada tambem no
// cofre. Nada disso volta pela API.

import * as acervo from "./acervo.mjs";
import { importarArquivos, limiteDoPlano, limiteDoPlanoConferido, competenciasEntre } from "./motor-captura.mjs";
import {
  ClienteSieg, ClienteDominio, ClienteAcessorias, PAPEIS_SIEG, TIPO_XML_SIEG, situacaoDoLote, regimeDaAcessorias,
  SIEG_PRODUCAO, DOMINIO_AUTH, DOMINIO_API, ACESSORIAS_PRODUCAO
} from "./externos.mjs";
import { clientes, documentos, integracoes } from "./repositorio.mjs";
import { acervoDocs, arquivos, enviosExternos } from "./repo-captura.mjs";

/** O Dominio recebe NF-e, NFC-e e CT-e por XML; a NFS-e tem leiaute proprio la. */
export const TIPOS_DOMINIO = ["NF-e", "NFC-e", "CT-e"];
const LOTE_DOMINIO = 50;
const LIMITE_GUIAS = 50;
const CACHE_OBRIGACOES_MS = 10 * 60_000;

const ultimoDia = (competencia) => {
  const [ano, mes] = competencia.split("-").map(Number);
  return competencia + "-" + String(new Date(Date.UTC(ano, mes, 0)).getUTCDate()).padStart(2, "0");
};
const lerToken = (texto) => { try { return texto ? JSON.parse(texto) : null; } catch { return null; } };

// ------------------------------------------------------------ clientes HTTP
// O endereco de cada API pode ser trocado por variavel de ambiente (simuladores
// dos testes); o token do dia (SIEG e Dominio) fica no cofre, para sobreviver
// ao servidor que dorme.

function clienteSieg(env) {
  const c = integracoes.config("sieg");
  return new ClienteSieg({
    base: env.NUCLEO_SIEG_BASE || SIEG_PRODUCAO, clientId: c.clientId, secretKey: c.secretKey, apiKey: c.apiKey,
    intervaloMs: env.NUCLEO_SIEG_INTERVALO_MS !== undefined ? Number(env.NUCLEO_SIEG_INTERVALO_MS) : 31_000,
    tokenGuardado: lerToken(c._token),
    guardarToken: (token) => integracoes.salvar("sieg", { _token: JSON.stringify(token) }, "sistema")
  });
}

function clienteDominio(env) {
  const c = integracoes.config("dominio");
  return new ClienteDominio({
    authUrl: env.NUCLEO_DOMINIO_AUTH || DOMINIO_AUTH, base: env.NUCLEO_DOMINIO_BASE || DOMINIO_API,
    clientId: c.clientId, clientSecret: c.clientSecret, tokenGuardado: lerToken(c._token),
    guardarToken: (token) => integracoes.salvar("dominio", { _token: JSON.stringify(token) }, "sistema")
  });
}

function clienteAcessorias(env) {
  const c = integracoes.config("acessorias");
  return new ClienteAcessorias({ base: env.NUCLEO_ACESSORIAS_BASE || ACESSORIAS_PRODUCAO, token: c.token,
    esperaMs: env.NUCLEO_ACESSORIAS_ESPERA_MS !== undefined ? Number(env.NUCLEO_ACESSORIAS_ESPERA_MS) : 2000 });
}

export function criarRotasIntegracoes(ctx) {
  const { json, body, auth, exigir, auditar, configuracaoCaptura, executarVigilancia, env = process.env } = ctx;

  const chaveDominio = (cliente) => integracoes.config("dominio")["empresa:" + cliente.cnpjDigits] || null;
  const http = (erro) => (erro.autenticacao || erro.definitivo ? 422 : erro.transitorio ? 503 : 502);

  /** XML guardados de uma empresa numa competencia, dos tipos pedidos. */
  async function xmlsDaCompetencia(cliente, competencia, tipos) {
    const { documentos: lista } = acervoDocs.buscar({ clienteId: cliente.id, competencia, pagina: 1, porPagina: 5000 });
    const saida = [];
    for (const item of lista) {
      const documento = documentos.porId(item.id);
      if (!documento || !tipos.includes(documento.kind)) continue;
      const xml = arquivos.doDocumento(item.id).xml;
      if (!xml) continue;
      saida.push({ documento, nome: (documento.key || documento.id) + ".xml", bytes: await acervo.ler(xml.caminho) });
    }
    return saida;
  }

  // --------------------------------------------------------------------- SIEG

  const baixasSieg = new Map();

  async function baixarDoSieg({ cliente, de, ate, tipos, usuario, estado }) {
    const sieg = clienteSieg(env);
    const meses = competenciasEntre(de, ate, 12).reverse();
    const passos = meses.flatMap((mes) => tipos.flatMap((tipo) => PAPEIS_SIEG[tipo].map((campo) => ({ mes, tipo, campo }))));
    estado.total = passos.length;
    const resumo = { meses: meses.length, chamadas: 0, xmls: 0, novos: 0, duplicados: 0, recusados: 0, eventos: 0, porTipo: {} };
    for (const passo of passos) {
      for (let pagina = 0; pagina < 40; pagina += 1) {
        const xmls = await sieg.baixarXmls({ tipo: passo.tipo, campoCnpj: passo.campo, cnpj: cliente.cnpjDigits,
          de: passo.mes + "-01", ate: ultimoDia(passo.mes), skip: pagina * 50 });
        resumo.chamadas += 1;
        if (xmls.length) {
          resumo.xmls += xmls.length;
          const r = await importarArquivos({
            clienteId: cliente.id, usuario, origem: "sieg", fonte: "SIEG", configuracao: configuracaoCaptura(),
            arquivos: xmls.map((bytes, i) => ({ nome: "sieg-" + passo.tipo + "-" + passo.mes + "-" + (pagina * 50 + i + 1) + ".xml", bytes }))
          });
          resumo.novos += r.novos;
          resumo.duplicados += r.duplicados;
          resumo.recusados += r.recusados;
          resumo.eventos += r.eventos;
          if (r.novos) resumo.porTipo[passo.tipo] = (resumo.porTipo[passo.tipo] || 0) + r.novos;
        }
        if (xmls.length < 50) break;
      }
      estado.feitos += 1;
    }
    return resumo;
  }

  async function enviarAoSieg({ cliente, competencia, usuario }) {
    const sieg = clienteSieg(env);
    const lista = await xmlsDaCompetencia(cliente, competencia, Object.keys(TIPO_XML_SIEG));
    const recusas = [];
    let aceitos = 0;
    for (const item of lista) {
      const r = await sieg.enviarXml(item.bytes);
      if (r.ok) aceitos += 1;
      else recusas.push({ arquivo: item.nome, motivo: r.mensagem });
    }
    return enviosExternos.registrar({
      destino: "SIEG", clienteId: cliente.id, competencia, arquivos: lista.length, aceitos, recusados: recusas.length,
      situacao: recusas.length && !aceitos ? "erro" : "enviado", detalhe: recusas.length ? { recusas: recusas.slice(0, 100) } : null, usuario
    });
  }

  // ------------------------------------------------------------------ Dominio

  async function enviarAoDominio({ cliente, competencia, usuario, boxe = false }) {
    const integrationKey = chaveDominio(cliente);
    if (!integrationKey) throw Object.assign(new Error("Ative a empresa no Dominio com a chave do contador antes de enviar"), { definitivo: true });
    const dominio = clienteDominio(env);
    const lista = await xmlsDaCompetencia(cliente, competencia, TIPOS_DOMINIO);
    if (!lista.length) throw Object.assign(new Error("Nenhum XML de NF-e, NFC-e ou CT-e nesta competencia"), { definitivo: true });
    const lotes = [];
    for (let i = 0; i < lista.length; i += LOTE_DOMINIO) {
      const parte = lista.slice(i, i + LOTE_DOMINIO);
      try {
        const r = await dominio.enviarLote(integrationKey, parte, { boxe });
        lotes.push(enviosExternos.registrar({
          destino: "DOMINIO", clienteId: cliente.id, competencia, lote: r.id ? String(r.id) : null, arquivos: parte.length,
          situacao: r.id ? "aguardando" : situacaoDoLote(r.resposta), detalhe: { resposta: r.resposta }, usuario
        }));
      } catch (erro) {
        if (erro.autenticacao) throw erro;
        lotes.push(enviosExternos.registrar({
          destino: "DOMINIO", clienteId: cliente.id, competencia, arquivos: parte.length, recusados: parte.length,
          situacao: "erro", detalhe: { erro: erro.message }, usuario
        }));
      }
    }
    return lotes;
  }

  /** Pergunta ao Dominio pelos lotes ainda aguardando. */
  async function conferirLotesDominio(clienteId = null) {
    const pendentes = enviosExternos.listar({ destino: "DOMINIO", situacao: "aguardando", clienteId, limite: 100 })
      .filter((item) => item.lote);
    if (!pendentes.length) return [];
    const dominio = clienteDominio(env);
    const saida = [];
    for (const envio of pendentes) {
      const cliente = clientes.porId(envio.clientId);
      const integrationKey = cliente && chaveDominio(cliente);
      if (!integrationKey) continue;
      try {
        const resposta = await dominio.consultarLote(integrationKey, envio.lote);
        const situacao = situacaoDoLote(resposta);
        saida.push(enviosExternos.atualizar(envio.id, { situacao, detalhe: { ...(envio.detalhe || {}), consulta: resposta } }));
      } catch (erro) {
        if (erro.autenticacao) throw erro;
        saida.push({ ...envio, erroConsulta: erro.message });
      }
    }
    return saida;
  }

  // --------------------------------------------------------------- Acessorias

  let cacheObrigacoes = null;

  /** Resumo de obrigacoes por empresa da Acessorias, ligado ao cliente do NUCLEO pelo CNPJ. */
  async function obrigacoesDaCarteira({ renovar = false } = {}) {
    if (!renovar && cacheObrigacoes && cacheObrigacoes.ate > Date.now()) return cacheObrigacoes.dados;
    const empresas = await clienteAcessorias(env).todasAsEmpresas({ obrigacoes: true });
    const nossos = new Map(clientes.listar().map((item) => [item.cnpjDigits, item]));
    const numero = (valor) => Number(valor) || 0;
    const linhas = empresas.map((empresa) => {
      const cnpj = String(empresa.Identificador || "").replace(/\D/g, "");
      const ativas = (empresa.Obrigacoes || []).filter((item) => !/inativa/i.test(item.Status || ""));
      const cliente = nossos.get(cnpj) || null;
      return {
        cnpj, razao: empresa.Razao || empresa.Fantasia || cnpj, regime: empresa.Regime || null, status: empresa.Status || null,
        clientId: cliente?.id || null, clientName: cliente?.name || null,
        atrasadas: ativas.reduce((s, item) => s + numero(item.Atrasadas), 0),
        proximos30: ativas.reduce((s, item) => s + numero(item.Proximos30D), 0),
        entregues: ativas.reduce((s, item) => s + numero(item.Entregues), 0),
        obrigacoes: ativas.filter((item) => numero(item.Atrasadas) || numero(item.Proximos30D))
          .map((item) => ({ nome: item.Nome, atrasadas: numero(item.Atrasadas), proximos30: numero(item.Proximos30D) }))
      };
    }).sort((a, b) => b.atrasadas - a.atrasadas || b.proximos30 - a.proximos30 || a.razao.localeCompare(b.razao));
    const dados = { empresas: linhas, consultadoEm: new Date().toISOString() };
    cacheObrigacoes = { dados, ate: Date.now() + CACHE_OBRIGACOES_MS };
    return dados;
  }

  /** Cadastra no NUCLEO as empresas ativas da Acessorias que faltam, respeitando o plano. */
  async function trazerEmpresasDaAcessorias() {
    const empresas = await clienteAcessorias(env).todasAsEmpresas();
    let plano = await limiteDoPlanoConferido(configuracaoCaptura());
    const nossos = new Set(clientes.listar().map((item) => item.cnpjDigits));
    const criadas = [];
    const jaExistiam = [];
    const ignoradas = [];
    for (const empresa of empresas) {
      const cnpj = String(empresa.Identificador || "").replace(/\D/g, "");
      const nome = String(empresa.Razao || empresa.Fantasia || "").trim().toUpperCase();
      if (cnpj.length !== 14) { ignoradas.push({ identificador: empresa.Identificador, motivo: "CPF ou identificador sem CNPJ" }); continue; }
      if (/inativ/i.test(empresa.Status || "")) { ignoradas.push({ identificador: empresa.Identificador, motivo: "inativa na Acessorias" }); continue; }
      if (nossos.has(cnpj)) { jaExistiam.push({ cnpj, nome }); continue; }
      if (plano.cheio) { ignoradas.push({ identificador: empresa.Identificador, motivo: "limite do plano" }); continue; }
      const regime = regimeDaAcessorias(empresa.Regime);
      const cliente = clientes.criar({ cnpj, name: nome || cnpj, ...(regime ? { taxRegime: regime } : {}), modules: ["Federal", "Servicos"] });
      nossos.add(cnpj);
      criadas.push({ id: cliente.id, cnpj, nome: cliente.name, regime: cliente.taxRegime });
      plano = limiteDoPlano();
    }
    cacheObrigacoes = null;
    return { naAcessorias: empresas.length, criadas, jaExistiam, ignoradas };
  }

  // -------------------------------------------------------------------- rotas

  const empresaOu404 = (res, id) => {
    const cliente = clientes.porId(id);
    if (!cliente) json(res, 404, { error: "Empresa nao encontrada" });
    return cliente;
  };
  const competenciaValida = (valor) => /^\d{4}-\d{2}$/.test(String(valor || ""));

  return [
    // Situacao das tres integracoes para uma empresa: o que esta ligado e o que ja foi enviado.
    ["GET", /^\/api\/integracoes\/empresas\/([^/]+)$/, (req, res, match) => {
      if (!auth(req, res)) return;
      const cliente = empresaOu404(res, match[1]);
      if (!cliente) return;
      const chaves = integracoes.todasAsChaves();
      const pronto = (nome, requisitos) => requisitos.every((chave) => chaves[nome]?.[chave]);
      json(res, 200, {
        sieg: { configurado: pronto("sieg", ["clientId", "secretKey", "apiKey"]), baixa: baixasSieg.get(cliente.id) || null },
        dominio: { configurado: pronto("dominio", ["clientId", "clientSecret"]), ativada: Boolean(chaves.dominio?.["empresa:" + cliente.cnpjDigits]) },
        acessorias: { configurado: pronto("acessorias", ["token"]) },
        envios: enviosExternos.listar({ clienteId: cliente.id, limite: 30 })
      });
    }],

    ["GET", /^\/api\/integracoes\/envios$/, (req, res) => {
      if (!auth(req, res)) return;
      const url = new URL(req.url, "http://local");
      json(res, 200, enviosExternos.listar({ destino: url.searchParams.get("destino") || null, limite: 300 }));
    }],

    // SIEG: baixar um periodo (em segundo plano: 2 consultas por minuto).
    ["POST", /^\/api\/integracoes\/sieg\/empresas\/([^/]+)\/baixar$/, async (req, res, match) => {
      const atual = exigir(req, res, "import");
      if (!atual) return;
      const cliente = empresaOu404(res, match[1]);
      if (!cliente) return;
      const input = await body(req);
      const tipos = (Array.isArray(input.tipos) && input.tipos.length ? input.tipos : Object.keys(PAPEIS_SIEG));
      if (tipos.some((tipo) => !PAPEIS_SIEG[tipo])) return json(res, 422, { error: "Tipo invalido: use " + Object.keys(PAPEIS_SIEG).join(", ") });
      try {
        competenciasEntre(input.de, input.ate, 12);
      } catch (erro) {
        return json(res, 422, { error: erro.message });
      }
      const andamento = baixasSieg.get(cliente.id);
      if (andamento?.situacao === "executando") return json(res, 409, { error: "Ja ha uma baixa do SIEG em andamento para esta empresa", baixa: andamento });
      const estado = { situacao: "executando", de: input.de, ate: input.ate, tipos, feitos: 0, total: 0,
        iniciadaEm: new Date().toISOString(), resumo: null, erro: null };
      baixasSieg.set(cliente.id, estado);
      auditar(atual, "Baixa do SIEG pedida", cliente.id, { de: input.de, ate: input.ate, tipos });
      baixarDoSieg({ cliente, de: input.de, ate: input.ate, tipos, usuario: atual.email, estado })
        .then((resumo) => {
          estado.situacao = "concluida";
          estado.resumo = resumo;
          auditar({ email: atual.email }, "Notas baixadas do SIEG", cliente.id, { de: input.de, ate: input.ate, ...resumo });
          executarVigilancia();
        })
        .catch((erro) => { estado.situacao = "falhou"; estado.erro = erro.message; });
      json(res, 202, estado);
    }],

    ["GET", /^\/api\/integracoes\/sieg\/empresas\/([^/]+)\/baixar$/, (req, res, match) => {
      if (!auth(req, res)) return;
      json(res, 200, baixasSieg.get(match[1]) || { situacao: "nenhuma" });
    }],

    ["POST", /^\/api\/integracoes\/sieg\/empresas\/([^/]+)\/enviar$/, async (req, res, match) => {
      const atual = exigir(req, res, "import");
      if (!atual) return;
      const cliente = empresaOu404(res, match[1]);
      if (!cliente) return;
      const { competencia } = await body(req);
      if (!competenciaValida(competencia)) return json(res, 422, { error: "Competencia invalida: use AAAA-MM" });
      try {
        const envio = await enviarAoSieg({ cliente, competencia, usuario: atual.email });
        auditar(atual, "XML enviados ao SIEG", cliente.id, { competencia, arquivos: envio.arquivos, aceitos: envio.aceitos, recusados: envio.recusados });
        json(res, 200, envio);
      } catch (erro) {
        json(res, http(erro), { error: erro.message });
      }
    }],

    // Dominio: ativar a empresa com a chave do contador (digitada pela pessoa; vira a integrationKey no cofre).
    ["POST", /^\/api\/integracoes\/dominio\/empresas\/([^/]+)\/ativar$/, async (req, res, match) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      const cliente = empresaOu404(res, match[1]);
      if (!cliente) return;
      const chave = String((await body(req)).chaveContador || "").trim();
      if (!chave) return json(res, 422, { error: "Informe a chave que o contador gerou no Onvio para este CNPJ" });
      try {
        const dominio = clienteDominio(env);
        const info = await dominio.infoDaChave(chave);
        const cnpjDaChave = JSON.stringify(info || "").match(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/)?.[0]?.replace(/\D/g, "") || null;
        if (cnpjDaChave && cnpjDaChave !== cliente.cnpjDigits) {
          return json(res, 422, { error: "Esta chave e do CNPJ " + cnpjDaChave + ", nao de " + cliente.cnpj + ". Confira com o contador.", info });
        }
        const { integrationKey } = await dominio.ativar(chave);
        integracoes.salvar("dominio", { ["empresa:" + cliente.cnpjDigits]: integrationKey }, atual.email);
        auditar(atual, "Empresa ativada no Dominio", cliente.id, { cnpjConfere: Boolean(cnpjDaChave) });
        json(res, 200, { ativada: true, info });
      } catch (erro) {
        json(res, http(erro), { error: erro.message });
      }
    }],

    ["POST", /^\/api\/integracoes\/dominio\/empresas\/([^/]+)\/desativar$/, async (req, res, match) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      const cliente = empresaOu404(res, match[1]);
      if (!cliente) return;
      integracoes.salvar("dominio", { ["empresa:" + cliente.cnpjDigits]: "" }, atual.email);
      auditar(atual, "Empresa desligada do Dominio", cliente.id, {});
      json(res, 200, { ativada: false });
    }],

    ["POST", /^\/api\/integracoes\/dominio\/empresas\/([^/]+)\/enviar$/, async (req, res, match) => {
      const atual = exigir(req, res, "import");
      if (!atual) return;
      const cliente = empresaOu404(res, match[1]);
      if (!cliente) return;
      const input = await body(req);
      if (!competenciaValida(input.competencia)) return json(res, 422, { error: "Competencia invalida: use AAAA-MM" });
      try {
        const lotes = await enviarAoDominio({ cliente, competencia: input.competencia, usuario: atual.email, boxe: input.boxe === true });
        auditar(atual, "XML enviados ao Dominio", cliente.id, { competencia: input.competencia, lotes: lotes.length,
          arquivos: lotes.reduce((s, item) => s + item.arquivos, 0) });
        json(res, 200, { lotes });
      } catch (erro) {
        json(res, http(erro), { error: erro.message });
      }
    }],

    ["POST", /^\/api\/integracoes\/dominio\/lotes\/conferir$/, async (req, res) => {
      const atual = exigir(req, res, "import");
      if (!atual) return;
      try {
        const lotes = await conferirLotesDominio((await body(req)).clientId || null);
        json(res, 200, { conferidos: lotes.length, lotes });
      } catch (erro) {
        json(res, http(erro), { error: erro.message });
      }
    }],

    // Acessorias: obrigacoes da carteira, entregas de uma empresa, cadastro e guias.
    ["GET", /^\/api\/integracoes\/acessorias\/obrigacoes$/, async (req, res) => {
      if (!auth(req, res)) return;
      try {
        json(res, 200, await obrigacoesDaCarteira({ renovar: new URL(req.url, "http://local").searchParams.has("renovar") }));
      } catch (erro) {
        json(res, http(erro), { error: erro.message });
      }
    }],

    ["GET", /^\/api\/integracoes\/acessorias\/empresas\/([^/]+)\/entregas$/, async (req, res, match) => {
      if (!auth(req, res)) return;
      const cliente = empresaOu404(res, match[1]);
      if (!cliente) return;
      const url = new URL(req.url, "http://local");
      const hoje = new Date();
      const mes = hoje.getFullYear() + "-" + String(hoje.getMonth() + 1).padStart(2, "0");
      const de = url.searchParams.get("de") || mes + "-01";
      const ate = url.searchParams.get("ate") || ultimoDia(mes);
      if (![de, ate].every((data) => /^\d{4}-\d{2}-\d{2}$/.test(data))) return json(res, 422, { error: "Datas invalidas: use AAAA-MM-DD" });
      try {
        const entregas = await clienteAcessorias(env).entregas(cliente.cnpjDigits, { de, ate });
        json(res, 200, {
          de, ate,
          entregas: entregas.map((item) => ({
            nome: item.Nome, prazo: item.EntDtPrazo, entrega: item.EntDtEntrega && !/^0000/.test(item.EntDtEntrega) ? item.EntDtEntrega : null,
            status: item.Status, multa: item.EntMulta === "S", guiaLida: item.EntGuiaLida || null,
            departamento: item.Config?.DptoNome || null, responsavel: item.RespEntrega || item.Config?.RespPrazo || null
          }))
        });
      } catch (erro) {
        json(res, http(erro), { error: erro.message });
      }
    }],

    ["POST", /^\/api\/integracoes\/acessorias\/empresas\/trazer$/, async (req, res) => {
      const atual = exigir(req, res, "config");
      if (!atual) return;
      try {
        const r = await trazerEmpresasDaAcessorias();
        auditar(atual, "Empresas trazidas da Acessorias", "acessorias", {
          naAcessorias: r.naAcessorias, criadas: r.criadas.map((item) => item.cnpj), jaExistiam: r.jaExistiam.length, ignoradas: r.ignoradas.length
        });
        executarVigilancia();
        json(res, 200, r);
      } catch (erro) {
        json(res, http(erro), { error: erro.message });
      }
    }],

    ["POST", /^\/api\/integracoes\/acessorias\/guias$/, async (req, res) => {
      const atual = exigir(req, res, "import");
      if (!atual) return;
      const input = await body(req);
      const lista = Array.isArray(input.arquivos) ? input.arquivos : null;
      if (!lista?.length) return json(res, 422, { error: "Envie arquivos: [{ nome, conteudoBase64 }] em PDF" });
      if (lista.length > LIMITE_GUIAS) return json(res, 422, { error: "Maximo de " + LIMITE_GUIAS + " guias por envio" });
      const guias = lista.map((item) => ({ nome: String(item.nome || "guia.pdf").split(/[\\/]/).pop().slice(0, 200),
        bytes: Buffer.from(String(item.conteudoBase64 || ""), "base64") }));
      const naoPdf = guias.find((item) => item.bytes.subarray(0, 5).toString("latin1") !== "%PDF-");
      if (naoPdf) return json(res, 422, { error: "So PDF: " + naoPdf.nome + " nao e um PDF" });
      try {
        const acessorias = clienteAcessorias(env);
        const resultados = [];
        for (const guia of guias) resultados.push({ arquivo: guia.nome, ...(await acessorias.enviarGuia(guia)) });
        const aceitos = resultados.filter((item) => item.ok).length;
        const envio = enviosExternos.registrar({
          destino: "ACESSORIAS", arquivos: guias.length, aceitos, recusados: guias.length - aceitos,
          situacao: aceitos === guias.length ? "processado" : aceitos ? "parcial" : "erro", detalhe: { resultados }, usuario: atual.email
        });
        auditar(atual, "Guias enviadas a Acessorias", "acessorias", { arquivos: guias.length, aceitos });
        json(res, 200, { envio, resultados });
      } catch (erro) {
        json(res, http(erro), { error: erro.message });
      }
    }]
  ];
}

/** Teste de conexao de cada uma, sem gravar nada fora. */
export async function testarExterno(nome, { env = process.env } = {}) {
  if (nome === "sieg") {
    const sieg = clienteSieg(env);
    await sieg.jwt();
    const hoje = new Date();
    const inicio = new Date(Date.UTC(hoje.getFullYear(), hoje.getMonth() - 1, 1)).toISOString().slice(0, 10);
    const contagem = await sieg.contar({ de: inicio, ate: hoje.toISOString().slice(0, 10) });
    return { mensagem: "SIEG conectado: token gerado e a API Key aceita.\nXML no cofre do SIEG desde " + inicio.split("-").reverse().join("/") +
      ": " + (Object.entries(contagem || {}).map(([tipo, n]) => tipo + " " + n).join(", ") || "nenhum") + ".", resumo: contagem };
  }
  if (nome === "dominio") {
    await clienteDominio(env).accessToken();
    const ativadas = Object.keys(integracoes.config("dominio")).filter((chave) => chave.startsWith("empresa:")).length;
    return { mensagem: "Dominio conectado: token do dia valido (um por dia, guardado no cofre).\n" + ativadas +
      " empresa(s) ativada(s) com a chave do contador.", resumo: { ativadas } };
  }
  if (nome === "acessorias") {
    const pagina = await clienteAcessorias(env).empresas(1);
    const nossos = new Set(clientes.listar().map((item) => item.cnpjDigits));
    const aqui = pagina.filter((item) => nossos.has(String(item.Identificador || "").replace(/\D/g, ""))).length;
    return { mensagem: "Acessorias conectada: API Token aceito.\nPrimeira pagina: " + pagina.length + " empresa(s), " + aqui +
      " tambem no NUCLEO.", resumo: { primeiraPagina: pagina.length, noNucleo: aqui } };
  }
  return null;
}
