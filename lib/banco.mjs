// Persistencia em SQLite, com migrations versionadas.
//
// Usa `node:sqlite`, embutido no Node a partir da 22.5 e estavel na 24: continua
// sem dependencia externa. Substitui o `data/db.json`, que era reescrito inteiro
// a cada alteracao (custo proporcional ao acervo) e nao suportava mais de um
// processo escrevendo.
//
// A tabela `audit_log` e append-only de verdade: triggers no banco abortam
// UPDATE e DELETE. Nem a propria aplicacao consegue reescrever um evento.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Cada migration roda uma vez, em ordem, dentro de uma transacao. Nunca edite
// uma migration ja aplicada: acrescente outra.
const MIGRACOES = [
  {
    versao: 1,
    nome: "esquema inicial",
    sql: `
      CREATE TABLE usuarios (
        id            TEXT PRIMARY KEY,
        nome          TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE,
        senha         TEXT NOT NULL,
        perfil        TEXT NOT NULL,
        trocar_senha  INTEGER NOT NULL DEFAULT 0,
        ativo         INTEGER NOT NULL DEFAULT 1,
        criado_em     TEXT NOT NULL
      );

      CREATE TABLE sessoes (
        id         TEXT PRIMARY KEY,
        usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        criada_em  TEXT NOT NULL,
        expira_em  INTEGER NOT NULL
      );
      CREATE INDEX idx_sessoes_expira ON sessoes(expira_em);

      CREATE TABLE clientes (
        id          TEXT PRIMARY KEY,
        cnpj        TEXT NOT NULL,
        cnpj_digits TEXT NOT NULL UNIQUE,
        nome        TEXT NOT NULL,
        cidade      TEXT,
        regime      TEXT,
        anexo       TEXT,
        rbt12       REAL,
        folha12     REAL,
        modulos     TEXT NOT NULL DEFAULT '[]',
        demo        INTEGER NOT NULL DEFAULT 0,
        criado_em   TEXT NOT NULL
      );
      CREATE INDEX idx_clientes_cnpj ON clientes(cnpj_digits);

      CREATE TABLE certificados (
        id              TEXT PRIMARY KEY,
        cliente_id      TEXT REFERENCES clientes(id) ON DELETE CASCADE,
        tipo            TEXT NOT NULL,
        vence_em        TEXT,
        uso             TEXT,
        titular         TEXT,
        emissor         TEXT,
        serie           TEXT,
        lido_do_arquivo INTEGER NOT NULL DEFAULT 0,
        criado_em       TEXT NOT NULL
      );
      CREATE INDEX idx_certificados_cliente ON certificados(cliente_id);
      CREATE INDEX idx_certificados_vence ON certificados(vence_em);

      -- O documento normalizado fica em JSON na coluna 'dados', porque o layout
      -- varia por modelo. As colunas de fora existem para consulta e indice.
      CREATE TABLE documentos (
        id          TEXT PRIMARY KEY,
        chave       TEXT NOT NULL,
        identidade  TEXT NOT NULL UNIQUE,
        tipo        TEXT NOT NULL,
        numero      TEXT,
        serie       TEXT,
        emitido_em  TEXT,
        operacao    TEXT,
        emitente    TEXT,
        cliente_id  TEXT REFERENCES clientes(id) ON DELETE SET NULL,
        valor       REAL NOT NULL DEFAULT 0,
        cancelado   INTEGER NOT NULL DEFAULT 0,
        motivo_cancelamento TEXT,
        upload_id   TEXT,
        capturado_em TEXT NOT NULL,
        capturado_por TEXT,
        dados       TEXT NOT NULL
      );
      CREATE INDEX idx_documentos_cliente ON documentos(cliente_id);
      CREATE INDEX idx_documentos_emitido ON documentos(emitido_em);
      CREATE INDEX idx_documentos_emitente ON documentos(emitente);
      CREATE INDEX idx_documentos_chave ON documentos(chave);
      CREATE INDEX idx_documentos_tipo ON documentos(tipo);

      CREATE TABLE conferencias (
        chave        TEXT PRIMARY KEY,
        documento_id TEXT REFERENCES documentos(id) ON DELETE CASCADE,
        cliente_id   TEXT REFERENCES clientes(id) ON DELETE SET NULL,
        tipo         TEXT,
        numero       TEXT,
        emitido_em   TEXT,
        situacao     TEXT NOT NULL,
        criticos     INTEGER NOT NULL DEFAULT 0,
        atencao      INTEGER NOT NULL DEFAULT 0,
        total        INTEGER NOT NULL DEFAULT 0,
        conferido_em TEXT NOT NULL
      );
      CREATE INDEX idx_conferencias_cliente ON conferencias(cliente_id);
      CREATE INDEX idx_conferencias_situacao ON conferencias(situacao);

      -- Um achado por linha: permite relatorio e contagem sem abrir JSON.
      CREATE TABLE achados (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        chave          TEXT NOT NULL REFERENCES conferencias(chave) ON DELETE CASCADE,
        codigo         TEXT NOT NULL,
        severidade     TEXT NOT NULL,
        escopo         TEXT,
        item           INTEGER,
        titulo         TEXT NOT NULL,
        esperado       TEXT,
        encontrado     TEXT,
        diferenca      REAL,
        conta          TEXT,
        base_normativa TEXT,
        justificativa  TEXT,
        justificado_por TEXT,
        justificado_em TEXT
      );
      CREATE INDEX idx_achados_chave ON achados(chave);
      CREATE INDEX idx_achados_codigo ON achados(codigo);
      CREATE INDEX idx_achados_severidade ON achados(severidade);

      CREATE TABLE alertas (
        id          TEXT PRIMARY KEY,
        codigo      TEXT NOT NULL,
        fonte       TEXT NOT NULL,
        severidade  TEXT NOT NULL,
        cliente_id  TEXT REFERENCES clientes(id) ON DELETE CASCADE,
        titulo      TEXT NOT NULL,
        detalhe     TEXT,
        evidencia   TEXT,
        situacao    TEXT NOT NULL DEFAULT 'Pendente',
        detectado_em TEXT NOT NULL,
        vence_em    TEXT,
        tratado_por TEXT,
        tratado_em  TEXT,
        motivo      TEXT
      );
      CREATE INDEX idx_alertas_situacao ON alertas(situacao);
      CREATE INDEX idx_alertas_cliente ON alertas(cliente_id);

      CREATE TABLE ocorrencias (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        quando     TEXT NOT NULL,
        titulo     TEXT NOT NULL,
        fonte      TEXT,
        severidade TEXT,
        cliente_id TEXT REFERENCES clientes(id) ON DELETE SET NULL,
        dados      TEXT
      );
      CREATE INDEX idx_ocorrencias_quando ON ocorrencias(quando);

      CREATE TABLE apuracoes (
        id          TEXT PRIMARY KEY,
        cliente_id  TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        competencia TEXT NOT NULL,
        tipo        TEXT NOT NULL DEFAULT 'DAS',
        valor       REAL NOT NULL DEFAULT 0,
        situacao    TEXT NOT NULL,
        anexo       TEXT,
        faixa       INTEGER,
        rbt12       REAL,
        receita_mes REAL,
        aliquota_nominal  REAL,
        deducao           REAL,
        aliquota_efetiva  REAL,
        vigencia_aplicavel INTEGER,
        dados       TEXT NOT NULL,
        apurado_em  TEXT NOT NULL,
        apurado_por TEXT,
        UNIQUE(cliente_id, competencia)
      );
      CREATE INDEX idx_apuracoes_competencia ON apuracoes(competencia);

      CREATE TABLE rotinas (
        id         TEXT PRIMARY KEY,
        quando     TEXT NOT NULL,
        tipo       TEXT NOT NULL,
        alvo       TEXT,
        situacao   TEXT NOT NULL,
        detalhe    TEXT,
        duracao_ms INTEGER,
        iniciado_por TEXT,
        resultado  TEXT
      );
      CREATE INDEX idx_rotinas_quando ON rotinas(quando);

      CREATE TABLE importacoes (
        id          TEXT PRIMARY KEY,
        quando      TEXT NOT NULL,
        modulo      TEXT,
        metodo      TEXT,
        situacao    TEXT NOT NULL,
        clientes    INTEGER NOT NULL DEFAULT 0,
        documentos  INTEGER NOT NULL DEFAULT 0,
        duplicados  INTEGER NOT NULL DEFAULT 0,
        erros       TEXT,
        sem_cliente TEXT,
        upload_id   TEXT,
        duracao_ms  INTEGER,
        detalhe     TEXT
      );
      CREATE INDEX idx_importacoes_quando ON importacoes(quando);

      CREATE TABLE uploads (
        id           TEXT PRIMARY KEY,
        nome         TEXT NOT NULL,
        nome_no_disco TEXT NOT NULL,
        finalidade   TEXT,
        tamanho      INTEGER NOT NULL,
        sha256       TEXT NOT NULL UNIQUE,
        quando       TEXT NOT NULL,
        situacao     TEXT NOT NULL,
        enviado_por  TEXT
      );

      CREATE TABLE relatorios (
        id           TEXT PRIMARY KEY,
        nome         TEXT NOT NULL,
        tipo         TEXT NOT NULL,
        modulo       TEXT,
        competencia  TEXT,
        cliente_id   TEXT REFERENCES clientes(id) ON DELETE SET NULL,
        situacao     TEXT NOT NULL,
        linhas       INTEGER NOT NULL DEFAULT 0,
        arquivo      TEXT,
        pedido_por   TEXT,
        pedido_em    TEXT NOT NULL
      );

      CREATE TABLE regras (
        id               TEXT PRIMARY KEY,
        modulo           TEXT NOT NULL,
        tipo             TEXT NOT NULL,
        chave            TEXT NOT NULL,
        aliquota_esperada REAL,
        situacao         TEXT NOT NULL DEFAULT 'Ativa',
        descricao        TEXT NOT NULL
      );
      CREATE INDEX idx_regras_situacao ON regras(situacao);

      -- Valor de credencial nunca em texto plano: ver lib/segredos.mjs.
      CREATE TABLE integracoes (
        adaptador   TEXT NOT NULL,
        chave       TEXT NOT NULL,
        valor_cifrado TEXT NOT NULL,
        atualizado_em TEXT NOT NULL,
        atualizado_por TEXT,
        PRIMARY KEY (adaptador, chave)
      );

      CREATE TABLE configuracoes (
        chave TEXT PRIMARY KEY,
        valor TEXT NOT NULL
      );

      -- APPEND-ONLY: os triggers abaixo impedem alteracao e remocao de evento.
      CREATE TABLE audit_log (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        quando      TEXT NOT NULL,
        usuario     TEXT NOT NULL,
        acao        TEXT NOT NULL,
        alvo        TEXT NOT NULL,
        dados       TEXT,
        hash_dados  TEXT NOT NULL,
        hash_anterior TEXT NOT NULL,
        hash        TEXT NOT NULL,
        assinatura  TEXT
      );
      CREATE INDEX idx_audit_usuario ON audit_log(usuario);
      CREATE INDEX idx_audit_alvo ON audit_log(alvo);
      CREATE INDEX idx_audit_acao ON audit_log(acao);

      CREATE TRIGGER audit_sem_update BEFORE UPDATE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log e append-only: UPDATE bloqueado pelo banco');
      END;

      CREATE TRIGGER audit_sem_delete BEFORE DELETE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log e append-only: DELETE bloqueado pelo banco');
      END;
    `
  },
  {
    versao: 2,
    nome: "captura automatica de documentos",
    sql: `
      -- Certificado A1: arquivo e senha so cifrados (lib/segredos.mjs).
      CREATE TABLE certificados_digitais (
        id                TEXT PRIMARY KEY,
        titular           TEXT NOT NULL,
        titular_cnpj      TEXT,
        raiz_cnpj         TEXT,
        emissor           TEXT,
        serie             TEXT,
        impressao_digital TEXT,
        valido_de         TEXT NOT NULL,
        valido_ate        TEXT NOT NULL,
        tipo              TEXT NOT NULL DEFAULT 'A1',
        pfx_cifrado       TEXT NOT NULL,
        senha_cifrada     TEXT NOT NULL,
        sha256_arquivo    TEXT NOT NULL UNIQUE,
        enviado_por       TEXT,
        criado_em         TEXT NOT NULL,
        ativo             INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_certdig_cnpj ON certificados_digitais(titular_cnpj);

      -- Configuracao de captura de cada empresa da carteira.
      CREATE TABLE empresas_captura (
        cliente_id     TEXT PRIMARY KEY REFERENCES clientes(id) ON DELETE CASCADE,
        modo           TEXT NOT NULL DEFAULT 'proprio',
        certificado_id TEXT REFERENCES certificados_digitais(id) ON DELETE SET NULL,
        pasta_destino  TEXT,
        tipos          TEXT NOT NULL DEFAULT 'ambas',
        fontes         TEXT NOT NULL DEFAULT '["ADN"]',
        ativa          INTEGER NOT NULL DEFAULT 1,
        atualizado_em  TEXT NOT NULL,
        atualizado_por TEXT
      );

      -- Cursor de NSU por empresa e fonte: so avanca depois que o lote foi gravado.
      CREATE TABLE cursores (
        cliente_id      TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        fonte           TEXT NOT NULL,
        ultimo_nsu      INTEGER NOT NULL DEFAULT 0,
        maior_nsu       INTEGER NOT NULL DEFAULT 0,
        ultima_consulta TEXT,
        ultimo_sucesso  TEXT,
        bloqueado_ate   INTEGER,
        PRIMARY KEY (cliente_id, fonte)
      );

      -- cliente_id NULL = vale para todas as empresas ativas.
      CREATE TABLE agendamentos (
        id           TEXT PRIMARY KEY,
        cliente_id   TEXT REFERENCES clientes(id) ON DELETE CASCADE,
        nome         TEXT NOT NULL,
        frequencia   TEXT NOT NULL,
        dia_mes      INTEGER,
        dia_semana   INTEGER,
        hora         INTEGER NOT NULL DEFAULT 6,
        minuto       INTEGER NOT NULL DEFAULT 0,
        revarreduras TEXT NOT NULL DEFAULT '[5,15]',
        ativo        INTEGER NOT NULL DEFAULT 1,
        criado_em    TEXT NOT NULL,
        criado_por   TEXT
      );

      CREATE TABLE tarefas (
        id               TEXT PRIMARY KEY,
        cliente_id       TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        fonte            TEXT NOT NULL,
        origem           TEXT NOT NULL,
        competencia      TEXT,
        prioridade       INTEGER NOT NULL DEFAULT 0,
        situacao         TEXT NOT NULL DEFAULT 'pendente',
        tentativas       INTEGER NOT NULL DEFAULT 0,
        max_tentativas   INTEGER NOT NULL DEFAULT 5,
        proxima_tentativa INTEGER NOT NULL DEFAULT 0,
        travada_em       INTEGER,
        iniciada_em      TEXT,
        concluida_em     TEXT,
        erro             TEXT,
        resumo           TEXT,
        chave_unica      TEXT UNIQUE,
        agendamento_id   TEXT,
        criada_em        TEXT NOT NULL,
        criada_por       TEXT
      );
      CREATE INDEX idx_tarefas_fila ON tarefas(situacao, proxima_tentativa, prioridade);
      CREATE INDEX idx_tarefas_cliente ON tarefas(cliente_id, situacao);

      -- Cada NSU que o portal devolveu, com o que se fez dele.
      CREATE TABLE rastreio_nsu (
        cliente_id     TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        fonte          TEXT NOT NULL,
        nsu            INTEGER NOT NULL,
        resultado      TEXT NOT NULL,
        chave          TEXT,
        tipo_documento TEXT,
        documento_id   TEXT,
        tarefa_id      TEXT,
        visto_em       TEXT NOT NULL,
        PRIMARY KEY (cliente_id, fonte, nsu)
      );

      CREATE TABLE pendencias (
        id            TEXT PRIMARY KEY,
        cliente_id    TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        fonte         TEXT NOT NULL,
        tipo          TEXT NOT NULL,
        referencia    TEXT NOT NULL,
        chave         TEXT,
        nsu           INTEGER,
        documento_id  TEXT,
        detalhe       TEXT,
        situacao      TEXT NOT NULL DEFAULT 'aberta',
        tentativas    INTEGER NOT NULL DEFAULT 0,
        criada_em     TEXT NOT NULL,
        atualizada_em TEXT NOT NULL,
        resolvida_em  TEXT,
        resolvida_por TEXT,
        UNIQUE (cliente_id, fonte, tipo, referencia)
      );
      CREATE INDEX idx_pendencias_situacao ON pendencias(situacao, cliente_id);

      -- Arquivos guardados no acervo, enderecados pelo SHA-256 do conteudo.
      CREATE TABLE arquivos_documento (
        documento_id TEXT NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
        tipo         TEXT NOT NULL,
        caminho      TEXT NOT NULL,
        sha256       TEXT NOT NULL,
        tamanho      INTEGER NOT NULL,
        gerado_em    TEXT NOT NULL,
        PRIMARY KEY (documento_id, tipo)
      );

      CREATE TABLE eventos_documento (
        id          TEXT PRIMARY KEY,
        cliente_id  TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        chave       TEXT NOT NULL,
        nsu         INTEGER,
        tipo        TEXT,
        descricao   TEXT,
        motivo      TEXT,
        quando      TEXT,
        caminho_xml TEXT NOT NULL,
        sha256      TEXT NOT NULL,
        capturado_em TEXT NOT NULL,
        UNIQUE (cliente_id, sha256)
      );
      CREATE INDEX idx_eventos_chave ON eventos_documento(chave);

      -- Espelho na pasta do cliente: quem grava e o servidor (pasta local) ou o agente.
      CREATE TABLE gravacoes_pasta (
        documento_id  TEXT NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
        tipo_arquivo  TEXT NOT NULL,
        cliente_id    TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        destino       TEXT NOT NULL,
        sha256        TEXT NOT NULL,
        situacao      TEXT NOT NULL DEFAULT 'pendente',
        erro          TEXT,
        tentativas    INTEGER NOT NULL DEFAULT 0,
        gravado_por   TEXT,
        atualizado_em TEXT NOT NULL,
        PRIMARY KEY (documento_id, tipo_arquivo)
      );
      CREATE INDEX idx_gravacoes_situacao ON gravacoes_pasta(situacao, cliente_id);

      CREATE TABLE tokens_agente (
        id         TEXT PRIMARY KEY,
        nome       TEXT NOT NULL,
        hash       TEXT NOT NULL UNIQUE,
        criado_por TEXT,
        criado_em  TEXT NOT NULL,
        ultimo_uso TEXT,
        ativo      INTEGER NOT NULL DEFAULT 1
      );

      ALTER TABLE documentos ADD COLUMN fonte TEXT;
      ALTER TABLE documentos ADD COLUMN nsu INTEGER;
      ALTER TABLE documentos ADD COLUMN papel TEXT;
      ALTER TABLE documentos ADD COLUMN competencia TEXT;
      CREATE INDEX idx_documentos_papel ON documentos(cliente_id, competencia, papel);
    `
  },
  {
    versao: 3,
    nome: "NF-e e CT-e pela SEFAZ, manifestacao do destinatario",
    sql: `
      -- UF do interessado vai no pedido de distribuicao (cUFAutor). Ciencia
      -- automatica e opcao explicita por empresa: e um ato em nome do cliente.
      ALTER TABLE empresas_captura ADD COLUMN uf TEXT;
      ALTER TABLE empresas_captura ADD COLUMN manifestar_ciencia INTEGER NOT NULL DEFAULT 0;

      -- Cada manifestacao enviada a SEFAZ, aceita ou nao, com o XML assinado.
      CREATE TABLE manifestacoes (
        id          TEXT PRIMARY KEY,
        cliente_id  TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        chave       TEXT NOT NULL,
        tipo_evento TEXT NOT NULL,
        situacao    TEXT NOT NULL,
        protocolo   TEXT,
        cstat       TEXT,
        motivo      TEXT,
        origem      TEXT NOT NULL,
        enviada_em  TEXT NOT NULL,
        enviada_por TEXT,
        caminho_xml TEXT,
        sha256      TEXT,
        tentativas  INTEGER NOT NULL DEFAULT 1,
        UNIQUE (cliente_id, chave, tipo_evento)
      );
      CREATE INDEX idx_manifestacoes_cliente ON manifestacoes(cliente_id, situacao);
    `
  },
  {
    versao: 4,
    nome: "pasta monitorada lembra o que ja leu",
    sql: `
      -- A pasta monitorada pode ser de outro sistema (exportacao do ERP): o
      -- arquivo fica onde esta, e o conteudo ja lido nao e importado de novo.
      CREATE TABLE pasta_monitorada_vistos (
        sha256   TEXT PRIMARY KEY,
        nome     TEXT NOT NULL,
        tamanho  INTEGER NOT NULL,
        visto_em TEXT NOT NULL
      );
    `
  },
  {
    versao: 5,
    nome: "o que a PONTE SEFAZ sabe de cada empresa",
    sql: `
      -- Empresa capturada pela PONTE nao tem A1 aqui: a validade dele, o radar
      -- e os achados da conferencia da PONTE chegam a cada captura e alimentam
      -- a vigilancia, que de outro modo ficaria cega para essas empresas.
      CREATE TABLE ponte_estado (
        cliente_id             TEXT PRIMARY KEY REFERENCES clientes(id) ON DELETE CASCADE,
        na_carteira            INTEGER NOT NULL DEFAULT 1,
        tem_certificado        INTEGER NOT NULL DEFAULT 0,
        certificado_vencimento TEXT,
        certificado_titular    TEXT,
        radar                  INTEGER NOT NULL DEFAULT 1,
        ultima_varredura       TEXT,
        achados                TEXT NOT NULL DEFAULT '[]',
        atualizado_em          TEXT NOT NULL
      );
    `
  },
  {
    versao: 6,
    nome: "revisao de cancelamentos da NFS-e pela chave",
    sql: `
      -- Cada NFS-e conferida na Sefin Nacional (eventos pela chave): quando e
      -- com que resultado. "sem_evento" nao e consultada de novo no mesmo dia;
      -- "nao_conferida" (a Sefin nao respondeu direito) entra na proxima.
      CREATE TABLE revisao_eventos (
        documento_id  TEXT PRIMARY KEY REFERENCES documentos(id),
        conferido_em  TEXT NOT NULL,
        resultado     TEXT NOT NULL CHECK (resultado IN ('sem_evento','cancelada','nao_conferida')),
        detalhe       TEXT
      );
    `
  },
  {
    versao: 7,
    nome: "mapa do periodo de cada empresa",
    sql: `
      -- Cada competencia trazida de uma fonte por mes (PONTE): quando, quantos
      -- arquivos vieram e quantos so em resumo. E o mapa do periodo da empresa.
      CREATE TABLE periodos_captura (
        cliente_id   TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        competencia  TEXT NOT NULL,
        fonte        TEXT NOT NULL,
        trazido_em   TEXT NOT NULL,
        arquivos     INTEGER NOT NULL DEFAULT 0,
        sem_xml      INTEGER NOT NULL DEFAULT 0,
        falhas       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (cliente_id, competencia, fonte)
      );
      -- Desde quando o cliente esta na carteira do escritorio na PONTE: o
      -- comeco natural do periodo dele.
      ALTER TABLE ponte_estado ADD COLUMN desde TEXT;
    `
  },
  {
    versao: 8,
    nome: "dados da nota na pendencia de resumo",
    sql: `
      -- O que o portal informou da nota que so veio em resumo (emitente, CNPJ,
      -- emissao, valor), em JSON. A tela de resumos mostra uma por uma; o texto
      -- do detalhe muda (ciencia enviada...) e estes dados ficam.
      ALTER TABLE pendencias ADD COLUMN dados TEXT;
    `
  },
  {
    versao: 9,
    nome: "agendamento que so copia da PONTE",
    sql: `
      -- Com a agenda da PONTE buscando na SEFAZ, o agendamento do NUCLEO so
      -- copia o que ela ja tem, sem pedir nova busca (os dois nao disputam).
      ALTER TABLE agendamentos ADD COLUMN so_copiar INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    versao: 10,
    nome: "regra de busca de cada empresa",
    sql: `
      -- O que e de qual periodo buscar, por empresa: os documentos pela PONTE
      -- (JSON, nulo = todos), o comeco do periodo (AAAA-MM) e quantos meses a
      -- rotina olha para tras (nulo = o padrao do sistema).
      ALTER TABLE empresas_captura ADD COLUMN documentos TEXT;
      ALTER TABLE empresas_captura ADD COLUMN periodo_desde TEXT;
      ALTER TABLE empresas_captura ADD COLUMN periodo_meses INTEGER;
    `
  },
  {
    versao: 11,
    nome: "apuracao do Lucro Presumido e do Lucro Real",
    sql: `
      -- Cada apuracao gravada, com o que foi informado e a memoria de calculo.
      -- Gravar de novo o mesmo periodo e regime cria outra linha: o historico fica.
      CREATE TABLE apuracoes_lucro (
        id           TEXT PRIMARY KEY,
        cliente_id   TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        regime       TEXT NOT NULL,
        periodo      TEXT NOT NULL,
        total        REAL NOT NULL,
        entrada      TEXT NOT NULL,
        resultado    TEXT NOT NULL,
        apurado_em   TEXT NOT NULL,
        apurado_por  TEXT
      );
      CREATE INDEX idx_apuracoes_lucro_cliente ON apuracoes_lucro(cliente_id, periodo);
    `
  },
  {
    versao: 12,
    nome: "envios para SIEG, Dominio e Acessorias",
    sql: `
      -- Cada envio feito para fora: XML para o SIEG, lote para o Dominio, guia
      -- para a Acessorias. O lote do Dominio fica "aguardando" ate a consulta
      -- dizer que foi armazenado.
      CREATE TABLE envios_externos (
        id            TEXT PRIMARY KEY,
        destino       TEXT NOT NULL,
        cliente_id    TEXT REFERENCES clientes(id) ON DELETE CASCADE,
        competencia   TEXT,
        lote          TEXT,
        arquivos      INTEGER NOT NULL DEFAULT 0,
        aceitos       INTEGER NOT NULL DEFAULT 0,
        recusados     INTEGER NOT NULL DEFAULT 0,
        situacao      TEXT NOT NULL,
        detalhe       TEXT,
        criado_em     TEXT NOT NULL,
        atualizado_em TEXT NOT NULL,
        criado_por    TEXT
      );
      CREATE INDEX idx_envios_externos_cliente ON envios_externos(cliente_id, destino, criado_em);
    `
  },
  {
    versao: 13,
    nome: "trilha com elo unico",
    sql: `
      -- Um evento so pode apontar para cada anterior: a trilha nao abre duas
      -- pontas quando dois gravadores leem a mesma cabeca. A sequencia ja e a
      -- chave primaria e passa a ser gravada explicita (a mesma do hash).
      CREATE UNIQUE INDEX idx_audit_hash_anterior ON audit_log(hash_anterior);
    `
  },
  {
    versao: 14,
    nome: "termo de guarda do A1 no NUCLEO",
    sql: `
      -- Um termo por certificado da empresa: A1 novo cria outro pendente e o
      -- anterior fica no historico como substituido, com o assinado dele.
      CREATE TABLE termos_guarda (
        id               TEXT PRIMARY KEY,
        cliente_id       TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        certificado_id   TEXT REFERENCES certificados_digitais(id),
        situacao         TEXT NOT NULL,
        autorizado_por   TEXT,
        referencia       TEXT,
        criado_em        TEXT NOT NULL,
        criado_por       TEXT,
        gerado_em        TEXT,
        gerado_por       TEXT,
        assinado_em      TEXT,
        assinado_por     TEXT,
        arquivo_assinado TEXT,
        sha256_assinado  TEXT,
        nome_arquivo     TEXT,
        substituido_em   TEXT
      );
      CREATE INDEX idx_termos_guarda_cliente ON termos_guarda(cliente_id, criado_em);
    `
  },
  {
    versao: 15,
    nome: "conferencia da assinatura do termo",
    sql: `
      -- O que a maquina provou sobre a assinatura do termo recebido (icp-brasil,
      -- gov-br, integra, nao-confere ou manual), com quem assinou. Aviso, nao trava.
      ALTER TABLE termos_guarda ADD COLUMN conferencia TEXT;
    `
  }
];

let conexao = null;

/**
 * Abre o banco, aplica as migrations pendentes e devolve a conexao.
 * `caminho` pode ser ":memory:" nos testes.
 */
export function abrir(caminho) {
  if (caminho !== ":memory:") mkdirSync(dirname(caminho), { recursive: true });
  const bd = new DatabaseSync(caminho);

  // WAL deixa leitura e escrita concorrerem; foreign_keys nao e padrao no SQLite.
  if (caminho !== ":memory:") bd.exec("PRAGMA journal_mode = WAL");
  bd.exec("PRAGMA foreign_keys = ON");
  bd.exec("PRAGMA busy_timeout = 5000");

  bd.exec("CREATE TABLE IF NOT EXISTS migracoes (versao INTEGER PRIMARY KEY, nome TEXT NOT NULL, aplicada_em TEXT NOT NULL)");

  const aplicadas = new Set(bd.prepare("SELECT versao FROM migracoes").all().map((linha) => linha.versao));
  for (const migracao of MIGRACOES) {
    if (aplicadas.has(migracao.versao)) continue;
    bd.exec("BEGIN");
    try {
      bd.exec(migracao.sql);
      bd.prepare("INSERT INTO migracoes (versao, nome, aplicada_em) VALUES (?, ?, ?)")
        .run(migracao.versao, migracao.nome, new Date().toISOString());
      bd.exec("COMMIT");
      console.log("migration " + migracao.versao + " aplicada: " + migracao.nome);
    } catch (erro) {
      bd.exec("ROLLBACK");
      throw new Error("Falha na migration " + migracao.versao + " (" + migracao.nome + "): " + erro.message);
    }
  }

  conexao = bd;
  return bd;
}

export function bd() {
  if (!conexao) throw new Error("Banco nao aberto: chame abrir() primeiro");
  return conexao;
}

export function fechar() {
  conexao?.close();
  conexao = null;
}

export function versaoEsquema() {
  return bd().prepare("SELECT MAX(versao) AS v FROM migracoes").get().v ?? 0;
}

let profundidade = 0;

/**
 * Executa `trabalho` numa transacao, revertendo em caso de erro.
 * Reentrante: chamada dentro de outra transacao vira SAVEPOINT, entao um
 * modulo que abre a propria transacao pode rodar dentro do lote de outro.
 */
export function transacao(trabalho) {
  const base = bd();
  const nivel = profundidade;
  const ponto = "sp_" + nivel;
  base.exec(nivel === 0 ? "BEGIN" : "SAVEPOINT " + ponto);
  profundidade += 1;
  try {
    const resultado = trabalho(base);
    base.exec(nivel === 0 ? "COMMIT" : "RELEASE " + ponto);
    return resultado;
  } catch (erro) {
    if (nivel === 0) base.exec("ROLLBACK");
    else base.exec("ROLLBACK TO " + ponto + "; RELEASE " + ponto);
    throw erro;
  } finally {
    profundidade -= 1;
  }
}

// ---------------------------------------------------------------- utilitarios

/** JSON para coluna TEXT, tolerando null. */
export function paraJson(valor) {
  return valor === undefined || valor === null ? null : JSON.stringify(valor);
}

/** Coluna TEXT de volta para objeto, tolerando conteudo invalido. */
export function deJson(valor, padrao = null) {
  if (valor === null || valor === undefined) return padrao;
  try {
    return JSON.parse(valor);
  } catch {
    return padrao;
  }
}

/** SQLite nao tem booleano: 0 e 1. */
export function paraBool(valor) {
  return valor ? 1 : 0;
}

export function deBool(valor) {
  return valor === 1 || valor === true;
}
