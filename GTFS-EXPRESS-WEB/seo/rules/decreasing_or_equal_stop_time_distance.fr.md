---
title: "decreasing_or_equal_stop_time_distance : distance parcourue qui recule"
description: Dans stop_times.txt, shape_dist_traveled n'augmente pas d'un arrêt au suivant sur une course. Ce que signale cette erreur GTFS et comment la corriger.
updated: 2026-10-21
---

## Ce que signifie cette règle

Le champ facultatif `shape_dist_traveled` de `stop_times.txt` donne, pour chaque passage, la distance parcourue depuis le début du tracé (`shapes.txt`) de la course. C'est une distance cumulée : elle doit augmenter strictement d'un passage au suivant, dans l'ordre de `stop_sequence`. La règle se déclenche quand la valeur d'un passage est inférieure ou égale à celle du passage précédent. Les passages où le champ est vide ne sont pas comparés.

Sévérité : **erreur**.

## Pourquoi c'est important

Les consommateurs du flux utilisent `shape_dist_traveled` pour placer chaque arrêt sur le tracé, en particulier quand une ligne passe deux fois près du même point (boucle, aller-retour sur une même voie). Une distance qui recule ou stagne situe l'arrêt au mauvais endroit : le tracé affiché entre deux arrêts est faux, et la position des véhicules en temps réel peut être mal interprétée.

## Causes fréquentes

- Des distances exprimées dans des unités différentes selon les courses ou les fichiers (mètres d'un côté, kilomètres de l'autre).
- Un arrêt inséré ou déplacé dans la course sans recalculer les distances.
- Deux arrêts consécutifs qui reçoivent la même valeur, parce que la distance a été arrondie au kilomètre.
- Un `stop_sequence` qui ne suit pas l'ordre réel de passage.
- Des distances calculées sur un autre tracé que celui du `shape_id` de la course.

## Comment la corriger

Recalculez `shape_dist_traveled` de la course en projetant chaque arrêt sur son tracé, dans l'ordre de `stop_sequence`, avec la même unité que celle de `shapes.txt`. Si les distances ne peuvent pas être recalculées de façon fiable, videz le champ pour toute la course : il est facultatif, et une valeur absente vaut mieux qu'une valeur fausse. Si c'est l'ordre des arrêts qui est faux, corrigez `stop_sequence`.

Dans GTFS Express, chaque occurrence du rapport désigne la course et le passage. « Corriger un par un » ouvre le passage dans l'éditeur, le champ signalé ; chaque correction est une retouche du brouillon, puis « Revalider » relance le validateur.

## Exemple

```
trip_id,stop_id,stop_sequence,shape_dist_traveled
T310,S100,1,0
T310,S110,2,1250
T310,S120,3,1.9
T310,S130,4,2600
```

Le troisième passage est en kilomètres. Corrigé :

```
trip_id,stop_id,stop_sequence,shape_dist_traveled
T310,S100,1,0
T310,S110,2,1250
T310,S120,3,1900
T310,S130,4,2600
```

Voir aussi la [liste des règles de validation](/regles).
