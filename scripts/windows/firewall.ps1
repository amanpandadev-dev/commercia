# Windows Firewall for Commercia: ONE inbound rule for the app's port, for the Private network profile only, and only from
# the shop's own network (and Tailscale, if you ask for it). Nothing here opens a router port; from outside the shop use
# Tailscale or Cloudflare Tunnel + Access (see docs/REMOTE-ACCESS.md), which connect outwards and need no inbound rule at all.
#
#   firewall.bat allow               makes the rule (the port is PORT in .env, or 8787)
#   firewall.bat allow -Tailscale    the same, and also lets Tailscale's range (100.64.0.0/10) in
#   firewall.bat remove              takes the rule away again
#   firewall.bat status              shows the rule, and any broader rule that Windows made for Node.js when it asked you
param(
  [ValidateSet('allow', 'remove', 'status')] [string]$Action = 'status',
  [int]$Port = 0,
  [switch]$Tailscale
)
$ErrorActionPreference = 'Stop'
$RuleName = 'Commercia (shop network)'

function Get-AppPort {
  if ($Port -gt 0) { return $Port }
  $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
  $envFile = Join-Path $root '.env'
  if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*"?(\d+)' | Select-Object -First 1
    if ($m) { return [int]$m.Matches[0].Groups[1].Value }
  }
  return 8787
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and $Action -ne 'status') {
  throw 'This needs Administrator rights. Run firewall.bat instead: it asks Windows for permission.'
}

function Remove-OurRule {
  $existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
  if ($existing) { $existing | Remove-NetFirewallRule }
}

switch ($Action) {
  'allow' {
    $p = Get-AppPort
    Remove-OurRule # exactly one rule, however often this is run
    $remote = @('LocalSubnet')
    if ($Tailscale) { $remote += '100.64.0.0/10' }
    New-NetFirewallRule -DisplayName $RuleName `
      -Description 'Lets phones and computers on the shop network (not the internet) reach Commercia.' `
      -Direction Inbound -Action Allow -Protocol TCP -LocalPort $p `
      -Profile Private -RemoteAddress $remote -EdgeTraversalPolicy Block | Out-Null
    Write-Host "Done. One inbound rule, TCP port $p, Private networks only, from: $($remote -join ', ')."
    Write-Host 'Your Wi-Fi must be set to "Private" in Windows (Settings > Network > Wi-Fi > your network). Run "firewall.bat status" to check for broader rules.'
  }
  'remove' {
    Remove-OurRule
    Write-Host 'The Commercia firewall rule is removed.'
  }
  'status' {
    $rule = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
    if ($rule) {
      $port = ($rule | Get-NetFirewallPortFilter).LocalPort
      $addr = ($rule | Get-NetFirewallAddressFilter).RemoteAddress -join ', '
      Write-Host "Rule present: TCP $port, profile $($rule.Profile), from $addr, enabled $($rule.Enabled)."
    } else {
      Write-Host 'No Commercia rule. Phones on the Wi-Fi will not get through until you run: firewall.bat allow'
    }
    # When Node.js first starts, Windows asks "allow access?"; saying yes makes a rule for every address on the chosen profiles.
    $broad = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -like '*\node.exe' } |
      Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }
    if ($broad) {
      Write-Host ''
      Write-Host 'These broader rules for Node.js exist. They let ANY address in, on the profiles shown. Delete them if you only want the rule above:' 
      $broad | ForEach-Object { Write-Host "  $($_.DisplayName)  (profile $($_.Profile))" }
      Write-Host '  Windows Security > Firewall > Advanced settings > Inbound Rules > find "Node.js" > Delete.'
    }
  }
}
