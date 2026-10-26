# Record the actual offline assertions. The approval is simulated by the harness.
# Requirements: VHS 0.12.1, ttyd, FFmpeg and Chromium (or VHS's browser download).
Output docs/media/railgate-offline.gif
Output docs/media/railgate-offline.mp4

Require pnpm
Set Shell bash
Set Width 1280
Set Height 640
Set FontSize 25
Set FontFamily "DejaVu Sans Mono, Menlo, monospace"
Set Padding 32
Set Margin 16
Set BorderRadius 12
Set WindowBar Colorful
Set Theme "Catppuccin Frappe"
Set Framerate 25
Set TypingSpeed 40ms

Hide
Type "export PS1='$ '"
Enter
Type "clear"
Enter
Sleep 500ms
Show
Type "pnpm --silent demo:offline --present"
Enter
Wait+Screen /Offline demo passed/
Sleep 6s
