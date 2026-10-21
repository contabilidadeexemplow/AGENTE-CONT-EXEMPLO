// Acesso a dados. Toda leitura e escrita do servidor passa por aqui.
//
// As funcoes devolvem objetos no mesmo formato que as telas e os motores ja
// esperavam, em camelCase: o SQL fica contido neste modulo. Contagens e
// agregacoes sao feitas em consulta, nao carregando tabela para a memoria.

import crypto from "node:crypto";
import { bd, transacao, paraJson, deJson, paraBool, deBool } from "./banco.mjs";
import { proximoEvento, verificar, GENESIS } from "./auditoria.mjs";
import { cifrar, decifrar, chaveConfigurada } from "./segredos.mjs";
import { PERMISSOES, hashSenha, conferirSenha, formatarCnpj, somenteDigitos } from "./estado.mjs";

const agora = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

// ------------------------------------------------------------------ usuarios

export const usuarios = {
  contar() {
    return bd().prepare("SELECT count(*) c FROM usuarios WHERE ativo = 1").get().c;
  },

  porEmail(email) {
    const linha = bd().prepare("SELECT * FROM usuarios WHERE email = ? AND ativo = 1").get(String(email || ""));
    return linha ? this.montar(linha) : null;
  },

  porId(id) {
    const linha = bd().prepare("SELECT * FROM usuarios WHERE id = ? AND ativo = 1").get(id);
    return linha ? this.montar(linha) : null;
  },

  montar(linha) {
    return {
      id: linha.id,
      name: linha.nome,
      email: linha.email,
      password: linha.senha,
      role: linha.perfil,
      mustChangePassword: deBool(linha.trocar_senha),
      permissions: PERMISSOES[linha.perfil] || [],
      createdAt: linha.criado_em
    };
  },

  listar() {
    return bd().prepare("SELECT * FROM usuarios WHERE ativo = 1 ORDER BY nome").all()
      .map((linha) => {
        const { password, ...resto } = this.montar(linha);
        return resto;
      });
  },

  criar({ name, email, password, role, mustChangePassword = false }) {
    const item = {
      id: uuid(),
      nome: String(name),
      email: String(email).toLowerCase(),
      senha: hashSenha(password),
      perfil: role,
      trocar_senha: paraBool(mustChangePassword),
      criado_em: agora()
    };
    bd().prepare(
      "INSERT INTO usuarios (id,nome,email,senha,perfil,trocar_senha,ativo,criado_em) VALUES (?,?,?,?,?,?,1,?)"
    ).run(item.id, item.nome, item.email, item.senha, item.perfil, item.trocar_senha, item.criado_em);
    return this.porId(item.id);
  },

  conferirSenha(usuario, senha) {
    return conferirSenha(senha, usuario.password);
  },

  trocarSenha(id, novaSenha) {
    bd().prepare("UPDATE usuarios SET senha = ?, trocar_senha = 0 WHERE id = ?")
      .run(hashSenha(novaSenha), id);
    return this.porId(id);
  },

  desativar(id) {
    bd().prepare("UPDATE usuarios SET ativo = 0 WHERE id = ?").run(id);
    bd().prepare("DELETE FROM sessoes WHERE usuario_id = ?").run(id);
  }
};

// ------------------------------------------------------------------- sessoes

export const sessoes = {
  idDe(token) {
    return crypto.createHash("sha256").update(String(token)).digest("hex");
  },

  criar(usuarioId, horas = 8) {
    this.limpar();
    const token = crypto.randomBytes(32).toString("hex");
    bd().prepare("INSERT INTO sessoes (id,usuario_id,criada_em,expira_em) VALUES (?,?,?,?)")
      .run(this.idDe(token), usuarioId, agora(), Date.now() + horas * 3600_000);
    return token;
  },

  usuarioDe(token) {
    if (!token) return null;
    const sessao = bd().prepare("SELECT * FROM sessoes WHERE id = ?").get(this.idDe(token));
    if (!sessao) return null;
    if (sessao.expira_em < Date.now()) {
      bd().prepare("DELETE FROM sessoes WHERE id = ?").run(sessao.id);
      return null;
    }
    return usuarios.porId(sessao.usuario_id);
  },

  remover(token) {
    bd().prepare("DELETE FROM sessoes WHERE id = ?").run(this.idDe(token));
  },

  limpar() {
    bd().prepare("DELETE FROM sessoes WHERE expira_em < ?").run(Date.now());
  },

  contar() {
    return bd().prepare("SELECT count(*) c FROM sessoes").get().c;
  }
};

// ------------------------------------------------------------------ clientes

const SELECT_CLIENTE = `
  SELECT c.*,
    (SELECT count(*) FROM documentos d WHERE d.cliente_id = c.id) AS documentos,
    (SELECT count(*) FROM alertas a WHERE a.cliente_id = c.id AND a.situacao = 'Pendente') AS alertas_abertos,
    (SELECT count(*) FROM alertas a WHERE a.cliente_id = c.id AND a.situacao = 'Pendente'
       AND a.severidade = 'critico') AS alertas_criticos,
    (SELECT max(vence_em) FROM certificados ce WHERE ce.cliente_id = c.id) AS cert_mais_longe,
    (SELECT count(*) FROM certificados ce WHERE ce.cliente_id = c.id) AS certificados
  FROM clientes c
`;

function situacaoCertificado(linha) {
  if (!linha.certificados) return "Pendente";
  if (!linha.cert_mais_longe) return "Pendente";
  const dias = Math.floor((new Date(linha.cert_mais_longe + "T12:00:00Z") - Date.now()) / 86_400_000);
  return dias < 0 ? "Vencido" : dias <= 30 ? "Vencendo" : "Valido";
}

function montarCliente(linha) {
  return {
    id: linha.id,
    cnpj: linha.cnpj,
    cnpjDigits: linha.cnpj_digits,
    name: linha.nome,
    city: linha.cidade || "",
    taxRegime: linha.regime,
    anexo: linha.anexo,
    rbt12: linha.rbt12,
    folha12: linha.folha12,
    modules: deJson(linha.modulos, []),
    demo: deBool(linha.demo),
    documents: linha.documentos ?? 0,
    openAlerts: linha.alertas_abertos ?? 0,
    certificate: situacaoCertificado(linha),
    status: linha.alertas_criticos > 0 ? "Critico" : linha.alertas_abertos > 0 ? "Atencao" : "Saudavel"
  };
}

