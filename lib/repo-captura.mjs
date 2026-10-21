// Acesso a dados da captura automatica: certificados A1, configuracao por
// empresa, cursores, agendamentos, fila, rastreio de NSU, pendencias, arquivos,
// eventos, espelho de pastas e tokens do agente local.

import crypto from "node:crypto";
import { bd, transacao, paraJson, deJson, paraBool, deBool } from "./banco.mjs";
import { cifrar, decifrar } from "./segredos.mjs";
import { EMISSOR_NACIONAL_SIMPLES } from "./simples.mjs";

const agora = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

// ------------------------------------------------------------ certificados A1

function montarCertificado(linha) {
  const dias = Math.floor((new Date(linha.valido_ate + "T23:59:59Z") - Date.now()) / 86_400_000);
  return {
    id: linha.id,
    titular: linha.titular,
    titularCnpj: linha.titular_cnpj,
    raizCnpj: linha.raiz_cnpj,
    emissor: linha.emissor,
    serie: linha.serie,
    impressaoDigital: linha.impressao_digital,
    validoDe: linha.valido_de,
    validoAte: linha.valido_ate,
    diasParaVencer: dias,
    situacao: !deBool(linha.ativo) ? "Inativo" : dias < 0 ? "Vencido" : dias <= 30 ? "Vencendo" : "Valido",
    tipo: linha.tipo,
    ativo: deBool(linha.ativo),
    enviadoPor: linha.enviado_por,
    criadoEm: linha.criado_em
  };
}

export const certificadosDigitais = {
  criar(info, pfx, senha, usuario) {
    const id = uuid();
    bd().prepare(
      "INSERT INTO certificados_digitais (id,titular,titular_cnpj,raiz_cnpj,emissor,serie,impressao_digital," +
      "valido_de,valido_ate,tipo,pfx_cifrado,senha_cifrada,sha256_arquivo,enviado_por,criado_em,ativo)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)"
    ).run(id, info.titular, info.titularCnpj, info.raizCnpj, info.emissor, info.serie, info.impressaoDigital,
      info.validoDe, info.validoAte, info.tipo, cifrar(pfx.toString("base64")), cifrar(String(senha)),
      info.sha256Arquivo, usuario, agora());
    return this.porId(id);
  },

  porId(id) {
    const linha = bd().prepare("SELECT * FROM certificados_digitais WHERE id = ?").get(id);
    return linha ? montarCertificado(linha) : null;
  },

  porSha(sha) {
    const linha = bd().prepare("SELECT * FROM certificados_digitais WHERE sha256_arquivo = ?").get(sha);
    return linha ? montarCertificado(linha) : null;
  },

  listar() {
    return bd().prepare("SELECT * FROM certificados_digitais ORDER BY ativo DESC, valido_ate").all()
      .map(montarCertificado)
      .map((item) => ({ ...item, empresas: this.empresasQueUsam(item.id) }));
  },

  empresasQueUsam(id) {
    return bd().prepare(
      "SELECT c.id, c.nome, c.cnpj FROM empresas_captura e JOIN clientes c ON c.id = e.cliente_id" +
      " WHERE e.certificado_id = ? ORDER BY c.nome"
    ).all(id).map((linha) => ({ id: linha.id, name: linha.nome, cnpj: linha.cnpj }));
  },

  /** Arquivo e senha em claro, so para o handshake. Nunca devolver pela API. */
  segredo(id) {
    const linha = bd().prepare(
      "SELECT pfx_cifrado, senha_cifrada FROM certificados_digitais WHERE id = ? AND ativo = 1"
    ).get(id);
    if (!linha) return null;
    return { pfx: Buffer.from(decifrar(linha.pfx_cifrado), "base64"), senha: decifrar(linha.senha_cifrada) };
  },

  desativar(id) {
    bd().prepare("UPDATE certificados_digitais SET ativo = 0 WHERE id = ?").run(id);
  },

  vencendo(dias) {
    return bd().prepare(
      "SELECT * FROM certificados_digitais WHERE ativo = 1 AND julianday(valido_ate) - julianday('now') <= ?"
    ).all(dias).map(montarCertificado);
  }
};

// ----------------------------------------------------- configuracao por empresa

const SELECT_EMPRESA = `
  SELECT c.id, c.nome, c.cnpj, c.cnpj_digits, c.regime, c.anexo, c.modulos,
         e.modo, e.certificado_id, e.pasta_destino, e.tipos, e.fontes, e.ativa, e.atualizado_em,
         e.uf, e.manifestar_ciencia, e.documentos, e.periodo_desde, e.periodo_meses,
         cd.titular AS cert_titular, cd.titular_cnpj AS cert_cnpj, cd.valido_ate AS cert_ate, cd.ativo AS cert_ativo,
         cu.ultimo_nsu, cu.ultimo_sucesso AS ultimo_sucesso_adn,
         (SELECT max(x.ultima_consulta) FROM cursores x WHERE x.cliente_id = c.id) AS ultima_consulta,
         (SELECT max(x.ultimo_sucesso) FROM cursores x WHERE x.cliente_id = c.id) AS ultimo_sucesso,
         (SELECT json_group_object(x.fonte, x.ultimo_sucesso) FROM cursores x WHERE x.cliente_id = c.id)
           AS sucessos_por_fonte,
         (SELECT count(*) FROM documentos d WHERE d.cliente_id = c.id AND d.fonte IS NOT NULL) AS capturados,
         (SELECT count(*) FROM documentos d WHERE d.cliente_id = c.id AND d.fonte IS NOT NULL AND d.tipo = 'NFS-e'
            AND d.papel = 'emitida' AND d.competencia >= strftime('%Y-%m', 'now', 'start of month', '-3 months'))
           AS nfse_emitidas_recentes,
         (SELECT count(*) FROM documentos d WHERE d.cliente_id = c.id AND d.tipo = 'NFS-e' AND d.papel = 'emitida'
            AND (d.fonte = 'ADN' OR json_extract(d.dados, '$.standard') = 'Nacional')
            AND d.competencia >= max(strftime('%Y-%m', 'now', 'start of month', '-3 months'), '${EMISSOR_NACIONAL_SIMPLES.desde}'))
           AS nfse_nacional_recentes,
         (SELECT count(*) FROM documentos d WHERE d.cliente_id = c.id AND d.tipo = 'NFS-e' AND d.papel = 'emitida'
            AND json_extract(d.dados, '$.standard') = 'ABRASF' AND d.competencia >= '${EMISSOR_NACIONAL_SIMPLES.desde}')
           AS nfse_prefeitura_pos_obrigacao,
         (SELECT count(*) FROM pendencias p WHERE p.cliente_id = c.id AND p.situacao = 'aberta') AS pendencias,
         (SELECT situacao FROM tarefas t WHERE t.cliente_id = c.id ORDER BY t.criada_em DESC LIMIT 1) AS ultima_tarefa,
         (SELECT erro FROM tarefas t WHERE t.cliente_id = c.id ORDER BY t.criada_em DESC LIMIT 1) AS ultimo_erro
  FROM clientes c
  LEFT JOIN empresas_captura e ON e.cliente_id = c.id
  LEFT JOIN certificados_digitais cd ON cd.id = e.certificado_id
  LEFT JOIN cursores cu ON cu.cliente_id = c.id AND cu.fonte = 'ADN'
`;

function montarEmpresa(linha) {
  const diasCert = linha.cert_ate
    ? Math.floor((new Date(linha.cert_ate + "T23:59:59Z") - Date.now()) / 86_400_000)
    : null;
  return {
    clientId: linha.id,
    name: linha.nome,
    cnpj: linha.cnpj,
    cnpjDigits: linha.cnpj_digits,
    taxRegime: linha.regime,
    anexo: linha.anexo || null,
    // Presta servico: anexo III, IV ou V do Simples, ou modulo de servicos/NFS-e.
    prestaServico: ["III", "IV", "V"].includes(String(linha.anexo || "").toUpperCase()) ||
      deJson(linha.modulos, []).some((item) => /servi|nfs/i.test(String(item))),
    nfseEmitidasRecentes: linha.nfse_emitidas_recentes ?? 0,
    simples: /simples/i.test(String(linha.regime || "")),
    // So NFS-e do padrao nacional (ADN ou XML nacional importado) vale para o Simples.
    nfseNacionalRecentes: linha.nfse_nacional_recentes ?? 0,
    nfsePrefeituraPosObrigacao: linha.nfse_prefeitura_pos_obrigacao ?? 0,
    configurada: Boolean(linha.modo),
    modo: linha.modo || null,
    certificadoId: linha.certificado_id || null,
    certificado: linha.certificado_id ? {
      titular: linha.cert_titular, cnpj: linha.cert_cnpj, validoAte: linha.cert_ate,
      diasParaVencer: diasCert, ativo: deBool(linha.cert_ativo)
    } : null,
    pastaDestino: linha.pasta_destino || "",
    tipos: linha.tipos || "ambas",
    fontes: deJson(linha.fontes, ["ADN"]),
    uf: linha.uf || "",
    manifestarCiencia: deBool(linha.manifestar_ciencia),
    // Regra de busca: documentos pela PONTE (nulo = todos), comeco do periodo e meses da rotina.
    documentosPonte: deJson(linha.documentos, null),
    periodoDesde: linha.periodo_desde || null,
    periodoMeses: linha.periodo_meses ?? null,
    ativa: linha.modo ? deBool(linha.ativa) : false,
    ultimoNsu: linha.ultimo_nsu ?? 0,
    ultimaConsulta: linha.ultima_consulta || null,
    ultimoSucesso: linha.ultimo_sucesso || null,
    ultimoSucessoAdn: linha.ultimo_sucesso_adn || null,
    // A ultima captura que deu certo, fonte a fonte: a queda de faturamento so
    // julga o mes fechado depois de TODAS as fontes ligadas rodarem apos o fim dele.
    ultimoSucessoPorFonte: deJson(linha.sucessos_por_fonte, {}) || {},
    capturados: linha.capturados ?? 0,
    pendencias: linha.pendencias ?? 0,
    ultimaTarefa: linha.ultima_tarefa || null,
    ultimoErro: linha.ultima_tarefa === "erro" ? linha.ultimo_erro : null
  };
}

