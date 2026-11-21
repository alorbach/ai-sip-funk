#!/usr/bin/env bash
# Baut faxmodem.exe in einer MSYS2-UCRT64-Umgebung.
# Voraussetzung: pacman -S mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-spandsp mingw-w64-ucrt-x86_64-ghostscript
# Aufruf (PowerShell): C:\msys64\usr\bin\bash.exe -lc "cd '$(pwd)' && MSYSTEM=UCRT64 ./tools/faxmodem/build.sh"
set -euo pipefail
export PATH=/ucrt64/bin:/usr/bin:$PATH
cd "$(dirname "$0")"
mkdir -p bin
gcc -O2 -Wall -o bin/faxmodem.exe faxmodem.c -lspandsp -ltiff -lm
echo "gebaut: $(pwd)/bin/faxmodem.exe (braucht C:\\msys64\\ucrt64\\bin im PATH)"
