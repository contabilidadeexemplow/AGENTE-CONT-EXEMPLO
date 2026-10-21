# NÚCLEO FISCAL

Central operacional para escritorio contabil: **captura automatica de NFS-e,
NF-e e CT-e de toda a carteira pelos servicos oficiais** (ADN da NFS-e e
distribuicao da SEFAZ), conferencia tributaria, apuracao do Simples Nacional,
vigilancia de pendencias e trilha de auditoria append-only.

Node puro, **sem nenhuma dependencia externa**. `npm install` nao e necessario.
A persistencia usa `node:sqlite`, embutido no Node a partir da 22.5.

## Captura automatica de notas (NFS-e, NF-e e CT-e)

O sistema recebe a carteira de empresas e os certificados A1, consulta os
servicos oficiais por cada uma, baixa o XML, gera o PDF (DANFSe, DANFE ou
DACTE), guarda no acervo central, espelha na pasta de cada cliente e aponta o
que faltou. Cada empresa escolhe as fontes: NFS-e (ADN), NF-e e CT-e (SEFAZ).

### Como funciona

- **Fonte:** API oficial de distribuicao de DF-e do ADN
  (`GET https://adn.nfse.gov.br/contribuintes/DFe/{NSU}?lote=true`), a mesma
  que a extensao "Baixar NFSe" usa. A extensao pegava carona na sessao do
  Chrome; aqui o proprio servidor faz o mTLS com o certificado.
- **Autenticacao por empresa:** o A1 da propria empresa (mesmo CNPJ ou mesmo
  CNPJ raiz), ou o A1 do escritorio com **procuracao eletronica**, pelo
  parametro oficial `cnpjConsulta`.
- **Modelo NSU:** o portal entrega os documentos em ordem, por um contador
  sequencial por CNPJ. Nao existe filtro por data no portal: a primeira
  sincronizacao drena o historico que ele mantem, e as seguintes so pegam o
  que chegou depois. "Ultimo mes", "12 meses" e periodo personalizado sao
  filtros sobre o acervo.
- **Emitida ou recebida:** pelo CNPJ da empresa no XML (prestador ou tomador).
  A mesma nota entre dois clientes da carteira aparece nos dois: emitida para
  um, recebida para o outro.
- **DANFSe:** gerado no servidor pelo codigo original da extensao
  (`vendor/danfse.cjs`, NT 008), com marca d'agua CANCELADA ou SUBSTITUIDA
  quando chega o evento.
- **Agendamento:** mensal no dia e hora escolhidos busca a competencia
  anterior (1/10 busca 09), com revarreduras (padrao D+5 e D+15) para notas
  publicadas com atraso; tambem semanal e diario. Horario de Brasilia.
  Servidor desligado no horario cria a tarefa quando volta, no mesmo mes.
- **Fila:** ate 3 empresas ao mesmo tempo, nunca duas tarefas da mesma
  empresa juntas, espera crescente em falha temporaria, parada imediata em
  falha de autenticacao (certificado vencido, sem procuracao).
- **Retomada:** o cursor de NSU so avanca depois que o lote inteiro esta
  gravado. Processo morto no meio retoma sem buraco e sem duplicata.

### NF-e e CT-e pela SEFAZ

- **Fonte:** `NFeDistribuicaoDFe` e `CTeDistribuicaoDFe` do Ambiente Nacional,
  SOAP 1.2 sobre mTLS, por NSU, um cursor por empresa e por fonte.
- **O que vem:** NF-e em que a empresa e destinataria (ou transportadora, ou
  autorizada no XML); CT-e em que ela e tomadora, remetente, destinataria,
  expedidora ou recebedora; e os eventos dessas notas.
- **O que nao vem:** a NF-e que a propria empresa emitiu. A SEFAZ nao devolve
  ao emitente o que ele emitiu: essas entram pela importacao do XML do
  emissor. Evento de nota emitida (o cliente dela manifestando) e registrado,
  mas nao vira pendencia.
- **Certificado:** so o A1 da propria empresa (mesma raiz de CNPJ). Procuracao
  vale no ADN, nao aqui: a SEFAZ rejeita com 593, e o sistema recusa antes de
  consultar. A UF da empresa e obrigatoria (vai no pedido).
- **Resumo e Ciencia da Operacao:** NF-e recebida chega primeiro como resumo
  (`resNFe`), sem o XML. O XML completo so e liberado depois da manifestacao
  do destinatario. O resumo vira pendencia com emitente, data e valor; o botao
  **Manifestar ciencia** envia o evento 210210 assinado em XMLDSig com o A1 do
  cliente e baixa o XML na hora pela consulta por chave. A ciencia automatica
  existe por empresa, **desligada por padrao**: e um ato em nome do cliente,
  so com a autorizacao dele. Toda manifestacao fica registrada (protocolo,
  quem pediu, XML assinado) e entra na trilha de auditoria. A ciencia nao
  confirma nem nega a operacao; a manifestacao conclusiva continua com o
  cliente.
- **Regra de uma hora:** depois de chegar ao fim da caixa, a SEFAZ so aceita
  nova consulta do CNPJ uma hora depois; insistir rende o bloqueio 656. O motor
  grava o horario liberado e a tarefa que chega antes volta para a fila marcada
  para aquele horario, sem gastar tentativa. Ciencia aceita na rodada agenda
  sozinha a busca do XML para depois da janela.
