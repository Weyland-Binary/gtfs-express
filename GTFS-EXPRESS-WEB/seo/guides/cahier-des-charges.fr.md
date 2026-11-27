---
title: Du cahier des charges au GTFS livré
description: Ce que doit dire un cahier des charges pour modifier un GTFS sans deviner, comment GTFS Express en fait un changement, et quoi vérifier avant de livrer.
updated: 2026-10-21
slug: du-cahier-des-charges-au-gtfs
---

Un cahier des charges devient un GTFS livré quand chaque demande se traduit, sans deviner, en lignes de fichiers : quelles lignes, quels sens, quels jours, à partir de quelle date, à quelles heures, à quels arrêts. On vérifie ensuite chaque demande sur le réseau modifié, ainsi que tout ce qui ne devait pas bouger, avant de livrer une nouvelle version.

## Ce que dit un bon cahier des charges

- **Les lignes**, par leur nom public (celui de `route_short_name`), et les variantes concernées : services partiels, courses scolaires, renforts. « La ligne 5 » couvre toutes ses courses ; si seules certaines sont visées, il faut le dire.
- **Le sens**, par sa destination : « vers Gare » est clair, « aller » ne l'est pas toujours.
- **Les jours.** « Du lundi au vendredi » inclut les vacances scolaires, sauf mention « en période scolaire ». Les « jours ouvrables » vont du lundi au samedi, les « jours ouvrés » du lundi au vendredi, jours fériés exclus dans les deux cas. « Dimanches et fêtes » couvre les jours fériés.
- **La période.** Une date de début (« à partir du 4 janvier 2027 ») et une date de fin, ou « jusqu'à nouvel ordre ». Si les vacances comptent, la zone scolaire.
- **Les heures.** Des horaires précis, ou un intervalle avec son amplitude et son point de départ : « toutes les 15 minutes de 7 h à 9 h au départ de Gare ». « En heure de pointe » ne suffit pas sans les heures.
- **Les arrêts.** Les arrêts existants par leur nom et le sens concerné ; pour un arrêt nouveau, sa position (coordonnées, ou un emplacement sans ambiguïté), et ses voisins sur la ligne.
- **L'état actuel, s'il est cité.** « Actuellement, le premier départ est à 6 h 10 » sera comparé au jeu existant : si c'est faux, c'est une question à trancher, pas un détail.

Les tableaux d'horaires joints sont bienvenus, à condition de dire à quelle ligne, quel sens et quels jours ils s'appliquent.

## Les phrases qui se lisent de deux façons

- « Renfort le samedi et en soirée » : les samedis soir, ou les samedis plus tous les soirs. Les deux lectures modifient des courses différentes.
- « Prolonger la ligne 3 jusqu'au Parc » : toutes les courses, ou seulement certaines (une sur deux, celles de la pointe).
- « Supprimer l'arrêt Mairie » : pour cette ligne seulement, ou retirer l'arrêt du réseau.
- « Dernier départ à 23 h » : au terminus de départ, ou à l'arrêt central cité plus haut.

Une seule phrase précise évite un aller-retour.

## Comment GTFS Express transforme le cahier des charges en changement

Le cahier des charges se donne en texte ou en documents (PDF, Word, Excel). Le changement se fait dans un brouillon, séparé du réseau de travail :

1. Un agent d'IA modifie une copie du réseau.
2. Le moteur établit les faits du changement : ce qui a changé, table par table, et les nouvelles erreurs du validateur.
3. Une revue indépendante, menée par un autre modèle, vérifie chaque demande du cahier des charges sur cette copie et la déclare faite, non faite ou non prouvée, avec ses preuves, ainsi que les changements que personne n'a demandés.
4. Quand une demande se lit de deux façons ou qu'une donnée manque (la position d'un nouvel arrêt, par exemple), l'agent pose une question au lieu de deviner.
5. La personne décide, sous son nom.

« Avant » montre le réseau tel qu'il est, « Après » le brouillon. Appliquer le brouillon crée une nouvelle version (v1, v2...), qui peut être annulée. Une nouvelle erreur du validateur bloque la livraison. Les noms et adresses e-mail sont masqués avant tout envoi au modèle d'IA.

## Vérifier avant de livrer

Que le changement vienne d'un outil ou d'une saisie à la main, les contrôles sont les mêmes.

- **Chaque demande, mesurée.** Pour « dernier départ à 23 h en semaine à partir du 4 janvier », regardez les départs de la ligne et du sens concernés un jour de semaine après le 4 janvier, et le même jour de semaine avant cette date, qui doit être inchangé.
- **Un jour concerné et un jour qui ne l'est pas.** Un samedi, un jour de vacances, un jour férié.
- **Ce qui n'était pas demandé.** Les autres lignes, l'autre sens, les autres dates, les autres fichiers. Un service partagé entre plusieurs lignes est la cause la plus fréquente de changements involontaires.
- **Le validateur.** Aucune nouvelle erreur par rapport au jeu d'origine, et les nouveaux avertissements expliqués.
- **La validité.** `feed_info.feed_version`, et `feed_start_date` et `feed_end_date` si la période change.
- **La grille.** La fiche horaire d'une ligne modifiée, lue comme un voyageur la lira.

## Livrer

Le paquet livré par GTFS Express contient le GTFS et son rapport de validation, et garde la décision de la personne. La version précédente reste disponible : si un problème apparaît après livraison, on peut revenir en arrière.

## Pour aller plus loin

- [Modifier un GTFS](/guides/modifier-un-gtfs)
- [Vacances scolaires et jours fériés dans un GTFS](/guides/vacances-scolaires-et-jours-feries-dans-un-gtfs)
- [Choisir un outil pour modifier un GTFS](/guides/choisir-un-outil-pour-modifier-un-gtfs)
