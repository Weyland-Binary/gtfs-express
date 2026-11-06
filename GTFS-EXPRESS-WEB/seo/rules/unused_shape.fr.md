---
title: "unused_shape : tracé qu'aucune course n'utilise"
description: Un shape_id de shapes.txt n'est référencé par aucune course de trips.txt. Un tracé orphelin à supprimer, ou le signe qu'une course a perdu le sien.
updated: 2026-10-21
---

## Ce que signifie cette règle

`shapes.txt` décrit des tracés, chacun identifié par un `shape_id` et formé d'une suite de points (`shape_pt_lat`, `shape_pt_lon`, `shape_pt_sequence`). Une course s'y rattache par le champ `shape_id` de `trips.txt`. Quand un tracé n'est utilisé par aucune course, le validateur lève cet avertissement. Sévérité : **avertissement**.

## Pourquoi c'est important

Un avertissement ne bloque pas la livraison dans GTFS Express. Un tracé orphelin ne s'affiche dans aucune application, mais il alourdit le fichier, souvent de plusieurs milliers de points, et trompe ceux qui réutilisent les données : un tracé présent laisse croire à un itinéraire desservi. Surtout, il peut révéler l'inverse du problème : une course qui devait l'utiliser pointe vers un autre tracé, ou n'en a plus.

## Causes fréquentes

- Une variante de ligne a été supprimée, ses courses avec, mais pas son tracé.
- Un tracé a été redessiné sous un nouveau `shape_id`, l'ancien est resté.
- Un outil d'export écrit tous les tracés de sa base, y compris ceux des périodes passées.
- Les courses d'un sens ont été rattachées par erreur au tracé de l'autre sens.

## Comment la corriger

Vérifiez d'abord à quoi correspond le tracé : affichez-le sur une carte et comparez-le aux courses de la ligne. Si une course aurait dû l'utiliser, renseignez son `shape_id` dans `trips.txt`. Sinon, supprimez de `shapes.txt` toutes les lignes portant ce `shape_id`.

Dans GTFS Express, le rapport de validation liste les tracés concernés, et la carte du lecteur permet de voir chacun avant de décider. La suppression ou le rattachement se fait dans le brouillon, chaque modification étant une retouche ; « Revalider » relance ensuite le validateur.

## Exemple

Le tracé `SH_7_ANCIEN` est resté après le redessin de la ligne 7 :

```
shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence
SH_7_ANCIEN,49.8941,2.2958,1
SH_7_ANCIEN,49.8950,2.2981,2
SH_7,49.8941,2.2958,1
```

```
route_id,service_id,trip_id,shape_id
L7,SEM,T7_001,SH_7
L7,SEM,T7_002,SH_7
```

Aucune course ne cite `SH_7_ANCIEN` : on supprime ses points.

Voir aussi le guide [Modifier un GTFS](/guides/modifier-un-gtfs) et la [liste des règles](/regles).
