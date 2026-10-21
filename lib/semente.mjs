// Semeadura de primeira execucao.
//
// Decisao que muda em relacao a versao anterior: NAO existe mais usuario de
// demonstracao com senha publica por padrao. Na primeira subida o sistema cria
// um administrador e imprime uma senha aleatoria UMA vez no console, marcada
// para troca obrigatoria no primeiro login.
//
// Os dois logins de demonstracao (admin@demo.local / fiscal@demo.local) so
// aparecem com NUCLEO_DEMO=1, que tambem semeia clientes e certificados ficticios.
// A suite de testes usa esse modo; producao nao deve.

import crypto from "node:crypto";
import { usuarios, clientes, certificados, regras, configuracoes } from "./repositorio.mjs";
import { CONFIGURACAO_PADRAO } from "./estado.mjs";

export const MODO_DEMO = process.env.NUCLEO_DEMO === "1";

function senhaAleatoria() {
  // 24 caracteres base64url: forte e ainda copiavel do terminal.
  return crypto.randomBytes(18).toString("base64url");
}

const REGRAS_INICIAIS = [
  {
    module: "Servicos", type: "ISS", key: "1402", expectedRate: 5, status: "Ativa",
    description: "Aliquota de ISS esperada para o item 14.02 da LC 116"
  },
  {
    module: "Federal", type: "PIS/COFINS", key: "87083090", expectedRate: 1.65, status: "Ativa",
    description: "PIS esperado para autopecas NCM 8708.30.90 no regime cumulativo"
  }
];

const CLIENTES_DEMO = [
  { cnpj: "12.345.678/0001-90", name: "EMPRESA DEMONSTRATIVA UM LTDA", city: "Sao Paulo",
    taxRegime: "Simples Nacional", anexo: "I", rbt12: 500000, folha12: null,
    modules: ["Federal", "Servicos"], demo: true },
  { cnpj: "23.456.789/0001-12", name: "EMPRESA DEMONSTRATIVA DOIS LTDA", city: "Campinas",
    taxRegime: "Simples Nacional", anexo: "III", rbt12: 350000, folha12: 120000,
    modules: ["Servicos"], demo: true },
  { cnpj: "34.567.890/0001-43", name: "EMPRESA DEMONSTRATIVA TRES LTDA", city: "Sao Paulo",
    taxRegime: "Simples Nacional", anexo: "III", rbt12: 180000, folha12: 20000,
    modules: ["Servicos", "Simples Nacional"], demo: true },
  { cnpj: "45.678.901/0001-74", name: "EMPRESA DEMONSTRATIVA QUATRO LTDA", city: "Barueri",
    taxRegime: "Lucro Presumido", anexo: null, rbt12: null, folha12: null,
    modules: ["Federal"], demo: true }
];

/**
 * Roda uma vez, na subida. Devolve o que foi criado, para o servidor avisar.
 */
export function semear() {
  const criado = { usuarios: [], clientes: 0, certificados: 0, regras: 0, senhaInicial: null };

  if (!configuracoes.ler("app")) {
    configuracoes.gravar("app", {
      ...CONFIGURACAO_PADRAO,
      officeName: process.env.NUCLEO_ESCRITORIO || CONFIGURACAO_PADRAO.officeName
    });
  }

  if (!regras.listar().length) {
    for (const regra of REGRAS_INICIAIS) regras.criar(regra);
    criado.regras = REGRAS_INICIAIS.length;
  }

  if (usuarios.contar() === 0) {
    if (MODO_DEMO) {
      usuarios.criar({ name: "Administrador", email: "admin@demo.local", password: "123456", role: "admin" });
      usuarios.criar({ name: "Operador Fiscal", email: "fiscal@demo.local", password: "123456", role: "operador_fiscal" });
      criado.usuarios = ["admin@demo.local", "fiscal@demo.local"];
    } else {
      const email = process.env.NUCLEO_ADMIN_EMAIL || "admin@local";
      const senha = process.env.NUCLEO_ADMIN_SENHA || senhaAleatoria();
      usuarios.criar({
        name: "Administrador",
        email,
        password: senha,
        role: "admin",
        // Senha que veio de fora (kit da PONTE, quem instalou) e provisoria: troca no primeiro login.
        mustChangePassword: true
      });
      criado.usuarios = [email];
      criado.senhaInicial = process.env.NUCLEO_ADMIN_SENHA ? null : senha;
    }
  }

  if (MODO_DEMO && clientes.listar().length === 0) {
    const criados = CLIENTES_DEMO.map((item) => clientes.criar(item));
    criado.clientes = criados.length;
    certificados.criar({ clientId: criados[0].id, type: "A1", expiresAt: "2026-08-15", usage: "Federal e Servicos" });
    certificados.criar({ clientId: criados[1].id, type: "A1", expiresAt: "2026-11-05", usage: "Servicos" });
    criado.certificados = 2;
  }

  return criado;
}

/** Texto que o servidor imprime na primeira subida. */
export function avisoDeSemeadura(criado) {
  const linhas = [];
  if (criado.senhaInicial) {
    linhas.push("");
    linhas.push("=".repeat(68));
    linhas.push("  PRIMEIRA EXECUCAO - anote a senha abaixo, ela nao sera mostrada de novo");
    linhas.push("");
    linhas.push("    usuario: " + criado.usuarios[0]);
    linhas.push("    senha  : " + criado.senhaInicial);
    linhas.push("");
    linhas.push("  A troca e obrigatoria no primeiro login.");
    linhas.push("=".repeat(68));
    linhas.push("");
  } else if (criado.usuarios.length && MODO_DEMO) {
    linhas.push("MODO DEMO (NUCLEO_DEMO=1): usuarios admin@demo.local e fiscal@demo.local, senha 123456.");
    linhas.push("Nao use este modo em producao.");
  }
  return linhas.join("\n");
}