export const empresasCaptura = {
  listar() {
    return bd().prepare(SELECT_EMPRESA + " ORDER BY c.nome").all().map(montarEmpresa);
  },

  porCliente(clienteId) {
    const linha = bd().prepare(SELECT_EMPRESA + " WHERE c.id = ?").get(clienteId);
    return linha ? montarEmpresa(linha) : null;
  },

  ativas() {
    return bd().prepare(SELECT_EMPRESA + " WHERE e.ativa = 1 ORDER BY c.nome").all().map(montarEmpresa);
  },

  salvar(clienteId, entrada, usuario) {
    const atual = this.porCliente(clienteId);
    bd().prepare(
      "INSERT INTO empresas_captura (cliente_id,modo,certificado_id,pasta_destino,tipos,fontes,ativa,uf," +
      "manifestar_ciencia,atualizado_em,atualizado_por,documentos,periodo_desde,periodo_meses)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(cliente_id) DO UPDATE SET modo=excluded.modo," +
      " certificado_id=excluded.certificado_id, pasta_destino=excluded.pasta_destino, tipos=excluded.tipos," +
      " fontes=excluded.fontes, ativa=excluded.ativa, uf=excluded.uf, manifestar_ciencia=excluded.manifestar_ciencia," +
      " atualizado_em=excluded.atualizado_em, atualizado_por=excluded.atualizado_por, documentos=excluded.documentos," +
      " periodo_desde=excluded.periodo_desde, periodo_meses=excluded.periodo_meses"
    ).run(
      clienteId,
      entrada.modo ?? atual?.modo ?? "proprio",
      entrada.certificadoId !== undefined ? (entrada.certificadoId || null) : (atual?.certificadoId ?? null),
      entrada.pastaDestino !== undefined ? (entrada.pastaDestino || null) : (atual?.pastaDestino || null),
      entrada.tipos ?? atual?.tipos ?? "ambas",
      paraJson(entrada.fontes ?? atual?.fontes ?? ["ADN"]),
      paraBool(entrada.ativa ?? atual?.ativa ?? true),
      entrada.uf !== undefined ? (String(entrada.uf || "").toUpperCase() || null) : (atual?.uf || null),
      paraBool(entrada.manifestarCiencia ?? atual?.manifestarCiencia ?? false),
      agora(), usuario,
      // undefined mantem; null (ou lista vazia) volta ao padrao.
      entrada.documentosPonte !== undefined
        ? (entrada.documentosPonte?.length ? paraJson(entrada.documentosPonte) : null)
        : (atual?.documentosPonte?.length ? paraJson(atual.documentosPonte) : null),
      entrada.periodoDesde !== undefined ? (entrada.periodoDesde || null) : (atual?.periodoDesde || null),
      entrada.periodoMeses !== undefined ? (entrada.periodoMeses || null) : (atual?.periodoMeses ?? null)
    );
    return this.porCliente(clienteId);
  }
};

// ------------------------------------------------------------------- cursores

export const cursores = {
  ler(clienteId, fonte) {
    const linha = bd().prepare("SELECT * FROM cursores WHERE cliente_id = ? AND fonte = ?").get(clienteId, fonte);
    return linha
      ? { ultimoNsu: linha.ultimo_nsu, maiorNsu: linha.maior_nsu, ultimaConsulta: linha.ultima_consulta,
          ultimoSucesso: linha.ultimo_sucesso, bloqueadoAte: linha.bloqueado_ate }
      : { ultimoNsu: 0, maiorNsu: 0, ultimaConsulta: null, ultimoSucesso: null, bloqueadoAte: null };
  },

  avancar(clienteId, fonte, nsu) {
    bd().prepare(
      "INSERT INTO cursores (cliente_id,fonte,ultimo_nsu,maior_nsu,ultima_consulta) VALUES (?,?,?,?,?)" +
      " ON CONFLICT(cliente_id,fonte) DO UPDATE SET ultimo_nsu = max(cursores.ultimo_nsu, excluded.ultimo_nsu)," +
      " maior_nsu = max(cursores.maior_nsu, excluded.maior_nsu), ultima_consulta = excluded.ultima_consulta"
    ).run(clienteId, fonte, nsu, nsu, agora());
  },

  marcarSucesso(clienteId, fonte) {
    bd().prepare(
      "INSERT INTO cursores (cliente_id,fonte,ultima_consulta,ultimo_sucesso) VALUES (?,?,?,?)" +
      " ON CONFLICT(cliente_id,fonte) DO UPDATE SET ultima_consulta = excluded.ultima_consulta," +
      " ultimo_sucesso = excluded.ultimo_sucesso"
    ).run(clienteId, fonte, agora(), agora());
  },

  zerar(clienteId, fonte) {
    bd().prepare("UPDATE cursores SET ultimo_nsu = 0 WHERE cliente_id = ? AND fonte = ?").run(clienteId, fonte);
  },

  /** SEFAZ: proxima consulta so depois deste instante (ms), sob pena de bloqueio 656. */
  bloquear(clienteId, fonte, ate) {
    bd().prepare(
      "INSERT INTO cursores (cliente_id,fonte,bloqueado_ate,ultima_consulta) VALUES (?,?,?,?)" +
      " ON CONFLICT(cliente_id,fonte) DO UPDATE SET bloqueado_ate = excluded.bloqueado_ate," +
      " ultima_consulta = excluded.ultima_consulta"
    ).run(clienteId, fonte, ate, agora());
  },

  /** Um por fonte, para o painel da empresa. */
  daEmpresa(clienteId) {
    return bd().prepare("SELECT * FROM cursores WHERE cliente_id = ? ORDER BY fonte").all(clienteId)
      .map((linha) => ({
        fonte: linha.fonte, ultimoNsu: linha.ultimo_nsu, maiorNsu: linha.maior_nsu,
        ultimaConsulta: linha.ultima_consulta, ultimoSucesso: linha.ultimo_sucesso,
        bloqueadoAte: linha.bloqueado_ate && linha.bloqueado_ate > Date.now()
          ? new Date(linha.bloqueado_ate).toISOString() : null
      }));
  }
};

// ---------------------------------------------------- manifestacao do destinatario

function montarManifestacao(linha) {
  return {
    id: linha.id,
    clientId: linha.cliente_id,
    chave: linha.chave,
    tipoEvento: linha.tipo_evento,
    situacao: linha.situacao,
    protocolo: linha.protocolo,
    cStat: linha.cstat,
    motivo: linha.motivo,
    origem: linha.origem,
    enviadaEm: linha.enviada_em,
    enviadaPor: linha.enviada_por,
    caminhoXml: linha.caminho_xml,
    tentativas: linha.tentativas
  };
}

export const manifestacoes = {
  /** Uma linha por nota e tipo de evento; reenvio atualiza e conta tentativa. */
  registrar({ clienteId, chave, tipoEvento, situacao, protocolo = null, cStat = null, motivo = null, origem,
    usuario = null, caminho = null, sha256 = null }) {
    bd().prepare(
      "INSERT INTO manifestacoes (id,cliente_id,chave,tipo_evento,situacao,protocolo,cstat,motivo,origem,enviada_em," +
      "enviada_por,caminho_xml,sha256,tentativas) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)" +
      " ON CONFLICT(cliente_id,chave,tipo_evento) DO UPDATE SET situacao = excluded.situacao," +
      " protocolo = coalesce(excluded.protocolo, manifestacoes.protocolo), cstat = excluded.cstat," +
      " motivo = excluded.motivo, origem = excluded.origem, enviada_em = excluded.enviada_em," +
      " enviada_por = excluded.enviada_por, caminho_xml = coalesce(excluded.caminho_xml, manifestacoes.caminho_xml)," +
      " sha256 = coalesce(excluded.sha256, manifestacoes.sha256), tentativas = manifestacoes.tentativas + 1"
    ).run(crypto.randomUUID(), clienteId, chave, tipoEvento, situacao, protocolo, cStat, motivo, origem, agora(), usuario,
      caminho, sha256);
    return this.porChave(clienteId, chave, tipoEvento);
  },

  porChave(clienteId, chave, tipoEvento = "210210") {
    const linha = bd().prepare(
      "SELECT * FROM manifestacoes WHERE cliente_id = ? AND chave = ? AND tipo_evento = ?"
    ).get(clienteId, chave, tipoEvento);
    return linha ? montarManifestacao(linha) : null;
  },

  listar({ clienteId = null, limite = 500 } = {}) {
    const linhas = clienteId
      ? bd().prepare("SELECT * FROM manifestacoes WHERE cliente_id = ? ORDER BY enviada_em DESC LIMIT ?").all(clienteId, limite)
      : bd().prepare("SELECT * FROM manifestacoes ORDER BY enviada_em DESC LIMIT ?").all(limite);
    return linhas.map(montarManifestacao);
  }
};

