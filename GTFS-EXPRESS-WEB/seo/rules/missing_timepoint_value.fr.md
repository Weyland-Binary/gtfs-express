---
title: "missing_timepoint_value : timepoint non renseigné"
description: Une ligne de stop_times.txt laisse le champ timepoint vide. Pourquoi indiquer 0 ou 1 explicitement, et comment distinguer horaires exacts et horaires approchés.
updated: 2026-10-21
---

## Ce que signifie cette règle

Le champ `timepoint` de `stop_times.txt` dit si l'horaire d'un passage est tenu exactement (`1`) ou seulement approché (`0`). Il est facultatif, mais la référence GTFS recommande de le renseigner sur toutes les lignes qui portent des horaires. Quand une ligne le laisse vide, le validateur lève cet avertissement. Sévérité : **avertissement**.

Faute de valeur, la référence considère les horaires comme exacts.

## Pourquoi c'est important

Un avertissement ne bloque pas la livraison dans GTFS Express. Le risque est d'annoncer comme garanti un horaire qui ne l'est pas. Beaucoup de réseaux ne tiennent l'horaire qu'à certains points de régulation et estiment les passages intermédiaires. Si `timepoint` est vide partout, une application ne peut pas faire la différence et présente chaque minute comme une promesse ; le voyageur qui arrive à l'heure exacte à un arrêt intermédiaire peut voir le bus déjà passé.

## Causes fréquentes

- L'outil d'export n'écrit pas la colonne, ou l'écrit vide.
- Les horaires intermédiaires ont été interpolés sans marquer qu'ils sont approchés.
- La colonne a été ajoutée pour quelques courses seulement.

## Comment la corriger

Renseignez `timepoint` sur chaque ligne de `stop_times.txt` : `1` aux arrêts où l'horaire est tenu (souvent les terminus et les points de régulation), `0` aux autres. Une ligne qui n'a ni `arrival_time` ni `departure_time` devrait porter `0` : `1` sans horaire est une erreur, décrite par la règle [stop_time_timepoint_without_times](/regles/stop_time_timepoint_without_times).

Dans GTFS Express, le rapport de validation liste les lignes concernées et « Corriger un par un » ouvre chacune dans l'éditeur, le champ signalé. Quand la règle touche toute une ligne de bus, il est plus rapide de remplir la colonne pour toutes ses courses dans le brouillon ; chaque modification est une retouche, puis « Revalider » relance le contrôle.

## Exemple

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence,timepoint
T3,07:30:00,07:30:00,GARE,1,
T3,07:34:00,07:34:00,ECOLE,2,
T3,07:41:00,07:41:00,HOPITAL,3,
```

Corrigé, l'horaire n'étant tenu qu'aux deux extrémités :

```
trip_id,arrival_time,departure_time,stop_id,stop_sequence,timepoint
T3,07:30:00,07:30:00,GARE,1,1
T3,07:34:00,07:34:00,ECOLE,2,0
T3,07:41:00,07:41:00,HOPITAL,3,1
```

Voir aussi la [liste des règles](/regles).
