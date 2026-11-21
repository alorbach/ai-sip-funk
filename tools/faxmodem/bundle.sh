#!/usr/bin/env bash
# Stellt die Fax-Bausteine für das Installationspaket zusammen: vendor/fax/bin mit faxmodem.exe, Ghostscript
# und allen DLLs, die sie aus MSYS2 UCRT64 brauchen, dazu Lizenzen und Herkunftsangaben in vendor/fax/LIZENZEN.txt.
# Voraussetzung: pacman -S mingw-w64-ucrt-x86_64-{gcc,spandsp,ghostscript}
# Aufruf: npm run fax:bundle
set -euo pipefail
export PATH=/ucrt64/bin:/usr/bin:$PATH
cd "$(dirname "$0")/../.."
OUT=vendor/fax
BIN=$OUT/bin

bash tools/faxmodem/build.sh
rm -rf "$OUT"
mkdir -p "$BIN"
cp tools/faxmodem/bin/faxmodem.exe "$BIN/"
cp /ucrt64/bin/gswin64c.exe "$BIN/"

# DLL-Abhängigkeiten rekursiv aus /ucrt64/bin einsammeln (System-DLLs von Windows bleiben draußen)
copy_deps() {
  local f dll
  for dll in $(objdump -p "$1" | sed -n 's/^\s*DLL Name: //p'); do
    f=/ucrt64/bin/$dll
    if [ -f "$f" ] && [ ! -f "$BIN/$dll" ]; then
      cp "$f" "$BIN/"
      copy_deps "$f"
    fi
  done
}
copy_deps "$BIN/faxmodem.exe"
copy_deps "$BIN/gswin64c.exe"

# Herkunft und Lizenzen
{
  echo "Fax-Bausteine von SIPFunk (vendor/fax/bin)"
  echo "==========================================="
  echo
  echo "faxmodem.exe: Teil von SIPFunk (AGPL-3.0-or-later), Quelle tools/faxmodem/faxmodem.c im SIPFunk-Repository."
  echo
  echo "Die übrigen Dateien stammen unverändert aus MSYS2 (UCRT64), https://www.msys2.org/."
  echo "Quellcode und Bauanleitung jedes Pakets: https://packages.msys2.org/ bzw. https://github.com/msys2/MINGW-packages"
  echo "Wichtige Pakete: spandsp (LGPL-2.1), Ghostscript (AGPL-3.0), libtiff (libtiff-Lizenz, BSD-artig)."
  echo
  echo "Enthaltene Pakete:"
  for f in "$BIN"/*; do
    case "$(basename "$f")" in faxmodem.exe) continue ;; esac
    pacman -Qoq "/ucrt64/bin/$(basename "$f")" 2>/dev/null || true
  done | sort -u | while read -r pkg; do
    printf '  %-45s %s\n' "$(pacman -Q "$pkg")" "$(pacman -Qi "$pkg" | sed -n 's/^Licenses\s*:\s*//p')"
  done
} > "$OUT/LIZENZEN.txt"

echo "Fax-Bausteine: $(ls "$BIN" | wc -l) Dateien, $(du -sh "$BIN" | cut -f1) in $OUT"
