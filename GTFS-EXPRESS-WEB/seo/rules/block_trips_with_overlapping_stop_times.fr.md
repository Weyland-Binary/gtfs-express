---
title: "block_trips_with_overlapping_stop_times : courses qui se chevauchent"
description: Deux courses du même block_id se chevauchent dans le temps un même jour, ce qu'un seul véhicule ne peut pas faire. Causes et correction dans trips.txt.
updated: 2026-10-21
---

## Ce que signifie cette règle

Le champ `block_id` de `trips.txt` regroupe les courses enchaînées par un même véhicule (un service voiture). Un véhicule ne fait qu'une course à la fois : deux courses du même bloc ne doivent pas se chevaucher. La règle se déclenche quand deux courses partageant un `block_id` circulent un même jour (leurs `service_id` ont au moins une date en commun) et que l'intervalle entre le premier et le dernier horaire de l'une recouvre celui de l'autre.

Sévérité : **erreur**.

## Pourquoi c'est important

Les consommateurs du flux utilisent `block_id` pour savoir qu'un voyageur peut rester à bord d'une course à la suivante, et pour relier les données temps réel au bon véhicule. Un bloc impossible fausse ces deux usages : correspondances « sans changer de véhicule » annoncées à tort, positions de véhicules rattachées à la mauvaise course.

## Causes fréquentes

- Une course décalée dans le temps sans revoir le bloc auquel elle appartient.
- Des `block_id` réutilisés d'une période à l'autre, alors que les calendriers des deux périodes se recouvrent.
- Deux services (semaine et samedi, par exemple) qui portent le même `block_id` et ont des dates communes à cause d'une exception de `calendar_dates.txt`.
- Un `block_id` rempli par erreur avec le numéro de ligne ou de service commercial.

## Comment la corriger

Pour chaque paire signalée, vérifiez d'abord les horaires des deux courses dans `stop_times.txt` : si l'une est fausse, corrigez-la. Si les horaires sont bons, le bloc est faux : donnez à l'une des courses le `block_id` du véhicule qui l'assure réellement, ou videz le champ si cette information n'est pas connue (il est facultatif). Si les deux courses ne devaient pas circuler le même jour, c'est le calendrier qu'il faut corriger.

Dans GTFS Express, le rapport de validation désigne les courses en cause. « Corriger un par un » ouvre la ligne concernée dans l'éditeur ; chaque correction est une retouche du brouillon, puis « Revalider » vérifie que le bloc tient.

## Exemple

La course `T2` part avant l'arrivée de `T1`, avec le même véhicule :

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence
T1,07:00:00,07:00:00,S100,1
T1,07:40:00,07:40:00,S200,2
T2,07:30:00,07:30:00,S200,1
T2,08:10:00,08:10:00,S100,2
```

```
route_id,service_id,trip_id,block_id
L1,SEM,T1,B12
L1,SEM,T2,B12
```

Si `T2` est assurée par un autre véhicule, elle reçoit un autre bloc :

```
route_id,service_id,trip_id,block_id
L1,SEM,T1,B12
L1,SEM,T2,B14
```

Voir aussi la [liste des règles de validation](/regles).