// --------------------------------------------------------------- agendamentos

function montarAgendamento(linha) {
  return {
    id: linha.id,
    clientId: linha.cliente_id,
    clientName: linha.cliente_nome || null,
    nome: linha.nome,
    frequencia: linha.frequencia,
    diaMes: linha.dia_mes,
    diaSemana: linha.dia_semana,
    hora: linha.hora,
    minuto: linha.minuto,
    revarreduras: deJson(linha.revarreduras, []),
    ativo: deBool(linha.ativo),
    soCopiar: deBool(linha.so_copiar),
    criadoEm: linha.criado_em,
    criadoPor: linha.criado_por
  };
}

export const agendamentos = {
  listar() {
    return bd().prepare(
      "SELECT a.*, c.nome AS cliente_nome FROM agendamentos a LEFT JOIN clientes c ON c.id = a.cliente_id" +
      " ORDER BY a.criado_em"
    ).all().map(montarAgendamento);
  },

  ativos() {
    return this.listar().filter((item) => item.ativo);
  },

  porId(id) {
    const linha = bd().prepare(
      "SELECT a.*, c.nome AS cliente_nome FROM agendamentos a LEFT JOIN clientes c ON c.id = a.cliente_id WHERE a.id = ?"
    ).get(id);
    return linha ? montarAgendamento(linha) : null;
  },

  criar(entrada, usuario) {
    const id = uuid();
    bd().prepare(
      "INSERT INTO agendamentos (id,cliente_id,nome,frequencia,dia_mes,dia_semana,hora,minuto,revarreduras,ativo,criado_em," +
      "criado_por,so_copiar) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(id, entrada.clientId || null, entrada.nome, entrada.frequencia,
      entrada.diaMes ?? null, entrada.diaSemana ?? null, entrada.hora ?? 6, entrada.minuto ?? 0,
      paraJson(entrada.revarreduras ?? []), paraBool(entrada.ativo ?? true), agora(), usuario, paraBool(entrada.soCopiar ?? false));
    return this.porId(id);
  },

  atualizar(id, entrada) {
    const atual = this.porId(id);
    if (!atual) return null;
    const novo = { ...atual, ...entrada };
    bd().prepare(
      "UPDATE agendamentos SET cliente_id=?, nome=?, frequencia=?, dia_mes=?, dia_semana=?, hora=?, minuto=?," +
      " revarreduras=?, ativo=?, so_copiar=? WHERE id=?"
    ).run(novo.clientId || null, novo.nome, novo.frequencia, novo.diaMes ?? null, novo.diaSemana ?? null,
      novo.hora, novo.minuto, paraJson(novo.revarreduras || []), paraBool(novo.ativo), paraBool(novo.soCopiar), id);
    return this.porId(id);
  },

  remover(id) {
    bd().prepare("DELETE FROM agendamentos WHERE id = ?").run(id);
  }
};

// --------------------------------------------------------------------- tarefas

function montarTarefa(linha) {
  return {
    id: linha.id,
    clientId: linha.cliente_id,
    clientName: linha.cliente_nome || null,
    fonte: linha.fonte,
    origem: linha.origem,
    competencia: linha.competencia,
    prioridade: linha.prioridade,
    situacao: linha.situacao,
    tentativas: linha.tentativas,
    maxTentativas: linha.max_tentativas,
    proximaTentativa: linha.proxima_tentativa ? new Date(linha.proxima_tentativa).toISOString() : null,
    iniciadaEm: linha.iniciada_em,
    concluidaEm: linha.concluida_em,
    erro: linha.erro,
    resumo: deJson(linha.resumo),
    agendamentoId: linha.agendamento_id,
    criadaEm: linha.criada_em,
    criadaPor: linha.criada_por
  };
}

const SELECT_TAREFA = "SELECT t.*, c.nome AS cliente_nome FROM tarefas t LEFT JOIN clientes c ON c.id = t.cliente_id";

export const tarefas = {
  /** Devolve a tarefa criada, ou null quando a chave unica ja existia. */
  enfileirar({ clienteId, fonte = "ADN", origem, competencia = null, prioridade = 0, chaveUnica = null,
    agendamentoId = null, usuario = null, maxTentativas = 5, aPartirDe = 0 }) {
    const id = uuid();
    const resultado = bd().prepare(
      "INSERT OR IGNORE INTO tarefas (id,cliente_id,fonte,origem,competencia,prioridade,situacao,tentativas," +
      "max_tentativas,proxima_tentativa,chave_unica,agendamento_id,criada_em,criada_por)" +
      " VALUES (?,?,?,?,?,?,'pendente',0,?,?,?,?,?,?)"
    ).run(id, clienteId, fonte, origem, competencia, prioridade, maxTentativas, aPartirDe, chaveUnica, agendamentoId,
      agora(), usuario);
    return Number(resultado.changes) ? this.porId(id) : null;
  },

  /** Ja existe tarefa nao finalizada para esta empresa e fonte? */
  emAberto(clienteId, fonte) {
    return bd().prepare(
      SELECT_TAREFA + " WHERE t.cliente_id = ? AND t.fonte = ? AND t.situacao IN ('pendente','executando')" +
      " ORDER BY t.criada_em LIMIT 1"
    ).get(clienteId, fonte);
  },

  porId(id) {
    const linha = bd().prepare(SELECT_TAREFA + " WHERE t.id = ?").get(id);
    return linha ? montarTarefa(linha) : null;
  },

  listar({ situacao, clienteId, limite = 200 } = {}) {
    const condicoes = [];
    const parametros = [];
    if (situacao) { condicoes.push("t.situacao = ?"); parametros.push(situacao); }
    if (clienteId) { condicoes.push("t.cliente_id = ?"); parametros.push(clienteId); }
    return bd().prepare(
      SELECT_TAREFA + (condicoes.length ? " WHERE " + condicoes.join(" AND ") : "") +
      " ORDER BY t.criada_em DESC LIMIT ?"
    ).all(...parametros, limite).map(montarTarefa);
  },

  /**
   * Reserva ate `limite` tarefas prontas, respeitando a trava por empresa:
   * duas tarefas da mesma empresa e fonte nunca rodam juntas.
   */
  reservar(limite) {
    return transacao((base) => {
      const prontas = base.prepare(
        "SELECT t.id, t.cliente_id, t.fonte FROM tarefas t WHERE t.situacao = 'pendente' AND t.proxima_tentativa <= ?" +
        " AND NOT EXISTS (SELECT 1 FROM tarefas x WHERE x.cliente_id = t.cliente_id AND x.fonte = t.fonte" +
        "   AND x.situacao = 'executando')" +
        " ORDER BY t.prioridade DESC, t.criada_em LIMIT ?"
      ).all(Date.now(), limite * 4);

      const escolhidas = [];
      const empresas = new Set();
      for (const linha of prontas) {
        const chave = linha.cliente_id + "|" + linha.fonte;
        if (empresas.has(chave)) continue;
        empresas.add(chave);
        base.prepare(
          "UPDATE tarefas SET situacao = 'executando', travada_em = ?, iniciada_em = coalesce(iniciada_em, ?)," +
          " tentativas = tentativas + 1 WHERE id = ? AND situacao = 'pendente'"
        ).run(Date.now(), agora(), linha.id);
        escolhidas.push(linha.id);
        if (escolhidas.length >= limite) break;
      }
      return escolhidas.map((id) => this.porId(id));
    });
  },

  concluir(id, resumo) {
    bd().prepare(
      "UPDATE tarefas SET situacao = 'concluida', concluida_em = ?, resumo = ?, erro = NULL, travada_em = NULL WHERE id = ?"
    ).run(agora(), paraJson(resumo), id);
    return this.porId(id);
  },

  /** Erro transitorio volta para a fila com espera crescente; definitivo encerra. */
  falhar(id, erro, { definitivo = false, resumo = null } = {}) {
    const tarefa = this.porId(id);
    if (!tarefa) return null;
    const esgotou = tarefa.tentativas >= tarefa.maxTentativas;
    if (definitivo || esgotou) {
      bd().prepare(
        "UPDATE tarefas SET situacao = 'erro', concluida_em = ?, erro = ?, resumo = ?, travada_em = NULL WHERE id = ?"
      ).run(agora(), String(erro), paraJson(resumo), id);
    } else {
      const esperas = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
      const espera = esperas[Math.min(tarefa.tentativas - 1, esperas.length - 1)];
      bd().prepare(
        "UPDATE tarefas SET situacao = 'pendente', proxima_tentativa = ?, erro = ?, resumo = ?, travada_em = NULL WHERE id = ?"
      ).run(Date.now() + espera, String(erro), paraJson(resumo), id);
    }
    return this.porId(id);
  },

  /**
   * A fonte pediu para esperar (janela da SEFAZ): volta para a fila marcada
   * para o instante liberado, sem gastar tentativa.
   */
  adiar(id, ate, motivo) {
    bd().prepare(
      "UPDATE tarefas SET situacao = 'pendente', proxima_tentativa = ?, erro = ?, travada_em = NULL," +
      " tentativas = max(0, tentativas - 1) WHERE id = ?"
    ).run(ate, String(motivo), id);
    return this.porId(id);
  },

  cancelar(id) {
    const resultado = bd().prepare(
      "UPDATE tarefas SET situacao = 'cancelada', concluida_em = ? WHERE id = ? AND situacao = 'pendente'"
    ).run(agora(), id);
    return Number(resultado.changes) > 0;
  },

  reprocessar(id) {
    const resultado = bd().prepare(
      "UPDATE tarefas SET situacao = 'pendente', proxima_tentativa = 0, tentativas = 0, erro = NULL," +
      " concluida_em = NULL WHERE id = ? AND situacao IN ('erro','cancelada')"
    ).run(id);
    return Number(resultado.changes) > 0;
  },

  /** Antecipa tarefas em espera (para teste e para "tentar agora"). */
  antecipar(id) {
    bd().prepare("UPDATE tarefas SET proxima_tentativa = 0 WHERE id = ? AND situacao = 'pendente'").run(id);
  },

  /** Processo morreu no meio: tarefa travada ha mais que o limite volta para a fila. */
  recuperarTravadas(limiteMs = 30 * 60_000) {
    const resultado = bd().prepare(
      "UPDATE tarefas SET situacao = 'pendente', travada_em = NULL, proxima_tentativa = 0," +
      " erro = 'retomada apos interrupcao' WHERE situacao = 'executando' AND (travada_em IS NULL OR travada_em < ?)"
    ).run(Date.now() - limiteMs);
    return Number(resultado.changes) || 0;
  },

  contagem() {
    const saida = { pendente: 0, executando: 0, concluida: 0, erro: 0, cancelada: 0 };
    for (const linha of bd().prepare("SELECT situacao, count(*) c FROM tarefas GROUP BY situacao").all()) {
      saida[linha.situacao] = linha.c;
    }
    return saida;
  }
};

