// Prevencao: o que vai vencer, com data, enquanto ainda da tempo de evitar.
// Os Alertas mostram o que ja esta errado; aqui fica o que esta para acontecer.
//
//   - A1 que vence, no cofre do NUCLEO e no da PONTE: sem ele a captura para
//     e a ciencia nao sai;
//   - NF-e so em resumo: a distribuicao da SEFAZ entrega o XML por cerca de 90
//     dias depois da emissao. Passado isso, so pedindo ao fornecedor. A data
//     vem do mes de emissao gravado na chave (conta do comeco do mes, para nao
//     prometer prazo que nao existe);
//   - fechamento do mes: a captura precisa rodar depois que o mes acabou, ou as
//     notas do fim do mes ficam de fora. Prazo de referencia: dia 10.
//
// Funcao pura: recebe o que o banco ja sabe e devolve a lista ordenada por data.

const DIA = 86_400_000;
export const JANELA_DIAS = 60;
export const JANELA_DISTRIBUICAO_DIAS = 90;
export const DIA_FECHAMENTO = 10;

const dataIso = (data) => data.toISOString().slice(0, 10);

/** Primeiro dia do mes de emissao gravado na chave de NF-e (AAMM nas posicoes 3 a 6). */
export function mesDeEmissaoDaChave(chave) {
  const texto = String(chave || "");
  if (!/^\d{44}$/.test(texto)) return null;
  const ano = 2000 + Number(texto.slice(2, 4));
  const mes = Number(texto.slice(4, 6));
  if (mes < 1 || mes > 12) return null;
  return new Date(Date.UTC(ano, mes - 1, 1));
}

export function prazosPreventivos({ empresas = [], certificados = [], ponteEstados = [], resumos = [], agora = new Date(),
  janelaDias = JANELA_DIAS }) {
  const itens = [];
  const limite = agora.getTime() + janelaDias * DIA;
  const nomeDe = new Map(empresas.map((empresa) => [empresa.clientId, empresa.name]));
  const incluir = (item) => {
    const falta = new Date(item.data + "T23:59:59Z").getTime() - agora.getTime();
    itens.push({ ...item, dias: falta < 0 ? Math.floor(falta / DIA) : Math.ceil(falta / DIA), vencido: falta < 0 });
  };

  // A1 no cofre do NUCLEO: um certificado pode atender varias empresas (procuracao).
  for (const certificado of certificados) {
    if (!certificado.ativo || !certificado.validoAte) continue;
    if (new Date(certificado.validoAte + "T23:59:59Z").getTime() > limite) continue;
    const atendidas = certificado.empresas || [];
    incluir({
      tipo: "a1", origem: "NUCLEO", data: certificado.validoAte, clientId: atendidas[0]?.id || null,
      empresa: atendidas.map((item) => item.name).join(", ") || certificado.titular,
      titulo: "A1 de " + certificado.titular + " no cofre do NUCLEO",
      seVencer: "A captura direta (ambiente nacional e SEFAZ) para e a ciencia nao sai.",
      acao: "Renove o A1 com o cliente e envie em Certificados A1."
    });
  }

  // A1 no cofre da PONTE.
  for (const estado of ponteEstados) {
    if (!estado.naCarteira || !estado.temCertificado || !estado.certificadoVencimento) continue;
    const data = String(estado.certificadoVencimento).slice(0, 10);
    if (new Date(data + "T23:59:59Z").getTime() > limite) continue;
    incluir({
      tipo: "a1", origem: "PONTE", data, clientId: estado.clientId, empresa: nomeDe.get(estado.clientId) || estado.clientId,
      titulo: "A1 de " + (estado.certificadoTitular || nomeDe.get(estado.clientId) || "cliente") + " no cofre da PONTE",
      seVencer: "A PONTE para de varrer a SEFAZ e o ambiente nacional para esta empresa.",
      acao: "Renove o A1 e envie para a PONTE no painel da empresa."
    });
  }

  // NF-e so em resumo: por empresa, uma linha das que ainda estao na janela
  // (prazo mais curto) e outra das que ja passaram dela.
  const porEmpresa = new Map();
  for (const resumo of resumos) {
    const mes = mesDeEmissaoDaChave(resumo.chave);
    if (!mes || String(resumo.chave).slice(20, 22) !== "55") continue;
    const prazo = new Date(mes.getTime() + JANELA_DISTRIBUICAO_DIAS * DIA);
    if (prazo.getTime() > limite) continue;
    const passou = prazo.getTime() < agora.getTime();
    const chaveGrupo = resumo.clientId + "|" + (passou ? "passou" : "aVencer");
    const atual = porEmpresa.get(chaveGrupo) || { clientId: resumo.clientId, passou, quantas: 0, prazo };
    atual.quantas += 1;
    if (prazo < atual.prazo) atual.prazo = prazo;
    porEmpresa.set(chaveGrupo, atual);
  }
  for (const { clientId, passou, quantas, prazo } of porEmpresa.values()) {
    incluir({
      tipo: "resumo", origem: "SEFAZ", data: dataIso(prazo), clientId, empresa: nomeDe.get(clientId) || clientId, quantas,
      titulo: passou ? quantas + " NF-e so em resumo passaram de 90 dias da emissao" : quantas + " NF-e so em resumo, sem o XML",
      seVencer: passou
        ? "A SEFAZ pode nao entregar mais o XML pela distribuicao."
        : "Cerca de 90 dias depois da emissao a SEFAZ deixa de entregar o XML pela distribuicao; ai so pedindo ao fornecedor.",
      acao: passou ? "Tente a ciencia; se o XML nao vier, peca ao fornecedor." : "Manifeste a ciencia (Ciencia em lote) para liberar o XML."
    });
  }

  // Fechamento do mes anterior: a captura tem que ter rodado depois que ele acabou.
  const inicioDoMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1));
  const mesAnterior = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 1, 1));
  const competencia = String(mesAnterior.getUTCMonth() + 1).padStart(2, "0") + "/" + mesAnterior.getUTCFullYear();
  const prazoFechamento = dataIso(new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), DIA_FECHAMENTO)));
  for (const empresa of empresas) {
    if (!empresa.configurada || !empresa.ativa) continue;
    if (empresa.ultimoSucesso && new Date(empresa.ultimoSucesso) >= inicioDoMes) continue;
    incluir({
      tipo: "fechamento", origem: "NUCLEO", data: prazoFechamento, clientId: empresa.clientId, empresa: empresa.name,
      titulo: "Captura do fechamento de " + competencia + " ainda nao rodou",
      seVencer: "O mes fecha sem as notas que chegaram no fim dele.",
      acao: "Capture agora, ou crie um agendamento mensal em Agendamentos."
    });
  }

  return itens.sort((a, b) => a.data.localeCompare(b.data) || String(a.empresa).localeCompare(String(b.empresa)));
}