- **Retencao:** a distribuicao da SEFAZ guarda poucos meses (a documentacao
  fala em cerca de 90 dias). O que for mais antigo vem do arquivo da empresa.
- **PDF:** DANFE (retrato, canhoto, codigo de barras CODE-128C da chave, itens
  paginados) e DACTE, gerados no servidor, com marca CANCELADA quando chega o
  evento 110111.
- **TLS:** conferido em 08/10/2026, as cadeias do ADN e da SEFAZ sao aceitas
  pelo Node sem CA extra. `NUCLEO_ADN_CA` e `NUCLEO_SEFAZ_CA` ficam para o caso de
  isso mudar.

### Prefeituras com sistema proprio e NF-e emitida

Nota que nao passa pelos portais com NSU entra por importacao, no mesmo
acervo, na mesma conferencia e na mesma pasta:

- **NFS-e de prefeitura com sistema proprio** (padrao ABRASF): exporte os XML
  no site da prefeitura. O PDF da prefeitura com o mesmo nome do XML e guardado
  junto. A nota e identificada por CNPJ do prestador + numero, e o mes da pasta
  vem do campo Competencia.
- **NF-e emitida pela propria empresa** (a SEFAZ nao devolve ao emitente):
  exporte do emissor; o DANFE e gerado aqui. Cancelamento importado marca a
  nota e regera o PDF.
- **Dois caminhos:** o botao **Importar XML** no painel da empresa (XML, ZIP e
  PDF), ou a **pasta de entrada** `ENTRADA` dentro da pasta da
  empresa. O servidor (quando enxerga a pasta) ou o agente local le a pasta a
  cada minuto e move cada arquivo para `ENTRADA/IMPORTADOS/<data>` ou
  `ENTRADA/COM_ERRO`, com um `.motivo.txt` ao lado. Nada e apagado nem
  sobrescrito; arquivo copiado ha menos de 5 segundos espera a proxima volta.
- **Seguranca:** XML que nao menciona o CNPJ da empresa e recusado; nota de
  outro cliente nao entra por engano.
- **Quem emite fora do Emissor Nacional:** dois alertas olham a empresa que
  presta servico (Anexo III, IV ou V, ou modulo de servicos) e cujo ADN
  respondeu:
  - **Simples, vermelho:** desde 01/09/2026 o Simples so pode emitir NFS-e pelo
    Emissor Nacional (Resolucao CGSN 189/2026). Sem nenhuma NFS-e do padrao
    nacional desde 09/2026 (ou nos ultimos 3 meses, o que for mais recente), e
    irregularidade. Nota de sistema da prefeitura depois dessa data nao conta e
    e citada no alerta. A data fica em `EMISSOR_NACIONAL_SIMPLES`, em
    `lib/simples.mjs`.
  - **Presumido e Real, amarelo:** sem NFS-e nos ultimos 3 meses, o mais
    provavel e o sistema proprio da prefeitura. Importada a nota, o alerta some.

Conector direto com o sistema de uma prefeitura so existe quando ela oferece
webservice oficial ao contribuinte; isso e feito cidade a cidade, depois de
saber quais a carteira usa.

### PONTE SEFAZ como fonte de captura

A PONTE SEFAZ (`PONTE-SEFAZ`, em `ponte-sefaz.vercel.app`) ja faz, em producao, a
captura de uma carteira de escritorio: guarda o A1 de cada cliente, varre a
Distribuicao DF-e (NF-e, CT-e) e o ADN (NFS-e) todo dia, manifesta ciencia em
lote e monta o pacote de cada mes. Para os clientes que estao na carteira do
escritorio la, o NUCLEO captura **pela PONTE** em vez de consultar a SEFAZ de
novo:

- **Sem bloqueio 656.** A PONTE guarda um ponteiro de NSU por CNPJ. Se o NUCLEO
  consultasse a SEFAZ pelo mesmo CNPJ ao mesmo tempo, um derrubaria o outro por
  uma hora. Por isso a empresa com a PONTE ligada nao aceita NF-e e CT-e
  diretos (a tela recusa e explica).
- **Sem A1 duplicado.** O certificado fica no cofre da PONTE; a empresa nao
  precisa de certificado no NUCLEO.
- **Como funciona:** confere se o CNPJ esta na carteira, pede uma varredura
  (`/api/escritorio/radar/varrer`), traz o pacote dos ultimos 4 meses, um tipo
  de documento por vez (a funcao da Vercel devolve no maximo 4,5 MB), e passa
  tudo pela mesma importacao: acervo, conferencia, PDF gerado aqui, pasta do
  cliente. O `indice.csv` do pacote vira pendencia para o que a PONTE so tem
  em resumo, com a explicacao dela, e marca como cancelada a nota que ela
  informar cancelada.
- **Ciencia:** o botao Manifestar ciencia, numa pendencia que veio da PONTE,
  pede a ciencia a ela (que tem o A1); com a ciencia automatica da empresa
  ligada, vai em lote. O XML chega na captura seguinte.

**Para ligar com a PONTE real:**

1. Na PONTE, o cadastro do escritorio com o modulo de contabilidade ligado, e
   cada cliente na carteira dele, com o A1 (aba Contabilidades, em Clientes).
