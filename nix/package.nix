{
  lib,
  stdenvNoCC,
  bun,
  makeBinaryWrapper,
}:

stdenvNoCC.mkDerivation {
  pname = "you-should-know";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../plugins
      ../prompts
      ../src
      ../tsconfig.json
    ];
  };

  nativeBuildInputs = [
    bun
    makeBinaryWrapper
  ];

  buildPhase = ''
    runHook preBuild

    for entry in omp opencode-server opencode-tui codex; do
      bun build "src/$entry.ts" --target bun --outfile "dist/$entry.js" --external '@oh-my-pi/*' --external '@opencode-ai/*'
    done

    bun build src/claude-code.tsx --target browser --format esm --external claude-code --outfile plugins/claude-code/hooks/register.js

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm644 -t $out/share/you-should-know dist/*.js
    cp -r plugins/claude-code $out/share/you-should-know/claude-code
    makeWrapper ${lib.getExe bun} $out/bin/ysk-codex-hook --add-flags $out/share/you-should-know/codex.js

    runHook postInstall
  '';

  meta.mainProgram = "ysk-codex-hook";
}
