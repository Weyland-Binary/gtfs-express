---
title: "invalid_time : heure au mauvais format dans un GTFS"
description: Un champ horaire ne suit pas le format GTFS HH:MM:SS. Les valeurs refusées par invalid_time, le cas des heures après minuit et la façon de les corriger.
updated: 2026-10-21
---

## Ce que signifie cette règle

Les heures de GTFS s'écrivent `HH:MM:SS`, en heure locale du réseau, comptées depuis le début de la journée de service : `08:05:00`. L'heure peut s'écrire sur un seul chiffre avant 10 h (`8:05:00`). Les champs concernés sont surtout `arrival_time` et `departure_time` dans `stop_times.txt`, et `start_time` et `end_time` dans `frequencies.txt`. La règle se déclenche quand une valeur ne respecte pas ce format.

Une heure au-delà de `24:00:00` est valide et même attendue : une course partie à 23 h 50 et arrivée à 0 h 20 le lendemain s'écrit `23:50:00` puis `24:20:00`, sur le même jour de service.

Sévérité : **erreur**.

## Pourquoi c'est important

Une heure illisible ne peut pas être placée dans la journée. Le passage concerné est ignoré, ou la course entière est écartée par les outils qui calculent les itinéraires et les fiches horaires.

## Causes fréquentes

- Un tableur qui enregistre `8:05` sans les secondes, ou une fraction de jour (`0.3368`) à la place de l'heure.
- Une notation sur 12 heures (`8:05 PM`) ou avec un séparateur différent (`8h05`, `08.05.00`).
- Des heures après minuit écrites `00:20:00` au lieu de `24:20:00` : le format est valide, mais l'heure est alors celle du début de la journée, ce que d'autres règles signalent.
- Une espace ou une virgule résiduelle dans la cellule.

## Comment la corriger

Réécrivez chaque valeur signalée au format `HH:MM:SS`, en ajoutant les secondes si besoin et en passant les heures après minuit au-delà de 24 quand la course appartient à la journée de service précédente. Si le fichier sort d'un tableur, formatez la colonne en texte avant l'export pour éviter que le problème revienne.

Dans GTFS Express, le rapport liste chaque occurrence avec le fichier, la ligne, le champ et la valeur fautive. « Corriger un par un » ouvre le passage dans l'éditeur ; chaque correction est une retouche du brouillon, puis « Revalider » relance le validateur.

## Exemple

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T2301,23:50,23:50,S100,1
T2301,0:05:00,0:05:00,S205,2
```

Corrigé :

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T2301,23:50:00,23:50:00,S100,1
T2301,24:05:00,24:05:00,S205,2
```

Voir aussi le guide [Valider un GTFS](/guides/valider-un-gtfs).