// ---------------------------------------------------------------- rastreio NSU

export const rastreio = {
  registrar({ clienteId, fonte, nsu, resultado, chave = null, tipoDocumento = null, documentoId = null, tarefaId = null }) {
    bd().prepare(
      "INSERT INTO rastreio_nsu (cliente_id,fonte,nsu,resultado,chave,tipo_documento,documento_id,tarefa_id,visto_em)" +
      " VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(cliente_id,fonte,nsu) DO UPDATE SET resultado=excluded.resultado," +
      " chave=coalesce(excluded.chave, rastreio_nsu.chave), documento_id=coalesce(excluded.documento_id, rastreio_nsu.documento_id)," +
      " tarefa_id=excluded.tarefa_id, visto_em=excluded.visto_em"
    ).run(clienteId, fonte, nsu, resultado, chave, tipoDocumento, documentoId, tarefaId, agora());
  },

  /**
   * NSU que faltam entre o menor e o maior ja vistos. Como o lote sempre traz
   * os NSU seguintes em ordem, um numero pulado e o portal dizendo que ali nao
   * ha documento para este contribuinte: lacuna confirmada, nao falha nossa.
   */
  lacunas(clienteId, fonte) {
    const saltos = bd().prepare(`
      SELECT anterior + 1 AS de, nsu - 1 AS ate FROM (
        SELECT nsu, LAG(nsu) OVER (ORDER BY nsu) AS anterior
        FROM rastreio_nsu WHERE cliente_id = ? AND fonte = ?
      ) WHERE anterior IS NOT NULL AND nsu - anterior > 1
    `).all(clienteId, fonte);
    return saltos.map((linha) => ({ de: linha.de, ate: linha.ate }));
  },

  resumo(clienteId, fonte) {
    const saida = {};
    for (const linha of bd().prepare(
      "SELECT resultado, count(*) c, min(nsu) menor, max(nsu) maior FROM rastreio_nsu" +
      " WHERE cliente_id = ? AND fonte = ? GROUP BY resultado"
    ).all(clienteId, fonte)) {
      saida[linha.resultado] = linha.c;
    }
    return saida;
  }
};

// ------------------------------------------------------------------ pendencias

function montarPendencia(linha) {
  return {
    id: linha.id,
    clientId: linha.cliente_id,
    clientName: linha.cliente_nome || null,
    fonte: linha.fonte,
    tipo: linha.tipo,
    referencia: linha.referencia,
    chave: linha.chave,
    nsu: linha.nsu,
    documentoId: linha.documento_id,
    detalhe: linha.detalhe,
    dados: deJson(linha.dados, null),
    situacao: linha.situacao,
    tentativas: linha.tentativas,
    criadaEm: linha.criada_em,
    atualizadaEm: linha.atualizada_em,
    resolvidaEm: linha.resolvida_em,
    resolvidaPor: linha.resolvida_por
  };
}

export const pendencias = {
  /** Abre ou reabre. Repetir a mesma pendencia so conta tentativa. */
  abrir({ clienteId, fonte, tipo, referencia, chave = null, nsu = null, documentoId = null, detalhe = "",
    situacao = "aberta", dados = null }) {
    bd().prepare(
      "INSERT INTO pendencias (id,cliente_id,fonte,tipo,referencia,chave,nsu,documento_id,detalhe,situacao,tentativas,criada_em," +
      "atualizada_em,dados) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(cliente_id,fonte,tipo,referencia) DO UPDATE SET" +
      " detalhe = excluded.detalhe, tentativas = pendencias.tentativas + 1, atualizada_em = excluded.atualizada_em," +
      " situacao = CASE WHEN pendencias.situacao = 'resolvida' THEN excluded.situacao ELSE pendencias.situacao END," +
      " resolvida_em = CASE WHEN pendencias.situacao = 'resolvida' THEN NULL ELSE pendencias.resolvida_em END," +
      " documento_id = coalesce(excluded.documento_id, pendencias.documento_id)," +
      " dados = coalesce(excluded.dados, pendencias.dados)"
    ).run(uuid(), clienteId, fonte, tipo, String(referencia), chave, nsu, documentoId, detalhe, situacao, agora(), agora(),
      dados ? paraJson(dados) : null);
  },

  /** Fecha sozinha quando o problema deixou de existir. */
  resolverPorReferencia({ clienteId, fonte, tipo, referencia, por = "sistema" }) {
    bd().prepare(
      "UPDATE pendencias SET situacao = 'resolvida', resolvida_em = ?, resolvida_por = ?, atualizada_em = ?" +
      " WHERE cliente_id = ? AND fonte = ? AND tipo = ? AND referencia = ? AND situacao = 'aberta'"
    ).run(agora(), por, agora(), clienteId, fonte, tipo, String(referencia));
  },

  porId(id) {
    const linha = bd().prepare(
      "SELECT p.*, c.nome AS cliente_nome FROM pendencias p LEFT JOIN clientes c ON c.id = p.cliente_id WHERE p.id = ?"
    ).get(id);
    return linha ? montarPendencia(linha) : null;
  },

  listar({ clienteId, situacao, tipo, limite = 500 } = {}) {
    const condicoes = [];
    const parametros = [];
    if (clienteId) { condicoes.push("p.cliente_id = ?"); parametros.push(clienteId); }
    if (situacao) { condicoes.push("p.situacao = ?"); parametros.push(situacao); }
    if (tipo) { condicoes.push("p.tipo = ?"); parametros.push(tipo); }
    return bd().prepare(
      "SELECT p.*, c.nome AS cliente_nome FROM pendencias p LEFT JOIN clientes c ON c.id = p.cliente_id" +
      (condicoes.length ? " WHERE " + condicoes.join(" AND ") : "") +
      " ORDER BY CASE p.situacao WHEN 'aberta' THEN 0 WHEN 'confirmada' THEN 1 ELSE 2 END, p.atualizada_em DESC LIMIT ?"
    ).all(...parametros, limite).map(montarPendencia);
  },

  marcar(id, situacao, usuario) {
    bd().prepare(
      "UPDATE pendencias SET situacao = ?, resolvida_em = CASE WHEN ? = 'resolvida' THEN ? ELSE NULL END," +
      " resolvida_por = CASE WHEN ? = 'resolvida' THEN ? ELSE NULL END, atualizada_em = ? WHERE id = ?"
    ).run(situacao, situacao, agora(), situacao, usuario, agora(), id);
    return this.porId(id);
  },

  contagem(clienteId = null) {
    const saida = {};
    const linhas = clienteId
      ? bd().prepare("SELECT tipo, situacao, count(*) c FROM pendencias WHERE cliente_id = ? GROUP BY tipo, situacao").all(clienteId)
      : bd().prepare("SELECT tipo, situacao, count(*) c FROM pendencias GROUP BY tipo, situacao").all();
    for (const linha of linhas) {
      saida[linha.tipo] = saida[linha.tipo] || {};
      saida[linha.tipo][linha.situacao] = linha.c;
    }
    return saida;
  }
};

