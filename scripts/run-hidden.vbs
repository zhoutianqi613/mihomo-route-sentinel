Option Explicit

If WScript.Arguments.Count <> 3 Then
    WScript.Quit 2
End If

Dim shell, fso, nodePath, cliPath, configPath, projectRoot, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

nodePath = WScript.Arguments(0)
cliPath = WScript.Arguments(1)
configPath = WScript.Arguments(2)
projectRoot = fso.GetParentFolderName(fso.GetParentFolderName(cliPath))
shell.CurrentDirectory = projectRoot

command = Quote(nodePath) & " " & Quote(cliPath) & " --config " & Quote(configPath) & " --run --apply --quiet"
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function Quote(value)
    Quote = Chr(34) & value & Chr(34)
End Function
