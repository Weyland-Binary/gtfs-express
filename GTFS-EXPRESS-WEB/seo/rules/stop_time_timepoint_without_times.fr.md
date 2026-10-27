---
title: "stop_time_timepoint_without_times : horaire exact annoncé sans heure"
description: Un passage de stop_times.txt est marqué comme horaire exact (timepoint) mais ne porte ni heure d'arrivée ni heure de départ. Causes et correction.
updated: 2026-10-21
---

## Ce que signifie cette règle

Le champ `timepoint` de `stop_times.txt` indique si les heures d'un passage sont exactes (`1`) ou approximatives (`0`). Un passage marqué exact doit porter ses heures : `arrival_time` et `departure_time`. La règle se déclenche sur un passage avec `timepoint=1` qui n'a pas d'heure. Le catalogue de GTFS Express traite aussi un `timepoint` vide comme exact.

Sévérité : **erreur**.

## Pourquoi c'est important

Un point de régulation sans heure est une contradiction : le flux annonce un horaire garanti à cet arrêt sans le donner. Les outils qui interpolent les heures des arrêts intermédiaires s'appuient sur les points horodatés ; un point vide les prive d'un repère, et certains écartent la course.

## Causes fréquentes

- Un export qui met `timepoint` à `1` sur tous les passages par défaut, alors que seuls certains arrêts ont une heure.
- Des heures effacées sur des arrêts intermédiaires pour laisser l'interpolation faire, sans passer `timepoint` à `0`.
- Un arrêt inséré dans une course, sans heure, en recopiant le `timepoint` d'une ligne voisine.

## Comment la corriger

Deux corrections possibles selon ce qui est vrai sur le terrain. Si l'arrêt est un point de régulation, renseignez `arrival_time` et `departure_time` à partir de la fiche horaire. S'il ne l'est pas, passez `timepoint` à `0` et laissez les heures vides : les consommateurs les interpolent entre les points horodatés. Le premier et le dernier arrêt d'une course doivent toujours avoir leurs heures (voir [missing_trip_edge](/regles/missing_trip_edge)).

Dans GTFS Express, chaque occurrence du rapport désigne le passage et le champ. « Corriger un par un » ouvre le passage dans l'éditeur ; chaque correction est une retouche du brouillon, puis « Revalider » relance le validateur.

## Exemple

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence,timepoint
T501,07:00:00,07:00:00,S100,1,1
T501,,,S110,2,1
T501,07:12:00,07:12:00,S120,3,1
```

Corrigé, l'arrêt `S110` n'étant pas un point de régulation :

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence,timepoint
T501,07:00:00,07:00:00,S100,1,1
T501,,,S110,2,0
T501,07:12:00,07:12:00,S120,3,1
```

Voir aussi la [liste des règles de validation](/regles).
