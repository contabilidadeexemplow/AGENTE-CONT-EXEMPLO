// Indicadores do dashboard, calculados por consulta.
//
// Nada aqui carrega tabela para a memoria: as contagens saem de agregacao no
// banco, para o painel continuar rapido com acervo grande.

import {
  clientes, certificados, documentos, conferencias, alertas, apuracoes, configuracoes
} from "./repositorio.mjs";
import { CONFIGURACAO_PADRAO } from "./estado.mjs";

export function configuracao() {
  const gravada = configuracoes.ler("app", {});
  return {
    ...CONFIGURACAO_PADRAO,
    ...gravada,
    modules: { ...CONFIGURACAO_PADRAO.modules, ...(gravada.modules || {}) },
    limites: { ...CONFIGURACAO_PADRAO.limites, ...(gravada.limites || {}) }
  };
}

function saudeDoModulo(nome, listaClientes, pendentesPorCliente, config) {
  const escopo = listaClientes.filter((cliente) => (cliente.modules || []).includes(nome));
  let criticos = 0;
  let atencao = 0;
  for (const cliente of escopo) {
    const estado = pendentesPorCliente.get(cliente.id);
    if (!estado) continue;
    if (estado.criticos > 0) criticos += 1;
    else atencao += 1;
  }
  return {
    name: nome,
    status: config.modules[nome] === false ? "Nao contratado" : "Ativo",
    healthy: escopo.length - criticos - atencao,
    warning: atencao,
    critical: criticos
  };
}

export function montarDashboard() {
  const config = configuracao();
  const listaClientes = clientes.listar();
  const metricasAlertas = alertas.metricas();

  const pendentesPorCliente = new Map();
  for (const cliente of listaClientes) {
    if (cliente.openAlerts > 0) {
      pendentesPorCliente.set(cliente.id, {
        criticos: cliente.status === "Critico" ? 1 : 0,
        total: cliente.openAlerts
      });
    }
  }

  const conferidos = conferencias.contar();
  const consolidado = conferencias.consolidado();
  const avisoDias = config.limites.certificadoAvisoDias ?? 30;

  const porSituacao = (situacao) =>
    listaClientes.filter((cliente) => cliente.certificate === situacao).length;

  return {
    monitoredCompanies: listaClientes.length,
    activeModules: Object.values(config.modules || {}).filter(Boolean).length,
    pendingAlerts: metricasAlertas.pendentes,
    metrics: {
      criticalCompanies: metricasAlertas.criticos,
      affectedCompanies: metricasAlertas.afetados,
      certificatesExpiring: certificados.vencendoEm(avisoDias),
      companiesWithoutIssuance: metricasAlertas.semEmissao,
      failedCaptures: metricasAlertas.capturasFalhas,
      pendingDas: metricasAlertas.das,
      documentsCaptured: documentos.contar(),
      documentsChecked: conferidos,
      documentsIrregular: consolidado.irregulares,
      conformityRate: conferidos
        ? Math.round(((conferidos - consolidado.irregulares) / conferidos) * 100)
        : null,
      openAssessments: apuracoes.contarAbertas()
    },
    attention: alertas.agrupadosPendentes(),
    moduleHealth: [
      {
        name: "Certificados",
        status: "Ativo",
        healthy: porSituacao("Valido"),
        warning: porSituacao("Vencendo"),
        critical: porSituacao("Vencido")
      },
      saudeDoModulo("Servicos", listaClientes, pendentesPorCliente, config),
      saudeDoModulo("Simples Nacional", listaClientes, pendentesPorCliente, config),
      saudeDoModulo("Federal", listaClientes, pendentesPorCliente, config),
      {
        name: "Prevencao",
        status: config.modules.Prevencao ? "Ativo" : "Nao contratado",
        healthy: 0, warning: 0, critical: 0
      }
    ]
  };
}