// -------------------------------------------------------- arquivos e eventos

export const arquivos = {
  salvar(documentoId, tipo, { caminho, sha256, tamanho }) {
    bd().prepare(
      "INSERT INTO arquivos_documento (documento_id,tipo,caminho,sha256,tamanho,gerado_em) VALUES (?,?,?,?,?,?)" +
      " ON CONFLICT(documento_id,tipo) DO UPDATE SET caminho=excluded.caminho, sha256=excluded.sha256," +
      " tamanho=excluded.tamanho, gerado_em=excluded.gerado_em"
    ).run(documentoId, tipo, caminho, sha256, tamanho, agora());
  },

  doDocumento(documentoId) {
    const saida = {};
    for (const linha of bd().prepare("SELECT * FROM arquivos_documento WHERE documento_id = ?").all(documentoId)) {
      saida[linha.tipo] = { caminho: linha.caminho, sha256: linha.sha256, tamanho: linha.tamanho, geradoEm: linha.gerado_em };
    }
    return saida;
  },

  um(documentoId, tipo) {
    const linha = bd().prepare("SELECT * FROM arquivos_documento WHERE documento_id = ? AND tipo = ?").get(documentoId, tipo);
    return linha ? { caminho: linha.caminho, sha256: linha.sha256, tamanho: linha.tamanho } : null;
  }
};

