"""Compile adapter assemblies against installed Unity, and run its pure C# scheduler tests. No Editor calls."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / 'packages/com.gameqa.agent'


def run(args):
    result = subprocess.run([str(x) for x in args], capture_output=True, text=True, encoding='utf-8', errors='replace')
    if result.returncode:
        raise RuntimeError((result.stdout + result.stderr)[:6000])
    return result.stdout.strip()


def compile_cs(dotnet, csc, out, sources, references, executable=False):
    rsp = out.with_suffix('.rsp')
    lines = ['/nologo', '/nostdlib+', '/langversion:9', '/target:' + ('exe' if executable else 'library'), '/out:"' + str(out) + '"']
    lines += ['/reference:"' + str(p) + '"' for p in sorted(set(references))]
    lines += ['"' + str(p) + '"' for p in sources]
    rsp.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return run([dotnet, csc, '@' + str(rsp)])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--editor-data', type=Path, required=True)
    args = parser.parse_args()
    dotnet = shutil.which('dotnet')
    if not dotnet:
        raise ValueError('dotnet host/SDK required')
    output = ROOT / 'work/unity-agent-adapter-check'
    output.mkdir(parents=True, exist_ok=True)
    references = set()
    for project_file in args.project.glob('*.csproj'):
        for element in ET.parse(project_file).getroot().iter():
            if element.tag.endswith('HintPath') and element.text:
                path = Path(element.text)
                path = path if path.is_absolute() else args.project / path
                if path.is_file():
                    references.add(path.resolve())
    references.update((args.project / 'Library/ScriptAssemblies').glob('*.dll'))
    # Do not accidentally compile against an earlier installed build of our own assemblies.
    references = {p for p in references if not p.name.startswith('GameQA.Agent.')}
    if not any(p.name == 'MCPForUnity.Editor.dll' for p in references):
        raise ValueError('Installed/compiled Coplay Unity MCP required')
    csc = args.editor_data / 'DotNetSdkRoslyn/csc.dll'
    main_sources = [p for p in (PACKAGE / 'Editor').rglob('*.cs') if 'Mcp' not in p.relative_to(PACKAGE / 'Editor').parts]
    main_dll = output / 'GameQA.Agent.Editor.dll'
    log = compile_cs(dotnet, csc, main_dll, main_sources, references)
    log += '\n' + compile_cs(dotnet, csc, output / 'GameQA.Agent.Mcp.Editor.dll', list((PACKAGE / 'Editor/Mcp').glob('*.cs')), references | {main_dll})
    (output / 'compiler.log').write_text(log + '\n', encoding='utf-8')
    # Pure scheduler tests use the installed .NET 8 reference pack, not Unity mocks.
    dotnet_root = Path(dotnet).resolve().parent
    packs = sorted((dotnet_root / 'packs/Microsoft.NETCore.App.Ref').glob('8.*/ref/net8.0'))
    if not packs:
        raise ValueError('.NET 8 SDK reference pack required for offline tests')
    test_dll = output / 'JobEngineTests.dll'
    compile_cs(dotnet, csc, test_dll, [PACKAGE / 'Editor/Core/JobEngine.cs', Path(__file__).with_name('JobEngineTests.cs')], list(packs[-1].glob('*.dll')), True)
    test_dll.with_suffix('.runtimeconfig.json').write_text(json.dumps({'runtimeOptions': {'tfm': 'net8.0', 'framework': {'name': 'Microsoft.NETCore.App', 'version': '8.0.0'}}}), encoding='utf-8')
    test_output = run([dotnet, test_dll])
    report = {'scope': 'offline API/type compilation and pure C# scheduler; no Unity run/input', 'assemblies': 2, 'sources': len(main_sources) + 1, 'tests': test_output}
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
