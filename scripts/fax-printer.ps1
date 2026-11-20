# Legt den Drucker 'SIPFunk Fax' an (oder entfernt ihn mit -Remove).
# Der Drucker nutzt den in Windows enthaltenen 'Microsoft PS Class Driver' und druckt RAW auf 127.0.0.1:<Port>,
# wo SIPFunk lauscht (FAX_PRINT_PORT, Standard 9101). SIPFunk wandelt den Auftrag in ein PDF und fragt nach der Faxnummer.
#
#   powershell -ExecutionPolicy Bypass -File scripts\fax-printer.ps1            anlegen
#   powershell -ExecutionPolicy Bypass -File scripts\fax-printer.ps1 -Remove    entfernen
#
# Braucht Administratorrechte; ohne sie startet sich das Skript einmal mit UAC-Abfrage neu.
param([int]$Port = 9101, [switch]$Remove)

$ErrorActionPreference = 'Stop'
$printerName = 'SIPFunk Fax'
$portName = 'SIPFunkFaxPort'
$driver = 'Microsoft PS Class Driver'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath), '-Port', $Port)
    if ($Remove) { $argList += '-Remove' }
    $p = Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait -PassThru
    exit $p.ExitCode
}

try {
    if ($Remove) {
        Remove-Printer -Name $printerName -ErrorAction SilentlyContinue
        Remove-PrinterPort -Name $portName -ErrorAction SilentlyContinue
        Write-Host "Drucker '$printerName' entfernt."
        exit 0
    }

    # Treiber: ist in Windows enthalten, steht aber nicht immer im Spooler – dann aus dem Treiberspeicher nachladen
    if (-not (Get-PrinterDriver -Name $driver -ErrorAction SilentlyContinue)) {
        try { Add-PrinterDriver -Name $driver }
        catch {
            $inf = Get-ChildItem (Join-Path $env:windir 'System32\DriverStore\FileRepository') -Recurse -Filter 'prnms005.inf' -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $inf) { throw "Treiber '$driver' nicht gefunden" }
            Add-PrinterDriver -Name $driver -InfPath $inf.FullName
        }
    }

    # Port neu anlegen, falls sich die Portnummer geändert hat
    $existing = Get-PrinterPort -Name $portName -ErrorAction SilentlyContinue
    if ($existing -and $existing.PortNumber -ne $Port) {
        Remove-Printer -Name $printerName -ErrorAction SilentlyContinue
        Remove-PrinterPort -Name $portName
        $existing = $null
    }
    if (-not $existing) { Add-PrinterPort -Name $portName -PrinterHostAddress '127.0.0.1' -PortNumber $Port }

    if (-not (Get-Printer -Name $printerName -ErrorAction SilentlyContinue)) {
        Add-Printer -Name $printerName -DriverName $driver -PortName $portName
    }
    Write-Host "Drucker '$printerName' ist eingerichtet (127.0.0.1:$Port)."
    exit 0
}
catch {
    Write-Host "Fehler: $($_.Exception.Message)"
    Start-Sleep -Seconds 5
    exit 1
}
