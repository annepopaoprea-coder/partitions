# Partitions

Bibliothèque de partitions (PDF et images) avec annotations et setlists, installable sur
tablette, téléphone et ordinateur, synchronisée automatiquement via Google Drive.

- `npm install` puis `npm run dev` pour développer, `npm test` pour les tests.
- `tools/import_msb.py <sauvegarde.msb> <dossier>` convertit une sauvegarde MobileSheets ;
  importez ensuite le dossier depuis Réglages → Importer une bibliothèque MobileSheets.
- Les données restent dans le dossier « Partitions » du Google Drive de l'utilisateur ;
  chaque appareil y écrit son propre journal (`journal/<appareil>.json`), fusionné par les autres.

## Pont MuseScore (sur le PC)

`bridge/partitions-bridge.py` est un petit service local (127.0.0.1:47823) qui permet à l'app,
sur l'ordinateur où il tourne, d'utiliser MuseScore et Audiveris : conversion d'un PDF en
partition (Audiveris), transposition, extraction des parties, changement de clé, version
sans basse chiffrée, et « Ouvrir dans MuseScore » (chaque enregistrement revient dans l'app).
Il n'accepte que les requêtes venant de l'app (en-tête Origin).

Installation : copier le script dans `~/.local/bin/partitions-bridge` et activer le service
utilisateur systemd `partitions-bridge.service`.
