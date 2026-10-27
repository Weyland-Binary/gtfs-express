---
title: "stop_too_far_from_shape : arrêt trop loin du tracé"
description: Un arrêt desservi par une course se trouve à plus de 100 m du tracé de cette course dans shapes.txt. Causes fréquentes et correction pas à pas.
updated: 2026-10-21
---

## Ce que signifie cette règle

Le validateur compare la position de chaque arrêt desservi par une course (`stop_lat`, `stop_lon` dans `stops.txt`) au tracé que la course référence par son `shape_id`. Quand l'arrêt est plus loin du tracé que le seuil, 100 m par défaut, il lève cet avertissement. Sévérité : **avertissement**.

La règle ne porte que sur les courses qui ont un `shape_id`. Une course sans tracé n'est pas concernée.

## Pourquoi c'est important

Un avertissement ne bloque pas la livraison dans GTFS Express, mais l'écart se voit. Les applications de voyageurs dessinent la ligne d'après `shapes.txt` et posent les arrêts d'après `stops.txt` : l'arrêt apparaît alors à côté de la ligne, parfois dans la rue voisine. Les calculateurs d'itinéraire qui découpent le tracé entre deux arrêts produisent des segments faux, et les distances calculées le long du tracé deviennent incohérentes.

## Causes fréquentes

- Le tracé a été dessiné pour une autre variante de la ligne (un terminus différent, une boucle en moins).
- La course pointe vers le mauvais `shape_id`, souvent celui de l'autre sens.
- Les coordonnées de l'arrêt sont fausses : latitude et longitude inversées, décimales tronquées, arrêt déplacé sans mise à jour.
- Un tracé ancien a été conservé après une déviation devenue permanente.

## Comment la corriger

Regardez d'abord qui a raison. Si l'arrêt est bien placé, redessinez le tracé dans `shapes.txt` pour qu'il passe par l'arrêt, ou rattachez la course au bon `shape_id` dans `trips.txt`. Si le tracé est juste, corrigez `stop_lat` et `stop_lon` de l'arrêt.

Dans GTFS Express, ouvrez le rapport de validation : la règle liste ses occurrences avec l'arrêt et la course en cause. « Corriger un par un » ouvre chaque ligne concernée dans l'éditeur, et la carte montre l'arrêt et le tracé ensemble. Chaque correction est une retouche du brouillon, puis « Revalider » relance le validateur.

## Exemple

L'arrêt `MAIRIE` est placé à environ 450 m au nord du tracé `SH_4_ALLER` :

```
stop_id,stop_name,stop_lat,stop_lon
MAIRIE,Mairie,49.8985,2.2950
```

Après vérification sur le terrain, les coordonnées corrigées le remettent sur la chaussée que suit la ligne :

```
stop_id,stop_name,stop_lat,stop_lon
MAIRIE,Mairie,49.8945,2.2952
```

Voir aussi le guide [Ajouter un arrêt dans un GTFS](/guides/ajouter-un-arret-dans-un-gtfs) et la [liste des règles](/regles).
