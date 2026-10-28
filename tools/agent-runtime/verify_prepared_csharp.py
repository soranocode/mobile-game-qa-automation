"""Compile prepared snippets against existing Unity/game assemblies without running Unity."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import xml.etree.ElementTree as ET


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--editor-data", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    output = (args.out or repo / "work/prepared-quest-compile").resolve()
    if not output.is_relative_to(repo.resolve()):
        raise ValueError("Compile artifacts must stay inside this workspace")
    output.mkdir(parents=True, exist_ok=True)
    project = args.project.resolve()
    references = set()
    for csproj in project.glob("*.csproj"):
        for node in ET.parse(csproj).getroot().iter():
            if node.tag.endswith("HintPath") and node.text:
                path = Path(node.text)
                if not path.is_absolute():
                    path = project / path
                if path.is_file():
                    references.add(path.resolve())
    references.update((project / "Library/ScriptAssemblies").glob("*.dll"))
    if not references or not (project / "Library/ScriptAssemblies/Assembly-CSharp.dll").is_file():
        raise ValueError("Existing compiled project and generated csproj references required")
    snippets = ["quest-observer.cs.txt", "known-quest-ui.cs.txt", "select-quest-command.cs.txt",
                "control-gesture.cs.txt", "defense-command.cs.txt", "../unity-entry/startup-control.cs.txt"]
    sources = []
    for number, name in enumerate(snippets):
        body = (Path(__file__).resolve().parent / name).read_text(encoding="utf-8")
        body = body.replace("__MODE__", "prepare").replace("__CONTROL__", "observe").replace("__DISPATCH__", "false").replace("__ERROR_WATCH_SETUP__",
            "System.Func<bool> errorWatchBlocked=()=>false; System.Func<object> errorWatchSnapshot=()=>new{available=true};")
        text = ("using System;using System.Linq;using UnityEngine;using UnityEditor;public class PreparedCompile" +
                str(number) + " {public object Execute(){" + body + "}}")
        path = output / Path(name).name.replace(".txt", "")
        path.write_text(text, encoding="utf-8")
        sources.append(path)
    # Compile the same fixed lifecycle commands that will hold the error watcher
    # across mission boundaries. Importing this JS module never connects to Unity.
    node = shutil.which('node')
    if not node:
        raise ValueError('Node is required to load the cycle lifecycle commands')
    module_url = (repo / 'tools/unity-ui/session.mjs').as_uri()
    script = ('import {cycleLifecycleCommands} from ' + json.dumps(module_url) + ';'
              'process.stdout.write(JSON.stringify(cycleLifecycleCommands()));')
    loaded = subprocess.run([node, '--input-type=module', '-e', script], check=True,
                            capture_output=True, text=True, encoding='utf-8')
    lifecycle = json.loads(loaded.stdout)
    for number, body in enumerate(lifecycle):
        path = output / ('cycle-lifecycle-' + str(number) + '.cs')
        text = ('using System;using System.Linq;using UnityEngine;using UnityEditor;public class CycleCompile' +
                str(number) + ' {public object Execute(){' + body + '}}')
        path.write_text(text, encoding='utf-8')
        sources.append(path)
    response = output / "compile.rsp"
    lines = ["/nologo", "/target:library", "/nostdlib+", "/langversion:6",
             '/out:"' + str(output / "prepared-quest-commands.dll") + '"']
    lines += ['/reference:"' + str(path) + '"' for path in sorted(references)]
    lines += ['"' + str(path) + '"' for path in sources]
    response.write_text("\n".join(lines), encoding="utf-8")
    dotnet = shutil.which("dotnet")
    if not dotnet:
        raise ValueError("Installed dotnet host required for offline Roslyn verification")
    result = subprocess.run([dotnet, str(args.editor_data / "DotNetSdkRoslyn/csc.dll"), "@" + str(response)],
                            capture_output=True, text=True, encoding="utf-8", errors="replace")
    log = result.stdout + result.stderr
    (output / "compiler.log").write_text(log, encoding="utf-8")
    report = {"exit_code": result.returncode, "files": len(sources), "references": len(references),
              "scope": "offline type/API compilation only; guards stubbed; no Unity execution or input"}
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))
    if log:
        print(log[:5000])
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