export const clientes = {
  listar() {
    return bd().prepare(SELECT_CLIENTE + " ORDER BY c.nome").all().map(montarCliente);
  },

  porId(id) {
    const linha = bd().prepare(SELECT_CLIENTE + " WHERE c.id = ?").get(id);
    return linha ? montarCliente(linha) : null;
  },

  porCnpj(cnpj) {
    const linha = bd().prepare(SELECT_CLIENTE + " WHERE c.cnpj_digits = ?").get(somenteDigitos(cnpj));
    return linha ? montarCliente(linha) : null;
  },

  porModulo(nome) {
    const alvo = String(nome).toLowerCase();
    return this.listar().filter((cliente) =>
      (cliente.modules || []).some((modulo) => modulo.toLowerCase().includes(alvo)));
  },

  nome(id) {
    if (!id) return "Nao vinculado";
    const linha = bd().prepare("SELECT nome FROM clientes WHERE id = ?").get(id);
    return linha ? linha.nome : "Cliente nao encontrado";
  },

  criar(entrada) {
    const digitos = somenteDigitos(entrada.cnpj);
    const item = {
      id: uuid(),
      cnpj: formatarCnpj(entrada.cnpj),
      cnpj_digits: digitos,
      nome: entrada.name,
      cidade: entrada.city || "",
      regime: entrada.taxRegime || "Simples Nacional",
      anexo: entrada.anexo || null,
      rbt12: entrada.rbt12 === undefined || entrada.rbt12 === null ? null : Number(entrada.rbt12),
      folha12: entrada.folha12 === undefined || entrada.folha12 === null ? null : Number(entrada.folha12),
      modulos: paraJson(Array.isArray(entrada.modules) ? entrada.modules : []),
      demo: paraBool(entrada.demo),
      criado_em: agora()
    };
    bd().prepare(
      "INSERT INTO clientes (id,cnpj,cnpj_digits,nome,cidade,regime,anexo,rbt12,folha12,modulos,demo,criado_em)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(item.id, item.cnpj, item.cnpj_digits, item.nome, item.cidade, item.regime,
      item.anexo, item.rbt12, item.folha12, item.modulos, item.demo, item.criado_em);
    return this.porId(item.id);
  },

  existeCnpj(cnpj, exceto = null) {
    const linha = bd().prepare("SELECT id FROM clientes WHERE cnpj_digits = ?").get(somenteDigitos(cnpj));
    return Boolean(linha) && linha.id !== exceto;
  },

  atualizar(id, entrada) {
    const atual = this.porId(id);
    if (!atual) return null;
    const novo = {
      cnpj: entrada.cnpj !== undefined ? formatarCnpj(entrada.cnpj) : atual.cnpj,
      cnpj_digits: entrada.cnpj !== undefined ? somenteDigitos(entrada.cnpj) : atual.cnpjDigits,
      nome: entrada.name ?? atual.name,
      cidade: entrada.city ?? atual.city,
      regime: entrada.taxRegime ?? atual.taxRegime,
      anexo: entrada.anexo !== undefined ? entrada.anexo : atual.anexo,
      rbt12: entrada.rbt12 === undefined ? atual.rbt12 : (entrada.rbt12 === null ? null : Number(entrada.rbt12)),
      folha12: entrada.folha12 === undefined ? atual.folha12 : (entrada.folha12 === null ? null : Number(entrada.folha12)),
      modulos: paraJson(Array.isArray(entrada.modules) ? entrada.modules : atual.modules)
    };
    bd().prepare(
      "UPDATE clientes SET cnpj=?, cnpj_digits=?, nome=?, cidade=?, regime=?, anexo=?, rbt12=?, folha12=?, modulos=?" +
      " WHERE id=?"
    ).run(novo.cnpj, novo.cnpj_digits, novo.nome, novo.cidade, novo.regime,
      novo.anexo, novo.rbt12, novo.folha12, novo.modulos, id);
    return this.porId(id);
  },

  /** Documentos capturados antes do cadastro passam a ter dono. */
  vincularOrfaos(clienteId, cnpjDigits) {
    const resultado = bd().prepare(
      "UPDATE documentos SET cliente_id = ? WHERE cliente_id IS NULL AND emitente = ?"
    ).run(clienteId, cnpjDigits);
    bd().prepare(
      "UPDATE conferencias SET cliente_id = ? WHERE cliente_id IS NULL AND documento_id IN" +
      " (SELECT id FROM documentos WHERE cliente_id = ?)"
    ).run(clienteId, clienteId);
    return Number(resultado.changes) || 0;
  }
};

// -------------------------------------------------------------- certificados

function montarCertificado(linha) {
  const dias = linha.vence_em
    ? Math.floor((new Date(linha.vence_em + "T12:00:00Z") - Date.now()) / 86_400_000)
    : null;
  return {
    id: linha.id,
    clientId: linha.cliente_id,
    clientName: clientes.nome(linha.cliente_id),
    type: linha.tipo,
    expiresAt: linha.vence_em,
    usage: linha.uso || "",
    subject: linha.titular,
    issuer: linha.emissor,
    serial: linha.serie,
    readFromFile: deBool(linha.lido_do_arquivo),
    daysToExpiry: dias,
    status: dias === null ? "Pendente" : dias < 0 ? "Vencido" : dias <= 30 ? "Vencendo" : "Valido"
  };
}

export const certificados = {
  listar() {
    return bd().prepare("SELECT * FROM certificados ORDER BY vence_em").all().map(montarCertificado);
  },

  paraVigilancia() {
    return bd().prepare("SELECT id, cliente_id, tipo, vence_em FROM certificados").all()
      .map((linha) => ({
        id: linha.id, clientId: linha.cliente_id, type: linha.tipo, expiresAt: linha.vence_em
      }));
  },

  criar(entrada) {
    const item = {
      id: uuid(),
      cliente_id: entrada.clientId,
      tipo: entrada.type || "A1",
      vence_em: entrada.expiresAt,
      uso: entrada.usage || "",
      titular: entrada.subject || null,
      emissor: entrada.issuer || null,
      serie: entrada.serial || null,
      lido_do_arquivo: paraBool(entrada.readFromFile),
      criado_em: agora()
    };
    bd().prepare(
      "INSERT INTO certificados (id,cliente_id,tipo,vence_em,uso,titular,emissor,serie,lido_do_arquivo,criado_em)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run(item.id, item.cliente_id, item.tipo, item.vence_em, item.uso,
      item.titular, item.emissor, item.serie, item.lido_do_arquivo, item.criado_em);
    const linha = bd().prepare("SELECT * FROM certificados WHERE id = ?").get(item.id);
    return montarCertificado(linha);
  },

  vencendoEm(dias) {
    return bd().prepare(
      "SELECT count(*) c FROM certificados WHERE vence_em IS NOT NULL" +
      " AND julianday(vence_em) - julianday('now') BETWEEN 0 AND ?"
    ).get(dias).c;
  }
};

// ----------------------------------------------------------------- documentos

function valorDe(documento) {
  if (documento.kind === "NFS-e") return documento.service?.gross ?? 0;
  return documento.totals?.invoice ?? documento.totals?.products ?? 0;
}