2. Gere a chave de API do cadastro do escritorio la.
3. No NUCLEO, em Sistema > Integracoes > PONTE SEFAZ > Configurar: `url`
   (`https://ponte-sefaz.vercel.app`) e `chave`. A chave fica cifrada no cofre e
   nunca volta pela API. O Testar mostra a carteira da PONTE e quais clientes
   tambem estao no NUCLEO.
4. Clique **Trazer a carteira** (Integracoes > PONTE SEFAZ): cada cliente da
   carteira passa a ser capturado pela PONTE; quem nao existe no NUCLEO e
   cadastrado; quem ja existe mantem a NFS-e pelo ADN e troca NF-e e CT-e
   diretos pela PONTE. Repetir nao duplica nada.

**Vigilancia pela PONTE.** Empresa capturada pela PONTE nao tem A1 aqui, entao
a cada captura o NUCLEO guarda o que a PONTE sabe dela (validade do A1, radar,
ultima varredura) e os achados da conferencia da PONTE. Viram alerta: A1
vencendo, vencido ou ausente na PONTE, empresa fora da carteira, radar
desligado, furo de numeracao, nota cancelada depois, captura atrasada, nunca
varrida e CFOP fora do padrao. "Falta manifestar" nao vira alerta: ja e
pendencia, com o botao.

O que fica de fora, de proposito: o DANFE da PONTE para nota recebida sai
"SEM VALOR FISCAL" (ela so carimba o que emitiu), entao o PDF continua sendo
gerado aqui; e a chave de cada empresa (as da Lidera e da Alianca) nao e usada,
porque a porta do escritorio alcanca a carteira inteira com uma chave so.

### Outras entradas que funcionam

- **Baixar NF-e pela chave** (Sistema > Importacoes): ate 20 chaves por vez,
  com a empresa destinataria. Usa a consulta por chave da SEFAZ com o A1 dela;
  XML e DANFE vao para o acervo e para a pasta. Cada chave volta com o motivo
  quando nao da: ja no acervo, nota emitida pela propria empresa, CT-e (sem
  consulta por chave na SEFAZ), nota que a SEFAZ nao tem para aquele CNPJ, ou
  resumo esperando a Ciencia da Operacao.
- **Pasta monitorada** (Sistema > Integracoes): uma pasta deste servidor, lida
  a cada minuto, ou na hora pelo botao Importar agora. O arquivo fica onde esta
  (a pasta pode ser de outro sistema); o conteudo ja lido nao entra de novo.
- **Testar** de cada conector: ADN e SEFAZ dizem, empresa por empresa, se o
  certificado esta valido e quando foi a ultima captura certa, sem consultar o
  portal. SIEG, Dominio e Acessorias mostram o que falta (contrato, token ou
  layout do fornecedor), em vez de um teste que sempre falha.

### Plano do escritorio: quantidade de empresas

O plano da contabilidade e regrado pela quantidade de empresas na carteira
(plano 1 tantas, plano 2 tantas). Quem diz o plano e a PONTE: quando a resposta
de `/api/escritorio/carteira` traz `plano: { nome, limiteEmpresas,
empresasNaCarteira }`, o NUCLEO guarda e passa a:

- mostrar "Plano X: N / limite" na Captura de notas > Carteira e no Testar da PONTE;
- recusar empresa nova acima do limite, dizendo o plano e mandando falar com o
  suporte (sem preco, como os planos BETA/PRO/MAX);
- no Trazer a carteira, nao criar alem do limite e listar quem ficou de fora.

Sem `plano` na resposta (ou `limiteEmpresas` nulo), sem limite.

### Revisao de cancelamentos da NFS-e pela chave

A caixa do ADN traz os eventos da empresa, mas a NFS-e que entrou por outro
caminho (importacao, pasta de entrada, chave avulsa) nunca seria perguntada de
novo, e o municipio pode cancelar de oficio. O NUCLEO pergunta a Sefin Nacional,
nota por nota (`GET /SefinNacional/nfse/{chave}/eventos/{tipo}/1`, Manual dos
Contribuintes da API do Emissor Nacional): 101101 cancelamento, 105102
substituicao, 305101 de oficio, 105104 deferido em analise fiscal.

- Botao **Revisar cancelamentos** em Captura de notas > Empresas (ultimos 3
  meses), e sozinho depois de cada captura pelo ADN (`NUCLEO_REVISAR_EVENTOS=1`,
  ultimos 2 meses).
- So o XML do evento cancela a nota (guardado junto dela, PDF com a marca);
  404 e "sem evento"; outra resposta e "nao conferida" e volta na proxima.
- Nota sem evento nao e perguntada de novo no mesmo dia (tabela
  `revisao_eventos`, migration 6).
- Usa o A1 da empresa guardado no NUCLEO. Empresa so pela PONTE fica de fora:
  o achado "cancelada depois" da conferencia da PONTE cobre.

### O que fica rastreado

Todo NSU devolvido pelo portal fica registrado com o que foi feito dele.

| Situacao | Significa | O que o sistema faz |
|---|---|---|
| Nota informada sem XML | o portal deu NSU e chave, nao o arquivo | pendencia com chave e NSU; "Tentar de novo" rebusca o NSU |
| XML corrompido | o arquivo chegou ilegivel | pendencia com NSU; rebusca |
| Evento de nota nao capturada | chegou cancelamento de uma nota que nao veio | pendencia com a chave para ir atras |
| PDF nao gerado | XML guardado, DANFSe falhou | pendencia; regera |
| Conflito na pasta | ja existe arquivo diferente com o mesmo nome | **nada e sobrescrito**; pendencia |
| NSU pulado | o portal confirma que nao ha documento ali | registrado como **confirmada**, nao como falta |
| Resumo de NF-e (SEFAZ) | a nota existe, o XML depende da ciencia | pendencia com emitente, data e valor; **Manifestar ciencia** |
| Resumo de NF-e cancelada | a SEFAZ nao entrega XML de nota cancelada | registrado como **confirmada** |