export const eventos = {
  inserir({ clienteId, chave, nsu, tipo, descricao, motivo, quando, caminho, sha256 }) {
    const resultado = bd().prepare(
      "INSERT OR IGNORE INTO eventos_documento (id,cliente_id,chave,nsu,tipo,descricao,motivo,quando,caminho_xml,sha256,capturado_em)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).run(uuid(), clienteId, chave, nsu, tipo, descricao, motivo, quando, caminho, sha256, agora());
    return Number(resultado.changes) > 0;
  },

  daChave(chave, clienteId = null) {
    return bd().prepare("SELECT * FROM eventos_documento WHERE chave = ?" + (clienteId ? " AND cliente_id = ?" : "") +
      " ORDER BY quando").all(...(clienteId ? [chave, clienteId] : [chave]))
      .map((linha) => ({
        tipo: linha.tipo, descricao: linha.descricao, motivo: linha.motivo, quando: linha.quando,
        nsu: linha.nsu, caminho: linha.caminho_xml, sha256: linha.sha256
      }));
  },

  /** Notas da empresa com evento que ainda nao virou arquivo da nota (para ir a pasta). */
  documentosComEventoSemArquivo(clienteId) {
    return bd().prepare(
      "SELECT DISTINCT d.id FROM documentos d JOIN eventos_documento e ON e.chave = d.chave AND e.cliente_id = d.cliente_id" +
      " WHERE d.cliente_id = ? AND NOT EXISTS (SELECT 1 FROM arquivos_documento a WHERE a.documento_id = d.id" +
      " AND a.tipo = 'evento-' || substr(e.sha256, 1, 12))"
    ).all(clienteId).map((linha) => linha.id);
  }
};

// --------------------------------------------- revisao de cancelamentos (Sefin)

export const revisaoEventos = {
  ultima(documentoId) {
    const linha = bd().prepare("SELECT * FROM revisao_eventos WHERE documento_id = ?").get(documentoId);
    return linha ? { conferidoEm: linha.conferido_em, resultado: linha.resultado, detalhe: linha.detalhe } : null;
  },

  registrar(documentoId, resultado, detalhe = null) {
    bd().prepare(
      "INSERT INTO revisao_eventos (documento_id, conferido_em, resultado, detalhe) VALUES (?,?,?,?)" +
      " ON CONFLICT(documento_id) DO UPDATE SET conferido_em = excluded.conferido_em," +
      " resultado = excluded.resultado, detalhe = excluded.detalhe"
    ).run(documentoId, agora(), resultado, detalhe);
  }
};

// --------------------------------------------------------------- espelho local

export const gravacoes = {
  agendar({ documentoId, tipoArquivo, clienteId, destino, sha256 }) {
    bd().prepare(
      "INSERT INTO gravacoes_pasta (documento_id,tipo_arquivo,cliente_id,destino,sha256,situacao,atualizado_em)" +
      " VALUES (?,?,?,?,?,'pendente',?) ON CONFLICT(documento_id,tipo_arquivo) DO UPDATE SET" +
      " destino = excluded.destino, sha256 = excluded.sha256, atualizado_em = excluded.atualizado_em," +
      " situacao = CASE WHEN gravacoes_pasta.sha256 = excluded.sha256 AND gravacoes_pasta.destino = excluded.destino" +
      "   AND gravacoes_pasta.situacao IN ('gravado','ja_existia') THEN gravacoes_pasta.situacao ELSE 'pendente' END"
    ).run(documentoId, tipoArquivo, clienteId, destino, sha256, agora());
  },

  pendentes({ clienteId = null, limite = 200 } = {}) {
    return bd().prepare(
      "SELECT g.*, e.pasta_destino, a.caminho AS caminho_acervo FROM gravacoes_pasta g" +
      " JOIN empresas_captura e ON e.cliente_id = g.cliente_id" +
      " JOIN arquivos_documento a ON a.documento_id = g.documento_id AND a.tipo = g.tipo_arquivo" +
      " WHERE g.situacao IN ('pendente','erro') AND g.tentativas < 10 AND e.pasta_destino IS NOT NULL" +
      (clienteId ? " AND g.cliente_id = ?" : "") +
      " ORDER BY g.atualizado_em LIMIT ?"
    ).all(...(clienteId ? [clienteId, limite] : [limite])).map((linha) => ({
      documentoId: linha.documento_id,
      tipoArquivo: linha.tipo_arquivo,
      clientId: linha.cliente_id,
      destino: linha.destino,
      sha256: linha.sha256,
      pastaDestino: linha.pasta_destino,
      caminhoAcervo: linha.caminho_acervo,
      tentativas: linha.tentativas
    }));
  },

  marcar(documentoId, tipoArquivo, situacao, { erro = null, por = "servidor" } = {}) {
    bd().prepare(
      "UPDATE gravacoes_pasta SET situacao = ?, erro = ?, gravado_por = ?, atualizado_em = ?," +
      " tentativas = tentativas + CASE WHEN ? IN ('erro') THEN 1 ELSE 0 END WHERE documento_id = ? AND tipo_arquivo = ?"
    ).run(situacao, erro, por, agora(), situacao, documentoId, tipoArquivo);
  },

  /**
   * Documentos com arquivo no acervo e sem espelho agendado. E a reconciliacao
   * que impede uma nota de ficar so no acervo: queda no meio da captura, pasta
   * configurada depois, papel que passou a ser desejado.
   */
  documentosSemEspelho(clienteId) {
    return bd().prepare(
      "SELECT DISTINCT d.id FROM documentos d JOIN arquivos_documento a ON a.documento_id = d.id" +
      " WHERE d.cliente_id = ? AND d.fonte IS NOT NULL AND NOT EXISTS (SELECT 1 FROM gravacoes_pasta g" +
      "   WHERE g.documento_id = d.id AND g.tipo_arquivo = a.tipo)"
    ).all(clienteId).map((linha) => linha.id);
  },

  /** Documentos da empresa com algum arquivo no acervo: o que vai para a pasta. */
  documentosComArquivo(clienteId) {
    return bd().prepare(
      "SELECT DISTINCT d.id FROM documentos d JOIN arquivos_documento a ON a.documento_id = d.id" +
      " WHERE d.cliente_id = ? AND d.fonte IS NOT NULL"
    ).all(clienteId).map((linha) => linha.id);
  },

  /** Pasta trocada: tudo precisa ir de novo para o novo destino. */
  reiniciarCliente(clienteId) {
    bd().prepare(
      "UPDATE gravacoes_pasta SET situacao = 'pendente', tentativas = 0, erro = NULL, atualizado_em = ? WHERE cliente_id = ?"
    ).run(agora(), clienteId);
  },

  contagem(clienteId = null) {
    const saida = {};
    const linhas = clienteId
      ? bd().prepare("SELECT situacao, count(*) c FROM gravacoes_pasta WHERE cliente_id = ? GROUP BY situacao").all(clienteId)
      : bd().prepare("SELECT situacao, count(*) c FROM gravacoes_pasta GROUP BY situacao").all();
    for (const linha of linhas) saida[linha.situacao] = linha.c;
    return saida;
  }
};

// --------------------------------------------------------------- agente local

export const tokensAgente = {
  hash(token) {
    return crypto.createHash("sha256").update(String(token)).digest("hex");
  },

  criar(nome, usuario) {
    const token = "nucleoa_" + crypto.randomBytes(24).toString("base64url");
    const id = uuid();
    bd().prepare("INSERT INTO tokens_agente (id,nome,hash,criado_por,criado_em,ativo) VALUES (?,?,?,?,?,1)")
      .run(id, nome, this.hash(token), usuario, agora());
    return { id, nome, token };
  },

  validar(token) {
    if (!token) return null;
    const linha = bd().prepare("SELECT * FROM tokens_agente WHERE hash = ? AND ativo = 1").get(this.hash(token));
    if (!linha) return null;
    bd().prepare("UPDATE tokens_agente SET ultimo_uso = ? WHERE id = ?").run(agora(), linha.id);
    return { id: linha.id, nome: linha.nome };
  },

  listar() {
    return bd().prepare("SELECT id, nome, criado_por, criado_em, ultimo_uso, ativo FROM tokens_agente ORDER BY criado_em DESC")
      .all().map((linha) => ({
        id: linha.id, nome: linha.nome, criadoPor: linha.criado_por, criadoEm: linha.criado_em,
        ultimoUso: linha.ultimo_uso, ativo: deBool(linha.ativo)
      }));
  },

  /** Devolve false quando o token nao existe. */
  revogar(id) {
    return bd().prepare("UPDATE tokens_agente SET ativo = 0 WHERE id = ?").run(id).changes > 0;
  }
};

// ------------------------------------------------------------- PONTE SEFAZ

function montarPonteEstado(linha) {
  return {
    clientId: linha.cliente_id,
    naCarteira: deBool(linha.na_carteira),
    temCertificado: deBool(linha.tem_certificado),
    certificadoVencimento: linha.certificado_vencimento || null,
    certificadoTitular: linha.certificado_titular || null,
    radar: deBool(linha.radar),
    ultimaVarredura: linha.ultima_varredura || null,
    desde: linha.desde || null,
    achados: deJson(linha.achados, []),
    atualizadoEm: linha.atualizado_em
  };
}

export const ponteEstado = {
  /** Grava o que a PONTE disse. Achados so mudam quando vierem (null = manter). */
  salvar(clienteId, { naCarteira = true, temCertificado = false, certificadoVencimento = null, certificadoTitular = null,
    radar = true, ultimaVarredura = null, achados = null, desde = null }) {
    const atual = this.porCliente(clienteId);
    bd().prepare(
      "INSERT INTO ponte_estado (cliente_id,na_carteira,tem_certificado,certificado_vencimento,certificado_titular,radar," +
      "ultima_varredura,achados,desde,atualizado_em) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(cliente_id) DO UPDATE SET" +
      " na_carteira=excluded.na_carteira, tem_certificado=excluded.tem_certificado," +
      " certificado_vencimento=excluded.certificado_vencimento, certificado_titular=excluded.certificado_titular," +
      " radar=excluded.radar, ultima_varredura=coalesce(excluded.ultima_varredura, ponte_estado.ultima_varredura)," +
      " achados=excluded.achados, desde=coalesce(excluded.desde, ponte_estado.desde), atualizado_em=excluded.atualizado_em"
    ).run(clienteId, paraBool(naCarteira), paraBool(temCertificado), certificadoVencimento, certificadoTitular,
      paraBool(radar), ultimaVarredura, paraJson(achados ?? atual?.achados ?? []), desde, agora());
  },

  porCliente(clienteId) {
    const linha = bd().prepare("SELECT * FROM ponte_estado WHERE cliente_id = ?").get(clienteId);
    return linha ? montarPonteEstado(linha) : null;
  },

  listar() {
    return bd().prepare("SELECT * FROM ponte_estado").all().map(montarPonteEstado);
  }
};

// ------------------------------------------- Lucro Presumido e Lucro Real

export const lucro = {
  /**
   * O que as notas dizem para a apuracao, por competencia: receita das
   * emitidas por tipo de documento, compras (recebidas) e o IR e a CSLL
   * retidos nas NFS-e emitidas (padrao de prefeitura, que traz a retencao).
   * Canceladas ficam de fora.
   */
  dadosDasNotas(clienteId, competencias) {
    if (!competencias.length) return {};
    const marcas = competencias.map(() => "?").join(",");
    const saida = Object.fromEntries(competencias.map((c) => [c, { receitas: {}, receita: 0, compras: 0, retencoes: { irpj: 0, csll: 0 } }]));
    for (const linha of bd().prepare(
      "SELECT competencia, tipo, papel, sum(valor) v," +
      " sum(CASE WHEN json_extract(dados, '$.standard') = 'ABRASF' THEN coalesce(json_extract(dados, '$.service.ir'), 0) ELSE 0 END) ir," +
      " sum(CASE WHEN json_extract(dados, '$.standard') = 'ABRASF' THEN coalesce(json_extract(dados, '$.service.csll'), 0) ELSE 0 END) csll" +
      " FROM documentos WHERE cliente_id = ? AND cancelado = 0 AND tipo IN ('NF-e','NFC-e','NFS-e','CT-e')" +
      " AND competencia IN (" + marcas + ") GROUP BY competencia, tipo, papel"
    ).all(clienteId, ...competencias)) {
      const mes = saida[linha.competencia];
      if (!mes) continue;
      if (linha.papel === "emitida") {
        mes.receitas[linha.tipo] = (mes.receitas[linha.tipo] || 0) + (linha.v || 0);
        mes.receita += linha.v || 0;
        mes.retencoes.irpj += linha.ir || 0;
        mes.retencoes.csll += linha.csll || 0;
      } else if (linha.papel === "recebida") {
        mes.compras += linha.v || 0;
      }
    }
    return saida;
  },

  gravar({ clienteId, regime, periodo, total, entrada, resultado, usuario }) {
    const id = uuid();
    bd().prepare(
      "INSERT INTO apuracoes_lucro (id,cliente_id,regime,periodo,total,entrada,resultado,apurado_em,apurado_por) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(id, clienteId, regime, periodo, total, paraJson(entrada), paraJson(resultado), agora(), usuario || null);
    return id;
  },

  listar(clienteId = null) {
    return bd().prepare(
      "SELECT a.*, c.nome AS cliente_nome FROM apuracoes_lucro a JOIN clientes c ON c.id = a.cliente_id" +
      (clienteId ? " WHERE a.cliente_id = ?" : "") + " ORDER BY a.apurado_em DESC LIMIT 500"
    ).all(...(clienteId ? [clienteId] : [])).map((linha) => ({
      id: linha.id, clientId: linha.cliente_id, clientName: linha.cliente_nome, regime: linha.regime, periodo: linha.periodo,
      total: linha.total, entrada: deJson(linha.entrada, {}), resultado: deJson(linha.resultado, {}),
      apuradoEm: linha.apurado_em, apuradoPor: linha.apurado_por
    }));
  }
};

// --------------------------------------------- termo de guarda do A1

function montarTermo(linha) {
  return {
    id: linha.id, clientId: linha.cliente_id, certificadoId: linha.certificado_id, situacao: linha.situacao,
    autorizadoPor: linha.autorizado_por, referencia: linha.referencia, criadoEm: linha.criado_em, criadoPor: linha.criado_por,
    geradoEm: linha.gerado_em, geradoPor: linha.gerado_por, assinadoEm: linha.assinado_em, assinadoPor: linha.assinado_por,
    arquivoAssinado: linha.arquivo_assinado, sha256Assinado: linha.sha256_assinado, nomeArquivo: linha.nome_arquivo,
    substituidoEm: linha.substituido_em, conferencia: deJson(linha.conferencia, null)
  };
}

export const termosGuarda = {
  /**
   * O termo do certificado atual da empresa. Certificado novo: o termo anterior
   * vira "substituido" (com o assinado dele guardado) e nasce um pendente.
   */
  garantir({ clienteId, certificadoId, autorizadoPor = null, referencia = null, usuario = null }) {
    const atual = this.atual(clienteId);
    if (atual && atual.certificadoId === certificadoId) {
      if ((autorizadoPor && !atual.autorizadoPor) || (referencia && !atual.referencia)) {
        bd().prepare("UPDATE termos_guarda SET autorizado_por = coalesce(autorizado_por, ?), referencia = coalesce(referencia, ?) WHERE id = ?")
          .run(autorizadoPor, referencia, atual.id);
      }
      return this.porId(atual.id);
    }
    if (atual) bd().prepare("UPDATE termos_guarda SET situacao = 'substituido', substituido_em = ? WHERE id = ?").run(agora(), atual.id);
    const id = uuid();
    bd().prepare(
      "INSERT INTO termos_guarda (id,cliente_id,certificado_id,situacao,autorizado_por,referencia,criado_em,criado_por)" +
      " VALUES (?,?,?,'pendente',?,?,?,?)"
    ).run(id, clienteId, certificadoId, autorizadoPor, referencia, agora(), usuario);
    return this.porId(id);
  },

  porId(id) {
    const linha = bd().prepare("SELECT * FROM termos_guarda WHERE id = ?").get(id);
    return linha ? montarTermo(linha) : null;
  },

  atual(clienteId) {
    const linha = bd().prepare(
      "SELECT * FROM termos_guarda WHERE cliente_id = ? AND situacao NOT IN ('substituido', 'reenviado')" +
      " ORDER BY criado_em DESC, rowid DESC LIMIT 1"
    ).get(clienteId);
    return linha ? montarTermo(linha) : null;
  },

  historico(clienteId) {
    return bd().prepare("SELECT * FROM termos_guarda WHERE cliente_id = ? ORDER BY criado_em DESC").all(clienteId).map(montarTermo);
  },

  marcarGerado(id, usuario) {
    bd().prepare("UPDATE termos_guarda SET gerado_em = ?, gerado_por = ? WHERE id = ?").run(agora(), usuario, id);
  },

  /**
   * Termo recebido. "assinado" quer dizer que o arquivo chegou; o que foi provado esta em conferencia.
   *
   * O termo que ja tinha um assinado nao e reescrito: ele fica no historico como
   * "reenviado", com o PDF e a conferencia dele, e o novo nasce numa linha
   * propria. Antes o UPDATE trocava o arquivo por cima, e o PDF que "nao
   * confere" sumia do historico justo quando alguem precisava comparar os dois.
   */
  marcarAssinado(id, { caminho, sha256, nome, usuario, conferencia = null }) {
    return transacao(() => {
      const anterior = this.porId(id);
      let alvo = id;
      if (anterior?.arquivoAssinado) {
        bd().prepare("UPDATE termos_guarda SET situacao = 'reenviado', substituido_em = ? WHERE id = ?").run(agora(), id);
        alvo = uuid();
        bd().prepare(
          "INSERT INTO termos_guarda (id,cliente_id,certificado_id,situacao,autorizado_por,referencia,criado_em,criado_por," +
          "gerado_em,gerado_por) VALUES (?,?,?,'pendente',?,?,?,?,?,?)"
        ).run(alvo, anterior.clientId, anterior.certificadoId, anterior.autorizadoPor, anterior.referencia, agora(), usuario,
          anterior.geradoEm, anterior.geradoPor);
      }
      bd().prepare(
        "UPDATE termos_guarda SET situacao = 'assinado', assinado_em = ?, assinado_por = ?, arquivo_assinado = ?," +
        " sha256_assinado = ?, nome_arquivo = ?, conferencia = ? WHERE id = ?"
      ).run(agora(), usuario, caminho, sha256, nome, conferencia ? paraJson(conferencia) : null, alvo);
      return this.porId(alvo);
    });
  }
};

// ------------------------------------- envios para SIEG, Dominio e Acessorias

function montarEnvio(linha) {
  return {
    id: linha.id, destino: linha.destino, clientId: linha.cliente_id, clientName: linha.cliente_nome || null,
    competencia: linha.competencia, lote: linha.lote, arquivos: linha.arquivos, aceitos: linha.aceitos,
    recusados: linha.recusados, situacao: linha.situacao, detalhe: deJson(linha.detalhe, null),
    criadoEm: linha.criado_em, atualizadoEm: linha.atualizado_em, criadoPor: linha.criado_por
  };
}

export const enviosExternos = {
  registrar({ destino, clienteId = null, competencia = null, lote = null, arquivos = 0, aceitos = 0, recusados = 0,
    situacao, detalhe = null, usuario = null }) {
    const id = uuid();
    const quando = agora();
    bd().prepare(
      "INSERT INTO envios_externos (id,destino,cliente_id,competencia,lote,arquivos,aceitos,recusados,situacao,detalhe," +
      "criado_em,atualizado_em,criado_por) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(id, destino, clienteId, competencia, lote, arquivos, aceitos, recusados, situacao,
      detalhe === null ? null : paraJson(detalhe), quando, quando, usuario);
    return this.porId(id);
  },

  porId(id) {
    const linha = bd().prepare("SELECT e.*, c.nome AS cliente_nome FROM envios_externos e LEFT JOIN clientes c ON c.id = e.cliente_id" +
      " WHERE e.id = ?").get(id);
    return linha ? montarEnvio(linha) : null;
  },

  atualizar(id, { situacao, detalhe }) {
    bd().prepare("UPDATE envios_externos SET situacao = ?, detalhe = ?, atualizado_em = ? WHERE id = ?")
      .run(situacao, detalhe === undefined || detalhe === null ? null : paraJson(detalhe), agora(), id);
    return this.porId(id);
  },

  listar({ clienteId = null, destino = null, situacao = null, limite = 200 } = {}) {
    const condicoes = [];
    const parametros = [];
    if (clienteId) { condicoes.push("e.cliente_id = ?"); parametros.push(clienteId); }
    if (destino) { condicoes.push("e.destino = ?"); parametros.push(destino); }
    if (situacao) { condicoes.push("e.situacao = ?"); parametros.push(situacao); }
    return bd().prepare("SELECT e.*, c.nome AS cliente_nome FROM envios_externos e LEFT JOIN clientes c ON c.id = e.cliente_id" +
      (condicoes.length ? " WHERE " + condicoes.join(" AND ") : "") + " ORDER BY e.criado_em DESC LIMIT ?")
      .all(...parametros, limite).map(montarEnvio);
  }
};

// ------------------------------------------------------ mapa do periodo

export const periodosCaptura = {
  /** Registra que a competencia foi trazida da fonte agora (a ultima vez vale). */
  registrar({ clienteId, competencia, fonte, arquivos = 0, semXml = 0, falhas = 0 }) {
    bd().prepare(
      "INSERT INTO periodos_captura (cliente_id,competencia,fonte,trazido_em,arquivos,sem_xml,falhas) VALUES (?,?,?,?,?,?,?)" +
      " ON CONFLICT(cliente_id,competencia,fonte) DO UPDATE SET trazido_em=excluded.trazido_em, arquivos=excluded.arquivos," +
      " sem_xml=excluded.sem_xml, falhas=excluded.falhas"
    ).run(clienteId, competencia, fonte, agora(), arquivos, semXml, falhas);
  },

  porCliente(clienteId) {
    return bd().prepare("SELECT * FROM periodos_captura WHERE cliente_id = ? ORDER BY competencia DESC").all(clienteId)
      .map((linha) => ({ competencia: linha.competencia, fonte: linha.fonte, trazidoEm: linha.trazido_em,
        arquivos: linha.arquivos, semXml: linha.sem_xml, falhas: linha.falhas }));
  }
};

// ---------------------------------------------------------- pasta monitorada

export const pastaMonitorada = {
  jaLido(sha256) {
    return Boolean(bd().prepare("SELECT 1 FROM pasta_monitorada_vistos WHERE sha256 = ?").get(sha256));
  },

  marcarLido(sha256, nome, tamanho) {
    bd().prepare(
      "INSERT OR IGNORE INTO pasta_monitorada_vistos (sha256,nome,tamanho,visto_em) VALUES (?,?,?,?)"
    ).run(sha256, nome, tamanho, agora());
  },

  contar() {
    return bd().prepare("SELECT count(*) c FROM pasta_monitorada_vistos").get().c;
  }
};

// ------------------------------------------------------------ acervo capturado

export const acervoDocs = {
  /** Busca com filtros e paginacao. */
  buscar({ clienteId, competencia, de, ate, papel, numero, chave, busca, produto, situacao, xml, pdf, cnpj, tipo, fonte,
    contraparte, valorMin, valorMax, pagina = 1, porPagina = 50 } = {}) {
    const condicoes = ["d.fonte IS NOT NULL"];
    const parametros = [];
    if (clienteId) { condicoes.push("d.cliente_id = ?"); parametros.push(clienteId); }
    if (cnpj) { condicoes.push("cl.cnpj_digits = ?"); parametros.push(String(cnpj).replace(/\D/g, "")); }
    if (competencia) { condicoes.push("d.competencia = ?"); parametros.push(competencia); }
    if (de) { condicoes.push("d.emitido_em >= ?"); parametros.push(de); }
    // So a data (AAAA-MM-DD) vale o dia inteiro: "~" fica depois de qualquer hora daquele dia.
    if (ate) { condicoes.push("d.emitido_em <= ?"); parametros.push(/^\d{4}-\d{2}-\d{2}$/.test(ate) ? ate + "~" : ate); }
    if (papel) { condicoes.push("d.papel = ?"); parametros.push(papel); }
    if (tipo) { condicoes.push("d.tipo = ?"); parametros.push(tipo); }
    if (fonte) { condicoes.push("d.fonte = ?"); parametros.push(fonte); }
    if (numero) { condicoes.push("d.numero = ?"); parametros.push(String(numero)); }
    if (chave) { condicoes.push("d.chave LIKE ?"); parametros.push("%" + String(chave).replace(/\D/g, "") + "%"); }
    // CNPJ da outra parte da nota: emitente, destinatario ou tomador. 8 digitos = a raiz (matriz e filiais).
    const daContraparte = (valor) => {
      const d = String(valor).replace(/\D/g, "");
      if (d.length === 8) {
        condicoes.push("(json_extract(d.dados, '$.emitter.cnpj') LIKE ? OR json_extract(d.dados, '$.recipient.doc') LIKE ?)");
        parametros.push(d + "%", d + "%");
      } else {
        condicoes.push("(json_extract(d.dados, '$.emitter.cnpj') = ? OR json_extract(d.dados, '$.recipient.doc') = ?)");
        parametros.push(d, d);
      }
    };
    if (contraparte) daContraparte(contraparte);
    if (valorMin !== undefined && valorMin !== "" && Number.isFinite(Number(valorMin))) { condicoes.push("d.valor >= ?"); parametros.push(Number(valorMin)); }
    if (valorMax !== undefined && valorMax !== "" && Number.isFinite(Number(valorMax))) { condicoes.push("d.valor <= ?"); parametros.push(Number(valorMax)); }
    // Um campo so para numero, chave, CNPJ da contraparte ou valor:
    //   1.234,56 ou R$ 1234,56 -> valor exato; 12.345.678/0001-90 -> CNPJ da contraparte;
    //   14 digitos -> numero ou CNPJ da contraparte; ate 15 digitos -> numero (a NFS-e chega a 15);
    //   mais que isso -> trecho da chave.
    const textoBusca = String(busca || "").trim();
    const digitos = textoBusca.replace(/\D/g, "");
    if (/^(r\$\s*)?(\d{1,3}(\.\d{3})+|\d+),\d{2}$/i.test(textoBusca)) {
      condicoes.push("abs(d.valor - ?) < 0.005");
      parametros.push(Number(textoBusca.replace(/^r\$\s*/i, "").replace(/\./g, "").replace(",", ".")));
    } else if (/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/.test(textoBusca)) {
      daContraparte(digitos);
    } else if (digitos.length === 14) {
      condicoes.push("(d.numero = ? OR ltrim(d.numero, '0') = ? OR json_extract(d.dados, '$.emitter.cnpj') = ? OR json_extract(d.dados, '$.recipient.doc') = ?)");
      parametros.push(digitos, digitos.replace(/^0+/, ""), digitos, digitos);
    } else if (digitos && digitos.length <= 15) {
      condicoes.push("(d.numero = ? OR ltrim(d.numero, '0') = ?)");
      parametros.push(digitos, digitos.replace(/^0+/, ""));
    }
    if (digitos.length > 15) { condicoes.push("d.chave LIKE ?"); parametros.push("%" + digitos + "%"); }
    // Produto, NCM ou CFOP: codigo so de digitos procura CFOP (igual), NCM e codigo do servico da NFS-e (pelo
    // comeco); texto procura na descricao do item da NF-e e na discriminacao do servico da NFS-e.
    const item = String(produto || "").trim();
    if (item) {
      const codigo = item.replace(/[.\s-]/g, "");
      if (/^\d{2,}$/.test(codigo)) {
        condicoes.push("(EXISTS (SELECT 1 FROM json_each(d.dados, '$.items') i WHERE json_extract(i.value, '$.ncm') LIKE ?" +
          " OR json_extract(i.value, '$.cfop') = ?) OR json_extract(d.dados, '$.cfop') = ?" +
          " OR replace(coalesce(json_extract(d.dados, '$.service.code'), ''), '.', '') LIKE ?)");
        parametros.push(codigo + "%", codigo, codigo, codigo + "%");
      } else {
        const texto = "%" + item.toLowerCase().replace(/[\\%_]/g, (c) => "\\" + c) + "%";
        condicoes.push("(EXISTS (SELECT 1 FROM json_each(d.dados, '$.items') i WHERE lower(json_extract(i.value, '$.description'))" +
          " LIKE ? ESCAPE '\\') OR lower(coalesce(json_extract(d.dados, '$.service.description'), '')) LIKE ? ESCAPE '\\')");
        parametros.push(texto, texto);
      }
    }
    if (situacao === "cancelada") condicoes.push("d.cancelado = 1");
    if (situacao === "autorizada") condicoes.push("d.cancelado = 0");
    if (xml === "sim") condicoes.push("EXISTS (SELECT 1 FROM arquivos_documento a WHERE a.documento_id = d.id AND a.tipo = 'xml')");
    if (pdf === "sim") condicoes.push("EXISTS (SELECT 1 FROM arquivos_documento a WHERE a.documento_id = d.id AND a.tipo = 'pdf')");
    if (pdf === "nao") condicoes.push("NOT EXISTS (SELECT 1 FROM arquivos_documento a WHERE a.documento_id = d.id AND a.tipo = 'pdf')");

    const onde = " WHERE " + condicoes.join(" AND ");
    const total = bd().prepare(
      "SELECT count(*) c FROM documentos d LEFT JOIN clientes cl ON cl.id = d.cliente_id" + onde
    ).get(...parametros).c;

    const linhas = bd().prepare(`
      SELECT d.id, d.chave, d.tipo, d.numero, d.serie, d.emitido_em, d.competencia, d.papel, d.fonte, d.nsu,
             d.valor, d.cancelado, d.cliente_id, d.dados, cl.nome AS cliente_nome, cl.cnpj AS cliente_cnpj,
             cf.situacao AS conferencia,
             (SELECT 1 FROM arquivos_documento a WHERE a.documento_id = d.id AND a.tipo = 'xml') AS tem_xml,
             (SELECT 1 FROM arquivos_documento a WHERE a.documento_id = d.id AND a.tipo = 'pdf') AS tem_pdf,
             (SELECT group_concat(g.situacao) FROM gravacoes_pasta g WHERE g.documento_id = d.id) AS pasta
      FROM documentos d
      LEFT JOIN clientes cl ON cl.id = d.cliente_id
      LEFT JOIN conferencias cf ON cf.chave = d.chave
      ${onde}
      ORDER BY d.emitido_em DESC, d.nsu DESC
      LIMIT ? OFFSET ?
    `).all(...parametros, porPagina, (Math.max(1, pagina) - 1) * porPagina);

    // Competencias que existem para a empresa filtrada: viram as opcoes do seletor.
    const competencias = bd().prepare(
      "SELECT DISTINCT competencia FROM documentos WHERE fonte IS NOT NULL AND competencia IS NOT NULL" +
      (clienteId ? " AND cliente_id = ?" : "") + " ORDER BY competencia DESC"
    ).all(...(clienteId ? [clienteId] : [])).map((linha) => linha.competencia);

    return {
      total,
      pagina,
      porPagina,
      competencias,
      documentos: linhas.map((linha) => {
        const dados = deJson(linha.dados, {});
        const pasta = String(linha.pasta || "").split(",").filter(Boolean);
        return {
          id: linha.id,
          chave: linha.chave,
          tipo: linha.tipo,
          numero: linha.numero,
          serie: linha.serie,
          emissao: linha.emitido_em,
          competencia: linha.competencia,
          papel: linha.papel,
          fonte: linha.fonte,
          nsu: linha.nsu,
          valor: linha.valor,
          cancelada: deBool(linha.cancelado),
          clientId: linha.cliente_id,
          clientName: linha.cliente_nome,
          emitente: { cnpj: dados.emitter?.cnpj, nome: dados.emitter?.name },
          destinatario: { cnpj: dados.recipient?.doc, nome: dados.recipient?.name },
          conferencia: linha.conferencia || "Nao conferido",
          xml: Boolean(linha.tem_xml),
          pdf: Boolean(linha.tem_pdf),
          pasta: !pasta.length ? "sem pasta"
            : pasta.every((item) => item === "gravado" || item === "ja_existia") ? "gravado"
            : pasta.includes("conflito") ? "conflito"
            : pasta.includes("erro") ? "erro" : "pendente"
        };
      })
    };
  },

  /** Totais por competencia e papel: o historico mensal da empresa. */
  historicoMensal(clienteId) {
    const mapa = new Map();
    for (const linha of bd().prepare(
      "SELECT competencia, papel, count(*) c, sum(valor) v, sum(cancelado) canc FROM documentos" +
      " WHERE cliente_id = ? AND fonte IS NOT NULL GROUP BY competencia, papel ORDER BY competencia DESC"
    ).all(clienteId)) {
      const chave = linha.competencia || "sem-competencia";
      const atual = mapa.get(chave) || { competencia: chave, emitidas: 0, recebidas: 0, outras: 0,
        valorEmitidas: 0, valorRecebidas: 0, canceladas: 0 };
      if (linha.papel === "emitida") { atual.emitidas += linha.c; atual.valorEmitidas += linha.v || 0; }
      else if (linha.papel === "recebida") { atual.recebidas += linha.c; atual.valorRecebidas += linha.v || 0; }
      else atual.outras += linha.c;
      atual.canceladas += linha.canc || 0;
      mapa.set(chave, atual);
    }
    return [...mapa.values()];
  },

  /** NFS-e de prefeitura (padrao ABRASF) que entraram por importacao. */
  nfsePrefeitura() {
    return bd().prepare(
      "SELECT count(*) c FROM documentos WHERE tipo = 'NFS-e' AND json_extract(dados, '$.standard') = 'ABRASF'" +
      " AND fonte = 'IMPORTACAO'"
    ).get().c;
  },

  contagemGeral() {
    return bd().prepare(`
      SELECT count(*) total,
             sum(CASE WHEN papel = 'emitida' THEN 1 ELSE 0 END) emitidas,
             sum(CASE WHEN papel = 'recebida' THEN 1 ELSE 0 END) recebidas,
             sum(CASE WHEN EXISTS (SELECT 1 FROM arquivos_documento a WHERE a.documento_id = d.id AND a.tipo = 'pdf') THEN 1 ELSE 0 END) com_pdf
      FROM documentos d WHERE fonte IS NOT NULL
    `).get();
  }
};
