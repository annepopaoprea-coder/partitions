# Partitions

Bibliothèque de partitions (PDF et images) avec annotations et setlists, installable sur
tablette, téléphone et ordinateur, synchronisée automatiquement via Google Drive.

- `npm install` puis `npm run dev` pour développer, `npm test` pour les tests.
- `tools/import_msb.py <sauvegarde.msb> <dossier>` convertit une sauvegarde MobileSheets ;
  importez ensuite le dossier depuis Réglages → Importer une bibliothèque MobileSheets.
- Les données restent dans le dossier « Partitions » du Google Drive de l'utilisateur ;
  chaque appareil y écrit son propre journal (`journal/<appareil>.json`), fusionné par les autres.
