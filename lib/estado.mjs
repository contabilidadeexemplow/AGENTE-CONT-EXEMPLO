// Identidade, senha e validacao de documento.
//
// Modulo sem estado e sem acesso a banco, de proposito: lib/repositorio.mjs
// importa daqui, entao o caminho inverso criaria ciclo.

import crypto from "node:crypto";

// Papeis da equipe do escritorio:
// - admin (dono): tudo, e so ele gere a equipe e as configuracoes do escritorio;
// - operador: mexe na carteira, nos certificados e nas integracoes, sem a equipe;
// - operador_fiscal: captura, importa e exporta, sem configurar;
// - leitura: so consulta.
export const PERMISSOES = {
  admin: ["read", "write", "import", "export", "transmit", "config", "equipe"],
  operador: ["read", "write", "import", "export", "transmit", "config"],
  operador_fiscal: ["read", "import", "export"],
  leitura: ["read"]
};

export const PERFIS = Object.keys(PERMISSOES);

export const ROTULO_PERFIL = { admin: "Dono", operador: "Operador", operador_fiscal: "Operador fiscal", leitura: "Leitura" };

/** Hash de senha com scrypt e sal por usuario. */
export function hashSenha(senha, sal = crypto.randomBytes(16).toString("hex")) {
  const derivada = crypto.scryptSync(String(senha), sal, 64).toString("hex");
  return sal + ":" + derivada;
}

/** Comparacao em tempo constante. */
export function conferirSenha(senha, armazenada) {
  const [sal, esperada] = String(armazenada || "").split(":");
  if (!sal || !esperada) return false;
  const derivada = crypto.scryptSync(String(senha), sal, 64).toString("hex");
  const a = Buffer.from(derivada, "hex");
  const b = Buffer.from(esperada, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Regras minimas de senha. Nao e politica completa, mas impede os casos que
 * tornam o resto inutil: senha curta, so digitos, ou das listas obvias.
 */
const SENHAS_PROIBIDAS = new Set([
  "123456", "1234567", "12345678", "123456789", "senha123", "password",
  "admin123", "mudar123", "alterar123", "123mudar", "contabil123"
]);

export function conferirForcaSenha(senha) {
  const valor = String(senha || "");
  if (valor.length < 10) return { ok: false, motivo: "Senha precisa de ao menos 10 caracteres" };
  if (SENHAS_PROIBIDAS.has(valor.toLowerCase())) {
    return { ok: false, motivo: "Senha muito comum: escolha outra" };
  }
  if (/^\d+$/.test(valor)) return { ok: false, motivo: "Senha nao pode ser so numeros" };
  if (/^(.)\1+$/.test(valor)) return { ok: false, motivo: "Senha nao pode ser um caractere repetido" };
  return { ok: true };
}

export function somenteDigitos(valor) {
  return String(valor || "").replace(/\D/g, "");
}

/** Valida CNPJ pelos dois digitos verificadores, nao so pelo formato. */
export function validarCnpj(valor) {
  const d = somenteDigitos(valor);
  if (d.length !== 14) return { valid: false, reason: "CNPJ deve ter 14 digitos" };
  if (/^(\d)\1{13}$/.test(d)) return { valid: false, reason: "CNPJ com todos os digitos iguais" };

  const calcular = (base, pesos) => {
    const soma = base.reduce((total, digito, indice) => total + digito * pesos[indice], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const numeros = d.split("").map(Number);
  const dv1 = calcular(numeros.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const dv2 = calcular(numeros.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);

  if (numeros[12] !== dv1 || numeros[13] !== dv2) {
    return { valid: false, reason: "Digitos verificadores invalidos (esperado " + dv1 + dv2 + ")" };
  }
  return { valid: true };
}

export function formatarCnpj(valor) {
  const d = somenteDigitos(valor);
  if (d.length !== 14) return valor;
  return d.slice(0, 2) + "." + d.slice(2, 5) + "." + d.slice(5, 8) + "/" + d.slice(8, 12) + "-" + d.slice(12);
}

export const LIMITES_VIGILANCIA = {
  certificadoAvisoDias: 30,
  semEmissaoDias: 45,
  dasVencimentoDia: 20,
  quedaFaturamentoPercentual: 50,
  simplesAvisoPercentual: 80,
  limiteSimples: 4800000
};

export const CONFIGURACAO_PADRAO = {
  officeName: "Escritorio",
  defaultPeriod: new Date().toISOString().slice(5, 7) + "/" + new Date().getFullYear(),
  modules: { Federal: true, Servicos: true, "Simples Nacional": true, Prevencao: false },
  limites: { ...LIMITES_VIGILANCIA }
};
