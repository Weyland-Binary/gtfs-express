---
title: "missing_trip_edge : premier ou dernier arrêt d'une course sans heure"
description: Le premier ou le dernier passage d'une course dans stop_times.txt n'a pas d'heure, alors que ses extrémités doivent être horodatées. Causes et correction.
updated: 2026-10-21
---

## Ce que signifie cette règle

Dans `stop_times.txt`, les arrêts intermédiaires d'une course peuvent rester sans heure : les consommateurs interpolent alors leurs horaires entre les arrêts horodatés. Les deux extrémités, en revanche, doivent porter `arrival_time` et `departure_time`. La règle se déclenche quand le premier ou le dernier passage d'une course (au sens de `stop_sequence`) n'a pas ses heures.

Sévérité : **erreur**.

## Pourquoi c'est important

Sans heure de départ ou d'arrivée terminus, la course n'a ni début ni fin dans le temps. L'interpolation des arrêts intermédiaires devient impossible, la course ne peut pas être placée dans la journée, et la plupart des outils qui consomment le flux l'écartent.

## Causes fréquentes

- Un arrêt ajouté en début ou en fin de course (prolongement d'une ligne) sans saisir ses heures.
- Un export qui ne garde les heures que sur les points de régulation, alors que le terminus n'en est pas un dans l'outil source.
- Des `stop_sequence` mal ordonnés : un arrêt intermédiaire sans heure se retrouve en tête ou en queue de la course.
- Le premier ou le dernier arrêt supprimé, laissant à sa place un arrêt intermédiaire non horodaté.

## Comment la corriger

Pour chaque course signalée, renseignez `arrival_time` et `departure_time` sur le premier et le dernier passage, d'après la fiche horaire ou le temps de parcours réel. Si l'arrêt est arrivé en tête ou en queue par une erreur d'ordre, corrigez `stop_sequence` pour remettre les passages dans l'ordre réel. Gardez des heures cohérentes avec les passages voisins, sinon d'autres règles prendront le relais.

Dans GTFS Express, chaque occurrence du rapport désigne la course et le passage concernés. « Corriger un par un » ouvre le passage dans l'éditeur, le champ signalé ; chaque correction est une retouche du brouillon, puis « Revalider » relance le validateur.

## Exemple

La course `T720` a été prolongée jusqu'à l'arrêt `S300`, sans heure :

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T720,08:00:00,08:00:00,S100,1
T720,08:14:00,08:14:00,S200,2
T720,,,S300,3
```

Corrigé :

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T720,08:00:00,08:00:00,S100,1
T720,08:14:00,08:14:00,S200,2
T720,08:21:00,08:21:00,S300,3
```

Voir aussi le guide [Ajouter un arrêt dans un GTFS](/guides/ajouter-un-arret-dans-un-gtfs).
