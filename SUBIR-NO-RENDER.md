# SUBIR O NUCLEO NO RENDER (PLANO GRATUITO + SUPABASE)

O codigo ja esta pronto, com os testes passando (622), a entrada protegida
contra senha chutada e os cabecalhos de seguranca do endereco publico. O
repositorio privado e `nucleo-fiscalw/nucleo-x`.

O Render gratuito apaga o disco sempre que o servico dorme (15 minutos sem
acesso) ou reinicia. Por isso o NUCLEO guarda tudo no Supabase: o banco sobe
alguns segundos depois de cada mudanca e no desligamento, e volta sozinho na
subida; XML, PDF e uploads sobem na hora e voltam na primeira leitura. Se a
copia da nuvem nao puder ser lida, o servidor **recusa subir**, em vez de abrir
um banco vazio por cima do bom.

## 1. O SUPABASE

1. Escolha (ou crie) o projeto que vai guardar o NUCLEO.
2. Em **Project Settings** > **Data API**, copie a **Project URL**
   (`https://xxxx.supabase.co`).
3. Em **Project Settings** > **API Keys** > **Legacy API Keys**, revele e copie a
   **service_role** (comeca com `eyJ`). A chave nova `sb_secret_` nao serve: o
   Storage a recusa.

O bucket privado `nucleo` e criado pelo proprio NUCLEO na primeira subida.

## 2. O SERVICO NO RENDER

1. https://dashboard.render.com > **New** > **Blueprint**.
2. Conecte o GitHub (conta nucleo-fiscalw) e escolha `nucleo-x`. O Render le o
   `render.yaml`: servico `nucleo-fiscal`, plano gratuito.
3. Ele pede os valores marcados `sync: false` no `render.yaml`:
   - `NUCLEO_CHAVE_SEGREDOS` e `NUCLEO_CHAVE_AUDITORIA`: 32 bytes aleatorios cada
     (`npm run chaves` gera os dois). Nunca mudam depois de criados;
   - `NUCLEO_SUPABASE_URL`: a Project URL do passo 1;
   - `NUCLEO_SUPABASE_CHAVE`: a service_role do passo 1;
   - `NUCLEO_ADMIN_EMAIL`: o e-mail de acesso do dono do escritorio;
   - `NUCLEO_ESCRITORIO`: o nome do escritorio;
   - opcionais (o kit da PONTE preenche, veja abaixo): `NUCLEO_ADMIN_SENHA`,
     `NUCLEO_PONTE_URL`, `NUCLEO_PONTE_CHAVE` e `NUCLEO_MARCA_JSON`. Vazios, nada muda.
4. **Apply**. A primeira subida leva poucos minutos.
5. Depois, em **nucleo-fiscal** > **Environment**, copie `NUCLEO_CHAVE_SEGREDOS` e
   `NUCLEO_CHAVE_AUDITORIA` para um lugar seguro (gerenciador de senhas). A
   primeira abre os certificados A1 e a chave da PONTE guardados no banco: se o
   servico for apagado e recriado sem ela, tudo isso precisa ser cadastrado de
   novo. Nao mande essas chaves por chat nem e-mail. (`npm run chaves` continua
   servindo para rodar o NUCLEO fora do Render.)

## 3. PRIMEIRO ACESSO

1. No Render, em **Logs**, procure a linha da senha do administrador: ela
   aparece uma unica vez, na primeira subida (nas proximas o banco volta do
   Supabase, com a senha que voce definir).
2. Abra o endereco do servico (`https://nucleo-fiscal.onrender.com`), entre
   com o e-mail do passo 2 e essa senha. O sistema pede a troca na hora.

## 4. MANTER ACORDADO

Dormindo, o agendamento do dia 1 so roda quando alguem abrir o sistema. No
Supabase, **SQL Editor**, rode `supabase/manter-acordado.sql` trocando
`SEU-SERVICO` pelo endereco do passo 3. O proprio Supabase chama o NUCLEO a cada
10 minutos.

O Render gratuito da 750 horas por mes por workspace; ligado o mes inteiro, o
NUCLEO usa ate 744. Se houver outro servico gratuito ligado no mesmo
workspace, use a versao de horario comercial que esta no mesmo arquivo.

## 5. LIGAR A PONTE

1. No painel da PONTE: **Clientes** > aba **Contabilidades** > **+ Nova
   contabilidade** (se o escritorio ainda nao estiver la). Abra o escritorio,
   inclua as empresas em **+ Empresa na carteira**, com o A1 de cada uma, e em
   **Chave da API deste escritorio** clique **Gerar chave**. Copie a chave.
2. No NUCLEO: **Sistema** > **Integracoes** > PONTE SEFAZ > **Configurar**.
   `url`: `https://ponte-sefaz.vercel.app`; `chave`: a que voce copiou.
