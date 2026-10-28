# Tools for spike 0001 on NixOS: `nix-shell` here, then the commands in README.md.
# Pinned to a nixpkgs-unstable release so everyone gets the same Bun (1.4, which reads this repository's lockfiles).
let
  pkgs = import (fetchTarball {
    url = "https://releases.nixos.org/nixpkgs/nixpkgs-26.11pre1103464.f05535a0efcb/nixexprs.tar.xz";
    sha256 = "0jqziyi29w15hvigjal9n9ax837hbfcpz3la1bbgnnjz2r190lgi";
  }) { };
in
pkgs.mkShell {
  packages = [
    pkgs.bun
    pkgs.nodejs_22
    pkgs.git
  ];
  # Native modules installed from npm (workerd, rolldown) look for the C++ runtime at load time.
  LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];
}
