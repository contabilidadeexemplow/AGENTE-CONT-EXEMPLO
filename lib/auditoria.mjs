// Trilha de auditoria: encadeamento por hash mais assinatura HMAC opcional.
//
// Tres camadas, de fora para dentro:
//
// 1. ENCADEAMENTO: cada evento carrega o hash do anterior. Alterar, remover ou
//    reordenar um evento rompe a cadeia e a verificacao aponta onde.
//
// 2. APPEND-ONLY NO BANCO: triggers em `audit_log` abortam UPDATE e DELETE
//    (ver lib/banco.mjs). Nem a aplicacao consegue reescrever um evento.
//
// 3. ASSINATURA HMAC: com `NUCLEO_CHAVE_AUDITORIA` no ambiente, cada evento e
//    assinado com uma chave que nao esta no banco. Isso fecha o furo que a
//    cadeia sozinha nao fecha: quem tem acesso de escrita ao arquivo do banco
//    pode reescrever a trilha inteira e recalcular os hashes, mas nao consegue
//    recalcular as assinaturas sem a chave.
//
// Sem a chave o sistema continua funcionando, e a verificacao diz claramente que
// a trilha esta "integra, sem assinatura": detecta adulteracao casual, nao
// adulteracao deliberada de quem tem o disco.

import crypto from "node:crypto";

export const GENESIS = "0".repeat(64);

function sha256(valor) {
  return crypto.createHash("sha256").update(valor, "utf8").digest("hex");
}

function chaveHmac() {
  const bruta = process.env.NUCLEO_CHAVE_AUDITORIA;
  return bruta && bruta.trim() ? bruta.trim() : null;
}

export function assinaturaConfigurada() {
  return chaveHmac() !== null;
}

/** Hash estavel de um objeto: chaves ordenadas, para o mesmo conteudo dar o mesmo hash. */
export function hashConteudo(data) {
  if (data === undefined || data === null) return sha256("null");
  return sha256(JSON.stringify(data, (chave, valor) => {
    if (valor && typeof valor === "object" && !Array.isArray(valor)) {
      return Object.fromEntries(Object.entries(valor).sort(([a], [b]) => a.localeCompare(b)));
    }
    return valor;
  }));
}

/**
 * Copia profunda do dado no momento do registro.
 *
 * Sem isso, quem chama pode passar uma referencia viva (as configuracoes, por
 * exemplo) e uma mutacao posterior nesse objeto altera um evento ja assinado,
 * quebrando a cadeia sem que ninguem tenha adulterado nada. A trilha precisa
 * ser dona da sua propria copia.
 */
export function congelar(data) {
  if (data === undefined || data === null) return null;
  if (typeof data !== "object") return data;
  try {
    return structuredClone(data);
  } catch {
    return JSON.parse(JSON.stringify(data));
  }
}

function corpoCanonico(evento) {
  return [
    evento.seq,
    evento.at,
    evento.user,
    evento.action,
    evento.target,
    evento.dataHash,
    evento.prevHash
  ].join("|");
}

function assinar(evento) {
  return sha256(corpoCanonico(evento));
}

function autenticar(evento) {
  const chave = chaveHmac();
  if (!chave) return null;
  return crypto.createHmac("sha256", chave).update(corpoCanonico(evento) + "|" + evento.hash).digest("hex");
}

/**
 * Monta o proximo evento da cadeia a partir do anterior.
 * `anterior` pode ser null (primeiro evento) ou qualquer objeto com seq e hash.
 */
export function proximoEvento(anterior, { user, action, target, data = null, at = new Date().toISOString() }) {
  const conteudo = congelar(data);
  const evento = {
    seq: anterior ? Number(anterior.seq) + 1 : 1,
    at,
    user: String(user || "sistema"),
    action: String(action || ""),
    target: String(target ?? ""),
    data: conteudo,
    dataHash: hashConteudo(conteudo),
    prevHash: anterior ? anterior.hash : GENESIS
  };
  evento.hash = assinar(evento);
  evento.signature = autenticar(evento);
  return evento;
}

/** Acrescenta um evento a uma trilha em array. Nao muda os eventos existentes. */
export function registrar(trilha, entrada) {
  const evento = proximoEvento(trilha.length ? trilha[trilha.length - 1] : null, entrada);
  trilha.push(evento);
  return evento;
}