O sistema so prova ausencia em relacao ao que o portal informa. Nota emitida
fora do sistema nacional (prefeitura com sistema proprio) nao deixa rastro e
nao aparece em lugar nenhum: o painel diz isso em vez de mostrar 100%.

### Pasta de cada cliente

```
<pasta da empresa>/<ANO>/<MES>/<NF-e|NFS-e|CT-e|NFC-e|EVENTOS>/<EMITIDAS|RECEBIDAS|OUTRAS>/<XML|PDF>/<numero>_<contraparte>_<NSU>.<ext>
```

Cada empresa tem a sua pasta (o NUCLEO recusa a mesma pasta para duas). No
computador do escritorio, `agente\escolher-pastas.ps1` abre uma janela com as
empresas e o seletor de pastas do Windows em cada uma, sem colar caminho; o
botao "Usar a pasta padrao" cria `Documentos\EMPRESAS\<nome>` para as que
estao sem pasta. O ZIP de exportacao, que junta empresas, poe antes
`EMPRESAS/<CNPJ>/`.

NF-e e CT-e levam o prefixo `NFe_` e `CTe_` no nome, porque dividem a pasta com
a NFS-e e tem NSU proprio. `OUTRAS` guarda o que a empresa recebeu sem ser
emitente nem destinataria (CT-e em que so aparece como destinataria da carga,
por exemplo). O mes vem da competencia da NFS-e e da emissao da NF-e e do CT-e. Se o servidor enxerga a pasta (rodando no
computador do escritorio), grava direto. Se nao (servidor no Render), o
**agente local** grava quando o computador ligar:

```powershell
$env:NUCLEO_SERVIDOR = "https://seu-servico.onrender.com"
$env:NUCLEO_AGENTE_TOKEN = "nucleoa_..."   # Captura de notas > Agente local > Gerar token
npm run agente
```

Toda execucao reconcilia o acervo contra a pasta: nota guardada sem espelho
(queda no meio, pasta configurada depois) e reagendada sozinha. Trocar a
pasta de uma empresa reenvia tudo para o destino novo.

### Ver funcionando sem certificado real

```powershell
npm run demo:captura
```

Sobe um ADN e uma SEFAZ simulados com mTLS de verdade, o servidor apontado
para eles, e semeia tres certificados de teste, duas empresas (uma por
procuracao), 35 NFS-e, 4 NF-e recebidas (uma cancelada), um resumo de NF-e
esperando ciencia, 3 CT-e, uma nota sem XML e um XML corrompido. Para ver a
importacao, use **Importar XML** no painel da empresa dois com qualquer XML
de `fixtures/` que cite o CNPJ dela. Abra
`http://localhost:4175` com `admin@demo.local` / `123456`. Os dados ficam em
`data-demo/`. Na demonstracao a janela de uma hora da SEFAZ vira um minuto.

### Implantacao no Render

`render.yaml` descreve o servico: plano gratuito, uma instancia, Node 24,
`NUCLEO_MODO_PASTA=agente` e `NUCLEO_ATRAS_DE_PROXY=1`. As chaves
`NUCLEO_CHAVE_SEGREDOS` e `NUCLEO_CHAVE_AUDITORIA` sao geradas pelo proprio Render
na criacao (`generateValue`) e nunca ficam no repositorio. Passo a passo em
`SUBIR-NO-RENDER.md`.

O gratuito apaga o disco ao dormir (15 minutos sem acesso) e ao reiniciar.
`lib/nuvem.mjs` guarda tudo num bucket privado do Supabase Storage:

| O que | Como |
|---|---|
| Banco | copia consistente (`VACUUM INTO`), comprimida, alguns segundos depois de cada mudanca e no desligamento (SIGTERM); duas vagas alternadas e o manifesto so muda quando todas as partes subiram; uma copia por dia da semana |
| Subida com o disco vazio | baixa a ultima copia antes de abrir o banco, conferida pelo SHA-256 |
| XML, PDF e uploads | sobem antes de existir no disco (se nao sobem, a gravacao falha); voltam na primeira leitura |
| Nuvem ilegivel na subida | o servidor recusa subir: abrir banco vazio apagaria o bom na copia seguinte |
| Outro servidor no mesmo bucket | recusa subir (cada banco tem uma origem) |

Variaveis: `NUCLEO_SUPABASE_URL`, `NUCLEO_SUPABASE_CHAVE` (a service_role LEGADA,
`eyJ...`: o Storage recusa a `sb_secret_`), `NUCLEO_SUPABASE_BUCKET` (padrao
`nucleo`). `supabase/manter-acordado.sql` faz o pg_cron do Supabase chamar o
`/api/health` a cada 10 minutos, para o agendamento do dia 1 rodar.

Plano pago com disco continua possivel: troque `plan`, acrescente `disk` em
`/var/data` e `NUCLEO_DATA_DIR=/var/data`.

### Antes do primeiro cliente real