function montarDocumento(linha) {
  const dados = deJson(linha.dados, {});
  return {
    ...dados,
    id: linha.id,
    key: linha.chave,
    identity: linha.identidade,
    kind: linha.tipo,
    number: linha.numero,
    series: linha.serie,
    issuedAt: linha.emitido_em,
    operation: linha.operacao,
    clientId: linha.cliente_id,
    cancelled: deBool(linha.cancelado),
    cancelReason: linha.motivo_cancelamento,
    uploadId: linha.upload_id,
    capturedAt: linha.capturado_em,
    capturedBy: linha.capturado_por,
    fonte: linha.fonte ?? null,
    nsu: linha.nsu ?? null,
    papel: linha.papel ?? null,
    competencia: linha.competencia ?? null
  };
}

export const documentos = {
  inserir(documento, { clienteId, capturadoPor, uploadId = null, fonte = null, nsu = null, papel = null, competencia = null }) {
    const id = uuid();
    const { id: _ignora, clientId: _c, ...dados } = documento;
    bd().prepare(
      "INSERT INTO documentos (id,chave,identidade,tipo,numero,serie,emitido_em,operacao,emitente," +
      "cliente_id,valor,cancelado,upload_id,capturado_em,capturado_por,dados,fonte,nsu,papel,competencia)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)"
    ).run(
      id, documento.key, documento.identity || documento.key, documento.kind,
      documento.number || null, documento.series || null, documento.issuedAt || null,
      documento.operation || null, documento.emitter?.cnpj || null,
      clienteId || null, valorDe(documento), uploadId, agora(), capturadoPor, paraJson(dados),
      fonte, nsu, papel,
      // Sem competencia do chamador: a do documento (dCompet da NFS-e), e so
      // depois o mes da emissao. Era so o mes da emissao no que entrava por arquivo.
      competencia || documento.competencia || (documento.issuedAt ? String(documento.issuedAt).slice(0, 7) : null)
    );
    return this.porId(id);
  },

  porIdentidade(identidade) {
    const linha = bd().prepare("SELECT * FROM documentos WHERE identidade = ?").get(identidade);
    return linha ? montarDocumento(linha) : null;
  },

  /** NF-e/NFC-e com chave que nao e de 44 digitos: sinal de leitura errada. */
  comChaveSuspeita() {
    return bd().prepare(
      "SELECT * FROM documentos WHERE tipo IN ('NF-e','NFC-e') AND (length(chave) <> 44 OR chave GLOB '*[^0-9]*')"
    ).all().map(montarDocumento);
  },

  /**
   * Corrige no lugar um documento lido errado: o mesmo registro (id, arquivos,
   * historico) passa a ter os dados da leitura certa do mesmo XML.
   */
  corrigirLeitura(id, documento, { papel, competencia }) {
    const { id: _ignora, clientId: _c, ...dados } = documento;
    bd().prepare(
      "UPDATE documentos SET chave=?, identidade=?, tipo=?, numero=?, serie=?, emitido_em=?, operacao=?, emitente=?," +
      " valor=?, dados=?, papel=?, competencia=? WHERE id = ?"
    ).run(documento.key, documento.identity, documento.kind, documento.number || null, documento.series || null,
      documento.issuedAt || null, documento.operation || null, documento.emitter?.cnpj || null, valorDe(documento),
      paraJson(dados), papel, competencia, id);
    return this.porId(id);
  },

  porId(id) {
    const linha = bd().prepare("SELECT * FROM documentos WHERE id = ?").get(id);
    return linha ? montarDocumento(linha) : null;
  },

  porChaveOuId(valor) {
    const linha = bd().prepare("SELECT * FROM documentos WHERE id = ? OR chave = ? LIMIT 1").get(valor, valor);
    return linha ? montarDocumento(linha) : null;
  },

  porChave(chave) {
    const linha = bd().prepare("SELECT * FROM documentos WHERE chave = ?").get(chave);
    return linha ? montarDocumento(linha) : null;
  },

  identidadesConhecidas() {
    return new Set(bd().prepare("SELECT identidade FROM documentos").all().map((linha) => linha.identidade));
  },

  contar() {
    return bd().prepare("SELECT count(*) c FROM documentos").get().c;
  },

  doCliente(clienteId, { incluirCancelados = false } = {}) {
    const sql = "SELECT * FROM documentos WHERE cliente_id = ?" +
      (incluirCancelados ? "" : " AND cancelado = 0");
    return bd().prepare(sql).all(clienteId).map(montarDocumento);
  },

  marcarCancelado(chave, motivo) {
    const resultado = bd().prepare(
      "UPDATE documentos SET cancelado = 1, motivo_cancelamento = ? WHERE chave = ?"
    ).run(motivo || null, chave);
    return Number(resultado.changes) || 0;
  },

  naoCancelados() {
    return bd().prepare("SELECT * FROM documentos WHERE cancelado = 0").all().map(montarDocumento);
  },

  /** Forma reduzida que os monitores consomem: sem abrir o JSON de cada nota. */
  paraVigilancia() {
    return bd().prepare(
      "SELECT cliente_id, emitido_em, operacao, valor FROM documentos WHERE cancelado = 0"
    ).all().map((linha) => ({
      clientId: linha.cliente_id,
      issuedAt: linha.emitido_em,
      operation: linha.operacao,
      amount: linha.valor
    }));
  },

  /** Visao Federal: NF-e e NFC-e com o resultado da conferencia, em uma consulta. */
  visaoFederal() {
    return bd().prepare(`
      SELECT d.id, d.chave, d.tipo, d.cliente_id, d.emitido_em, d.operacao, d.valor, d.cancelado,
             cl.nome AS cliente_nome, cf.situacao, cf.total,
             (SELECT codigo FROM achados a WHERE a.chave = cf.chave
                ORDER BY CASE a.severidade WHEN 'critico' THEN 0 WHEN 'atencao' THEN 1 ELSE 2 END, a.id
                LIMIT 1) AS primeiro_codigo
      FROM documentos d
      LEFT JOIN clientes cl ON cl.id = d.cliente_id
      LEFT JOIN conferencias cf ON cf.chave = d.chave
      WHERE d.tipo IN ('NF-e','NFC-e')
      ORDER BY d.emitido_em DESC
    `).all().map((linha) => ({
      id: linha.id,
      type: linha.tipo,
      key: linha.chave,
      clientId: linha.cliente_id,
      clientName: linha.cliente_nome || "Nao vinculado",
      date: linha.emitido_em,
      amount: linha.valor,
      operation: linha.operacao,
      cancelled: deBool(linha.cancelado),
      status: linha.situacao || "Nao conferido",
      findings: linha.total ?? 0,
      alert: linha.total
        ? linha.primeiro_codigo + (linha.total > 1 ? " e mais " + (linha.total - 1) : "")
        : ""
    }));
  },

  /** Visao Servicos/NFS-e. */
  visaoNfse() {
    return bd().prepare(`
      SELECT d.id, d.chave, d.numero, d.cliente_id, d.emitido_em, d.valor, d.dados, d.cancelado,
             cl.nome AS cliente_nome, cf.situacao, cf.total,
             (SELECT titulo FROM achados a WHERE a.chave = cf.chave
                ORDER BY CASE a.severidade WHEN 'critico' THEN 0 WHEN 'atencao' THEN 1 ELSE 2 END, a.id
                LIMIT 1) AS primeiro_titulo
      FROM documentos d
      LEFT JOIN clientes cl ON cl.id = d.cliente_id
      LEFT JOIN conferencias cf ON cf.chave = d.chave
      WHERE d.tipo = 'NFS-e'
      ORDER BY d.emitido_em DESC
    `).all().map((linha) => {
      const servico = deJson(linha.dados, {}).service || {};
      return {
        id: linha.id,
        number: linha.numero,
        clientId: linha.cliente_id,
        clientName: linha.cliente_nome || "Nao vinculado",
        date: linha.emitido_em,
        amount: servico.gross ?? linha.valor,
        retention: servico.withheldValue ?? 0,
        iss: servico.iss ?? 0,
        rate: servico.rate ?? 0,
        cancelled: deBool(linha.cancelado),
        status: linha.situacao || "Nao conferido",
        findings: linha.total ?? 0,
        alert: linha.total ? linha.primeiro_titulo : ""
      };
    });
  }
};

