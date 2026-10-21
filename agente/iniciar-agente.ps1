# LIGA O AGENTE LOCAL DO NUCLEO NESTE COMPUTADOR
#
# O agente grava nas pastas dos clientes o que o NUCLEO (no Render) capturou,
# e leva ao NUCLEO o que for solto em EMPRESAS\<CNPJ>\ENTRADA. Le o endereco e
# o token das variaveis de usuario NUCLEO_SERVIDOR e NUCLEO_AGENTE_TOKEN (ver
# SUBIR-NO-RENDER.md, passo 6): o token nao fica escrito neste arquivo.
#
# Se o agente cair (rede, Windows hibernou), volta sozinho em 30 segundos.
# O que ele faz fica em agente\agente.log.

$ErrorActionPreference = "Stop"
$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $pasta "agente.log"

# As variaveis deste computador mudaram de nome (agora NUCLEO_). Na primeira vez,
# o valor do nome antigo passa para o novo; o antigo fica como esta.
foreach ($nome in "SERVIDOR", "AGENTE_TOKEN", "AGENTE_RAIZ", "AGENTE_INTERVALO_S") {
  $antigo = [Environment]::GetEnvironmentVariable(("J" + "360_" + $nome), "User")
  if ($antigo -and -not [Environment]::GetEnvironmentVariable(("NUCLEO_" + $nome), "User")) {
    [Environment]::SetEnvironmentVariable(("NUCLEO_" + $nome), $antigo, "User")
  }
}

if (-not $env:NUCLEO_SERVIDOR) { $env:NUCLEO_SERVIDOR = [Environment]::GetEnvironmentVariable("NUCLEO_SERVIDOR", "User") }
if (-not $env:NUCLEO_AGENTE_TOKEN) { $env:NUCLEO_AGENTE_TOKEN = [Environment]::GetEnvironmentVariable("NUCLEO_AGENTE_TOKEN", "User") }

if (-not $env:NUCLEO_SERVIDOR -or -not $env:NUCLEO_AGENTE_TOKEN) {
  Write-Host "Falta configurar NUCLEO_SERVIDOR e NUCLEO_AGENTE_TOKEN. Veja SUBIR-NO-RENDER.md, passo 6."
  exit 2
}

# Pastas configuradas como caminho relativo valem a partir da pasta do usuario.
if (-not $env:NUCLEO_AGENTE_RAIZ) { $env:NUCLEO_AGENTE_RAIZ = [Environment]::GetFolderPath("UserProfile") }

Write-Host ("Agente do NUCLEO ligado. Servidor: " + $env:NUCLEO_SERVIDOR + ". Registro em " + $log)
while ($true) {
  & node (Join-Path $pasta "agente.mjs") *>> $log
  Add-Content -Path $log -Value ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " agente parou; volta em 30 s")
  Start-Sleep -Seconds 30
}