1. **Medir com o primeiro certificado real** (fase 0 da proposta). A
   ferramenta so le: nao grava, nao manifesta, nao gera PDF. Responde se o
   mTLS fecha, quantos documentos ha e desde quando, a latencia e quantos 429
   aparecem. A senha vai por variavel de ambiente, nunca pela linha de comando:

   ```powershell
   $env:NUCLEO_MEDIR_SENHA = "senha-do-certificado"
   npm run medir -- --pfx "C:\certs\cliente.pfx" --uf SP
   ```

   Gera `medicao-<cnpj>-<data>.json` sem senha e sem conteudo de nota. Se a
   medicao da NF-e ou do CT-e chegar ao fim da caixa, espere uma hora antes de
   ligar a captura dessa empresa (regra da SEFAZ).
   Rode a medicao duas vezes: no computador do escritorio e pelo Shell do
   servico no Render. O Render nao tem regiao no Brasil, e a segunda rodada
   confirma que ADN e SEFAZ aceitam o IP de saida dele.
2. **Cadeia TLS dos servidores.** Conferida em 08/10/2026: o Node aceita ADN e
   SEFAZ sem CA extra. Se um dia recusar com "unable to get local issuer
   certificate", aponte `NUCLEO_ADN_CA` ou `NUCLEO_SEFAZ_CA` para a cadeia.
3. **Autorizacao escrita de cada cliente** para uso do certificado e guarda dos
   documentos (LGPD: o escritorio passa a operador de dados).
4. **A1 do Windows:** o `.pfx` exportado pelo Windows usa RC2-40, que o
   OpenSSL 3 trata como legado. `lib/pkcs12.mjs` le o arquivo em JavaScript e
   entrega PEM ao TLS, entao o A1 abre com ou sem `--openssl-legacy-provider`
   (a opcao continua no `npm start`, mas a captura nao depende mais dela).

## Rodar

```powershell
cd "C:\Users\Usuario\Documents\NUCLEO X"
npm start
```

Abra `http://localhost:4175`.

> O PowerShell 5.1 (Windows PowerShell) nao aceita `&&`. Use `;` para encadear,
> ou duas linhas como acima. O PowerShell 7 (`pwsh`) aceita `&&`.

Na **primeira execucao** o sistema cria um administrador e imprime no console
uma senha aleatoria, uma unica vez, com troca obrigatoria no primeiro login.
Nao existe usuario com senha publica por padrao.

### Chaves do ambiente

```powershell
npm run chaves
```

Gera as duas chaves e mostra como exporta-las. Elas nao sao gravadas por
nenhuma parte do sistema, de proposito.

| Variavel | Para que serve | Sem ela |
|---|---|---|
| `NUCLEO_CHAVE_SEGREDOS` | cifra as credenciais de integracao (AES-256-GCM) | salvar credencial e **recusado**; nada vai para o banco em texto plano |
| `NUCLEO_CHAVE_AUDITORIA` | assina a trilha com HMAC | a cadeia de hash segue funcionando, mas quem tem o arquivo do banco pode reescrever tudo e recalcular os hashes |

Outras variaveis: `PORT`, `NUCLEO_DATA_DIR`, `NUCLEO_BANCO`, `NUCLEO_ADMIN_EMAIL`,
`NUCLEO_ADMIN_SENHA`, `NUCLEO_ESCRITORIO`, `NUCLEO_ARQUIVO_CHAVE`.
Login: `NUCLEO_LOGIN_MAX_CONTA` (padrao 5), `NUCLEO_LOGIN_MAX_ORIGEM` (padrao 20) e
`NUCLEO_ATRAS_DE_PROXY=1`, que faz o IP de origem vir de `x-forwarded-for` (so
ligue atras de um proxy que escreve esse cabecalho, como o do Render).

Captura: `NUCLEO_ADN_BASE`, `NUCLEO_ADN_CA`, `NUCLEO_ADN_ESPACAMENTO_MS`,
`NUCLEO_ADN_TENTATIVAS`, `NUCLEO_ADN_ESPERA_MAX_MS`, `NUCLEO_MODO_PASTA`
(`auto`, `servidor` ou `agente`), `NUCLEO_FUSO`, `NUCLEO_CAPTURA_CONCORRENCIA`.
SEFAZ: `NUCLEO_SEFAZ_AMBIENTE` (`producao` ou `homologacao`), `NUCLEO_SEFAZ_CA`,
e `NUCLEO_SEFAZ_NFE_DIST`, `NUCLEO_SEFAZ_CTE_DIST`, `NUCLEO_SEFAZ_NFE_EVENTO` e
`NUCLEO_SEFAZ_ESPERA_MIN` so para apontar para o simulador.

### Modo demonstracao

```powershell
$env:NUCLEO_DEMO = "1"; npm start
```

Cria `admin@demo.local` e `fiscal@demo.local` com senha `123456`, mais quatro
empresas ficticias. **Nao use em producao**: a suite de testes usa este modo.

## Visual

Mesma base do template de escritorio que o Lovable gerou na PONTE: Tailwind 4,
componentes no desenho do shadcn/ui, tokens em oklch (primaria indigo, destaque
esmeralda), Inter Tight e rotulos curtos em CAIXA ALTA pelo CSS (titulo, menu,
aba, campo, botao, cabecalho de tabela, badge). Navegacao no topo, sem barra
lateral: grupos no cabecalho e as telas num trilho de abas logo abaixo.

