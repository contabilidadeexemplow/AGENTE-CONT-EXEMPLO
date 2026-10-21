# ESCOLHER A PASTA DE CADA EMPRESA (no computador do escritorio)
#
# Abre uma janela com as empresas do NUCLEO. Em cada uma, "Escolher..." abre o
# seletor de pastas do Windows: nada de colar caminho. A pasta escolhida vai
# para o NUCLEO, e o agente grava nela, a cada 5 minutos:
#
#   <pasta da empresa>\<ANO>\<MES>\<NF-e|NFS-e|CT-e>\<EMITIDAS|RECEBIDAS>\<XML|PDF>
#
# "Usar a pasta padrao" cria Documentos\EMPRESAS\<NOME DA EMPRESA> para as que
# ainda estao sem pasta. Cada empresa tem a sua: o NUCLEO recusa a mesma pasta
# para duas.
#
# Usa o endereco e o token do agente guardados pelo configurar-agente.ps1.
#
# Uso: powershell -ExecutionPolicy Bypass -File agente\escolher-pastas.ps1

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# As variaveis deste computador mudaram de nome (agora NUCLEO_). Na primeira vez,
# o valor do nome antigo passa para o novo; o antigo fica como esta.
foreach ($nome in "SERVIDOR", "AGENTE_TOKEN", "AGENTE_RAIZ", "AGENTE_INTERVALO_S") {
  $antigo = [Environment]::GetEnvironmentVariable(("J" + "360_" + $nome), "User")
  if ($antigo -and -not [Environment]::GetEnvironmentVariable(("NUCLEO_" + $nome), "User")) {
    [Environment]::SetEnvironmentVariable(("NUCLEO_" + $nome), $antigo, "User")
  }
}

$servidor = $env:NUCLEO_SERVIDOR
if (-not $servidor) { $servidor = [Environment]::GetEnvironmentVariable("NUCLEO_SERVIDOR", "User") }
$token = $env:NUCLEO_AGENTE_TOKEN
if (-not $token) { $token = [Environment]::GetEnvironmentVariable("NUCLEO_AGENTE_TOKEN", "User") }
if (-not $servidor -or -not $token) {
  [System.Windows.Forms.MessageBox]::Show("O agente ainda nao foi configurado neste computador. Rode antes o agente\configurar-agente.ps1.",
    "NUCLEO") | Out-Null
  exit 2
}
$servidor = $servidor.TrimEnd("/")
$cabecalho = @{ "x-agente-token" = $token }

function Mensagem-DeErro($erro) {
  $texto = $erro.ErrorDetails.Message
  if ($texto) {
    try { $texto = ($texto | ConvertFrom-Json).error } catch { }
  } else {
    $texto = $erro.Exception.Message
  }
  return $texto
}

function Ler-Empresas {
  return @(Invoke-RestMethod -Uri ($servidor + "/api/agente/empresas") -Headers $cabecalho -TimeoutSec 120)
}