// --------------------------------------------------------------- conferencias

function montarAchado(linha) {
  return {
    code: linha.codigo,
    severity: linha.severidade,
    scope: linha.escopo,
    item: linha.item,
    title: linha.titulo,
    expected: deJson(linha.esperado, linha.esperado),
    found: deJson(linha.encontrado, linha.encontrado),
    difference: linha.diferenca,
    basis: linha.conta || "",
    rule: linha.base_normativa || "",
    justification: linha.justificativa || undefined,
    justifiedBy: linha.justificado_por || undefined,
    justifiedAt: linha.justificado_em || undefined
  };
}

function montarConferencia(linha, achadosDaChave) {
  return {
    documentKey: linha.chave,
    documentId: linha.documento_id,
    clientId: linha.cliente_id,
    clientName: clientes.nome(linha.cliente_id),
    kind: linha.tipo,
    number: linha.numero,
    issuedAt: linha.emitido_em,
    checkedAt: linha.conferido_em,
    findings: achadosDaChave,
    summary: {
      total: linha.total,
      critico: linha.criticos,
      atencao: linha.atencao,
      informativo: Math.max(0, linha.total - linha.criticos - linha.atencao),
      status: linha.situacao
    }
  };
}

export const conferencias = {
  /** A conferencia (e os achados) passa a responder pela chave nova do mesmo documento. */
  trocarChave(antiga, nova) {
    transacao((base) => {
      base.exec("PRAGMA defer_foreign_keys = ON");
      base.prepare("UPDATE achados SET chave = ? WHERE chave = ?").run(nova, antiga);
      base.prepare("UPDATE conferencias SET chave = ? WHERE chave = ?").run(nova, antiga);
    });
  },

  /** Grava a conferencia e seus achados, preservando justificativas do mesmo achado. */
  salvar(resultado, { clienteId, documentoId }) {
    return transacao((base) => {
      const justificadas = new Map();
      for (const linha of base.prepare(
        "SELECT codigo, item, justificativa, justificado_por, justificado_em FROM achados" +
        " WHERE chave = ? AND justificativa IS NOT NULL"
      ).all(resultado.documentKey)) {
        justificadas.set(linha.codigo + "|" + (linha.item ?? ""), linha);
      }

      base.prepare("DELETE FROM achados WHERE chave = ?").run(resultado.documentKey);
      base.prepare(
        "INSERT INTO conferencias (chave,documento_id,cliente_id,tipo,numero,emitido_em," +
        "situacao,criticos,atencao,total,conferido_em) VALUES (?,?,?,?,?,?,?,?,?,?,?)" +
        " ON CONFLICT(chave) DO UPDATE SET documento_id=excluded.documento_id," +
        " cliente_id=excluded.cliente_id, tipo=excluded.tipo, numero=excluded.numero," +
        " emitido_em=excluded.emitido_em, situacao=excluded.situacao, criticos=excluded.criticos," +
        " atencao=excluded.atencao, total=excluded.total, conferido_em=excluded.conferido_em"
      ).run(
        resultado.documentKey, documentoId, clienteId || null, resultado.kind,
        resultado.number || null, resultado.issuedAt || null, resultado.summary.status,
        resultado.summary.critico, resultado.summary.atencao, resultado.summary.total, agora()
      );

      const inserir = base.prepare(
        "INSERT INTO achados (chave,codigo,severidade,escopo,item,titulo,esperado,encontrado," +
        "diferenca,conta,base_normativa,justificativa,justificado_por,justificado_em)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      );
      for (const achado of resultado.findings) {
        const anterior = justificadas.get(achado.code + "|" + (achado.item ?? ""));
        inserir.run(
          resultado.documentKey, achado.code, achado.severity, achado.scope || null,
          achado.item ?? null, achado.title,
          paraJson(achado.expected), paraJson(achado.found),
          achado.difference ?? null, achado.basis || null, achado.rule || null,
          anterior?.justificativa ?? achado.justification ?? null,
          anterior?.justificado_por ?? achado.justifiedBy ?? null,
          anterior?.justificado_em ?? achado.justifiedAt ?? null
        );
      }

      return this.porChave(resultado.documentKey);
    });
  },

  porChave(valor) {
    const linha = bd().prepare(
      "SELECT * FROM conferencias WHERE chave = ? OR documento_id = ? LIMIT 1"
    ).get(valor, valor);
    if (!linha) return null;
    const achados = bd().prepare("SELECT * FROM achados WHERE chave = ? ORDER BY id").all(linha.chave)
      .map(montarAchado);
    return montarConferencia(linha, achados);
  },

  contar() {
    return bd().prepare("SELECT count(*) c FROM conferencias").get().c;
  },

  /** Lista com resumo, sem carregar os achados de cada documento. */
  listar() {
    return bd().prepare(`
      SELECT cf.*, cl.nome AS cliente_nome,
             (SELECT count(*) FROM achados a WHERE a.chave = cf.chave AND a.justificativa IS NULL) AS abertos
      FROM conferencias cf
      LEFT JOIN clientes cl ON cl.id = cf.cliente_id
      ORDER BY cf.conferido_em DESC
    `).all().map((linha) => ({
      documentKey: linha.chave,
      documentId: linha.documento_id,
      kind: linha.tipo,
      number: linha.numero,
      issuedAt: linha.emitido_em,
      clientId: linha.cliente_id,
      clientName: linha.cliente_nome || "Nao vinculado",
      checkedAt: linha.conferido_em,
      abertos: linha.abertos,
      summary: {
        total: linha.total, critico: linha.criticos, atencao: linha.atencao,
        informativo: Math.max(0, linha.total - linha.criticos - linha.atencao),
        status: linha.situacao
      }
    }));
  },

  consolidado() {
    const base = bd().prepare(`
      SELECT count(*) documentos,
             sum(CASE WHEN situacao = 'Conforme' THEN 1 ELSE 0 END) conformes,
             sum(CASE WHEN situacao = 'Atencao' THEN 1 ELSE 0 END) atencao,
             sum(CASE WHEN situacao = 'Irregular' THEN 1 ELSE 0 END) irregulares
      FROM conferencias
    `).get();
    const achados = bd().prepare(
      "SELECT count(*) total, sum(CASE WHEN justificativa IS NOT NULL THEN 1 ELSE 0 END) tratados FROM achados"
    ).get();
    const porCodigo = bd().prepare(`
      SELECT codigo code, severidade severity, count(*) count,
             sum(CASE WHEN justificativa IS NOT NULL THEN 1 ELSE 0 END) tratados,
             min(titulo) title
      FROM achados GROUP BY codigo, severidade ORDER BY count(*) DESC
    `).all();
    return {
      documentos: base.documentos || 0,
      conformes: base.conformes || 0,
      atencao: base.atencao || 0,
      irregulares: base.irregulares || 0,
      achados: achados.total || 0,
      tratados: achados.tratados || 0,
      porCodigo
    };
  },

  justificar(chave, { codigo, item, texto, usuario }) {
    const conferencia = this.porChave(chave);
    if (!conferencia) return null;
    const condicoes = ["chave = ?"];
    const parametros = [conferencia.documentKey];
    if (codigo) { condicoes.push("codigo = ?"); parametros.push(codigo); }
    if (item !== undefined && item !== null) { condicoes.push("item = ?"); parametros.push(item); }

    const resultado = bd().prepare(
      "UPDATE achados SET justificativa = ?, justificado_por = ?, justificado_em = ? WHERE " +
      condicoes.join(" AND ")
    ).run(texto, usuario, agora(), ...parametros);

    return { justificados: Number(resultado.changes) || 0, conferencia: this.porChave(chave) };
  },

  paraVigilancia() {
    const porChave = new Map();
    for (const linha of bd().prepare(
      "SELECT chave, codigo, severidade, justificativa FROM achados"
    ).all()) {
      if (!porChave.has(linha.chave)) porChave.set(linha.chave, []);
      porChave.get(linha.chave).push({
        code: linha.codigo,
        severity: linha.severidade,
        justification: linha.justificativa || undefined
      });
    }
    return bd().prepare("SELECT chave, tipo, numero, cliente_id FROM conferencias").all()
      .map((linha) => ({
        documentKey: linha.chave,
        kind: linha.tipo,
        number: linha.numero,
        clientId: linha.cliente_id,
        findings: porChave.get(linha.chave) || []
      }));
  },

  /** Relatorio: um achado por linha, sem carregar tudo na memoria de uma vez. */
  paraRelatorio(clienteId = null) {
    const sql = `
      SELECT cf.chave, cf.tipo, cf.numero, cf.emitido_em, cf.situacao, cl.nome AS cliente_nome,
             a.codigo, a.item, a.titulo, a.esperado, a.encontrado, a.diferenca,
             a.conta, a.base_normativa, a.justificativa
      FROM conferencias cf
      LEFT JOIN clientes cl ON cl.id = cf.cliente_id
      LEFT JOIN achados a ON a.chave = cf.chave
      ${clienteId ? "WHERE cf.cliente_id = ?" : ""}
      ORDER BY cf.emitido_em DESC, a.id
    `;
    const consulta = bd().prepare(sql);
    return clienteId ? consulta.all(clienteId) : consulta.all();
  }
};

// -------------------------------------------------------------------- alertas

function montarAlerta(linha) {
  return {
    id: linha.id,
    code: linha.codigo,
    source: linha.fonte,
    severity: linha.severidade,
    clientId: linha.cliente_id,
    clientName: clientes.nome(linha.cliente_id),
    title: linha.titulo,
    detail: linha.detalhe,
    evidence: deJson(linha.evidencia, {}),
    status: linha.situacao,
    detectedAt: linha.detectado_em,
    dueAt: linha.vence_em,
    handledBy: linha.tratado_por,
    handledAt: linha.tratado_em,
    reason: linha.motivo
  };
}

const ORDEM_SEVERIDADE = "CASE severidade WHEN 'critico' THEN 0 WHEN 'atencao' THEN 1 ELSE 2 END";

export const alertas = {
  listar() {
    return bd().prepare(
      "SELECT * FROM alertas ORDER BY " + ORDEM_SEVERIDADE + ", detectado_em DESC"
    ).all().map(montarAlerta);
  },

  porId(id) {
    const linha = bd().prepare("SELECT * FROM alertas WHERE id = ?").get(id);
    return linha ? montarAlerta(linha) : null;
  },

  /** Substitui a fila pelo resultado da vigilancia. O merge de status e do vigiar(). */
  substituir(lista) {
    transacao((base) => {
      base.prepare("DELETE FROM alertas").run();
      const inserir = base.prepare(
        "INSERT INTO alertas (id,codigo,fonte,severidade,cliente_id,titulo,detalhe,evidencia," +
        "situacao,detectado_em,vence_em,tratado_por,tratado_em,motivo)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      );
      for (const item of lista) {
        inserir.run(
          item.id, item.code, item.source, item.severity, item.clientId || null,
          item.title, item.detail || null, paraJson(item.evidence),
          item.status || "Pendente", item.detectedAt, item.dueAt || null,
          item.handledBy || null, item.handledAt || null, item.reason || null
        );
      }
    });
  },

  tratar(id, { situacao, usuario, motivo }) {
    bd().prepare(
      "UPDATE alertas SET situacao = ?, tratado_por = ?, tratado_em = ?, motivo = ? WHERE id = ?"
    ).run(situacao, usuario, agora(), motivo || null, id);
    return this.porId(id);
  },

  contarPendentes() {
    return bd().prepare("SELECT count(*) c FROM alertas WHERE situacao = 'Pendente'").get().c;
  },

  /** Agrupamento do dashboard: fonte + codigo, com contagem. */
  agrupadosPendentes() {
    return bd().prepare(
      "SELECT fonte source, codigo code, min(titulo) label, min(severidade) severity, count(*) count" +
      " FROM alertas WHERE situacao = 'Pendente' GROUP BY fonte, codigo ORDER BY count(*) DESC"
    ).all();
  },

  metricas() {
    const uma = (sql, ...p) => bd().prepare(sql).get(...p);
    return {
      pendentes: this.contarPendentes(),
      criticos: uma("SELECT count(DISTINCT cliente_id) c FROM alertas WHERE situacao='Pendente' AND severidade='critico' AND cliente_id IS NOT NULL").c,
      afetados: uma("SELECT count(DISTINCT cliente_id) c FROM alertas WHERE situacao='Pendente' AND cliente_id IS NOT NULL").c,
      semEmissao: uma("SELECT count(*) c FROM alertas WHERE situacao='Pendente' AND codigo LIKE 'SEM_EMISSAO%'").c,
      capturasFalhas: uma("SELECT count(*) c FROM alertas WHERE situacao='Pendente' AND codigo IN ('CAPTURA_FALHA','ROTINA_FALHA')").c,
      das: uma("SELECT count(*) c FROM alertas WHERE situacao='Pendente' AND codigo LIKE 'DAS_%'").c
    };
  },

  paraRelatorio(clienteId = null) {
    const sql = "SELECT a.*, cl.nome AS cliente_nome FROM alertas a" +
      " LEFT JOIN clientes cl ON cl.id = a.cliente_id" +
      (clienteId ? " WHERE a.cliente_id = ?" : "") +
      " ORDER BY " + ORDEM_SEVERIDADE.replace(/severidade/g, "a.severidade") + ", a.detectado_em DESC";
    const consulta = bd().prepare(sql);
    return clienteId ? consulta.all(clienteId) : consulta.all();
  }
};

// ----------------------------------------------------------------- ocorrencias

export const ocorrencias = {
  inserir({ titulo, fonte = "SIST", severidade = "informativo", clienteId = null, dados = null }) {
    bd().prepare(
      "INSERT INTO ocorrencias (quando,titulo,fonte,severidade,cliente_id,dados) VALUES (?,?,?,?,?,?)"
    ).run(agora(), titulo, fonte, severidade, clienteId, paraJson(dados));
  },

  listar(limite = 500) {
    return bd().prepare(
      "SELECT o.*, cl.nome AS cliente_nome FROM ocorrencias o" +
      " LEFT JOIN clientes cl ON cl.id = o.cliente_id" +
      " ORDER BY o.id DESC LIMIT ?"
    ).all(limite).map((linha) => ({
      id: linha.id,
      time: linha.quando,
      title: linha.titulo,
      source: linha.fonte,
      severity: linha.severidade,
      clientId: linha.cliente_id,
      clientName: linha.cliente_nome || "Nao vinculado",
      data: deJson(linha.dados)
    }));
  }
};

// ------------------------------------------------------------------ apuracoes

function montarApuracao(linha) {
  const dados = deJson(linha.dados, {});
  return {
    ...dados,
    id: linha.id,
    clientId: linha.cliente_id,
    clientName: clientes.nome(linha.cliente_id),
    period: linha.competencia,
    type: linha.tipo,
    amount: linha.valor,
    status: linha.situacao,
    anexo: linha.anexo,
    faixa: linha.faixa,
    rbt12: linha.rbt12,
    receitaMes: linha.receita_mes,
    aliquotaNominal: linha.aliquota_nominal,
    deducao: linha.deducao,
    aliquotaEfetiva: linha.aliquota_efetiva,
    vigenciaAplicavel: linha.vigencia_aplicavel === null ? null : deBool(linha.vigencia_aplicavel),
    apuradoEm: linha.apurado_em,
    apuradoPor: linha.apurado_por
  };
}

export const apuracoes = {
  salvar(resultado, { clienteId, competencia, usuario }) {
    const existente = bd().prepare(
      "SELECT id FROM apuracoes WHERE cliente_id = ? AND competencia = ?"
    ).get(clienteId, competencia);
    const id = existente?.id || uuid();

    // segmentos: cada parcela da receita no seu anexo (com mais de uma, nominal,
    // deducao e efetiva ficam nelas, e as colunas do topo vao nulas).
    const { tributos, foraDoDas, fatorR, memoria, avisos, origem, vigencia, segmentos } = resultado;
    bd().prepare(
      "INSERT INTO apuracoes (id,cliente_id,competencia,tipo,valor,situacao,anexo,faixa,rbt12," +
      "receita_mes,aliquota_nominal,deducao,aliquota_efetiva,vigencia_aplicavel,dados,apurado_em,apurado_por)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)" +
      " ON CONFLICT(cliente_id,competencia) DO UPDATE SET valor=excluded.valor," +
      " situacao=excluded.situacao, anexo=excluded.anexo, faixa=excluded.faixa, rbt12=excluded.rbt12," +
      " receita_mes=excluded.receita_mes, aliquota_nominal=excluded.aliquota_nominal," +
      " deducao=excluded.deducao, aliquota_efetiva=excluded.aliquota_efetiva," +
      " vigencia_aplicavel=excluded.vigencia_aplicavel, dados=excluded.dados," +
      " apurado_em=excluded.apurado_em, apurado_por=excluded.apurado_por"
    ).run(
      id, clienteId, competencia, "DAS", resultado.das ?? 0, resultado.status,
      resultado.anexo || null, resultado.faixa ?? null, resultado.rbt12 ?? null,
      resultado.receitaMes ?? null, resultado.aliquotaNominal ?? null, resultado.deducao ?? null,
      resultado.aliquotaEfetiva ?? null,
      resultado.vigenciaAplicavel === null || resultado.vigenciaAplicavel === undefined
        ? null : paraBool(resultado.vigenciaAplicavel),
      paraJson({ tributos, foraDoDas, fatorR, memoria, avisos, origem, vigencia, anexoNome: resultado.anexoNome,
        segmentos: segmentos || [] }),
      agora(), usuario
    );

    return this.porId(id);
  },

  porId(id) {
    const linha = bd().prepare("SELECT * FROM apuracoes WHERE id = ?").get(id);
    return linha ? montarApuracao(linha) : null;
  },

  listar() {
    return bd().prepare("SELECT * FROM apuracoes ORDER BY competencia DESC").all().map((linha) => {
      const item = montarApuracao(linha);
      item.alerts = bd().prepare(
        "SELECT count(*) c FROM alertas WHERE cliente_id = ? AND situacao = 'Pendente' AND codigo LIKE 'DAS_%'"
      ).get(linha.cliente_id).c;
      return item;
    });
  },

  /** Forma reduzida que os monitores consomem. */
  paraVigilancia() {
    return bd().prepare(
      "SELECT cliente_id, competencia, situacao, valor, rbt12 FROM apuracoes"
    ).all().map((linha) => ({
      clientId: linha.cliente_id,
      period: linha.competencia,
      status: linha.situacao,
      amount: linha.valor,
      rbt12: linha.rbt12
    }));
  },

  contarAbertas() {
    return bd().prepare("SELECT count(*) c FROM apuracoes WHERE situacao = 'Aberto'").get().c;
  },

  paraRelatorio(clienteId = null) {
    const sql = "SELECT a.*, cl.nome AS cliente_nome FROM apuracoes a" +
      " LEFT JOIN clientes cl ON cl.id = a.cliente_id" +
      (clienteId ? " WHERE a.cliente_id = ?" : "") + " ORDER BY a.competencia DESC";
    const consulta = bd().prepare(sql);
    return (clienteId ? consulta.all(clienteId) : consulta.all()).map((linha) => ({
      ...montarApuracao(linha),
      clientName: linha.cliente_nome || "Nao vinculado"
    }));
  }
};

// -------------------------------------------------------- rotinas, importacoes

export const rotinas = {
  inserir({ tipo, alvo, iniciadoPor }) {
    const id = uuid();
    bd().prepare(
      "INSERT INTO rotinas (id,quando,tipo,alvo,situacao,iniciado_por) VALUES (?,?,?,?,?,?)"
    ).run(id, agora(), tipo, alvo || "Todos", "Processando", iniciadoPor);
    return id;
  },

  concluir(id, { situacao, detalhe, duracaoMs, resultado = null }) {
    bd().prepare(
      "UPDATE rotinas SET situacao = ?, detalhe = ?, duracao_ms = ?, resultado = ? WHERE id = ?"
    ).run(situacao, detalhe || null, duracaoMs ?? null, paraJson(resultado), id);
    return this.porId(id);
  },

  porId(id) {
    const linha = bd().prepare("SELECT * FROM rotinas WHERE id = ?").get(id);
    if (!linha) return null;
    return {
      id: linha.id, date: linha.quando, type: linha.tipo, target: linha.alvo,
      status: linha.situacao, details: linha.detalhe, durationMs: linha.duracao_ms,
      startedBy: linha.iniciado_por, result: deJson(linha.resultado)
    };
  },

  listar(limite = 200) {
    return bd().prepare("SELECT id FROM rotinas ORDER BY quando DESC LIMIT ?").all(limite)
      .map((linha) => this.porId(linha.id));
  },

  paraVigilancia() {
    return bd().prepare("SELECT id, tipo, situacao, detalhe FROM rotinas WHERE situacao = 'Erro'").all()
      .map((linha) => ({ id: linha.id, type: linha.tipo, status: linha.situacao, details: linha.detalhe }));
  }
};

export const importacoes = {
  inserir(registro) {
    const id = uuid();
    bd().prepare(
      "INSERT INTO importacoes (id,quando,modulo,metodo,situacao,clientes,documentos,duplicados," +
      "erros,sem_cliente,upload_id,duracao_ms,detalhe) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(
      id, agora(), registro.module, registro.method, registro.status,
      registro.clients || 0, registro.documents || 0, registro.duplicates || 0,
      paraJson(registro.errors || []), paraJson(registro.unlinked || []),
      registro.uploadId || null, registro.durationMs ?? null, registro.details || null
    );
    return this.porId(id);
  },

  porId(id) {
    const linha = bd().prepare("SELECT * FROM importacoes WHERE id = ?").get(id);
    if (!linha) return null;
    return {
      id: linha.id, date: linha.quando, module: linha.modulo, method: linha.metodo,
      status: linha.situacao, clients: linha.clientes, documents: linha.documentos,
      duplicates: linha.duplicados, errors: deJson(linha.erros, []),
      unlinked: deJson(linha.sem_cliente, []), uploadId: linha.upload_id,
      durationMs: linha.duracao_ms, details: linha.detalhe
    };
  },

  listar(limite = 200) {
    return bd().prepare("SELECT id FROM importacoes ORDER BY quando DESC LIMIT ?").all(limite)
      .map((linha) => this.porId(linha.id));
  },

  paraVigilancia() {
    return bd().prepare(
      "SELECT id, modulo, situacao, erros, detalhe FROM importacoes WHERE situacao = 'Erro'"
    ).all().map((linha) => ({
      id: linha.id, module: linha.modulo, status: linha.situacao,
      errors: deJson(linha.erros, []), details: linha.detalhe
    }));
  },

  contarErros() {
    return bd().prepare("SELECT count(*) c FROM importacoes WHERE situacao = 'Erro'").get().c;
  }
};

// ------------------------------------------------------- uploads e relatorios

export const uploads = {
  inserir(item) {
    bd().prepare(
      "INSERT INTO uploads (id,nome,nome_no_disco,finalidade,tamanho,sha256,quando,situacao,enviado_por)" +
      " VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(item.id, item.filename, item.storedName, item.kind, item.size,
      item.sha256, item.date, item.status, item.uploadedBy);
    return this.porId(item.id);
  },

  porId(id) {
    const linha = bd().prepare("SELECT * FROM uploads WHERE id = ?").get(id);
    return linha ? this.montar(linha) : null;
  },

  porSha(sha) {
    const linha = bd().prepare("SELECT * FROM uploads WHERE sha256 = ?").get(sha);
    return linha ? this.montar(linha) : null;
  },

  montar(linha) {
    return {
      id: linha.id, filename: linha.nome, storedName: linha.nome_no_disco,
      kind: linha.finalidade, size: linha.tamanho, sha256: linha.sha256,
      date: linha.quando, status: linha.situacao, uploadedBy: linha.enviado_por
    };
  },

  listar() {
    return bd().prepare("SELECT * FROM uploads ORDER BY quando DESC").all()
      .map((linha) => {
        const { storedName, ...resto } = this.montar(linha);
        return resto;
      });
  }
};

export const relatorios = {
  inserir(item) {
    bd().prepare(
      "INSERT INTO relatorios (id,nome,tipo,modulo,competencia,cliente_id,situacao,linhas,arquivo," +
      "pedido_por,pedido_em) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).run(item.id, item.name, item.type, item.module, item.period, item.clientId,
      item.status, item.rows, item.file, item.requestedBy, item.requestedAt);
    return this.porId(item.id);
  },

  porId(id) {
    const linha = bd().prepare("SELECT * FROM relatorios WHERE id = ?").get(id);
    if (!linha) return null;
    return {
      id: linha.id, name: linha.nome, type: linha.tipo, module: linha.modulo,
      period: linha.competencia, clientId: linha.cliente_id, status: linha.situacao,
      rows: linha.linhas, file: linha.arquivo, requestedBy: linha.pedido_por,
      requestedAt: linha.pedido_em
    };
  },

  listar() {
    return bd().prepare("SELECT id FROM relatorios ORDER BY pedido_em DESC").all()
      .map((linha) => this.porId(linha.id));
  }
};

// -------------------------------------------------------------------- regras

function montarRegra(linha) {
  return {
    id: linha.id, module: linha.modulo, type: linha.tipo, key: linha.chave,
    expectedRate: linha.aliquota_esperada, status: linha.situacao, description: linha.descricao
  };
}

export const regras = {
  listar() {
    return bd().prepare("SELECT * FROM regras ORDER BY modulo, tipo, chave").all().map(montarRegra);
  },

  ativas() {
    return bd().prepare("SELECT * FROM regras WHERE situacao = 'Ativa'").all().map(montarRegra);
  },

  porId(id) {
    const linha = bd().prepare("SELECT * FROM regras WHERE id = ?").get(id);
    return linha ? montarRegra(linha) : null;
  },

  criar(entrada) {
    const id = uuid();
    bd().prepare(
      "INSERT INTO regras (id,modulo,tipo,chave,aliquota_esperada,situacao,descricao) VALUES (?,?,?,?,?,?,?)"
    ).run(id, entrada.module, entrada.type, entrada.key,
      entrada.expectedRate === undefined || entrada.expectedRate === null ? null : Number(entrada.expectedRate),
      entrada.status || "Ativa", entrada.description);
    return this.porId(id);
  },

  atualizar(id, entrada) {
    const atual = this.porId(id);
    if (!atual) return null;
    bd().prepare(
      "UPDATE regras SET modulo=?, tipo=?, chave=?, aliquota_esperada=?, situacao=?, descricao=? WHERE id=?"
    ).run(
      entrada.module ?? atual.module, entrada.type ?? atual.type, entrada.key ?? atual.key,
      entrada.expectedRate === undefined ? atual.expectedRate
        : (entrada.expectedRate === null ? null : Number(entrada.expectedRate)),
      entrada.status ?? atual.status, entrada.description ?? atual.description, id
    );
    return this.porId(id);
  }
};

// --------------------------------------------------------------- integracoes

export const integracoes = {
  /** Credenciais em claro, para uso do adaptador. Nunca devolver pela API. */
  config(adaptador) {
    if (!chaveConfigurada()) return {};
    const saida = {};
    for (const linha of bd().prepare(
      "SELECT chave, valor_cifrado FROM integracoes WHERE adaptador = ?"
    ).all(adaptador)) {
      try {
        saida[linha.chave] = decifrar(linha.valor_cifrado);
      } catch {
        // Chave mestra trocada: o segredo antigo fica ilegivel, e isso precisa
        // aparecer como "falta configurar", nao como credencial vazia valida.
      }
    }
    return saida;
  },

  /** Quais chaves estao preenchidas, sem os valores. */
  chavesPreenchidas(adaptador) {
    return bd().prepare("SELECT chave FROM integracoes WHERE adaptador = ?").all(adaptador)
      .map((linha) => linha.chave);
  },

  todasAsChaves() {
    const saida = {};
    for (const linha of bd().prepare("SELECT adaptador, chave FROM integracoes").all()) {
      if (!saida[linha.adaptador]) saida[linha.adaptador] = {};
      saida[linha.adaptador][linha.chave] = true;
    }
    return saida;
  },

  salvar(adaptador, credenciais, usuario) {
    const gravadas = [];
    transacao((base) => {
      const inserir = base.prepare(
        "INSERT INTO integracoes (adaptador,chave,valor_cifrado,atualizado_em,atualizado_por)" +
        " VALUES (?,?,?,?,?) ON CONFLICT(adaptador,chave) DO UPDATE SET" +
        " valor_cifrado=excluded.valor_cifrado, atualizado_em=excluded.atualizado_em," +
        " atualizado_por=excluded.atualizado_por"
      );
      const remover = base.prepare("DELETE FROM integracoes WHERE adaptador = ? AND chave = ?");
      for (const [chave, valor] of Object.entries(credenciais || {})) {
        if (valor === "" || valor === null || valor === undefined) {
          remover.run(adaptador, chave);
          continue;
        }
        inserir.run(adaptador, chave, cifrar(String(valor)), agora(), usuario);
        gravadas.push(chave);
      }
    });
    return gravadas;
  }
};

// -------------------------------------------------------------- configuracoes

export const configuracoes = {
  ler(chave, padrao = null) {
    const linha = bd().prepare("SELECT valor FROM configuracoes WHERE chave = ?").get(chave);
    return linha ? deJson(linha.valor, padrao) : padrao;
  },

  gravar(chave, valor) {
    bd().prepare(
      "INSERT INTO configuracoes (chave,valor) VALUES (?,?)" +
      " ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor"
    ).run(chave, paraJson(valor));
  },

  todas() {
    const saida = {};
    for (const linha of bd().prepare("SELECT chave, valor FROM configuracoes").all()) {
      saida[linha.chave] = deJson(linha.valor);
    }
    return saida;
  }
};

// ------------------------------------------------------------------ auditoria

export const auditoria = {
  /**
   * Append puro: a tabela tem trigger que aborta UPDATE e DELETE.
   *
   * A cabeca e lida e o evento gravado na mesma transacao, com a sequencia
   * explicita (a mesma que entra no hash) e o elo unico (hash_anterior): dois
   * gravadores que leram a mesma cabeca nao criam duas pontas; quem perde a
   * corrida le a cabeca nova e grava de novo.
   */
  anexar({ user, action, target, data = null }) {
    for (let tentativa = 1; ; tentativa += 1) {
      try {
        return transacao((base) => {
          const anterior = base.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").get();
          const evento = proximoEvento(anterior || null, { user, action, target, data });
          base.prepare(
            "INSERT INTO audit_log (seq,quando,usuario,acao,alvo,dados,hash_dados,hash_anterior,hash,assinatura)" +
            " VALUES (?,?,?,?,?,?,?,?,?,?)"
          ).run(evento.seq, evento.at, evento.user, evento.action, evento.target,
            paraJson(evento.data), evento.dataHash, evento.prevHash, evento.hash, evento.signature);
          return evento;
        });
      } catch (erro) {
        if (tentativa >= 5 || !/UNIQUE|PRIMARY KEY|constraint/i.test(String(erro.message))) throw erro;
      }
    }
  },

  montar(linha) {
    return {
      seq: linha.seq, at: linha.quando, user: linha.usuario, action: linha.acao,
      target: linha.alvo, data: deJson(linha.dados), dataHash: linha.hash_dados,
      prevHash: linha.hash_anterior, hash: linha.hash, signature: linha.assinatura
    };
  },

  todos() {
    return bd().prepare("SELECT * FROM audit_log ORDER BY seq").all().map((l) => this.montar(l));
  },

  verificar() {
    return verificar(this.todos());
  },

  consultar({ user, action, target, limite = 200 } = {}) {
    const condicoes = [];
    const parametros = [];
    if (user) { condicoes.push("usuario = ?"); parametros.push(user); }
    if (action) { condicoes.push("acao LIKE ?"); parametros.push("%" + action + "%"); }
    if (target) { condicoes.push("alvo = ?"); parametros.push(target); }
    const sql = "SELECT * FROM audit_log" +
      (condicoes.length ? " WHERE " + condicoes.join(" AND ") : "") +
      " ORDER BY seq DESC LIMIT ?";
    return bd().prepare(sql).all(...parametros, limite).map((l) => this.montar(l));
  },

  historico(alvo) {
    return bd().prepare("SELECT * FROM audit_log WHERE alvo = ? ORDER BY seq").all(alvo)
      .map((linha) => {
        const evento = this.montar(linha);
        return {
          seq: evento.seq, at: evento.at, user: evento.user,
          action: evento.action, data: evento.data, hash: evento.hash
        };
      });
  },

  contar() {
    return bd().prepare("SELECT count(*) c FROM audit_log").get().c;
  },

  cabeca() {
    const linha = bd().prepare("SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1").get();
    return linha ? linha.hash : GENESIS;
  }
};