`estilo/nucleo.css` e a fonte; `npm run css` copia a Inter Tight para
`public/fonts` e compila `public/styles.css`. Os dois vao para o repositorio: o
servidor nao instala nem compila nada, e a CSP so aceita estilo e fonte do
proprio endereco.

## Testar

```powershell
npm test
```

622 verificacoes em sete suites: 38 de banco, cofre e limite de tentativas,
199 de ponta a ponta pela API (inclusive cabecalhos de seguranca e trava de
login), 170 da captura contra ADN, SEFAZ e PONTE simulados
(certificado proprio, procuracao, A1 legado do Windows, vencido, sem
procuracao, queda no meio da drenagem, agendador por fonte, agente local,
exportacao ZIP, ciencia pela API, adiamento pela janela de uma hora, pasta de
entrada lida pelo servidor e pelo agente, teste de cada conector, pasta
monitorada, download de NF-e pela chave e captura pela PONTE), 67 do motor da SEFAZ (resumo,
ciencia automatica e manual, consulta por chave, cancelamento, evento de nota
emitida, CT-e tomado e de terceiro, 593, 656, assinatura adulterada recusada)
e 35 da importacao (NFS-e de prefeitura com o PDF dela, NF-e emitida, ZIP,
nota de outra empresa recusada, pasta de entrada, alerta de prestadora sem
NFS-e no Emissor Nacional) e 44 da captura pela PONTE SEFAZ (carteira, pacote
por mes e tipo, resumo, ciencia pela PONTE, cancelamento, chave errada ou
somente leitura, CNPJ fora da carteira, pacote que falha, alertas do A1 e da
conferencia da PONTE, trazer a carteira) e 45 da guarda no Supabase (servidor
que dorme, perde o disco e volta com banco, sessao, XML e uploads; ultima
mudanca salva no desligamento; copia em partes e em vagas; nuvem fora do ar,
copia adulterada e outro servidor no mesmo bucket recusados).

```powershell
npm run fixtures
```

Regenera os XML de teste em `fixtures/`, com chave de acesso e DV validos.

## O que faz, de verdade

### 1. Capturar

- **XML e ZIP**: NF-e e NFC-e (layout 4.00), NFS-e nos padroes ABRASF e
  nacional, e eventos de cancelamento. ZIP aberto com `zlib` pelo diretorio
  central; subpastas funcionam, nao-XML e ignorado.
- **Deduplicacao** pela chave de acesso de 44 digitos, ou por CNPJ+numero+serie
  na NFS-e. Reenviar o mesmo arquivo nao duplica documento.
- **Validacao da chave**: DV por modulo 11, e coerencia entre a chave e o
  conteudo da nota (CNPJ, numero, serie, modelo, competencia).
- **Vinculo automatico** pelo CNPJ do emitente. Documento capturado antes do
  cadastro e vinculado quando o cliente e criado.

### 2. Conferir

Recalcula e aponta divergencia com **memoria de calculo e base normativa**:

| Area | Verificacoes |
|---|---|
| PIS / COFINS | valor recalculado de base x aliquota; CST sem tributo com valor destacado; CST tributado com aliquota zerada |
| ICMS | valor proprio recalculado; ICMS-ST pela base x aliquota menos o proprio |
| Totais | soma dos itens x total declarado, por tributo; composicao do valor da nota |
| Cadastro | NCM de 8 digitos; CFOP de 4 digitos coerente com entrada/saida; CFOP de ST sem CST 60/CSOSN 500; CEST ausente em operacao com ST |
| Regime | optante do Simples usando CST em vez de CSOSN, e o inverso; CSOSN fora da tabela |
| Chave | DV e coerencia com o conteudo |
| NFS-e | ISS recalculado; base igual a servicos menos deducoes; teto de 5% e piso de 2%; retencao marcada sem valor destacado; servico sem item da LC 116 |
| Escritorio | regra propria por NCM com aliquota esperada |

Cada achado traz esperado, encontrado, diferenca, a conta e o dispositivo legal.
Divergencia pode ser **justificada**, e a justificativa sobrevive a
reconferencia do mesmo achado.

### 3. Apurar o Simples Nacional

Tabelas dos **Anexos I a V** da LC 123/2006 (redacao da LC 155/2016),
**conferidas em 08/10/2026** contra o texto da LC 155/2016, o anexo oficial da
Receita Federal e o texto consolidado do Senado. As 30 linhas de reparticao
foram comparadas numero por numero, sem divergencia.

- Aliquota efetiva: `[(RBT12 x nominal) - parcela a deduzir] / RBT12`.
- **Fator R**: folha de 12 meses sobre RBT12; 28% ou mais leva ao Anexo III,
  abaixo leva ao Anexo V.
- **Teto de ISS de 5%**, com excedente redistribuido aos tributos federais.
- **Faixa 6 e sublimite**: ICMS e ISS saem do DAS, e o sistema **nao inventa** o
  valor deles, porque ele nao sai da tabela do Simples.
- Receita somada dos documentos de saida da competencia, com as chaves que a
  formaram.
- Reparticao por tributo que **fecha exatamente** com o DAS.
- Memoria de calculo passo a passo, e `Sem Movimento` quando nao ha receita.

