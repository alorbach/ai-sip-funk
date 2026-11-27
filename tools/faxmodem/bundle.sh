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

# Herkunft und Lizenzen: Paketliste, Lizenztexte aus den Paketen, Quellpakete
PKGS=$(for f in "$BIN"/*; do
  case "$(basename "$f")" in faxmodem.exe) continue ;; esac
  pacman -Qoq "/ucrt64/bin/$(basename "$f")" 2>/dev/null || true
done | sort -u)

mkdir -p "$OUT/licenses"
for pkg in $PKGS; do
  name=${pkg#mingw-w64-ucrt-x86_64-}
  { pacman -Qlq "$pkg" | grep -E '/share/licenses/.+[^/]$' || true; } | while read -r lic; do
    mkdir -p "$OUT/licenses/$name"
    cp "$lic" "$OUT/licenses/$name/"
  done
done
cp LICENSE "$OUT/licenses/SIPFunk-LICENSE.txt"

{
  echo "Fax-Bausteine von SIPFunk (vendor/fax/bin)"
  echo "==========================================="
  echo
  echo "faxmodem.exe: Teil von SIPFunk (AGPL-3.0-or-later), Quelle tools/faxmodem/faxmodem.c im SIPFunk-Repository."
  echo
  echo "Die übrigen Dateien stammen unverändert aus MSYS2 (UCRT64), https://www.msys2.org/."
  echo "Die Lizenztexte der Pakete liegen im Ordner licenses/ neben dieser Datei."
  echo "Wichtige Pakete: spandsp (LGPL-2.1), Ghostscript (AGPL-3.0), libtiff (MIT-artig),"
  echo "jbigkit (GPL-2.0-or-later; MSYS2 schreibt nur \"GPL-2.0\", die Quelldateien erlauben"
  echo "\"any later version\", daher mit der AGPL-3.0 von SIPFunk vereinbar)."
  echo
  echo "Quellcode: Zu jedem Paket gibt es das unveränderte Quellpaket unter der angegebenen Adresse."
  echo "Ist eine Adresse nicht mehr erreichbar, stellt das SIPFunk-Projekt den Quellcode der"
  echo "mitgelieferten Fassung auf Anfrage bereit (Issue unter https://github.com/alorbach/ai-sip-funk)."
  echo
  echo "Enthaltene Pakete:"
  for pkg in $PKGS; do
    ver=$(pacman -Q "$pkg" | cut -d' ' -f2)
    printf '  %-45s %s\n' "$pkg $ver" "$(pacman -Qi "$pkg" | sed -n 's/^Licenses\s*:\s*//p')"
    # Quellpakete heißen nach dem Basispaket (libgcc und libstdc++ kommen aus gcc)
    base=$(sed -n '/^%BASE%$/{n;p}' "/var/lib/pacman/local/$pkg-$ver/desc")
    printf '    Quelle: https://repo.msys2.org/mingw/sources/%s-%s.src.tar.zst\n' "${base:-$pkg}" "$ver"
  done
} > "$OUT/LIZENZEN.txt"

echo "Fax-Bausteine: $(ls "$BIN" | wc -l) Dateien, $(du -sh "$BIN" | cut -f1) in $OUT"
