---
title: "stop_without_stop_time : arrêt desservi par aucune course"
description: Un arrêt n'apparaît dans aucune ligne de stop_times.txt. Pourquoi un arrêt sans passage gêne les voyageurs, et comment le supprimer ou le desservir.
updated: 2026-10-21
---

## Ce que signifie cette règle

Un arrêt ou un quai de `stops.txt` (`location_type` vide ou 0) n'a de sens que si au moins une course y passe, c'est-à-dire si son `stop_id` figure dans `stop_times.txt`. Quand aucune ligne de `stop_times.txt` ne le cite, le validateur lève cet avertissement. Les gares, entrées et nœuds (`location_type` 1 à 4) ne sont pas concernés : ils ne sont jamais desservis directement. Sévérité : **avertissement**.

## Pourquoi c'est important

Un avertissement ne bloque pas la livraison dans GTFS Express. Mais un arrêt sans passage s'affiche sur la carte des applications sans aucun horaire, et un calculateur d'itinéraire peut y conduire un voyageur à pied pour qu'il y attende un bus qui ne vient pas. Pour ceux qui réutilisent les données, il fausse le compte des arrêts desservis.

## Causes fréquentes

- Une ligne a été supprimée ou raccourcie, ses arrêts terminaux sont restés.
- Un arrêt a été remplacé par un nouveau `stop_id` lors d'un déplacement.
- Les arrêts d'une déviation temporaire sont restés après la fin des travaux.
- Des arrêts sont déjà créés pour un service qui n'a pas encore commencé.

## Comment la corriger

Si l'arrêt n'est plus desservi, supprimez-le de `stops.txt`. Vérifiez avant qu'aucun autre fichier ne le cite, `transfers.txt` ou `pathways.txt` par exemple, sinon la suppression crée une erreur de clé étrangère. Si l'arrêt devait être desservi, ajoutez-le aux courses concernées dans `stop_times.txt`, avec ses horaires et un `stop_sequence` à la bonne place.

Dans GTFS Express, le rapport de validation liste les arrêts concernés et « Corriger un par un » ouvre chacun dans l'éditeur ; la carte du lecteur montre où il se trouve par rapport aux lignes. Chaque suppression ou ajout est une retouche du brouillon, puis « Revalider » relance le contrôle.

## Exemple

L'arrêt `PISCINE_PROV` servait une déviation terminée :

```
stop_id,stop_name,stop_lat,stop_lon,location_type
PISCINE,Piscine,49.8812,2.3104,0
PISCINE_PROV,Piscine (provisoire),49.8818,2.3121,0
```

Aucune course ne le cite dans `stop_times.txt` et aucun autre fichier ne le référence : on supprime sa ligne.

Voir aussi le guide [Ajouter un arrêt dans un GTFS](/guides/ajouter-un-arret-dans-un-gtfs) et la [liste des règles](/regles).