**Limite de vigencia:** as tabelas valem ate a competencia **12/2026**. A
reforma tributaria troca PIS e COFINS por CBS e IBS na reparticao a partir de
01/2027 e muda aliquota nominal, com outra mudanca em 2029. Apurar competencia
de 2027 em diante e **recusado**, com a explicacao do motivo; so grava com
`confirmarForaDeVigencia: true`, e a confirmacao vai para a auditoria.

### 4. Vigiar

Sete monitores, todos calculados do acervo:

| Monitor | Dispara quando |
|---|---|
| `CERT_VENCIDO` / `CERT_VENCENDO` / `CERT_AUSENTE` | certificado fora da validade, perto dela, ou cliente com modulo ativo sem certificado |
| `SEM_EMISSAO` | ultima nota de saida mais antiga que o limite configurado |
| `CAPTURA_FALHA` / `ROTINA_FALHA` | importacao ou rotina terminou em erro |
| `DAS_SEM_APURACAO` / `DAS_VENCIDO` | competencia encerrada sem apuracao, ou DAS aberto apos o vencimento |
| `DIVERGENCIA_ABERTA` | achado critico de conferencia sem justificativa |
| `QUEDA_FATURAMENTO` | mes atual muito abaixo da media dos anteriores |
| `SIMPLES_LIMITE_PROXIMO` | RBT12 chegando no teto de permanencia |

Ids **deterministicos**: o mesmo fato gera o mesmo id, entao rodar a vigilancia
de novo nao duplica alerta, e alerta resolvido ou ignorado nao reabre. Ignorar
exige justificativa. Limites configuraveis em **Configuracoes**, e mudar um
recalcula a fila na hora.

### 5. Provar

Tres camadas, de fora para dentro:

1. **Encadeamento por hash**: cada evento carrega o hash do anterior. Alterar,
   remover ou reordenar rompe a cadeia, e a verificacao aponta onde.
2. **Append-only no banco**: triggers em `audit_log` abortam `UPDATE` e
   `DELETE`. Nem a propria aplicacao consegue reescrever um evento.
3. **Assinatura HMAC**: com `NUCLEO_CHAVE_AUDITORIA`, cada evento e assinado com
   uma chave que nao esta no banco. Quem tem acesso de escrita ao arquivo pode
   derrubar os triggers e recalcular os hashes, mas nao consegue refazer as
   assinaturas, e a verificacao aponta o evento reescrito.

Credenciais nunca entram na trilha: so os nomes das chaves que mudaram.

## Seguranca

