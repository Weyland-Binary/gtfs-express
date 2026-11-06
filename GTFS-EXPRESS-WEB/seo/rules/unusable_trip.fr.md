---
title: "unusable_trip : course avec moins de deux arrêts"
description: Une course de trips.txt a moins de deux lignes dans stop_times.txt. Elle ne peut pas être empruntée et les calculateurs d'itinéraire l'ignorent.
updated: 2026-10-21
---

## Ce que signifie cette règle

Une course de `trips.txt` décrit un déplacement d'un arrêt à un autre : il lui faut au moins deux passages dans `stop_times.txt`, un pour monter et un pour descendre. Quand une course n'a qu'une ligne dans `stop_times.txt`, ou aucune, le validateur lève cet avertissement. Sévérité : **avertissement**.

## Pourquoi c'est important

Un avertissement ne bloque pas la livraison dans GTFS Express. Mais une telle course est inutilisable : personne ne peut y faire un trajet, et les calculateurs d'itinéraire l'écartent. Le service qu'elle devait représenter manque donc aux voyageurs, sans que rien ne le signale dans les applications. Pour ceux qui réutilisent les données, elle fausse le nombre de courses d'une ligne.

## Causes fréquentes

- Des arrêts ont été supprimés de `stop_times.txt` sans retirer la course qui les utilisait.
- Un GTFS a été découpé sur une zone ou une période, et seuls un ou zéro passages de la course sont restés.
- L'export a perdu une partie de `stop_times.txt`, par exemple un fichier tronqué.
- Une course a été créée dans `trips.txt` et ses horaires n'ont jamais été saisis.

## Comment la corriger

Retrouvez ce que la course devait faire. Si elle circule réellement, complétez ses passages dans `stop_times.txt` : au moins le premier et le dernier arrêt, avec `arrival_time` et `departure_time`, et des `stop_sequence` croissants. Si elle n'existe plus, supprimez-la de `trips.txt` avec son éventuelle ligne restante dans `stop_times.txt` et ses lignes de `frequencies.txt` s'il y en a.

Dans GTFS Express, le rapport de validation liste les courses concernées et « Corriger un par un » ouvre chacune dans l'éditeur ; la fiche horaire de la ligne montre ce qu'il lui manque à côté des courses voisines. Chaque ajout ou suppression est une retouche du brouillon, puis « Revalider » relance le contrôle.

## Exemple

La course `T9_014` n'a plus qu'un passage :

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T9_013,17:00:00,17:00:00,GARE,1
T9_013,17:12:00,17:12:00,LYCEE,2
T9_014,17:30:00,17:30:00,GARE,1
```

Complétée d'après la fiche horaire :

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T9_014,17:30:00,17:30:00,GARE,1
T9_014,17:42:00,17:42:00,LYCEE,2
```

Voir aussi le guide [Modifier un GTFS](/guides/modifier-un-gtfs) et la [liste des règles](/regles).
