---
title: Modifier un fichier GTFS sans casser le réseau, étape par étape
description: Les fichiers qu'un changement touche, des identifiants stables, des calendriers et des stop_times cohérents, et la validation avant de livrer une version.
updated: 2026-10-21
slug: modifier-un-gtfs
---

Pour modifier un GTFS, on travaille sur une copie, on change les lignes des fichiers concernés en gardant les identifiants existants, puis on fait passer le validateur avant de livrer une nouvelle version. La plupart des problèmes viennent de trois endroits : des références cassées entre fichiers, des horaires incohérents dans `stop_times.txt` et des calendriers modifiés au-delà des dates voulues.

## Les fichiers qu'un changement touche

Un GTFS est une archive ZIP de fichiers CSV liés entre eux par des identifiants. Un changement d'offre en touche presque toujours plusieurs :

- `routes.txt` : les lignes, avec `route_short_name`, `route_long_name`, `route_type` et les couleurs.
- `trips.txt` : les courses, chacune rattachée à une ligne (`route_id`), à un service (`service_id`) et souvent à un tracé (`shape_id`), avec son sens (`direction_id`).
- `stop_times.txt` : les passages de chaque course, dans l'ordre de `stop_sequence`, avec `arrival_time` et `departure_time`.
- `stops.txt` : les arrêts, les quais et les stations.
- `calendar.txt` et `calendar_dates.txt` : les jours où chaque service circule.
- `shapes.txt` : le tracé suivi par les courses.
- `frequencies.txt`, si le réseau décrit certaines lignes par un intervalle plutôt que par des horaires.
- `feed_info.txt` : l'éditeur, la version et la période de validité du jeu de données.

Avant d'écrire quoi que ce soit, listez les lignes que le changement va toucher. Un décalage d'horaires sur une ligne, c'est des centaines de lignes de `stop_times.txt` ; un service modifié dans `calendar.txt`, ce sont toutes les courses qui l'utilisent, souvent sur plusieurs lignes.

## Travailler sur une copie

Gardez l'archive d'origine intacte et modifiez une copie. Vous pourrez ainsi comparer avant et après, et revenir en arrière.

Méfiez-vous des tableurs. Un fichier CSV ouvert puis réenregistré dans un tableur perd souvent les zéros en tête des identifiants (`0042` devient `42`), transforme `25:10:00` en date ou en durée, réécrit les dates `20261102` en format local et change l'encodage. GTFS attend de l'UTF-8 et des valeurs inchangées : éditez avec un outil qui traite chaque colonne comme du texte.

## Garder les identifiants stables

Les identifiants (`stop_id`, `route_id`, `trip_id`, `service_id`, `shape_id`) sont du texte, sensible à la casse. Les calculateurs d'itinéraires et les flux temps réel s'appuient dessus d'une version à l'autre.

- Pour renommer un arrêt, changez `stop_name`, pas `stop_id`.
- Une nouvelle ligne de fichier reçoit un identifiant nouveau, dans le style du réseau (même préfixe, même séparateur).
- Ne réutilisez jamais l'identifiant d'une ligne supprimée pour un autre objet.
- Quand vous supprimez une course, supprimez aussi ses `stop_times`, ses `frequencies` et les `transfers` qui la citent. Sinon le validateur signale une [référence cassée](/regles/foreign_key_violation).

## Calendriers : ne changer que les dates voulues

Un service sert en général à beaucoup de courses. Avant de toucher une ligne de `calendar.txt`, comptez les courses qui l'utilisent, ligne par ligne. Si le changement ne concerne que certaines courses ou certaines dates, ne modifiez pas le service en place :

1. Créez un service qui circule exactement aux dates changées.
2. Copiez les courses concernées sur ce service, avec de nouveaux `trip_id` et leurs `stop_times`.
3. Retirez ces dates de l'ancien service (une exception `exception_type` 2 dans `calendar_dates.txt`, ou un `end_date` avancé si le changement court jusqu'à la fin).
4. Modifiez les copies.

Pour un changement « à partir du 4 janvier », l'ancien service s'arrête le 3 :

```
service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
SEM,1,1,1,1,1,0,0,20260901,20270103
SEM_JAN,1,1,1,1,1,0,0,20270104,20270703
```

Reportez sur le nouveau service les exceptions de l'ancien postérieures à la date de bascule (jours fériés, vacances).

## Garder stop_times cohérent

- Les horaires s'écrivent `HH:MM:SS`. Une course après minuit garde le service de sa journée et dépasse `24:00:00` : 0 h 30 après un vendredi s'écrit `24:30:00` sur le service du vendredi.
- Le long d'une course, dans l'ordre de `stop_sequence`, les horaires ne reculent jamais, et à chaque arrêt `arrival_time` est inférieur ou égal à `departure_time`.
- Le premier et le dernier passage portent toujours leurs horaires.
- `stop_sequence` doit croître le long de la course, sans être forcément consécutif.
- Pour décaler une course, décalez tous ses horaires du même nombre de secondes, temps d'arrêt compris.
- Si le réseau renseigne `block_id`, deux courses d'un même véhicule ne doivent pas se chevaucher dans le temps.

Certains jeux écrivent l'heure sur un chiffre (`7:05:00`) : triez et comparez les horaires en secondes, jamais comme du texte.

## Les tracés

Un tracé de `shapes.txt` est souvent partagé par plusieurs courses. Si vous changez l'itinéraire de quelques-unes, copiez le tracé sous un nouveau `shape_id` avant de déplacer ses points. Quand le jeu renseigne `shape_dist_traveled`, les valeurs croissent le long de la course, dans la même unité dans `shapes.txt` et dans `stop_times.txt`. Un arrêt éloigné de son tracé déclenche l'avertissement [stop_too_far_from_shape](/regles/stop_too_far_from_shape).

## Valider avant de livrer

Passez le validateur de MobilityData sur le jeu modifié et comparez son rapport à celui du jeu d'origine. Ce qui compte pour un changement, ce sont les nouvelles erreurs : une référence cassée, une [clé en double](/regles/duplicate_key), des horaires qui reculent, un service qui ne circule plus aucun jour. Regardez aussi les nouveaux avertissements, par exemple un tracé qui n'est plus utilisé après la suppression d'une variante.

Vérifiez ensuite le résultat comme un voyageur : la grille d'une ligne un jour de semaine, un samedi, un jour férié, avant et après.

## Livrer une version

Chaque jeu livré est une version : mettez à jour `feed_info.feed_version` et, si elles changent, `feed_start_date` et `feed_end_date`. Conservez la version précédente pour pouvoir y revenir, et notez ce qui a changé et qui l'a décidé.

Dans GTFS Express, chaque changement se fait dans un brouillon séparé du réseau de travail : « Avant » montre le réseau tel qu'il est, « Après » le brouillon. Appliquer le brouillon crée une nouvelle version (v1, v2...) qui peut être annulée, et une nouvelle erreur du validateur bloque la livraison.

## Pour aller plus loin

- [Ajouter un arrêt dans un GTFS](/guides/ajouter-un-arret-dans-un-gtfs)
- [Vacances scolaires et jours fériés dans un GTFS](/guides/vacances-scolaires-et-jours-feries-dans-un-gtfs)
- [Valider un GTFS](/guides/valider-un-gtfs)