3. **Testar**: mostra a carteira da PONTE. Depois **Trazer a carteira**: todas
   as empresas passam a ser capturadas pela PONTE.

Empresa que nao esta na PONTE: **Certificados A1** > envie o A1 dela, e em
**Captura de notas** > **Empresas** > **Configurar**, marque NFS-e, NF-e e CT-e.

### Instalacao pelo kit da PONTE (um NUCLEO por contabilidade)

O kit da PONTE cria o servico com tudo preenchido, e o escritorio ja abre
ligado a ela e com a propria marca:

- `NUCLEO_PONTE_URL` (`https://ponte-sefaz.vercel.app`) e `NUCLEO_PONTE_CHAVE`
  (a chave de API do escritorio na PONTE): lidas so na primeira subida, vao
  cifradas para o cofre. Depois vale **Integracoes > PONTE SEFAZ**; o ambiente
  nunca sobrescreve.
- `NUCLEO_ADMIN_SENHA`: se vier, e provisoria (troca obrigatoria no primeiro login).
- `NUCLEO_MARCA_JSON`: o manifesto do escritorio numa linha (`escritorio`,
  `branding`, `telas`, `support`, `ui`, no formato do
  `escritorio.manifest.json` do kit). Nome, logo e favicon (https ou
  data:image), cores em #hex, tema claro ou escuro, mensagem de login, rodape,
  suporte e telas ligadas. O bloco `api` do manifesto e ignorado: segredo nao
  vai na marca. Campo invalido cai no padrao, com aviso no log.

## 6. AS PASTAS DOS CLIENTES (agente local)

O Render nao enxerga o disco do escritorio. Quem grava nas pastas e o agente,
neste computador:

1. No NUCLEO: **Captura de notas** > **Agente local** > **Gerar token**. Copie.
2. No PowerShell deste computador, uma vez so:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\Usuario\Documents\NUCLEO X\agente\configurar-agente.ps1"
```

3. Cole o token quando ele pedir (nao aparece na tela). O configurador confere
   o token com o NUCLEO antes de guardar, grava `NUCLEO_SERVIDOR` e
   `NUCLEO_AGENTE_TOKEN` nas variaveis do seu usuario, pergunta se o agente deve
   ligar junto com o Windows (atalho na pasta Inicializar) e ja liga o agente,
   numa janela minimizada.

4. Escolha a pasta de cada empresa, sem digitar caminho:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\Usuario\Documents\NUCLEO X\agente\escolher-pastas.ps1"
```

   Abre uma janela com as empresas: "Escolher..." abre o seletor de pastas do
   Windows; "Usar a pasta padrao" cria `Documentos\EMPRESAS\<nome>` para as que
   estao sem pasta.

Dentro da pasta de cada empresa o agente grava `ANO\MES\<NF-e|NFS-e|CT-e>\
<EMITIDAS|RECEBIDAS>\<XML|PDF>`, a cada 5 minutos, e leva ao NUCLEO o que voce
soltar na pasta `ENTRADA` dela. O registro do que fez fica em
`agente\agente.log`. Para ligar na mao: `agente\iniciar-agente.ps1`.

## 7. CONFERIR QUE ESTA TUDO NO AR

- `https://nucleo-fiscal.onrender.com/api/health` mostra
  `"nuvem": { "ativa": true, "ultimaCopia": ... }`.
- **Captura de notas** > **Carteira** > **Capturar todas agora**: cada empresa
  roda, e a **Fila** mostra o resultado de NFS-e, NF-e, CT-e ou PONTE.
- **Agendamentos**: crie o mensal (dia 1, 6h). Ele busca a competencia anterior
  e revarre no dia 6 e no dia 16.
- O Render nao tem regiao no Brasil. Se a SEFAZ ou o ADN recusarem o endereco
  dele, a primeira captura de uma empresa com A1 proprio mostra o erro na Fila;
  as empresas pela PONTE nao sao afetadas (quem fala com a SEFAZ e a PONTE).

## LIMITES DO GRATUITO

- **Supabase**: 1 GB de arquivos (XML, PDF, uploads e as copias do banco). Um
  XML tem de 10 a 30 KB e um PDF de 50 a 100 KB: da para alguns milhares de
  notas com PDF. O projeto gratuito pausa depois de uma semana sem uso; pausado,
  o NUCLEO recusa subir ate voce reativa-lo no painel do Supabase (os dados
  continuam la).
- **Render**: o que mudou nos ultimos segundos antes de uma queda brusca (sem o
  aviso de desligamento) pode se perder; o normal, dormir ou reiniciar, sobe a
  ultima copia antes de desligar.
- Uma copia por dia da semana fica em `banco/dia-0` a `banco/dia-6` no bucket,
  para voltar no tempo se algo for apagado por engano.
