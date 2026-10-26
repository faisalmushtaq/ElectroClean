#!/usr/bin/env bash
# Double-click this file in the macOS Finder to start ElectroClean.
# (The first time, macOS may ask you to confirm: right-click the file, choose Open.)
exec "$(cd "$(dirname "$0")" && pwd)/electroclean.sh" "$@"
