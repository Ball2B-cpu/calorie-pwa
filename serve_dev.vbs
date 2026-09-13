Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\AI Brain\tools\calorie-pwa"
sh.Run """C:\Python314\pythonw.exe"" ""C:\AI Brain\tools\calorie-pwa\serve_dev.py""", 0, False
