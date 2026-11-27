---
title: "fast_travel_between_consecutive_stops : vitesse impossible"
description: Entre deux arrêts consécutifs d'une course, la distance et les horaires impliquent une vitesse irréaliste. Causes et correction dans stop_times.txt.
updated: 2026-10-21
---

## Ce que signifie cette règle

Pour chaque course, le validateur prend deux arrêts consécutifs de `stop_times.txt`, mesure la distance entre leurs positions dans `stops.txt` et la divise par le temps écoulé entre le départ du premier et l'arrivée au second. Si la vitesse obtenue dépasse la limite plausible du mode de la ligne (`route_type`), par exemple plus de 150 km/h pour un bus, il lève cet avertissement. Sévérité : **avertissement**.

Les limites dépendent du mode : un train peut rouler bien plus vite qu'un tramway. Le rapport donne la vitesse calculée et les deux arrêts en cause.

## Pourquoi c'est important

Un avertissement ne bloque pas la livraison dans GTFS Express, mais une vitesse impossible signale presque toujours une donnée fausse. Le voyageur reçoit un temps de parcours irréaliste, et un calculateur d'itinéraire peut proposer une correspondance qui ne tient pas sur le terrain.

## Causes fréquentes

- Un arrêt mal géolocalisé, placé dans une autre commune ou à zéro de latitude.
- Une faute de frappe dans un horaire, `08:05:00` au lieu de `08:50:00`.
- Deux arrêts éloignés avec le même horaire, alors qu'un arrêt intermédiaire a été supprimé ou que les heures ont été arrondies à la minute.
- Un horaire décalé d'une heure sur une partie de la course.

## Comment la corriger

Vérifiez d'abord la position des deux arrêts (`stop_lat`, `stop_lon`). S'ils sont bien placés, corrigez `arrival_time` ou `departure_time` dans `stop_times.txt` pour que le temps de parcours corresponde à la distance réelle.

Dans GTFS Express, le rapport de validation liste chaque occurrence avec la course et les deux arrêts. « Corriger un par un » ouvre la ligne de `stop_times.txt` dans l'éditeur, le champ en cause signalé ; la fiche horaire de la course aide à repérer la valeur aberrante. La correction devient une retouche du brouillon, puis « Revalider » relance le contrôle.

## Exemple

Les arrêts `GARE` et `ZA_NORD` sont distants de 9 km, mais la course ne met qu'une minute :

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T12,08:04:00,08:05:00,GARE,5
T12,08:06:00,08:06:00,ZA_NORD,6
```

L'horaire réel était `08:16:00` :

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T12,08:04:00,08:05:00,GARE,5
T12,08:16:00,08:16:00,ZA_NORD,6
```

Voir aussi le guide [Valider un GTFS](/guides/valider-un-gtfs) et la [liste des règles](/regles).