/**
 * Verifica a cadeia inteira.
 * Retorna { valid, length, brokenAt, reason, signed, head }.
 */
export function verificar(trilha) {
  if (!Array.isArray(trilha)) {
    return { valid: false, length: 0, brokenAt: null, reason: "Trilha ausente", signed: false };
  }

  const temChave = assinaturaConfigurada();
  let esperadoPrev = GENESIS;
  let esperadoSeq = null;
  let assinados = 0;

  for (let indice = 0; indice < trilha.length; indice += 1) {
    const evento = trilha[indice];
    const posicao = indice + 1;
    const falha = (motivo) => ({
      valid: false, length: trilha.length, brokenAt: Number(evento.seq) || posicao,
      reason: motivo, signed: temChave
    });

    // A sequencia entra no hash: tem de crescer de um em um, sem buraco nem repeticao.
    if (esperadoSeq !== null && Number(evento.seq) !== esperadoSeq) {
      return falha("Sequencia rompida: depois do evento " + (esperadoSeq - 1) + " veio o " + evento.seq);
    }
    if (evento.prevHash !== esperadoPrev) {
      return falha("Elo rompido no evento " + evento.seq +
        ": prevHash nao corresponde ao hash do evento anterior");
    }
    if (evento.dataHash !== hashConteudo(evento.data)) {
      return falha("Conteudo do evento " + evento.seq + " foi alterado apos o registro");
    }
    if (evento.hash !== assinar(evento)) {
      return falha("Hash do evento " + evento.seq + " nao corresponde aos seus campos");
    }
    if (temChave && evento.signature) {
      if (evento.signature !== autenticar(evento)) {
        return falha("Assinatura do evento " + evento.seq +
          " nao confere: o evento foi reescrito por quem nao tem a chave de auditoria");
      }
      assinados += 1;
    } else if (temChave && assinados > 0) {
      // Depois do primeiro evento assinado, todo evento tem de ser assinado: sem
      // isso, quem tem o banco mas nao a chave acrescentaria eventos sem assinatura
      // no fim e a trilha continuaria "integra".
      return falha("Evento " + evento.seq + " sem assinatura depois de eventos assinados: foi gravado sem a chave de " +
        "auditoria, ou acrescentado por fora da aplicacao");
    }

    esperadoPrev = evento.hash;
    esperadoSeq = Number(evento.seq) + 1;
  }

  const semAssinatura = trilha.length - assinados;
  return {
    valid: true,
    length: trilha.length,
    brokenAt: null,
    signed: temChave,
    assinados,
    semAssinatura,
    reason: !temChave
      ? "Cadeia integra, sem assinatura (NUCLEO_CHAVE_AUDITORIA nao configurada)"
      : semAssinatura
        ? "Cadeia integra; " + assinados + " evento(s) assinado(s) e " + semAssinatura +
          " anterior(es) a configuracao da chave"
        : "Cadeia integra e inteiramente assinada",
    head: esperadoPrev
  };
}

/** Filtra a trilha. A copia filtrada nao e verificavel, por definicao. */
export function consultar(trilha, { user, action, target, de, ate, limite = 200 } = {}) {
  return trilha
    .filter((evento) => {
      if (user && evento.user !== user) return false;
      if (action && !evento.action.toLowerCase().includes(String(action).toLowerCase())) return false;
      if (target && String(evento.target) !== String(target)) return false;
      if (de && evento.at < de) return false;
      if (ate && evento.at > ate) return false;
      return true;
    })
    .slice(-limite)
    .reverse();
}

/** Reconstroi o historico de um alvo: toda alteracao que passou por ele. */
export function historico(trilha, target) {
  return trilha
    .filter((evento) => String(evento.target) === String(target))
    .map((evento) => ({
      seq: evento.seq,
      at: evento.at,
      user: evento.user,
      action: evento.action,
      data: evento.data,
      hash: evento.hash
    }));
}

/** Gera uma chave de auditoria, para o operador copiar. Nunca gravada. */
export function gerarChave() {
  return crypto.randomBytes(32).toString("hex");
}