| Item | Como esta |
|---|---|
| Senha | scrypt com sal por usuario; minimo de 10 caracteres, nao so numeros, fora da lista das mais comuns |
| Primeiro acesso | senha aleatoria impressa uma vez, troca obrigatoria; o servidor devolve 403 em tudo ate a troca |
| Sessao | token de 32 bytes; o banco guarda apenas o SHA-256 dele, entao o arquivo nao permite se passar por ninguem |
| Credenciais de integracao | AES-256-GCM com chave do ambiente; sem a chave, gravar e recusado |
| RBAC | verificado em cada rota do servidor, nao escondendo botao |
| Auditoria | cadeia de hash + append-only no banco + HMAC opcional |
| Tentativas de senha | 5 erros por conta ou 20 por origem em 15 minutos travam por 15 minutos; resposta 429 com `Retry-After`; a trava entra na trilha. Vale para o login e para a troca de senha |
| Cabecalhos | CSP fechada (`script-src 'self'`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`; HSTS so quando o pedido chega por HTTPS (Render) |

Nao ha recuperacao de senha por e-mail: um administrador desativa o usuario e
cria outro. Com um unico administrador, perder a senha dele significa perder o
acesso administrativo.

## O que NAO faz

Dito na interface, na cara do usuario:

| Falta | Por que |
|---|---|
| NF-e emitida pela propria empresa, pela SEFAZ | a distribuicao nao devolve ao emitente; entra pela importacao do XML do emissor |
| NF-e e CT-e com procuracao | a SEFAZ so atende o A1 da propria empresa (mesma raiz de CNPJ) |
| Conector direto com prefeitura de sistema proprio | depende de cada cidade oferecer webservice; ate la, a nota entra por importacao ou pela pasta de entrada |
| SIEG, Dominio, Acessorias | exigem contrato, credencial e o cliente HTTP de cada um |
| A3 na rotina automatica | token e cartao exigem PIN a cada uso, com alguem presente; so A1 entra no agendamento |
| Assinar e transmitir documento | mesma dependencia de certificado |
| Apurar Lucro Presumido e Lucro Real | so o Simples Nacional esta implementado |
| Competencia de 2027 em diante | os anexos da reforma tributaria ainda nao foram transcritos |
| XLSX e PDF | os relatorios saem em CSV |

A NFS-e nacional (ADN) e a NF-e/CT-e (SEFAZ) estao implementadas. Os outros conectores existem como
**interface declarada** em `lib/captura.mjs`: cada um diz o que exige e falha
com `501` listando o que falta. Nenhum deles finge conexao.

## Estrutura

```
server.mjs               API e rotas
lib/banco.mjs            SQLite, migrations, triggers append-only
lib/repositorio.mjs      acesso a dados (todo o SQL vive aqui)
lib/estado.mjs           senha, permissao, validacao de CNPJ
lib/semente.mjs          semeadura de primeira execucao
lib/painel.mjs           indicadores do dashboard, por agregacao
lib/segredos.mjs         cofre AES-256-GCM das credenciais
lib/auditoria.mjs        cadeia de hash e assinatura HMAC
lib/xml.mjs              parser XML sem dependencia
lib/zip.mjs              leitura de ZIP via zlib
lib/documentos.mjs       extracao de NF-e, NFC-e, NFS-e
lib/conferencia.mjs      motor de conferencia tributaria
lib/simples.mjs          tabelas e apuracao do Simples Nacional
lib/monitores.mjs        os sete monitores de vigilancia
lib/captura.mjs          captura por arquivo e adaptadores de portal
lib/certificados.mjs     abre o PFX com a senha, le titular, CNPJ e validade
lib/adn.mjs              cliente mTLS da API de distribuicao do ADN
lib/sefaz.mjs            cliente SOAP mTLS da distribuicao de NF-e/CT-e e da manifestacao
lib/pkcs12.mjs           tira a chave privada do PFX para assinar
lib/xmldsig.mjs          assinatura e conferencia XMLDSig no padrao da NF-e
lib/pdf-fiscal.mjs       DANFE e DACTE, com codigo de barras CODE-128C
lib/motor-captura.mjs    drenagem por NSU (ADN e SEFAZ), rastreio, pendencias, ciencia, PDF, espelho
lib/danfse.mjs           roda o gerador de DANFSe da extensao no Node
lib/repo-captura.mjs     dados da captura (certificados A1, fila, rastreio...)
lib/fila.mjs             fila com concorrencia e trava por empresa
lib/agendador.mjs        regra mensal, semanal e diaria no fuso de Brasilia
lib/pastas.mjs           pasta do cliente sem sobrescrever conteudo diferente
lib/acervo.mjs           XML e PDF enderecados por SHA-256
lib/entrada.mjs          pasta de entrada de cada empresa (ENTRADA, IMPORTADOS, COM_ERRO)
lib/ponte.mjs            cliente da PONTE SEFAZ pela porta do escritorio
lib/rotas-captura.mjs    rotas HTTP da captura
agente/agente.mjs        agente local que grava nas pastas do escritorio
vendor/                  danfse.js, pdf-lib, fontkit, qrcode e tabelas da extensao
render.yaml              implantacao no Render
public/app.js            interface (modulo unico): navegacao em abas no topo, titulos em CAIXA ALTA
ferramentas/medir-portal.mjs  medicao so leitura com o primeiro A1 real (npm run medir)
tests/teste-banco.mjs    30 verificacoes de banco e cofre
tests/teste-nucleo.mjs   191 verificacoes de ponta a ponta
tests/teste-captura.mjs  170 verificacoes da captura contra ADN, SEFAZ e PONTE simulados
tests/teste-sefaz.mjs    67 verificacoes do motor da SEFAZ
tests/teste-importacao.mjs 35 verificacoes da importacao e da pasta de entrada
tests/teste-ponte.mjs    44 verificacoes da captura pela PONTE SEFAZ
tests/ponte-simulada.mjs PONTE de teste com o contrato da porta do escritorio
tests/adn-simulado.mjs   ADN de teste com mTLS obrigatorio
tests/sefaz-simulado.mjs SEFAZ de teste: SOAP, mTLS, 593, 656, ciencia com XMLDSig conferido
tests/dfe-fixtures.mjs   NF-e, resumo, CT-e e eventos com chave e DV validos
tests/demo-captura.mjs   demonstracao navegavel (npm run demo:captura)
tests/gerar-fixtures.mjs gerador dos XML de teste
tests/gerar-chaves.mjs   gerador das chaves do ambiente
data/nucleo.db           banco (criado na primeira execucao)
data/uploads/            arquivos enviados
```

### Banco

33 tabelas com chave estrangeira, indices e migrations versionadas em
`lib/banco.mjs`. Para evoluir o esquema, **acrescente** uma migration ao array;
nunca edite uma ja aplicada. O WAL fica ligado, entao leitura e escrita
concorrem.

## Antes de usar em producao

1. **Gerar e exportar as duas chaves** (`npm run chaves`). Sem elas o sistema
   funciona, mas sem cofre e sem assinatura da trilha.
2. **Nao usar `NUCLEO_DEMO=1`.** Trocar a senha inicial do administrador.
3. **Backup do `data/nucleo.db`** e dos `data/uploads/`. Com WAL ligado, copie
   tambem `-wal` e `-shm`, ou pare o processo antes. Com o Supabase ligado, a
   copia ja sai sozinha (uma por dia da semana em `banco/dia-0..6`).
4. **Validar os parsers contra XML real** dos seus clientes, principalmente
   NFS-e: cada municipio tem o seu padrao, e os fixtures cobrem ABRASF e o
   nacional, nao todos os provedores. Esta e a unica recomendacao desta lista
   que nao consigo cumprir sozinho: depende dos seus arquivos.
5. **Transcrever os anexos de 2027** antes de janeiro, se for apurar
   competencias dali em diante.
6. **Considerar cofre externo** (Vault, KMS) no lugar da chave em variavel de
   ambiente, se o modelo de ameaca incluir quem tem o processo.

## Historico

`mapeamento_funcional_nucleo.md` e `plano_replicacao_nucleo.md` sao a
analise original de engenharia reversa da interface, de 08/10/2026, e estao
marcados como historicos. `FECHAMENTO_REPLICA.md` registra o que mudou desde
entao.