function Gravar-Pasta($empresa, $pasta) {
  $corpo = [Text.Encoding]::UTF8.GetBytes((@{ pastaDestino = $pasta } | ConvertTo-Json))
  return Invoke-RestMethod -Uri ($servidor + "/api/agente/empresas/" + $empresa.clientId + "/pasta") -Method Put `
    -Headers $cabecalho -ContentType "application/json; charset=utf-8" -Body $corpo -TimeoutSec 120
}

function Nome-DePasta($nome) {
  $limpo = ($nome -replace '[\\/:*?"<>|]', " ").Trim() -replace "\s+", " "
  if (-not $limpo) { $limpo = "EMPRESA" }
  return $limpo
}

try {
  $empresas = Ler-Empresas
} catch {
  [System.Windows.Forms.MessageBox]::Show("Nao consegui falar com o NUCLEO: " + (Mensagem-DeErro $_) +
    "`r`n`r`nO Render gratuito pode levar ate 1 minuto para acordar: tente de novo.", "NUCLEO") | Out-Null
  exit 3
}
if (-not $empresas.Count) {
  [System.Windows.Forms.MessageBox]::Show("Nenhuma empresa com captura configurada no NUCLEO.", "NUCLEO") | Out-Null
  exit 0
}

$padrao = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "EMPRESAS"

$janela = New-Object System.Windows.Forms.Form
$janela.Text = "NUCLEO - PASTA DE CADA EMPRESA"
$janela.StartPosition = "CenterScreen"
$janela.Width = 980
$janela.Height = [Math]::Min(720, 190 + 44 * $empresas.Count)
$janela.Font = New-Object System.Drawing.Font("Segoe UI", 10)

$explicacao = New-Object System.Windows.Forms.Label
$explicacao.Text = "Escolha a pasta de cada empresa. Dentro dela o agente cria ANO \ MES \ tipo de nota (NF-e, NFS-e, CT-e) \ EMITIDAS ou RECEBIDAS \ XML ou PDF."
$explicacao.Dock = "Top"
$explicacao.Height = 48
$explicacao.Padding = New-Object System.Windows.Forms.Padding(12, 10, 12, 0)
$janela.Controls.Add($explicacao)

$tabela = New-Object System.Windows.Forms.TableLayoutPanel
$tabela.Dock = "Fill"
$tabela.AutoScroll = $true
$tabela.ColumnCount = 3
$tabela.Padding = New-Object System.Windows.Forms.Padding(12, 0, 12, 0)
[void]$tabela.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 330)))
[void]$tabela.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void]$tabela.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 120)))

$rotulos = @{}
foreach ($empresa in $empresas) {
  $nome = New-Object System.Windows.Forms.Label
  $nome.Text = $empresa.nome + "`r`n" + $empresa.cnpj
  $nome.AutoSize = $false
  $nome.Width = 320
  $nome.Height = 40

  $pasta = New-Object System.Windows.Forms.Label
  $pasta.AutoSize = $false
  $pasta.AutoEllipsis = $true
  $pasta.Dock = "Fill"
  $pasta.TextAlign = "MiddleLeft"
  if ($empresa.pastaDestino) { $pasta.Text = $empresa.pastaDestino } else { $pasta.Text = "(sem pasta)"; $pasta.ForeColor = [System.Drawing.Color]::Firebrick }
  $rotulos[$empresa.clientId] = $pasta

  $botao = New-Object System.Windows.Forms.Button
  $botao.Text = "Escolher..."
  $botao.Width = 110
  $botao.Height = 32
  $botao.Tag = $empresa
  $botao.Add_Click({
    $alvo = $this.Tag
    $seletor = New-Object System.Windows.Forms.FolderBrowserDialog
    $seletor.Description = "Pasta da empresa " + $alvo.nome
    $seletor.ShowNewFolderButton = $true
    if ($alvo.pastaDestino -and (Test-Path -LiteralPath $alvo.pastaDestino)) {
      $seletor.SelectedPath = $alvo.pastaDestino
    } elseif (Test-Path -LiteralPath $padrao) {
      $seletor.SelectedPath = $padrao
    }
    if ($seletor.ShowDialog($janela) -ne [System.Windows.Forms.DialogResult]::OK) { return }
    try {
      $salvo = Gravar-Pasta $alvo $seletor.SelectedPath
      $alvo.pastaDestino = $salvo.pastaDestino
      $rotulos[$alvo.clientId].Text = $salvo.pastaDestino
      $rotulos[$alvo.clientId].ForeColor = [System.Drawing.Color]::DarkGreen
    } catch {
      [System.Windows.Forms.MessageBox]::Show((Mensagem-DeErro $_), "NUCLEO") | Out-Null
    }
  })

  [void]$tabela.Controls.Add($nome)
  [void]$tabela.Controls.Add($pasta)
  [void]$tabela.Controls.Add($botao)
}
$janela.Controls.Add($tabela)
$tabela.BringToFront()

$rodape = New-Object System.Windows.Forms.FlowLayoutPanel
$rodape.Dock = "Bottom"
$rodape.Height = 56
$rodape.FlowDirection = "RightToLeft"
$rodape.Padding = New-Object System.Windows.Forms.Padding(12, 10, 12, 0)

$fechar = New-Object System.Windows.Forms.Button
$fechar.Text = "Fechar"
$fechar.Width = 110
$fechar.Height = 34
$fechar.Add_Click({ $janela.Close() })

$usarPadrao = New-Object System.Windows.Forms.Button
$usarPadrao.Text = "Usar a pasta padrao nas que estao sem pasta (Documentos\EMPRESAS\nome)"
$usarPadrao.Width = 520
$usarPadrao.Height = 34
$usarPadrao.Add_Click({
  $feitas = 0
  $falhas = @()
  foreach ($alvo in $empresas) {
    if ($alvo.pastaDestino) { continue }
    $destino = Join-Path $padrao (Nome-DePasta $alvo.nome)
    try {
      New-Item -ItemType Directory -Force -Path $destino | Out-Null
      $salvo = Gravar-Pasta $alvo $destino
      $alvo.pastaDestino = $salvo.pastaDestino
      $rotulos[$alvo.clientId].Text = $salvo.pastaDestino
      $rotulos[$alvo.clientId].ForeColor = [System.Drawing.Color]::DarkGreen
      $feitas += 1
    } catch {
      $falhas += ($alvo.nome + ": " + (Mensagem-DeErro $_))
    }
  }
  $texto = "$feitas empresa(s) com a pasta padrao."
  if ($falhas.Count) { $texto += "`r`n`r`nNao deu certo:`r`n" + ($falhas -join "`r`n") }
  [System.Windows.Forms.MessageBox]::Show($texto, "NUCLEO") | Out-Null
})

$rodape.Controls.Add($fechar)
$rodape.Controls.Add($usarPadrao)
$janela.Controls.Add($rodape)

[void]$janela.ShowDialog()
