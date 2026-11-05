# Projektzeit BR Events

Stempeluhr und Stundenzettel als Web-App (PWA). Läuft im Browser auf dem Mac und auf Android,
lässt sich als App installieren und funktioniert offline. Einträge werden über Dropbox zwischen
den Geräten abgeglichen.

## Funktionen
- Stempeluhr für Arbeit, Telefonat und Fahrt, mit Präsenz oder Homeoffice und Pause
- Automatische Hin- und Rückfahrt an Präsenztagen (abschaltbar)
- Wochen- und Monatsansicht mit Summen und Beträgen
- Stundenzettel als PDF oder CSV, optional direkt in Dropbox gespeichert
- Hinweis auf doppelt erfasste Einträge
- Datensicherung und Übernahme per JSON-Datei

## Abgleich
Alle Daten liegen in einer Datei `projektzeit.json` im App-Ordner der Dropbox
(`Dropbox/Apps/<App-Name>/`). Pro Eintrag gewinnt die neuere Änderung. Gelöschte Einträge
werden als gelöscht markiert, damit das Löschen auf allen Geräten ankommt.

## Einrichtung
1. Bei https://www.dropbox.com/developers/apps eine App anlegen: „Scoped access“, „App folder“.
2. Unter *Permissions* `files.content.write` und `files.content.read` aktivieren.
3. Unter *Settings → OAuth 2 → Redirect URIs* die Adresse dieser Seite eintragen
   (z. B. `https://<name>.github.io/projektzeit/`).
4. Den *App key* in `config.js` eintragen.
