---
title: Faire les fiches horaires aux arrêts à partir d'un GTFS
description: Ce qu'une fiche horaire au poteau doit montrer, comment le GTFS le donne (types de jour, renvois, périodes, montée interdite) et les pièges qui rendent une fiche fausse.
updated: 2026-10-22
slug: fiches-horaires-aux-arrets-depuis-un-gtfs
---

Une fiche horaire au poteau montre, pour une ligne et une direction, les départs d'un arrêt sur une période. Tout ce qu'elle dit se trouve dans le GTFS : les heures dans `stop_times.txt`, les jours dans `calendar.txt` et `calendar_dates.txt`, la direction dans `trips.txt`. Le travail consiste à regrouper ces données comme un voyageur les lit, sans en perdre.

## Ce qu'une fiche doit montrer

- La ligne et sa direction, nommée par son terminus habituel.
- Le nom de l'arrêt, et son code s'il est affiché sur le poteau.
- Une colonne ou une bande par type de jour : lundi à vendredi en période scolaire, lundi à vendredi pendant les vacances, samedi, dimanche et jours fériés.
- Les départs par heure, avec un renvoi pour chaque départ qui ne circule pas tous les jours de sa colonne.
- La période de validité de la fiche.
- Le parcours de la ligne, avec l'arrêt repéré et le temps pour rejoindre les arrêts suivants.

## Des dates aux types de jour

Le GTFS ne donne pas de types de jour : il donne des services, chacun actif à certaines dates. Pour remplir une colonne, on prend toutes les dates de la période qui appartiennent à ce type de jour, puis les départs dont le service roule au moins une de ces dates.

Les vacances scolaires et les jours fériés ne sont pas dans le GTFS. Il faut les connaître pour séparer la semaine scolaire de la semaine de vacances ; le guide [Vacances scolaires et jours fériés dans un GTFS](/guides/vacances-scolaires-et-jours-feries-dans-un-gtfs) explique comment un réseau les écrit.

Deux colonnes qui ont exactement les mêmes départs n'en font qu'une : « lundi à samedi » se lit mieux que deux colonnes identiques.

## Les renvois

Un départ qui ne roule pas tous les jours de sa colonne porte une lettre, et la lettre renvoie à une phrase en bas de fiche. La phrase doit être exacte et courte :

- « Mercredi uniquement » quand le départ ne roule que certains jours de la semaine.
- « Sauf le 11 novembre » quand il manque quelques dates.
- « Uniquement du 2 au 6 novembre » quand il ne roule que quelques dates.
- « Terminus Gare » quand il s'arrête avant le terminus habituel.
- « Sur réservation » quand `pickup_type` vaut 2.

Deux pièges reviennent souvent. Un réseau publie parfois un service du lundi au jeudi et un autre le vendredi, avec les mêmes horaires : ce sont les mêmes départs, ils ne méritent aucun renvoi. Et quand presque tous les départs d'une colonne partagent la même exception, mieux vaut l'écrire une fois à côté du titre de la colonne qu'une lettre sur chaque minute.

## Ce qui n'est pas un départ

- Le dernier arrêt d'une course : on y descend, on n'y monte pas.
- Un arrêt où `pickup_type` vaut 1 : la montée y est interdite.
- Un horaire vide entre deux points d'arrêt : il faut l'estimer ou le signaler, pas l'inventer.

## Les périodes de validité

Une fiche valable « jusqu'à la fin de la saison » couvre souvent plusieurs régimes : une période de travaux, un marché de Noël, un service d'été. On peut les traiter de deux façons : une fiche par période, sans renvoi, ou une fiche pour la saison avec les exceptions en renvois. Pour choisir, il faut savoir où l'horaire du réseau change durablement, ce qu'on lit en comparant, pour chaque jour de la semaine et chaque type de jour, les services qui roulent d'une semaine sur l'autre.

## Les fréquences

Quand les départs se suivent à intervalle régulier pendant plusieurs heures, « toutes les 8 min » remplace utilement une colonne de minutes. Les départs qui portent un renvoi doivent rester visibles : on ne regroupe que les heures entières où tous les départs suivent le même rythme.

## Avant d'imprimer

Relisez chaque fiche comme un voyageur : un arrêt sans aucun départ sur la période, le même départ deux fois (deux courses identiques dans le GTFS), des passages sans horaire. Chacun de ces cas trahit une donnée à corriger avant l'affichage, et la [validation du GTFS](/guides/valider-un-gtfs) en trouve la plupart.

## Avec GTFS Express

Dans le lecteur, l'onglet « Fiches horaires » prépare les fiches d'une ligne, une par arrêt et par direction : colonnes par type de jour, renvois calculés à partir des calendriers, périodes détectées, parcours de la ligne, vacances scolaires, QR code par arrêt. On les regarde gratuitement ; l'impression, une fiche par page, fait partie de la licence. Sur un brouillon, la liste des arrêts dont la fiche change est connue avant d'appliquer la modification.
