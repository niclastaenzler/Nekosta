; Firewall-Freigabe für das Büronetz (nur „Private Netzwerke"), damit die Arbeitsplätze
; den NEKOSTA-Server erreichen und finden. Wird bei der Deinstallation wieder entfernt.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="NEKOSTA Server"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="NEKOSTA Server-Suche"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="NEKOSTA Server" dir=in action=allow protocol=TCP localport=8787 profile=private,domain program="$INSTDIR\NEKOSTA.exe" enable=yes'
  nsExec::Exec 'netsh advfirewall firewall add rule name="NEKOSTA Server-Suche" dir=in action=allow protocol=UDP localport=41234 profile=private,domain program="$INSTDIR\NEKOSTA.exe" enable=yes'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="NEKOSTA Server"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="NEKOSTA Server-Suche"'
!macroend
