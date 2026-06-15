Dim shell
Dim fso
Dim projectDir
Dim command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
command = "cmd.exe /c cd /d """ & projectDir & """ && npm.cmd start"

shell.Run command, 0, False
