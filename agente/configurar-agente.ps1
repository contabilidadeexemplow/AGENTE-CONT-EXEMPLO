# CONFIGURA O AGENTE LOCAL DO NUCLEO NESTE COMPUTADOR (uma vez so)
#
# 1. Pede o token do agente (NUCLEO > Captura de notas > Agente local > Gerar
#    token) sem mostra-lo na tela, e confere com o servidor antes de guardar.
# 2. Guarda NUCLEO_SERVIDOR e NUCLEO_AGENTE_TOKEN nas variaveis do seu usuario do
#    Windows: o token nao fica escrito em arquivo nenhum.
# 3. Pergunta antes de criar o atalho que liga o agente junto com o Windows.
# 4. Liga o agente agora, numa janela minimizada.
#
# Uso: powershell -ExecutionPolicy Bypass -File agente\configurar-agente.ps1

param([string]$Servidor = "https://nucleo-fiscal.onrender.com")

$ErrorActionPreference = "Stop"
$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$Servidor = $Servidor.TrimEnd("/")

Write-Host ""
Write-Host "AGENTE LOCAL DO NUCLEO"
Write-Host ("Servidor: " + $Servidor)
Write-Host ""
# O token vem da area de transferencia (botao "Copiar token" do NUCLEO): no
# terminal embutido, colar num Read-Host -AsSecureString so entrega 1 caractere.
# Ctrl+V dentro do Read-Host tambem nao cola ali (vira "^V"): o configurador
# le a area de transferencia de novo a cada Enter, sem precisar colar.
$token = ""
for ($tentativa = 1; $tentativa -le 5; $tentativa++) {
  try { $token = [string](Get-Clipboard -Raw) } catch { $token = "" }
  if ($token -match "nucleoa_[A-Za-z0-9_\-]+") {
    Write-Host "Token do agente encontrado na area de transferencia."
    break
  }
  $digitado = Read-Host "Copie o token (botao Copiar token do NUCLEO) e aperte Enter aqui"
  if ($digitado -match "nucleoa_[A-Za-z0-9_\-]+") { $token = $digitado; break }
}

# Colar no terminal pode trazer junto codigos invisiveis (colagem entre
# colchetes, ESC[200~ ... ESC[201~) ou espacos: pega so o token do meio.
$achado = [regex]::Match($token, "nucleoa_[A-Za-z0-9_\-]+")
if (-not $achado.Success) {
  Write-Host "Isso nao parece o token do agente (ele comeca com nucleoa_). Nada foi gravado."
  exit 2
}
$token = $achado.Value

# Confere com o servidor. O Render gratuito pode levar ate 1 minuto para acordar.
Write-Host "Conferindo o token com o NUCLEO..."
try {
  Invoke-WebRequest -Uri ($Servidor + "/api/agente/fila?limite=1") -Headers @{ "x-agente-token" = $token } `
    -UseBasicParsing -TimeoutSec 120 | Out-Null
} catch {
  $situacao = 0
  if ($_.Exception.Response) { $situacao = [int]$_.Exception.Response.StatusCode }
  if ($situacao -eq 401 -or $situacao -eq 403) {
    Write-Host "O NUCLEO recusou esse token. Gere outro em Captura de notas > Agente local. Nada foi gravado."
  } else {
    Write-Host ("Nao consegui falar com o NUCLEO (" + $_.Exception.Message + "). Nada foi gravado.")
  }
  exit 3
}

[Environment]::SetEnvironmentVariable("NUCLEO_SERVIDOR", $Servidor, "User")
[Environment]::SetEnvironmentVariable("NUCLEO_AGENTE_TOKEN", $token, "User")
Write-Host "Token conferido e guardado nas variaveis do seu usuario."

$iniciar = Join-Path $pasta "iniciar-agente.ps1"
$resposta = Read-Host "Ligar o agente sozinho sempre que o Windows iniciar? (S/N)"
if ($resposta -match "^[sS]") {
  $atalho = Join-Path ([Environment]::GetFolderPath("Startup")) "Agente do NUCLEO.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($atalho)
  $lnk.TargetPath = "powershell.exe"
  $lnk.Arguments = '-ExecutionPolicy Bypass -WindowStyle Minimized -File "' + $iniciar + '"'
  $lnk.WorkingDirectory = $pasta
  $lnk.WindowStyle = 7
  $lnk.Save()
  Write-Host ("Atalho criado: " + $atalho)
} else {
  Write-Host "Sem atalho. Para ligar depois: powershell -ExecutionPolicy Bypass -File agente\iniciar-agente.ps1"
}

$env:NUCLEO_SERVIDOR = $Servidor
$env:NUCLEO_AGENTE_TOKEN = $token
Start-Process powershell.exe -WindowStyle Minimized `
  -ArgumentList @("-ExecutionPolicy", "Bypass", "-WindowStyle", "Minimized", "-File", ('"' + $iniciar + '"'))
Write-Host ("Agente ligado, numa janela minimizada. O que ele faz fica em " + (Join-Path $pasta "agente.log"))
